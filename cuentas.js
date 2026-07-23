/**
 * CUENTAS Y SALDOS — cuánto hay en cada bolsillo
 *
 * El resto del sistema registra FLUJOS (gasto / ingreso / traspaso). Esta hoja
 * agrega el otro lado: el SALDO real de cada cuenta a una fecha de corte. Con
 * eso el sistema puede responder "¿cuánto tengo?" (pendiente 5 del CLAUDE.md).
 *
 * Enfoque acordado con el titular (2026-07-23): "foto de hoy y hacia adelante".
 * No reconstruimos el saldo sumando todo el histórico —que aún tiene vacíos—:
 * declaramos el saldo real de hoy como punto de partida y de aquí en adelante
 * los flujos lo mueven. Es empezar como cuenta nueva sin perder el histórico.
 *
 * Modelo de cuentas del titular:
 *   - Efectivo, BCP Corriente (= Yape = débito): líquido.
 *   - Wardadito: bolsillo de ahorro DENTRO del BCP, con sub-bolsillos
 *       · Vivienda (meta 1000, completa; ahorro fijo de 5/día hasta la meta)
 *       · Ando     (meta 1500; se nutre del REDONDEO a 5 de cada compra débito)
 *       · Intereses (lo que abona el banco)
 *   - BBVA Cuenta Digital (débito): líquido, aparte de la tarjeta.
 *   - BBVA Respaldo BFree: garantía bloqueada, se devuelve (fecha incierta).
 *   - Tarjetas de crédito (BCP Visa Light, BBVA Visa BFree): DEUDA, no líquido.
 *
 * PEN y USD nunca se mezclan (regla 2). La deuda en dólares vive en su moneda.
 */

const HOJA_CUENTAS = 'Cuentas';
const ENCABEZADOS_CUENTAS =
  ['Cuenta', 'Tipo', 'Moneda', 'Grupo', 'Saldo Inicial', 'Fecha Corte', 'Nota'];

/** El saldo real declarado por el titular vale a esta fecha (yyyy-MM-dd). */
const FECHA_CORTE_CUENTAS = '2026-07-23';

/**
 * Saldos reales al corte, declarados por el titular.
 * tipo: 'activo' (líquido) · 'activo_bloqueado' (activo no disponible) · 'deuda'.
 * El saldo de una deuda es lo que se DEBE (positivo); resta del patrimonio.
 */
const CUENTAS_INICIALES_ = [
  { cuenta: 'Efectivo',            tipo: 'activo',           moneda: 'PEN', grupo: '',          saldo: 20.00,   nota: 'no se rastrea tras salir' },
  { cuenta: 'BCP Corriente',       tipo: 'activo',           moneda: 'PEN', grupo: '',          saldo: 14.94,   nota: 'Yape = débito = misma cuenta' },
  { cuenta: 'Wardadito Vivienda',  tipo: 'activo',           moneda: 'PEN', grupo: 'Wardadito', saldo: 1000.00, nota: 'meta 1000, completa' },
  { cuenta: 'Wardadito Ando',      tipo: 'activo',           moneda: 'PEN', grupo: 'Wardadito', saldo: 1262.62, nota: 'meta 1500; redondeo a 5 de compras débito' },
  { cuenta: 'Wardadito Intereses', tipo: 'activo',           moneda: 'PEN', grupo: 'Wardadito', saldo: 1.05,    nota: 'intereses abonados por el banco' },
  { cuenta: 'BBVA Cuenta Digital', tipo: 'activo',           moneda: 'PEN', grupo: '',          saldo: 657.81,  nota: 'débito, aparte de la tarjeta' },
  { cuenta: 'BBVA Respaldo BFree', tipo: 'activo_bloqueado', moneda: 'PEN', grupo: '',          saldo: 500.00,  nota: 'garantía de la Visa BFree; se devuelve, fecha incierta' },
  { cuenta: 'BCP Visa Light',      tipo: 'deuda',            moneda: 'PEN', grupo: '',          saldo: 131.52,  nota: 'línea S/800; deuda por pagar' },
  { cuenta: 'BCP Visa Light USD',  tipo: 'deuda',            moneda: 'USD', grupo: '',          saldo: 24.59,   nota: 'deuda en dólares de la misma tarjeta' },
  { cuenta: 'BBVA Visa BFree',     tipo: 'deuda',            moneda: 'PEN', grupo: '',          saldo: 100.00,  nota: 'respaldo S/500 bloqueado aparte' },
];

/**
 * Crea la hoja `Cuentas` con los saldos declarados. Idempotente por seguridad:
 * si la hoja ya tiene datos, NO la sobrescribe (para no pisar ajustes a mano).
 * Bórrala a mano si quieres regenerarla desde CUENTAS_INICIALES_.
 */
function configurarCuentas() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Otra corrida en curso. Salgo.'); return; }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let hoja = ss.getSheetByName(HOJA_CUENTAS);

    if (hoja && hoja.getLastRow() > 1) {
      Logger.log('La hoja "' + HOJA_CUENTAS + '" ya tiene datos. No la sobrescribo.');
      Logger.log('Si quieres regenerarla, bórrala a mano y vuelve a correr configurarCuentas().');
      resumenCuentas();
      return;
    }
    if (!hoja) hoja = ss.insertSheet(HOJA_CUENTAS);

    hoja.getRange(1, 1, 1, ENCABEZADOS_CUENTAS.length)
        .setValues([ENCABEZADOS_CUENTAS]).setFontWeight('bold');
    hoja.setFrozenRows(1);

    const filas = CUENTAS_INICIALES_.map(function (c) {
      return [c.cuenta, c.tipo, c.moneda, c.grupo, c.saldo, FECHA_CORTE_CUENTAS, c.nota];
    });
    hoja.getRange(2, 1, filas.length, ENCABEZADOS_CUENTAS.length).setValues(filas);

    Logger.log('Hoja "' + HOJA_CUENTAS + '" creada con ' + filas.length + ' cuentas.');
    resumenCuentas();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Imprime, solo leyendo la hoja `Cuentas`, el líquido y el patrimonio por
 * moneda al corte. No toca nada. Sirve para responder "¿cuánto tengo?".
 */
function resumenCuentas() {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_CUENTAS);
  if (!hoja || hoja.getLastRow() < 2) {
    Logger.log('No hay hoja "' + HOJA_CUENTAS + '" con datos. Corre configurarCuentas().');
    return;
  }

  const filas = hoja.getRange(2, 1, hoja.getLastRow() - 1, ENCABEZADOS_CUENTAS.length).getValues();

  // Acumuladores por moneda: { PEN: {liquido, bloqueado, deuda}, USD: {...} }
  const acc = {};
  const bolsa = function (m) {
    if (!acc[m]) acc[m] = { liquido: 0, bloqueado: 0, deuda: 0 };
    return acc[m];
  };

  filas.forEach(function (f) {
    const tipo = String(f[1]).trim();
    const moneda = String(f[2]).trim();
    const saldo = Number(f[4]) || 0;
    const b = bolsa(moneda);
    if (tipo === 'activo') b.liquido += saldo;
    else if (tipo === 'activo_bloqueado') b.bloqueado += saldo;
    else if (tipo === 'deuda') b.deuda += saldo;
  });

  Logger.log('=== Saldos al ' + FECHA_CORTE_CUENTAS + ' ===');
  Object.keys(acc).sort().forEach(function (m) {
    const b = acc[m];
    const simbolo = (m === 'PEN') ? 'S/' : (m === 'USD') ? 'US$' : m;
    Logger.log('· ' + m);
    Logger.log('    Líquido disponible : ' + simbolo + ' ' + b.liquido.toFixed(2));
    if (b.bloqueado) Logger.log('    Activo bloqueado   : ' + simbolo + ' ' + b.bloqueado.toFixed(2));
    if (b.deuda)     Logger.log('    Deuda de tarjetas  : ' + simbolo + ' ' + b.deuda.toFixed(2));
    Logger.log('    Patrimonio neto    : ' + simbolo + ' ' +
      (b.liquido + b.bloqueado - b.deuda).toFixed(2) + '  (líquido + bloqueado − deuda)');
  });
}
