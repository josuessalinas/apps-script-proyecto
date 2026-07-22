/**
 * FASE 6 — Conciliación mensual con estado de cuenta (v2.1: PDFs con clave)
 *
 * Los estados de cuenta vienen protegidos con clave, y Apps Script no puede
 * descifrar PDFs. Solución: la extracción de texto ocurre EN EL NAVEGADOR.
 *
 *   Flujo:
 *   1. Abres la web app en ?pagina=conciliar (link "Conciliar" en el tablero).
 *   2. Subes el PDF y escribes su clave. pdf.js (en tu navegador) lo abre
 *      localmente y extrae el texto. LA CLAVE NUNCA SE ENVÍA AL SERVIDOR:
 *      solo viaja el texto plano ya extraído, por google.script.run,
 *      dentro de tu propia sesión de Google.
 *   3. El servidor corre el pipeline de siempre:
 *      texto → DeepSeek (1 llamada) → validación determinista → cruce.
 *
 *   Cruce por MONEDA + MONTO exacto + FECHA ±3 días (candidato más cercano):
 *      - coincide          → Conciliado = TRUE
 *      - falta en registro → se inserta (Fuente=estado_cuenta, conciliada,
 *                            sin_categoria → la Fase 5 la resuelve)
 *      - sobra en registro → queda FALSE y se reporta en pantalla y en el log
 *
 * Idempotencia: re-enviar el mismo estado no duplica nada (llave determinista
 * estado_cuenta|fecha|monto|moneda|n contra `ID Mensaje`).
 *
 * Instalación:
 *   1. Pegar este archivo (reemplaza la versión anterior de Fase 6; el servicio
 *      avanzado de Drive ya no es necesario).
 *   2. Crear el archivo HTML "conciliar" con conciliar.html.
 *   3. Reemplazar doGet en el backend del tablero (versión con routing) y
 *      actualizar tablero.html (link "Conciliar").
 *   4. Implementar → Administrar implementaciones → Nueva versión.
 */

const TOLERANCIA_DIAS_ = 3;      // desfase permitido correo vs. estado
const MAX_CHARS_ESTADO_ = 150000;

/**
 * Bancos que sabemos reconocer en un estado de cuenta.
 *
 * Esto existe porque antes había un `BANCO_ESTADO_ = 'BCP'` fijo: subir un
 * estado del BBVA lo cruzaba contra los movimientos del BCP y, peor, insertaba
 * las transacciones del BBVA rotuladas como BCP. Dato corrupto en el registro.
 *
 * La detección es DETERMINISTA a propósito: el nombre del banco aparece impreso
 * decenas de veces en su propio estado de cuenta, así que contar apariciones es
 * más confiable que preguntarle al LLM. Si no hay un ganador claro, el sistema
 * NO adivina: obliga a elegir el banco a mano en la interfaz.
 */
const BANCOS_CONOCIDOS_ = [
  { codigo: 'BCP',        patron: /banco de cr[ée]dito del per[úu]|\bBCP\b|viabcp/gi },
  { codigo: 'BBVA',       patron: /\bBBVA\b|banco continental/gi },
  { codigo: 'Interbank',  patron: /\binterbank\b/gi },
  { codigo: 'Scotiabank', patron: /\bscotiabank\b/gi },
  { codigo: 'Diners',     patron: /\bdiners club\b/gi }
];

/**
 * Devuelve el código del banco, o null si no hay un ganador claro.
 * Se cuenta cuántas veces aparece cada banco porque un estado del BCP puede
 * mencionar "BBVA" al describir una transferencia; lo que manda es la marca que
 * domina el documento, no una mención suelta. Se exige además que el ganador
 * duplique al segundo, para no decidir por un margen de una o dos apariciones.
 */
function detectarBanco_(texto) {
  const conteos = BANCOS_CONOCIDOS_.map(function (b) {
    return { codigo: b.codigo, n: (String(texto).match(b.patron) || []).length };
  }).sort(function (a, b) { return b.n - a.n; });

  if (conteos[0].n === 0) return null;
  if (conteos[1] && conteos[1].n > 0 && conteos[0].n < conteos[1].n * 2) return null;
  return conteos[0].codigo;
}

/**
 * Punto de entrada desde la página Conciliar (google.script.run).
 * Recibe texto plano ya extraído en el navegador. Devuelve un resumen
 * serializable para pintar en pantalla.
 */
function conciliarTextoEstado(texto, etiqueta, bancoElegido) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Otra corrida en curso. Intenta en un minuto.');

  try {
    texto = String(texto || '');
    if (texto.length < 100) throw new Error('El texto extraído es demasiado corto. ¿PDF vacío o escaneado como imagen?');
    if (texto.length > MAX_CHARS_ESTADO_) texto = texto.slice(0, MAX_CHARS_ESTADO_);

    // El banco se decide ANTES de tocar la hoja: de él dependen contra qué
    // movimientos se cruza y con qué rótulo se inserta lo que falta.
    let banco = String(bancoElegido || '').trim();
    let detectado = false;
    if (!banco || banco === 'auto') {
      banco = detectarBanco_(texto);
      detectado = true;
      if (!banco) throw new Error(
        'No pude identificar el banco de este estado de cuenta. ' +
        'Elígelo a mano en la lista y vuelve a intentar.');
    }

    const items = llamarDeepSeekEstado_(texto);
    if (items.length === 0) throw new Error('El LLM no devolvió transacciones válidas. Revisar el PDF.');

    const resumen = cruzarItems_(items, banco);
    resumen.etiqueta = String(etiqueta || 'estado de cuenta');
    resumen.banco = banco;
    resumen.bancoDetectado = detectado;
    Logger.log('Conciliación "' + resumen.etiqueta + '" · banco: ' + banco +
      (detectado ? ' (detectado)' : ' (elegido a mano)') +
      ' → estado: ' + resumen.transacciones +
      ' · coinciden: ' + resumen.coinciden + ' (' + resumen.pct + '%) · insertadas: ' +
      resumen.insertadas + ' · sin respaldo: ' + resumen.sobrantes.length);
    return resumen;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Cruce contra Movimientos, acotado al banco del estado. Devuelve resumen con
 * solo tipos serializables.
 */
function cruzarItems_(items, banco) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(HOJA_MOVIMIENTOS);
  const ids = cargarIdsExistentes_(hoja);
  const tz = Session.getScriptTimeZone();

  // Ventana temporal: fechas del estado ± tolerancia
  const tiempos = items.map(function (i) { return i.fecha.getTime(); });
  const ini = new Date(Math.min.apply(null, tiempos) - TOLERANCIA_DIAS_ * 86400000);
  const fin = new Date(Math.max.apply(null, tiempos) + TOLERANCIA_DIAS_ * 86400000);

  const n = hoja.getLastRow();
  const filas = n < 2 ? [] : hoja.getRange(2, 1, n - 1, 14).getValues();
  const candidatos = [];
  filas.forEach(function (f, i) {
    const fecha = f[1];
    if (!(fecha instanceof Date) || fecha < ini || fecha > fin) return;
    if (String(f[8]) !== banco) return; // col I = Banco
    candidatos.push({
      fila: i + 2, fecha: fecha, monto: Number(f[3]), moneda: String(f[4]),
      comercio: String(f[5]), conciliado: f[12] === true, usado: false
    });
  });

  let coinciden = 0, insertadas = 0;
  const contadorLlave = {};

  items.forEach(function (item) {
    let mejor = null;
    candidatos.forEach(function (c) {
      if (c.usado || c.moneda !== item.moneda) return;
      if (Math.abs(c.monto - item.monto) >= 0.01) return;
      const dias = Math.abs(c.fecha - item.fecha) / 86400000;
      if (dias > TOLERANCIA_DIAS_) return;
      if (!mejor || dias < mejor.dias) mejor = { c: c, dias: dias };
    });

    if (mejor) {
      mejor.c.usado = true;
      if (!mejor.c.conciliado) hoja.getRange(mejor.c.fila, 13).setValue(true); // col M
      coinciden++;
      return;
    }

    // La llave lleva el banco: sin él, un cargo del BBVA por el mismo monto y
    // fecha que uno del BCP se descartaría como duplicado del otro.
    const cola = Utilities.formatDate(item.fecha, tz, 'yyyy-MM-dd') +
      '|' + item.monto.toFixed(2) + '|' + item.moneda;
    const base = 'estado_cuenta|' + banco + '|' + cola;
    contadorLlave[base] = (contadorLlave[base] || 0) + 1;
    const llave = base + '|' + contadorLlave[base];

    // Compatibilidad: las filas escritas antes de que la llave incluyera el
    // banco eran todas del BCP. Sin este chequeo, reconciliar un estado del BCP
    // ya procesado duplicaría cada fila.
    const llaveLegado = 'estado_cuenta|' + cola + '|' + contadorLlave[base];
    if (ids.has(llave)) return;                              // re-envío del mismo estado
    if (banco === 'BCP' && ids.has(llaveLegado)) return;     // re-envío en formato viejo

    hoja.appendRow([
      llave, item.fecha, item.tipo, item.monto, item.moneda, item.descripcion,
      'sin_categoria', 'cuenta', banco, '', '', 'estado_cuenta', true, ''
    ]);
    ids.add(llave);
    insertadas++;
  });

  const sobrantes = candidatos.filter(function (c) { return !c.usado; })
    .map(function (c) {
      return Utilities.formatDate(c.fecha, tz, 'yyyy-MM-dd') + ' · ' +
        (c.moneda === 'PEN' ? 'S/' : 'US$') + ' ' + c.monto.toFixed(2) + ' · ' + c.comercio;
    });

  return {
    transacciones: items.length,
    coinciden: coinciden,
    pct: Math.round(coinciden / items.length * 100),
    insertadas: insertadas,
    sobrantes: sobrantes
  };
}

/** 1 llamada a DeepSeek. Devuelve solo transacciones que pasan la validación. */
function llamarDeepSeekEstado_(texto) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('DEEPSEEK_API_KEY');
  if (!apiKey) throw new Error('Falta DEEPSEEK_API_KEY en Script Properties.');

  const payload = {
    model: 'deepseek-chat',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'Extraes transacciones de estados de cuenta bancarios peruanos. ' +
          'Responde SOLO JSON: {"transacciones":[{"fecha":"yyyy-mm-dd","descripcion":"...",' +
          '"monto":0.00,"moneda":"PEN"|"USD","tipo":"gasto"|"ingreso"}]}. ' +
          'monto siempre positivo. Cargos/consumos = gasto; abonos/pagos recibidos = ingreso. ' +
          'Ignora saldos, totales, intereses informativos y líneas que no sean transacciones.'
      },
      { role: 'user', content: texto }
    ]
  };

  const res = UrlFetchApp.fetch(DEEPSEEK_URL_, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200)
    throw new Error('DeepSeek HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));

  const crudo = String(JSON.parse(res.getContentText()).choices[0].message.content)
    .replace(/```json|```/g, '').trim();
  const lista = (JSON.parse(crudo).transacciones) || [];

  const validas = [];
  lista.forEach(function (t) {
    const monto = Number(t.monto);
    const moneda = String(t.moneda).toUpperCase();
    const fecha = parsearFechaIso_(String(t.fecha));
    const tipo = String(t.tipo) === 'ingreso' ? 'ingreso' : 'gasto';
    if (!(monto > 0) || (moneda !== 'PEN' && moneda !== 'USD') || !fecha) {
      Logger.log('Transacción inválida del LLM, descartada: ' + JSON.stringify(t));
      return;
    }
    validas.push({ fecha: fecha, monto: monto, moneda: moneda, tipo: tipo,
      descripcion: String(t.descripcion || '').trim() || 'estado de cuenta' });
  });
  return validas;
}

function parsearFechaIso_(s) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const f = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  return isNaN(f.getTime()) ? null : f;
  }