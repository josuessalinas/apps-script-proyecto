/**
 * DUPLICADOS DE TRANSACCIÓN — misma compra, dos notificaciones.
 *
 * La deduplicación normal es por `ID Mensaje` (un correo = una fila). Pero a
 * veces el banco manda DOS correos por la MISMA compra: una autorización y una
 * captura, o dos procesadores (Uber → "DLC*UBER RIDES" y "PYU*UBER"). Son
 * mensajes distintos —distinto ID y número de operación— así que la llave no los
 * caza, y entran dos filas por el mismo gasto.
 *
 * Esta herramienta los detecta por su HUELLA ECONÓMICA: misma moneda, monto,
 * tipo, banco y método, dentro de una ventana corta de tiempo. Como dos compras
 * legítimas iguales también encajarían, NUNCA borra a ciegas: siempre corre
 * `detectarDuplicados()` / `simularEliminarDuplicados()` y revisa antes de
 * `aplicarEliminarDuplicados()`.
 *
 * Al quitar una fila la registra en `Correos Ignorados` (motivo
 * 'duplicado_transaccion') para que un backfill no la vuelva a insertar y para
 * no perder el rastro (regla 5). Toma `LockService` (regla 8).
 */

/** Ventana en minutos: dos movimientos con la misma huella dentro de este lapso
 *  se consideran la misma transacción. Ajústalo si hace falta. */
const VENTANA_DUP_MIN_ = 120;

/** Solo diagnóstico: lista los grupos con duplicados. No marca ni escribe. */
function detectarDuplicados() { analizarDuplicados_(false); }

/** Muestra exactamente qué filas se quitarían. No escribe. */
function simularEliminarDuplicados() { analizarDuplicados_(true, false); }

/** Quita los duplicados y los registra en Correos Ignorados. Corre el simulacro antes. */
function aplicarEliminarDuplicados() { analizarDuplicados_(true, true); }

function analizarDuplicados_(marcar, escribir) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Otra corrida en curso. Salgo.'); return; }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const hoja = ss.getSheetByName(HOJA_MOVIMIENTOS);
    const n = hoja.getLastRow();
    if (n < 2) { Logger.log('La hoja está vacía.'); return; }

    const filas = hoja.getRange(2, 1, n - 1, 14).getValues();
    const tz = Session.getScriptTimeZone();

    // Agrupar por huella: moneda | monto | tipo | banco | método.
    const grupos = {};
    filas.forEach(function (f, i) {
      const fecha = f[1];
      if (!(fecha instanceof Date)) return;
      const key = [f[4], Number(f[3]).toFixed(2), f[2], f[8], f[7]].join('|');
      (grupos[key] = grupos[key] || []).push({
        fila: i + 2, id: String(f[0]), fecha: fecha,
        comercio: String(f[5]), op: String(f[10])
      });
    });

    const aEliminar = [];
    let gruposDup = 0;

    Object.keys(grupos).forEach(function (key) {
      const arr = grupos[key];
      if (arr.length < 2) return;
      arr.sort(function (a, b) { return a.fecha - b.fecha; });

      // El primero de cada racha cercana se queda; los que caen dentro de la
      // ventana de un "keeper" anterior se marcan como duplicados.
      const keepers = [];
      arr.forEach(function (item) {
        const cerca = keepers.some(function (k) {
          return Math.abs(item.fecha - k.fecha) <= VENTANA_DUP_MIN_ * 60000;
        });
        if (cerca) { item.dup = true; aEliminar.push(item); }
        else keepers.push(item);
      });

      if (arr.some(function (x) { return x.dup; })) {
        gruposDup++;
        const p = key.split('|');
        Logger.log('· ' + (p[0] === 'PEN' ? 'S/' : 'US$') + ' ' + p[1] + ' · ' + p[2] + ' · ' + p[3] + ' · ' + p[4]);
        arr.forEach(function (x) {
          Logger.log('    ' + Utilities.formatDate(x.fecha, tz, 'yyyy-MM-dd HH:mm') + ' · ' +
            x.comercio.slice(0, 26) + ' · op ' + x.op + ' · ' + x.id +
            (x.dup ? '   ⟵ DUPLICADO (se quita)' : '   (se queda)'));
        });
      }
    });

    Logger.log('');
    Logger.log('Grupos con duplicados: ' + gruposDup + ' · filas a quitar: ' + aEliminar.length +
      ' (ventana ' + VENTANA_DUP_MIN_ + ' min)');

    if (!marcar) { Logger.log('=== Solo diagnóstico. Para actuar: simularEliminarDuplicados(). ==='); return; }

    if (escribir && aEliminar.length) {
      const hojaIgn = hojaIgnorados_(ss);
      aEliminar.forEach(function (x) {
        hojaIgn.appendRow([x.id, x.fecha, x.comercio, 'duplicado_transaccion',
          'quitado de Movimientos: misma transacción notificada dos veces']);
      });
      // Borrar de abajo hacia arriba para no desplazar los índices pendientes.
      aEliminar.map(function (x) { return x.fila; })
        .sort(function (a, b) { return b - a; })
        .forEach(function (fila) { hoja.deleteRow(fila); });
      Logger.log('=== APLICADO: ' + aEliminar.length + ' duplicados quitados y registrados en Correos Ignorados. ===');
    } else {
      Logger.log('=== SIMULACRO: ' + aEliminar.length + ' se quitarían. Nada se escribió. ===');
    }
  } finally {
    lock.releaseLock();
  }
}
