/**
 * Fase 8 — Análisis: entrega el libro mayor en forma ligera para el tablero de gráficos.
 * Solo lee. Idempotente. Sin constantes globales nuevas (evita choques con el resto del proyecto).
 */
function obtenerDatosAnalisis() {
  var hoja = SpreadsheetApp.getActive().getSheetByName('Movimientos');
  if (!hoja) return { movimientos: [], generado: new Date().toISOString() };
  var ultFila = hoja.getLastRow();
  if (ultFila < 2) return { movimientos: [], generado: new Date().toISOString() };

  var valores = hoja.getRange(2, 1, ultFila - 1, 14).getValues();
  var tz = Session.getScriptTimeZone() || 'America/Lima';
  var out = [];
  for (var i = 0; i < valores.length; i++) {
    var r = valores[i];
    if (!r[1]) continue;                                  // sin fecha -> saltar
    var fecha = (Object.prototype.toString.call(r[1]) === '[object Date]')
      ? Utilities.formatDate(r[1], tz, 'yyyy-MM-dd')
      : String(r[1]).slice(0, 10);
    var monto = Number(r[3]);
    if (!isFinite(monto) || monto <= 0) continue;
    var tipo = String(r[2] || '').toLowerCase();
    if (tipo !== 'gasto' && tipo !== 'ingreso') continue;

    out.push({
      f: fecha,
      t: tipo,
      m: monto,
      cur: String(r[4] || 'PEN').toUpperCase(),           // Moneda
      cat: (String(r[6] || '').trim() || 'Otros'),        // Categoría
      com: String(r[5] || '').trim(),                     // Comercio
      met: String(r[7] || '').trim(),                     // Método de Pago
      fuente: String(r[11] || '').trim(),                 // Fuente
      conc: (r[12] === true || String(r[12]).toUpperCase() === 'TRUE')
    });
  }
  return { movimientos: out, generado: new Date().toISOString() };
}