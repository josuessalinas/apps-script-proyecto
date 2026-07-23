/**
 * REPARACIÓN — arreglo puntual de datos ya escritos en la hoja
 *
 * Contexto: hasta el 2026-07-22, `conciliacion.js` tenía el banco fijo en 'BCP'.
 * Subir un estado de cuenta de otro banco dejaba dos daños:
 *
 *   1. Sus transacciones se insertaron con Banco = 'BCP'.
 *   2. Al cruzar, cualquier movimiento del BCP que coincidiera en moneda, monto
 *      y fecha ±3 días con una transacción del otro banco quedó marcado
 *      Conciliado = TRUE sin respaldo real.
 *
 * Las filas de ambos bancos son INDISTINGUIBLES por su contenido: misma Fuente,
 * mismo Banco, mismo formato de llave. Por eso aquí no hay ninguna heurística
 * que "detecte" cuáles son de quién. Tú las identificas leyendo el diagnóstico;
 * el código solo aplica lo que le indiques.
 *
 * Todas las operaciones vienen en pareja: `simular...` no toca nada,
 * `aplicar...` escribe. Corre siempre la simulación primero.
 *
 * Este archivo es de un solo uso. Una vez reparada la hoja, se puede borrar.
 */

// ===================== QUÉ CORREGIR (edítalo antes de aplicar) =====================

/**
 * Números de fila (los de la hoja, tal como salen en el diagnóstico) que en
 * realidad pertenecen a otro banco. Ejemplo: [15, 16, 17, 22]
 */
const FILAS_A_CORREGIR_ = [];

/** Banco correcto para esas filas. */
const BANCO_CORRECTO_ = 'BBVA';

/**
 * Rango a limpiar de falsos "Conciliado". Formato yyyy-MM-dd.
 * Usa el período que cubría el estado de cuenta mal subido.
 */
// Las transacciones del estado del BBVA mal subido van de 2026-02-10 a
// 2026-07-10, así que los falsos "Conciliado" del BCP pueden caer en todo ese
// lapso (el cruce usa ±3 días). Se abarca febrero a julio con margen.
const RESET_DESDE_ = '2026-02-01';
const RESET_HASTA_ = '2026-07-31';

// ===================== 1. DIAGNÓSTICO (solo lectura) =====================

/**
 * Lista todas las filas que entraron por un estado de cuenta. No modifica nada.
 * Lee el "Registro de ejecución" e identifica cuáles son del otro banco por su
 * descripción y su fecha.
 */
function diagnosticoEstadosCuenta() {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_MOVIMIENTOS);
  const n = hoja.getLastRow();
  if (n < 2) { Logger.log('La hoja está vacía.'); return; }

  const filas = hoja.getRange(2, 1, n - 1, 14).getValues();
  const tz = Session.getScriptTimeZone();
  let total = 0;

  Logger.log('=== Filas con Fuente = estado_cuenta ===');
  Logger.log('fila | fecha      | tipo    | monto        | banco | descripción');

  filas.forEach(function (f, i) {
    if (String(f[11]) !== 'estado_cuenta') return;
    total++;
    const fecha = (f[1] instanceof Date) ? Utilities.formatDate(f[1], tz, 'yyyy-MM-dd') : '????-??-??';
    Logger.log(
      pad_(i + 2, 4) + ' | ' + fecha + ' | ' + pad_(String(f[2]), 7) + ' | ' +
      pad_((String(f[4]) === 'PEN' ? 'S/' : 'US$') + ' ' + Number(f[3]).toFixed(2), 12) + ' | ' +
      pad_(String(f[8]), 5) + ' | ' + String(f[5]).slice(0, 45)
    );
  });

  Logger.log('Total: ' + total + ' filas de estado de cuenta.');
  Logger.log('');
  Logger.log('Anota los números de fila del banco equivocado y ponlos en');
  Logger.log('FILAS_A_CORREGIR_, arriba en este archivo. Luego corre');
  Logger.log('simularCorreccionBanco().');
}

function pad_(v, n) {
  let s = String(v);
  while (s.length < n) s += ' ';
  return s;
}

// ===================== 2. CORREGIR EL BANCO DE FILAS PUNTUALES =====================

/** Muestra qué cambiaría `aplicarCorreccionBanco()`. No escribe. */
function simularCorreccionBanco() {
  correccionBanco_(false);
}

/** Escribe los cambios. Corre simularCorreccionBanco() antes. */
function aplicarCorreccionBanco() {
  correccionBanco_(true);
}

function correccionBanco_(escribir) {
  if (FILAS_A_CORREGIR_.length === 0) {
    Logger.log('FILAS_A_CORREGIR_ está vacío. Corre diagnosticoEstadosCuenta() y llénalo.');
    return;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Otra corrida en curso. Salgo.'); return; }

  try {
    const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_MOVIMIENTOS);
    const tz = Session.getScriptTimeZone();
    let cambios = 0;

    FILAS_A_CORREGIR_.forEach(function (fila) {
      if (fila < 2 || fila > hoja.getLastRow()) {
        Logger.log('Fila ' + fila + ' fuera de rango. La salto.');
        return;
      }

      const f = hoja.getRange(fila, 1, 1, 14).getValues()[0];
      if (String(f[11]) !== 'estado_cuenta') {
        Logger.log('Fila ' + fila + ' no viene de un estado de cuenta (Fuente=' +
          f[11] + '). La salto por seguridad.');
        return;
      }

      // La llave también lleva el banco desde el arreglo del 2026-07-22. Hay que
      // reescribirla, si no volver a subir ese estado insertaría duplicados.
      const fecha = (f[1] instanceof Date) ? Utilities.formatDate(f[1], tz, 'yyyy-MM-dd') : '';
      const partes = String(f[0]).split('|');
      const n = partes[partes.length - 1];
      const llaveNueva = 'estado_cuenta|' + BANCO_CORRECTO_ + '|' + fecha + '|' +
        Number(f[3]).toFixed(2) + '|' + String(f[4]) + '|' + n;

      Logger.log('Fila ' + fila + ': Banco "' + f[8] + '" → "' + BANCO_CORRECTO_ + '"');
      Logger.log('           llave "' + f[0] + '" → "' + llaveNueva + '"');

      if (escribir) {
        hoja.getRange(fila, 9).setValue(BANCO_CORRECTO_);  // I = Banco
        hoja.getRange(fila, 1).setValue(llaveNueva);       // A = ID Mensaje
      }
      cambios++;
    });

    Logger.log(escribir
      ? '=== APLICADO: ' + cambios + ' filas corregidas. ==='
      : '=== SIMULACRO: ' + cambios + ' filas cambiarían. Nada se escribió. ===');
  } finally {
    lock.releaseLock();
  }
}

// ============ 2-bis. NORMALIZAR LLAVES AL FORMATO CON BANCO ============
//
// Para cuando la columna Banco YA está corregida a mano en la hoja. Como el
// banco correcto ya vive en la fila, la llave se puede reconstruir sin que
// nadie tenga que identificar nada: es puramente mecánico.
//
// Por qué hace falta: las llaves viejas son `estado_cuenta|fecha|monto|moneda|n`
// y las nuevas `estado_cuenta|BANCO|fecha|monto|moneda|n`. Si no se igualan,
// volver a subir ese mismo estado de cuenta no reconoce las filas y las
// inserta de nuevo, duplicadas.

/** Muestra qué llaves reescribiría. No escribe. */
function simularNormalizarLlaves() {
  normalizarLlaves_(false);
}

/** Reescribe las llaves al formato con banco. */
function aplicarNormalizarLlaves() {
  normalizarLlaves_(true);
}

function normalizarLlaves_(escribir) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Otra corrida en curso. Salgo.'); return; }

  try {
    const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_MOVIMIENTOS);
    const n = hoja.getLastRow();
    if (n < 2) { Logger.log('La hoja está vacía.'); return; }

    const filas = hoja.getRange(2, 1, n - 1, 14).getValues();
    const pendientes = [];

    filas.forEach(function (f, i) {
      if (String(f[11]) !== 'estado_cuenta') return;

      const partes = String(f[0]).split('|');
      // Formato viejo: la posición 1 es la fecha. En el nuevo es el banco.
      if (partes[0] !== 'estado_cuenta' || !/^\d{4}-\d{2}-\d{2}$/.test(partes[1] || '')) return;

      const banco = String(f[8]).trim();
      if (!banco) {
        Logger.log('Fila ' + (i + 2) + ' no tiene Banco. La salto: sin banco no hay llave.');
        return;
      }

      pendientes.push({
        fila: i + 2,
        vieja: String(f[0]),
        nueva: 'estado_cuenta|' + banco + '|' + partes.slice(1).join('|')
      });
    });

    pendientes.forEach(function (p) {
      Logger.log('Fila ' + p.fila + ': "' + p.vieja + '" → "' + p.nueva + '"');
    });

    // Detecta colisiones antes de escribir: dos filas que terminen con la misma
    // llave romperían la idempotencia en vez de arreglarla.
    const vistas = {}, choques = [];
    pendientes.forEach(function (p) {
      if (vistas[p.nueva]) choques.push(p.nueva);
      vistas[p.nueva] = true;
    });
    if (choques.length > 0) {
      Logger.log('ABORTO: estas llaves nuevas quedarían repetidas: ' + choques.join(', '));
      Logger.log('Revísalas a mano antes de continuar. No se escribió nada.');
      return;
    }

    if (escribir) pendientes.forEach(function (p) { hoja.getRange(p.fila, 1).setValue(p.nueva); });

    Logger.log(escribir
      ? '=== APLICADO: ' + pendientes.length + ' llaves normalizadas. ==='
      : '=== SIMULACRO: ' + pendientes.length + ' llaves cambiarían. Nada se escribió. ===');
  } finally {
    lock.releaseLock();
  }
}

// ===================== 3. LIMPIAR FALSOS "CONCILIADO" =====================
//
// No hay forma de saber qué movimientos del BCP fueron marcados por el cruce
// equivocado y cuáles por uno legítimo. La salida limpia es desmarcarlos todos
// en el período afectado y volver a subir el estado de cuenta del BCP: el cruce
// ya corregido vuelve a marcar los que de verdad corresponden.
//
// Es seguro porque `Conciliado` es información derivada, no el dato original:
// se puede reconstruir subiendo otra vez el PDF.

/** Muestra qué desmarcaría. No escribe. */
function simularResetConciliado() {
  resetConciliado_(false);
}

/** Desmarca. Después vuelve a subir el estado de cuenta del BCP del período. */
function aplicarResetConciliado() {
  resetConciliado_(true);
}

function resetConciliado_(escribir) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Otra corrida en curso. Salgo.'); return; }

  try {
    const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_MOVIMIENTOS);
    const n = hoja.getLastRow();
    if (n < 2) { Logger.log('La hoja está vacía.'); return; }

    const desde = fechaDeIso_(RESET_DESDE_);
    const hasta = fechaDeIso_(RESET_HASTA_);
    if (!desde || !hasta) throw new Error('RESET_DESDE_ / RESET_HASTA_ deben ser yyyy-MM-dd.');
    hasta.setHours(23, 59, 59);

    const filas = hoja.getRange(2, 1, n - 1, 14).getValues();
    const tz = Session.getScriptTimeZone();
    const objetivo = [];

    filas.forEach(function (f, i) {
      if (f[12] !== true) return;                       // M = Conciliado
      if (String(f[8]) !== 'BCP') return;               // I = Banco
      if (String(f[11]) === 'estado_cuenta') return;    // esas nacen conciliadas
      const fecha = f[1];
      if (!(fecha instanceof Date) || fecha < desde || fecha > hasta) return;
      objetivo.push({ fila: i + 2, f: f, fecha: fecha });
    });

    objetivo.forEach(function (o) {
      Logger.log('Fila ' + o.fila + ' · ' + Utilities.formatDate(o.fecha, tz, 'yyyy-MM-dd') +
        ' · ' + (String(o.f[4]) === 'PEN' ? 'S/' : 'US$') + ' ' + Number(o.f[3]).toFixed(2) +
        ' · ' + String(o.f[5]).slice(0, 40) + '  → Conciliado FALSE');
    });

    if (escribir && objetivo.length > 0) {
      // Una sola escritura por bloque contiguo sería mejor, pero estas filas no
      // son contiguas. Aun así son pocas y esto corre una vez.
      objetivo.forEach(function (o) { hoja.getRange(o.fila, 13).setValue(false); });
    }

    Logger.log(escribir
      ? '=== APLICADO: ' + objetivo.length + ' filas desmarcadas. Vuelve a subir el ' +
        'estado de cuenta del BCP de ese período para reconciliarlas bien. ==='
      : '=== SIMULACRO: ' + objetivo.length + ' filas se desmarcarían. Nada se escribió. ===');
  } finally {
    lock.releaseLock();
  }
}

function fechaDeIso_(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

// ============ 4. RECLASIFICAR LOS "INGRESOS" DEL BBVA COMO TRASPASO ============
//
// El titular confirmó que TODO ingreso del estado de cuenta del BBVA fue una
// transferencia desde su propia cuenta BCP: el mismo dinero moviéndose entre
// cuentas propias, o pagos a su tarjeta. Por la regla 1 eso es un `traspaso`, no
// un `ingreso`. Contarlo como ingreso lo suma a los totales dos veces —una al
// salir del BCP, otra al entrar al BBVA—: el doble conteo que el sistema existe
// para evitar. Se cambian a `traspaso` y su categoría a 'Traspaso' (así
// categorizarPendientes() tampoco les gasta una llamada al LLM).
//
// No hace falta identificar filas a mano: el criterio es determinista
// —Fuente=estado_cuenta, Banco=BBVA, Tipo=ingreso—. Los `gasto` del BBVA (las
// compras reales) no se tocan.

/** Muestra qué reclasificaría. No escribe. */
function simularReclasificarIngresosBBVA() {
  reclasificarIngresosBBVA_(false);
}

/** Cambia esos ingresos del BBVA a traspaso. Corre el simulacro antes. */
function aplicarReclasificarIngresosBBVA() {
  reclasificarIngresosBBVA_(true);
}

function reclasificarIngresosBBVA_(escribir) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Otra corrida en curso. Salgo.'); return; }

  try {
    const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_MOVIMIENTOS);
    const n = hoja.getLastRow();
    if (n < 2) { Logger.log('La hoja está vacía.'); return; }

    const filas = hoja.getRange(2, 1, n - 1, 14).getValues();
    const tz = Session.getScriptTimeZone();
    const objetivo = [];

    filas.forEach(function (f, i) {
      if (String(f[11]) !== 'estado_cuenta') return;  // L = Fuente
      if (String(f[8]) !== 'BBVA') return;            // I = Banco
      if (String(f[2]) !== 'ingreso') return;         // C = Tipo
      objetivo.push({ fila: i + 2, f: f });
    });

    let sumaPEN = 0, sumaUSD = 0;
    objetivo.forEach(function (o) {
      const fecha = (o.f[1] instanceof Date) ? Utilities.formatDate(o.f[1], tz, 'yyyy-MM-dd') : '????-??-??';
      const esPEN = String(o.f[4]) === 'PEN';
      if (esPEN) sumaPEN += Number(o.f[3]); else sumaUSD += Number(o.f[3]);
      Logger.log('Fila ' + pad_(o.fila, 4) + ' · ' + fecha + ' · ' +
        pad_((esPEN ? 'S/' : 'US$') + ' ' + Number(o.f[3]).toFixed(2), 12) + ' · ' +
        String(o.f[5]).slice(0, 40) + '  ingreso → traspaso');
    });

    if (escribir) {
      objetivo.forEach(function (o) {
        hoja.getRange(o.fila, 3).setValue('traspaso');   // C = Tipo
        hoja.getRange(o.fila, 7).setValue('Traspaso');   // G = Categoría
      });
    }

    Logger.log('');
    Logger.log('Dejarían de contar como ingreso: S/ ' + sumaPEN.toFixed(2) +
      ' y US$ ' + sumaUSD.toFixed(2));
    Logger.log(escribir
      ? '=== APLICADO: ' + objetivo.length + ' filas reclasificadas a traspaso. ==='
      : '=== SIMULACRO: ' + objetivo.length + ' filas se reclasificarían. Nada se escribió. ===');
  } finally {
    lock.releaseLock();
  }
}
