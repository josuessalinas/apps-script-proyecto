/**
 * BACKFILL AMPLIADO — carga histórica de todos los correos del BCP
 *
 * El inventario de 758 correos desde 2025 mostró el reparto real:
 *   ~532 los resuelve un parser determinista        → 0 llamadas al LLM
 *   ~59  se descartan por asunto                    → 0 llamadas
 *   ~166 necesitan al LLM                           → agrupados de a 8: ~21 llamadas
 *
 * Por qué va MES A MES y no de corrido:
 *   Apps Script mata la ejecución a los 6 minutos. Paginar por posición dentro
 *   de los resultados de Gmail no sirve: si llega correo nuevo entre corridas,
 *   las posiciones se desplazan y se saltan mensajes en silencio. Un rango de
 *   fechas cerrado es estable — el pasado ya no cambia.
 *
 * El avance se guarda en Script Properties, así que se puede correr muchas
 * veces hasta terminar. Es idempotente por partida doble: el `ID Mensaje` en
 * `Movimientos` y la hoja `Correos Ignorados`. Correrlo de más no duplica nada.
 *
 * Uso:
 *   1. estadoBackfillAmplio()   → dónde va, sin tocar nada.
 *   2. backfillBCPAmplio()      → procesa hasta quedarse sin tiempo. Repetir
 *                                 hasta que el log diga que terminó.
 *   3. reiniciarBackfillAmplio() → vuelve a empezar desde BACKFILL_AMPLIO_DESDE_.
 */

/** Primer mes a cargar, formato yyyy-MM. */
const BACKFILL_AMPLIO_DESDE_ = '2025-01';

/** Corte de seguridad: Apps Script mata a los 6 min, paramos bastante antes. */
const BACKFILL_MS_MAX_ = 4.5 * 60 * 1000;

const PROP_BACKFILL_MES_ = 'BACKFILL_AMPLIO_MES';

// ========================= ESTADO =========================

function estadoBackfillAmplio() {
  const actual = mesActualBackfill_();
  const ultimo = mesDeHoy_();
  Logger.log('Backfill ampliado');
  Logger.log('  desde        : ' + BACKFILL_AMPLIO_DESDE_);
  Logger.log('  mes en curso : ' + actual);
  Logger.log('  hasta        : ' + ultimo);
  Logger.log(mesEsPosterior_(actual, ultimo)
    ? '  estado       : TERMINADO'
    : '  estado       : pendiente, faltan ' + (mesesEntre_(actual, ultimo) + 1) + ' meses');
}

function reiniciarBackfillAmplio() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_BACKFILL_MES_);
  Logger.log('Backfill reiniciado: la próxima corrida empieza en ' + BACKFILL_AMPLIO_DESDE_ + '.');
}

function mesActualBackfill_() {
  return PropertiesService.getScriptProperties()
    .getProperty(PROP_BACKFILL_MES_) || BACKFILL_AMPLIO_DESDE_;
}

// ========================= CORRIDA =========================

function backfillBCPAmplio() {
  const arranque = Date.now();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Otra corrida en curso. Salgo.'); return; }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const hoja = ss.getSheetByName(HOJA_MOVIMIENTOS);
    const hojaIgn = hojaIgnorados_(ss);
    const idsExistentes = cargarIdsExistentes_(hoja);
    const ignorados = cargarIgnorados_(hojaIgn);
    const mapeo = cargarMapeoCategorias_(ss);

    const hasta = mesDeHoy_();
    let mes = mesActualBackfill_();
    const total = { parser: 0, asunto: 0, llm: 0, noMov: 0, dup: 0, err: 0, llamadas: 0 };
    let mesesHechos = 0;

    while (!mesEsPosterior_(mes, hasta)) {
      if (Date.now() - arranque > BACKFILL_MS_MAX_) {
        Logger.log('Se acabó el tiempo. Vuelve a correr backfillBCPAmplio() para seguir.');
        break;
      }

      Logger.log('── Mes ' + mes + ' ──');
      const r = procesarMesBackfill_(mes, {
        hoja: hoja, hojaIgn: hojaIgn, idsExistentes: idsExistentes,
        ignorados: ignorados, mapeo: mapeo, arranque: arranque
      });

      Object.keys(total).forEach(function (k) { total[k] += r[k]; });
      Logger.log('   parser: ' + r.parser + ' · asunto: ' + r.asunto + ' · LLM: ' + r.llm +
        ' · no-mov: ' + r.noMov + ' · ya estaban: ' + r.dup + ' · errores: ' + r.err +
        ' · llamadas: ' + r.llamadas);

      if (!r.completo) {
        // Se acabó el tiempo a mitad del mes. NO se avanza el cursor: se repite
        // el mes entero, y lo ya escrito se salta por ID. Repetir es barato;
        // saltarse un mes es una pérdida silenciosa.
        Logger.log('   (mes incompleto, se retomará desde aquí)');
        break;
      }

      mesesHechos++;
      mes = mesSiguiente_(mes);
      PropertiesService.getScriptProperties().setProperty(PROP_BACKFILL_MES_, mes);
    }

    Logger.log('');
    Logger.log('=== Backfill: ' + mesesHechos + ' meses completados en esta corrida ===');
    Logger.log('parser: ' + total.parser + ' · por asunto: ' + total.asunto +
      ' · por LLM: ' + total.llm + ' · no-movimiento: ' + total.noMov +
      ' · ya estaban: ' + total.dup + ' · errores: ' + total.err);
    Logger.log('Llamadas a DeepSeek en esta corrida: ' + total.llamadas);
    Logger.log(mesEsPosterior_(mes, hasta)
      ? 'TERMINADO. No hace falta volver a correrlo.'
      : 'Siguiente mes pendiente: ' + mes + '. Vuelve a correr backfillBCPAmplio().');
  } finally {
    lock.releaseLock();
  }
}

/** Procesa un mes completo. Devuelve contadores y si alcanzó a terminarlo. */
function procesarMesBackfill_(mes, ctx) {
  const r = { parser: 0, asunto: 0, llm: 0, noMov: 0, dup: 0, err: 0, llamadas: 0, completo: false };

  const rango = rangoGmailDelMes_(mes);
  const consulta = 'from:notificacionesbcp.com.pe after:' + rango.desde + ' before:' + rango.hasta;

  // Se juntan primero los mensajes que necesitan LLM, para mandarlos en lote.
  const pendientes = [];

  for (let inicio = 0; inicio < 500; inicio += 50) {
    const hilos = GmailApp.search(consulta, inicio, 50);
    if (hilos.length === 0) break;

    for (let h = 0; h < hilos.length; h++) {
      const mensajes = hilos[h].getMessages();
      for (let k = 0; k < mensajes.length; k++) {
        const msg = mensajes[k];
        const id = msg.getId();

        if (ctx.idsExistentes.has(id) || ctx.ignorados.has(id)) { r.dup++; continue; }

        // 1. Parsers deterministas: gratis.
        const mov = parsearDeterminista_(limpiarHtml_(msg.getBody()), id);
        if (mov) {
          if (escribirDesdeBackfill_(mov, msg, ctx)) r.parser++; else r.err++;
          continue;
        }

        // 2. Descarte por asunto: gratis.
        if (esAsuntoNoMovimiento_(msg.getSubject())) {
          registrarIgnorado_(ctx.hojaIgn, msg, 'no_movimiento', 'descartado por asunto');
          ctx.ignorados.add(id);
          r.noMov++;
          continue;
        }

        // 3. Lo que quede va al LLM, en lote.
        pendientes.push(msg);
      }
    }
  }

  // Lotes de a LOTE_TAMANO_.
  for (let i = 0; i < pendientes.length; i += LOTE_TAMANO_) {
    if (Date.now() - ctx.arranque > BACKFILL_MS_MAX_) return r; // completo = false
    const lote = pendientes.slice(i, i + LOTE_TAMANO_);

    let interpretados;
    try {
      interpretados = interpretarLoteBCP_(lote);
      r.llamadas++;
    } catch (e) {
      // Un lote que falla no debe tumbar el mes: se anotan y se siguen.
      Logger.log('   lote falló: ' + e.message);
      lote.forEach(function (msg) {
        registrarIgnorado_(ctx.hojaIgn, msg, 'error_parseo', 'lote falló: ' + e.message);
        ctx.ignorados.add(msg.getId());
        r.err++;
      });
      continue;
    }

    lote.forEach(function (msg, j) {
      const crudo = interpretados[j];
      const id = msg.getId();

      if (!crudo) {
        registrarIgnorado_(ctx.hojaIgn, msg, 'error_parseo', 'el LLM no devolvió este correo');
        ctx.ignorados.add(id); r.err++;
        return;
      }
      if (!crudo.es_movimiento) {
        registrarIgnorado_(ctx.hojaIgn, msg, 'no_movimiento', 'según el LLM');
        ctx.ignorados.add(id); r.noMov++;
        return;
      }

      try {
        const mov = movimientoDesdeLLM_(crudo, id, msg.getDate(), msg.getSubject());
        mov.fuente = 'correo_llm';
        if (escribirDesdeBackfill_(mov, msg, ctx)) r.llm++; else r.err++;
      } catch (e) {
        registrarIgnorado_(ctx.hojaIgn, msg, 'error_parseo', e.message);
        ctx.ignorados.add(id); r.err++;
      }
    });
  }

  r.completo = true;
  return r;
}

/** Valida, categoriza y escribe. Devuelve true si quedó en la hoja. */
function escribirDesdeBackfill_(mov, msg, ctx) {
  try {
    validarMovimiento_(mov);
    mov.categoria = (mov.tipo === 'traspaso')
      ? 'Traspaso'
      : categorizar_(mov.comercio, ctx.mapeo);
    mov.referencia = 'https://mail.google.com/mail/u/0/#all/' + mov.idMensaje;

    escribirMovimiento_(ctx.hoja, mov);
    ctx.idsExistentes.add(mov.idMensaje);
    return true;
  } catch (e) {
    registrarIgnorado_(ctx.hojaIgn, msg, 'error_parseo', e.message);
    ctx.ignorados.add(mov.idMensaje);
    Logger.log('   validación falló en ' + mov.idMensaje + ': ' + e.message);
    return false;
  }
}

// ========================= UTILIDADES DE MESES =========================

/**
 * Rango de búsqueda de un mes, SOLAPADO un día por cada lado.
 *
 * Gmail no documenta con precisión si `after:` y `before:` incluyen el día que
 * se les indica, y además interpreta las fechas en la zona horaria de la cuenta.
 * Con rangos pegados exactos, un correo del día 1 podía quedar fuera de los dos
 * meses y desaparecer sin dejar rastro — justo el día en que se paga el
 * alquiler. Solapando, en el peor caso un correo se evalúa dos veces, y eso ya
 * lo resuelve la deduplicación por `ID Mensaje`.
 */
function rangoGmailDelMes_(mes) {
  const p = mes.split('-');
  const ini = new Date(+p[0], +p[1] - 1, 1);
  ini.setDate(ini.getDate() - 1);              // un día antes del 1
  const fin = new Date(+p[0], +p[1], 1);
  fin.setDate(fin.getDate() + 1);              // un día después del 1 siguiente
  return { desde: fechaGmail_(ini), hasta: fechaGmail_(fin) };
}

function fechaGmail_(d) {
  return d.getFullYear() + '/' +
    ('0' + (d.getMonth() + 1)).slice(-2) + '/' +
    ('0' + d.getDate()).slice(-2);
}

function mesDeHoy_() {
  const hoy = new Date();
  return hoy.getFullYear() + '-' + ('0' + (hoy.getMonth() + 1)).slice(-2);
}

function mesSiguiente_(mes) {
  const p = mes.split('-');
  let a = +p[0], m = +p[1] + 1;
  if (m > 12) { m = 1; a++; }
  return a + '-' + ('0' + m).slice(-2);
}

/** ¿`a` es un mes posterior a `b`? */
function mesEsPosterior_(a, b) {
  return a > b; // yyyy-MM ordena bien como texto
}

function mesesEntre_(a, b) {
  const pa = a.split('-'), pb = b.split('-');
  return (+pb[0] - +pa[0]) * 12 + (+pb[1] - +pa[1]);
}
