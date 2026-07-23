/**
 * REGISTRO MANUAL — alta de un movimiento desde el formulario web (registro.html).
 *
 * Para gastos (o ingresos/traspasos) que no llegan por correo ni por estado de
 * cuenta: el usuario los teclea. Se re-valida en el servidor con las mismas
 * utilidades que el resto (`validarMovimiento_`, `escribirMovimiento_`) y se
 * escribe con `fuente = 'manual'` y una llave idempotente propia.
 *
 * Toma `LockService` como toda función que escribe (regla 8).
 */
function registrarMovimientoManual(d) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('El registro está ocupado; intenta de nuevo en un momento.');

  try {
    d = d || {};

    const tipo = String(d.tipo || 'gasto').trim();
    if (['gasto', 'ingreso', 'traspaso'].indexOf(tipo) < 0) throw new Error('Tipo inválido.');

    const moneda = String(d.moneda || 'PEN').trim().toUpperCase();
    if (moneda !== 'PEN' && moneda !== 'USD') throw new Error('Moneda inválida.');

    const monto = Number(d.monto);
    if (!(isFinite(monto) && monto > 0)) throw new Error('El monto debe ser un número mayor que cero.');

    const comercio = String(d.comercio || '').trim();
    if (!comercio) throw new Error('Falta la descripción o comercio.');

    // Fecha yyyy-MM-dd del formulario; si no viene, hoy. Mediodía para evitar
    // saltos de día por zona horaria.
    const mf = String(d.fecha || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const fecha = mf ? new Date(+mf[1], +mf[2] - 1, +mf[3], 12, 0) : new Date();

    const metodo = String(d.metodo || 'otro').trim() || 'otro';
    const banco = String(d.banco || '').trim();
    let categoria = String(d.categoria || '').trim();

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const hoja = ss.getSheetByName(HOJA_MOVIMIENTOS);

    // Categoría: traspaso siempre 'Traspaso'; si no se eligió y es gasto, se
    // intenta con el mapeo cacheado; si nada, 'Otros'.
    if (tipo === 'traspaso') categoria = 'Traspaso';
    else if (!categoria) categoria = (tipo === 'gasto')
      ? categorizar_(comercio, cargarMapeoCategorias_(ss))
      : 'Otros';

    const sello = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
    const mov = {
      idMensaje: 'manual|' + sello + '|' + Math.floor(Math.random() * 1e6),
      fecha: fecha, tipo: tipo, monto: monto, moneda: moneda,
      comercio: comercio, categoria: categoria,
      metodo: metodo, banco: banco, ultimos4: '', numOperacion: '',
      fuente: 'manual', referencia: ''
    };

    validarMovimiento_(mov);
    escribirMovimiento_(hoja, mov);

    return {
      ok: true,
      mensaje: 'Registrado: ' + comercio + ' · ' + (moneda === 'PEN' ? 'S/' : 'US$') + ' ' + monto.toFixed(2),
      tipo: tipo
    };
  } finally {
    lock.releaseLock();
  }
}
