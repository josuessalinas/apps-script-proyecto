/**
 * FASE 4 — Ingresos recurrentes (v2: materialización MENSUAL por adelantado)
 *
 * Cambio de diseño pedido por el usuario: los ingresos son fijos, así que
 * NO hay corrida diaria. Un solo trigger MENSUAL (día 1) materializa el mes
 * completo por adelantado. Idempotente: correr a mano las veces que sea
 * no duplica nada.
 *
 * Frecuencias soportadas y su interpretación:
 *
 *   mensual   → 1 fila en el Día indicado (31 → se ajusta al último día del mes).
 *               Llave: recurrente|{ID}|{yyyy-MM-dd}
 *
 *   quincenal → 1 fila por cada día listado en Día (ej. "15,30").
 *               Llave: recurrente|{ID}|{yyyy-MM-dd}
 *
 *   diaria    → 1 fila CONSOLIDADA por mes, fechada el día 1:
 *               Monto mensual = Monto × N, donde N es el número en Día
 *               (ej. "30 dias" → 30). Si Día no trae número, N = días del mes.
 *               Llave: recurrente|{ID}|{yyyy-MM}
 *
 * Ejemplo con la tabla real del usuario:
 *   sueldo | 1200 | PEN | mensual | 1        → 1200 PEN el día 1
 *   padres |   20 | PEN | diaria  | 30 dias  → 600 PEN (20×30) el día 1
 *
 * El parser tolera espacios extra y texto junto al número ("mensual ", "30 dias").
 *
 * FECHA_INICIO evita rellenar meses previos al arranque del sistema.
 */

const FECHA_INICIO_RECURRENTES = new Date(2026, 6, 1); // 1 jul 2026

function materializarRecurrentes() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Otra corrida en curso. Salgo.'); return; }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const hojaMov = ss.getSheetByName(HOJA_MOVIMIENTOS);
    const hojaRec = ss.getSheetByName(HOJA_RECURRENTES);
    const ids = cargarIdsExistentes_(hojaMov);
    const hoy = new Date();
    const tz = Session.getScriptTimeZone();

    const n = hojaRec.getLastRow();
    const reglas = n < 2 ? [] : hojaRec.getRange(2, 1, n - 1, 8).getValues();
    let creados = 0, saltados = 0;

    // Mes actual completo + mes anterior (catch-up si el trigger del día 1 falló).
    [-1, 0].forEach(function (offset) {
      const primero = new Date(hoy.getFullYear(), hoy.getMonth() + offset, 1);
      if (primero < FECHA_INICIO_RECURRENTES) return;
      const diasDelMes = new Date(primero.getFullYear(), primero.getMonth() + 1, 0).getDate();

      reglas.forEach(function (r) {
        const regla = validarRegla_(r);
        if (!regla) { if (r.join('') !== '') Logger.log('Regla inválida, se ignora: ' + JSON.stringify(r)); return; }
        if (!regla.activo) return;

        ocurrenciasDelMes_(regla, primero, diasDelMes, tz).forEach(function (oc) {
          if (ids.has(oc.llave)) { saltados++; return; }
          escribirMovimiento_(hojaMov, {
            idMensaje: oc.llave, fecha: oc.fecha, tipo: 'ingreso',
            monto: oc.monto, moneda: regla.moneda,
            comercio: oc.descripcion, categoria: regla.categoria,
            metodo: 'cuenta', banco: '', ultimos4: '', numOperacion: '',
            fuente: 'recurrente', referencia: ''
          });
          ids.add(oc.llave);
          creados++;
        });
      });
    });

    Logger.log('Recurrentes → creados: ' + creados + ' · ya existentes: ' + saltados);
  } finally {
    lock.releaseLock();
  }
}

/** Ocurrencias de una regla dentro del mes que empieza en `primero`. */
function ocurrenciasDelMes_(regla, primero, diasDelMes, tz) {
  const anio = primero.getFullYear(), mes = primero.getMonth();
  const pref = 'recurrente|' + regla.id + '|';

  if (regla.frecuencia === 'diaria') {
    const nDias = regla.dias.length > 0 ? regla.dias[0] : diasDelMes;
    const fecha = new Date(anio, mes, 1, 9, 0, 0);
    return [{
      llave: pref + Utilities.formatDate(fecha, tz, 'yyyy-MM'),
      fecha: fecha,
      monto: regla.monto * nDias,
      descripcion: regla.descripcion + ' (' + regla.monto + ' × ' + nDias + ' días)'
    }];
  }

  const dias = regla.frecuencia === 'mensual' ? [regla.dias[0]] : regla.dias;
  return dias.map(function (dia) {
    const fecha = new Date(anio, mes, Math.min(dia, diasDelMes), 9, 0, 0);
    return {
      llave: pref + Utilities.formatDate(fecha, tz, 'yyyy-MM-dd'),
      fecha: fecha,
      monto: regla.monto,
      descripcion: regla.descripcion
    };
  });
}

function validarRegla_(r) {
  const id = String(r[0]).trim();
  const monto = Number(r[2]);
  const moneda = String(r[3]).trim().toUpperCase();
  const frecuencia = String(r[4]).trim().toLowerCase();
  const dias = String(r[5]).split(/[,;\s]+/).map(Number).filter(function (d) {
    return Number.isInteger(d) && d >= 1 && d <= 31;
  });

  if (!id || !(monto > 0)) return null;
  if (moneda !== 'PEN' && moneda !== 'USD') return null;
  if (frecuencia !== 'mensual' && frecuencia !== 'quincenal' && frecuencia !== 'diaria') return null;
  if (frecuencia !== 'diaria' && dias.length === 0) return null; // diaria puede omitir Día

  return {
    id: id,
    descripcion: String(r[1]).trim() || id,
    monto: monto,
    moneda: moneda,
    frecuencia: frecuencia,
    dias: dias,
    categoria: String(r[6]).trim() || 'sin_categoria',
    activo: r[7] === true || String(r[7]).trim().toUpperCase() === 'TRUE'
  };
}

function instalarTriggerRecurrentes() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'materializarRecurrentes') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('materializarRecurrentes')
    .timeBased().onMonthDay(1).atHour(6).create();
  Logger.log('Trigger MENSUAL (día 1, ≈6 am) instalado para materializarRecurrentes.');
}