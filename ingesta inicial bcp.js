/**
 * SISTEMA DE REGISTRO FINANCIERO PERSONAL
 * Fase 0 (cimientos) + Fase 1 (slice vertical BCP)
 *
 * Uso:
 *   1. Ejecutar setupInicial() UNA vez (crea hojas, encabezados y etiquetas de Gmail).
 *   2. Ejecutar ingestarBCP() manualmente para verificar contra correos reales.
 *   3. Recién cuando la verificación sea exacta, instalar el trigger horario
 *      con instalarTriggerHorario().
 */

// ========================= CONFIGURACIÓN =========================

const HOJA_MOVIMIENTOS = 'Movimientos';
const HOJA_RECURRENTES = 'Recurrentes';
const HOJA_MAPEO = 'Mapeo de Categorías';

const LABEL_PROCESADO = 'procesado';
const LABEL_ERROR = 'error_parseo';

// Excluimos también error_parseo para que un correo fallido no se reintente
// en cada corrida horaria: queda marcado, visible, y se corrige el parser a mano.
const BUSQUEDA_BCP =
  'from:notificacionesbcp.com.pe subject:consumo -label:' +
  LABEL_PROCESADO + ' -label:' + LABEL_ERROR;

const ENCABEZADOS_MOVIMIENTOS = [
  'ID Mensaje', 'Fecha', 'Tipo', 'Monto', 'Moneda', 'Comercio', 'Categoría',
  'Método de Pago', 'Banco', 'Últimos 4', 'N° Operación', 'Fuente',
  'Conciliado', 'Referencia'
];

const ENCABEZADOS_RECURRENTES = [
  'ID', 'Descripción', 'Monto', 'Moneda', 'Frecuencia', 'Día', 'Categoría', 'Activo'
];

const ENCABEZADOS_MAPEO = ['Patrón Comercio', 'Categoría', 'Origen'];

// ========================= FASE 0: SETUP =========================

function setupInicial() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  crearHojaSiNoExiste_(ss, HOJA_MOVIMIENTOS, ENCABEZADOS_MOVIMIENTOS);
  crearHojaSiNoExiste_(ss, HOJA_RECURRENTES, ENCABEZADOS_RECURRENTES);
  crearHojaSiNoExiste_(ss, HOJA_MAPEO, ENCABEZADOS_MAPEO);

  // Columnas que deben ser texto para no perder ceros a la izquierda:
  // A = ID Mensaje, J = Últimos 4, K = N° Operación
  const mov = ss.getSheetByName(HOJA_MOVIMIENTOS);
  mov.getRange('A:A').setNumberFormat('@');
  mov.getRange('J:K').setNumberFormat('@');
  mov.getRange('B:B').setNumberFormat('yyyy-mm-dd hh:mm');
  mov.setFrozenRows(1);

  // Etiquetas de Gmail
  obtenerOCrearLabel_(LABEL_PROCESADO);
  obtenerOCrearLabel_(LABEL_ERROR);

  Logger.log('Setup completo: 3 hojas + 2 etiquetas de Gmail listas.');
}

function crearHojaSiNoExiste_(ss, nombre, encabezados) {
  let hoja = ss.getSheetByName(nombre);
  if (!hoja) hoja = ss.insertSheet(nombre);
  const primeraFila = hoja.getRange(1, 1, 1, encabezados.length).getValues()[0];
  if (primeraFila.join('') === '') {
    hoja.getRange(1, 1, 1, encabezados.length)
        .setValues([encabezados])
        .setFontWeight('bold');
  }
}

function obtenerOCrearLabel_(nombre) {
  return GmailApp.getUserLabelByName(nombre) || GmailApp.createLabel(nombre);
}

// ========================= FASE 1: INGESTA BCP =========================

function ingestarBCP() {
  // Lock: evita corridas superpuestas cuando ya haya trigger horario.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('Otra corrida en curso. Salgo.');
    return;
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const hoja = ss.getSheetByName(HOJA_MOVIMIENTOS);
    const labelOk = obtenerOCrearLabel_(LABEL_PROCESADO);
    const labelErr = obtenerOCrearLabel_(LABEL_ERROR);

    const idsExistentes = cargarIdsExistentes_(hoja);
    const mapeo = cargarMapeoCategorias_(ss);

    const hilos = GmailApp.search(BUSQUEDA_BCP, 0, 50);
    let ok = 0, dup = 0, err = 0;

    hilos.forEach(function (hilo) {
      let hiloConError = false;

      hilo.getMessages().forEach(function (msg) {
        const id = msg.getId();
        if (idsExistentes.has(id)) { dup++; return; }

        try {
          const texto = limpiarHtml_(msg.getBody());
          const mov = parseBCP_(texto, id);
          validarMovimiento_(mov); // lanza error si algo no cuadra

          mov.categoria = categorizar_(mov.comercio, mapeo);
          mov.referencia = 'https://mail.google.com/mail/u/0/#all/' + id;

          escribirMovimiento_(hoja, mov);
          idsExistentes.add(id);
          ok++;
        } catch (e) {
          hiloConError = true;
          err++;
          Logger.log('error_parseo en ' + id + ': ' + e.message);
        }
      });

      // Doble candado: etiqueta al hilo según resultado. Cero pérdidas silenciosas.
      if (hiloConError) hilo.addLabel(labelErr);
      else hilo.addLabel(labelOk);
    });

    Logger.log('Corrida BCP → insertados: ' + ok + ' · duplicados: ' + dup + ' · errores: ' + err);
  } finally {
    lock.releaseLock();
  }
}

function cargarIdsExistentes_(hoja) {
  const n = hoja.getLastRow();
  const set = new Set();
  if (n < 2) return set;
  hoja.getRange(2, 1, n - 1, 1).getValues().forEach(function (fila) {
    if (fila[0]) set.add(String(fila[0]));
  });
  return set;
}

// ========================= PARSER BCP (verificado) =========================

function limpiarHtml_(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

const MESES_ = { enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6, julio:7,
  agosto:8, septiembre:9, setiembre:9, octubre:10, noviembre:11, diciembre:12 };

function parseBCP_(text, messageId) {
  const mMonto = text.match(/Total del consumo\s*(S\/|US\$|\$)\s*([\d,]+\.\d{2})/);
  if (!mMonto) throw new Error('No se encontró "Total del consumo"');
  const moneda = (mMonto[1] === 'S/') ? 'PEN' : 'USD';
  const monto = parseFloat(mMonto[2].replace(/,/g, ''));

  const mF = text.match(/Fecha y hora\s*(\d{1,2}) de (\w+) de (\d{4})\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)/);
  if (!mF) throw new Error('No se encontró "Fecha y hora"');
  const mes = MESES_[mF[2].toLowerCase()];
  if (!mes) throw new Error('Mes no reconocido: ' + mF[2]);
  let hh = parseInt(mF[4], 10);
  if (mF[6] === 'PM' && hh !== 12) hh += 12;
  if (mF[6] === 'AM' && hh === 12) hh = 0;
  const fecha = new Date(+mF[3], mes - 1, +mF[1], hh, +mF[5]);

  const mCom = text.match(/Empresa\s*(.+?)\s*N[úu]mero de operaci[óo]n/);
  if (!mCom) throw new Error('No se encontró "Empresa"');
  const comercio = mCom[1].trim();

  // Débito verificado; crédito PROVISIONAL hasta traer un correo real de crédito.
  const mTarjeta = text.match(/Tarjeta de (D[ée]bito|Cr[ée]dito)\s*\**(\d{4})/);
  const metodo = (mTarjeta && /Cr/i.test(mTarjeta[1])) ? 'tarjeta_credito' : 'tarjeta_debito';

  const mOp = text.match(/N[úu]mero de operaci[óo]n\s*(\d+)/);

  return {
    idMensaje: messageId, fecha: fecha, tipo: 'gasto', monto: monto, moneda: moneda,
    comercio: comercio, metodo: metodo, banco: 'BCP',
    ultimos4: mTarjeta ? mTarjeta[2] : '',
    numOperacion: mOp ? mOp[1] : '',
    fuente: 'correo'
  };
}

// ========================= VALIDACIÓN Y ESCRITURA =========================

function validarMovimiento_(mov) {
  if (!(typeof mov.monto === 'number' && isFinite(mov.monto) && mov.monto > 0))
    throw new Error('Monto inválido: ' + mov.monto);
  if (mov.moneda !== 'PEN' && mov.moneda !== 'USD')
    throw new Error('Moneda inválida: ' + mov.moneda);
  if (!(mov.fecha instanceof Date) || isNaN(mov.fecha.getTime()))
    throw new Error('Fecha inválida');
  if (!mov.comercio) throw new Error('Comercio vacío');
}

function cargarMapeoCategorias_(ss) {
  const hoja = ss.getSheetByName(HOJA_MAPEO);
  if (!hoja || hoja.getLastRow() < 2) return [];
  return hoja.getRange(2, 1, hoja.getLastRow() - 1, 2).getValues()
    .filter(function (f) { return f[0] && f[1]; })
    .map(function (f) { return { patron: String(f[0]).toLowerCase(), categoria: String(f[1]) }; });
}

function categorizar_(comercio, mapeo) {
  const c = comercio.toLowerCase();
  for (let i = 0; i < mapeo.length; i++) {
    if (c.indexOf(mapeo[i].patron) !== -1) return mapeo[i].categoria;
  }
  return 'sin_categoria';
}

function escribirMovimiento_(hoja, mov) {
  hoja.appendRow([
    mov.idMensaje, mov.fecha, mov.tipo, mov.monto, mov.moneda, mov.comercio,
    mov.categoria, mov.metodo, mov.banco, mov.ultimos4, mov.numOperacion,
    mov.fuente, false, mov.referencia
  ]);
}

// ========================= TRIGGER (instalar DESPUÉS de verificar) =========================

function instalarTriggerHorario() {
  // Evitar duplicados de trigger
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ingestarBCP') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ingestarBCP').timeBased().everyHours(1).create();
  Logger.log('Trigger horario instalado para ingestarBCP.');
}