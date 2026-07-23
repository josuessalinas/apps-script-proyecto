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
  ['Cuenta', 'Tipo', 'Moneda', 'Grupo', 'Saldo Inicial', 'Fecha Corte', 'Nota', 'Límite/Meta'];

/** El saldo real declarado por el titular vale a esta fecha (yyyy-MM-dd). */
const FECHA_CORTE_CUENTAS = '2026-07-23';

/**
 * Saldos reales al corte, declarados por el titular.
 * tipo: 'activo' (líquido) · 'activo_bloqueado' (activo no disponible) · 'deuda'.
 * El saldo de una deuda es lo que se DEBE (positivo); resta del patrimonio.
 */
const CUENTAS_INICIALES_ = [
  { cuenta: 'Efectivo',            tipo: 'activo',           moneda: 'PEN', grupo: '',          saldo: 20.00,   meta: '',     nota: 'no se rastrea tras salir' },
  { cuenta: 'BCP Corriente',       tipo: 'activo',           moneda: 'PEN', grupo: '',          saldo: 14.94,   meta: '',     nota: 'Yape = débito = misma cuenta' },
  { cuenta: 'Wardadito Vivienda',  tipo: 'activo',           moneda: 'PEN', grupo: 'Wardadito', saldo: 1000.00, meta: 1000,   nota: 'meta 1000, completa' },
  { cuenta: 'Wardadito Ando',      tipo: 'activo',           moneda: 'PEN', grupo: 'Wardadito', saldo: 1262.62, meta: 1500,   nota: 'meta 1500; redondeo a 5 de compras débito' },
  { cuenta: 'Wardadito Intereses', tipo: 'activo',           moneda: 'PEN', grupo: 'Wardadito', saldo: 1.05,    meta: '',     nota: 'intereses abonados por el banco' },
  { cuenta: 'BBVA Cuenta Digital', tipo: 'activo',           moneda: 'PEN', grupo: '',          saldo: 657.81,  meta: '',     nota: 'débito, aparte de la tarjeta' },
  { cuenta: 'BBVA Respaldo BFree', tipo: 'activo_bloqueado', moneda: 'PEN', grupo: '',          saldo: 500.00,  meta: '',     nota: 'garantía de la Visa BFree; se devuelve, fecha incierta' },
  { cuenta: 'BCP Visa Light',      tipo: 'deuda',            moneda: 'PEN', grupo: '',          saldo: 131.52,  meta: 800,    nota: 'línea de crédito S/800' },
  { cuenta: 'BCP Visa Light USD',  tipo: 'deuda',            moneda: 'USD', grupo: '',          saldo: 24.59,   meta: '',     nota: 'deuda en dólares de la misma tarjeta' },
  { cuenta: 'BBVA Visa BFree',     tipo: 'deuda',            moneda: 'PEN', grupo: '',          saldo: 100.00,  meta: 500,    nota: 'línea de crédito S/500 (respaldo)' },
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
      return [c.cuenta, c.tipo, c.moneda, c.grupo, c.saldo, FECHA_CORTE_CUENTAS, c.nota, c.meta];
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

/**
 * INVENTARIO de las combinaciones (Banco · Método · Tipo · Moneda) que existen
 * en `Movimientos`, con su conteo y una descripción de ejemplo. Solo lee.
 *
 * Es el insumo para escribir la atribución de cuentas del motor de saldos SIN
 * adivinar: cada combinación se mapeará a una cuenta de la hoja `Cuentas`. Correr
 * esto primero evita inventar reglas para casos que no ocurren o pasar por alto
 * los que sí.
 */
function inventarioMovimientos() {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_MOVIMIENTOS);
  const n = hoja.getLastRow();
  if (n < 2) { Logger.log('La hoja "' + HOJA_MOVIMIENTOS + '" está vacía.'); return; }

  const filas = hoja.getRange(2, 1, n - 1, 14).getValues();
  const grupos = {};

  filas.forEach(function (f) {
    const tipo   = String(f[2]).trim() || '(vacío)';   // C
    const moneda = String(f[4]).trim() || '(vacío)';   // E
    const desc   = String(f[5]).trim();                // F
    const metodo = String(f[7]).trim() || '(vacío)';   // H
    const banco  = String(f[8]).trim() || '(vacío)';   // I
    const clave = banco + ' · ' + metodo + ' · ' + tipo + ' · ' + moneda;
    if (!grupos[clave]) grupos[clave] = { n: 0, ejemplo: desc };
    grupos[clave].n++;
  });

  const ordenadas = Object.keys(grupos).sort(function (a, b) {
    return grupos[b].n - grupos[a].n;
  });

  Logger.log('=== Inventario de movimientos: ' + (n - 1) + ' filas ===');
  Logger.log('Banco · Método · Tipo · Moneda   → conteo · ejemplo');
  ordenadas.forEach(function (clave) {
    const g = grupos[clave];
    Logger.log('  ' + clave + '   → ' + g.n + ' · "' + g.ejemplo.slice(0, 35) + '"');
  });
  Logger.log('Total de combinaciones distintas: ' + ordenadas.length);
}

// ========================= MOTOR DE SALDOS =========================

/**
 * Atribuye un movimiento a la(s) cuenta(s) de la hoja `Cuentas` que afecta.
 * Devuelve [{cuenta, signo}]; el motor multiplica cada efecto por el monto.
 *   signo +1 = sube el saldo guardado de esa cuenta (activo: entra dinero;
 *              deuda: se debe más).
 *   signo -1 = lo baja (activo: sale dinero; deuda: se paga).
 * Devuelve null cuando no sabe atribuirlo, para que el motor lo marque en vez
 * de inventar (regla: cero pérdidas silenciosas).
 *
 * Reglas confirmadas con el titular (2026-07-23) contra inventarioMovimientos().
 * Se aplican de aquí en adelante, no al histórico.
 */
function cuentaDeMovimiento_(banco, metodo, tipo, moneda, desc) {
  banco  = String(banco  || '').toUpperCase();
  metodo = String(metodo || '').toLowerCase();
  tipo   = String(tipo   || '').toLowerCase();
  moneda = String(moneda || '').toUpperCase();
  desc   = String(desc   || '').toLowerCase();

  const BCP      = 'BCP Corriente';
  const BBVA_DIG = 'BBVA Cuenta Digital';
  const BCP_TC   = (moneda === 'USD') ? 'BCP Visa Light USD' : 'BCP Visa Light';
  const BBVA_TC  = 'BBVA Visa BFree';
  const EFECTIVO = 'Efectivo';

  if (tipo === 'gasto') {
    if (metodo === 'tarjeta_credito') return [{ cuenta: (banco === 'BBVA') ? BBVA_TC : BCP_TC, signo: +1 }];
    if (banco === 'BBVA')             return [{ cuenta: BBVA_TC, signo: +1 }];  // consumo TC BBVA (estado de cuenta)
    return [{ cuenta: BCP, signo: -1 }];  // débito, yape, retiro_cajero, pago_servicio, transferencia, cuenta, otro
  }

  if (tipo === 'ingreso') {
    if (banco === 'BBVA') return [{ cuenta: BBVA_DIG, signo: +1 }];
    return [{ cuenta: BCP, signo: +1 }];  // el dinero entra a la corriente y se queda ahí
  }

  if (tipo === 'traspaso') {
    // Redondeo automático al ahorro (fila sintética que generamos nosotros).
    if (metodo === 'ahorro_redondeo')
      return [{ cuenta: BCP, signo: -1 }, { cuenta: REDONDEO_CUENTA_DESTINO_, signo: +1 }];

    // Pago de tu propia tarjeta: sale de la corriente y baja la deuda.
    if (metodo === 'pago_tarjeta') {
      const card = (banco === 'BBVA') ? BBVA_TC : BCP_TC;
      // En USD no tocamos la corriente (es PEN) sin convertir (regla 2): solo
      // bajamos la deuda en dólares; el lado en soles no se modela.
      if (moneda === 'USD') return [{ cuenta: card, signo: -1 }];
      return [{ cuenta: BCP, signo: -1 }, { cuenta: card, signo: -1 }];
    }

    // Lado BBVA del pago a la BFree (la salida del BCP va en su propia fila).
    if (banco === 'BBVA') return [{ cuenta: BBVA_TC, signo: -1 }];

    // Movimientos del wardadito. La descripción SIEMPRE trae "wardadito"
    // ("Aporte voluntario a wardadito Ando…", "Retiro wardadito Ando"), así que
    // se ata a esa palabra: un nombre tipo "Fernando" ya no se cuela como Ando.
    if (desc.indexOf('wardadito') >= 0) {
      const sub = (desc.indexOf('vivienda') >= 0) ? 'Wardadito Vivienda' : 'Wardadito Ando';
      return (desc.indexOf('retiro') >= 0)
        ? [{ cuenta: sub, signo: -1 }, { cuenta: BCP, signo: +1 }]   // retiro: vuelve a la corriente
        : [{ cuenta: BCP, signo: -1 }, { cuenta: sub, signo: +1 }];  // aporte voluntario
    }

    // Depósito de efectivo a la corriente.
    if (desc.indexOf('dep') >= 0) return [{ cuenta: EFECTIVO, signo: -1 }, { cuenta: BCP, signo: +1 }];

    // Transferencia a mi nombre → mi BBVA Cuenta Digital.
    if (metodo === 'transferencia') return [{ cuenta: BCP, signo: -1 }, { cuenta: BBVA_DIG, signo: +1 }];

    return null;  // sin atribuir: que el motor lo marque
  }

  return null;
}

/** Lee la hoja `Cuentas` y devuelve { nombre: {moneda, tipo, grupo, saldo, meta} }.
 *  Tolera hojas viejas sin la columna Límite/Meta (meta queda null). */
function cargarCuentas_() {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_CUENTAS);
  if (!hoja || hoja.getLastRow() < 2) return null;
  const cols = hoja.getLastColumn();
  const filas = hoja.getRange(2, 1, hoja.getLastRow() - 1, cols).getValues();
  const mapa = {};
  filas.forEach(function (f) {
    const meta = (cols >= 8 && f[7] !== '' && f[7] != null) ? Number(f[7]) : null;
    mapa[String(f[0]).trim()] = {
      moneda: String(f[2]).trim(), tipo: String(f[1]).trim(),
      grupo: String(f[3]).trim(), saldo: Number(f[4]) || 0, meta: meta
    };
  });
  return mapa;
}

/**
 * Migración: agrega/rellena la columna "Límite/Meta" en una hoja `Cuentas` que
 * se creó antes de que existiera. Idempotente, NO toca los saldos (que pudiste
 * ajustar a mano): solo escribe la meta/límite de cada cuenta por su nombre.
 */
function actualizarMetasCuentas() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Otra corrida en curso. Salgo.'); return; }
  try {
    const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_CUENTAS);
    if (!hoja || hoja.getLastRow() < 2) { Logger.log('No hay hoja "' + HOJA_CUENTAS + '".'); return; }
    hoja.getRange(1, 8).setValue('Límite/Meta').setFontWeight('bold');
    const metas = {};
    CUENTAS_INICIALES_.forEach(function (c) { metas[c.cuenta] = (c.meta === '' || c.meta == null) ? '' : c.meta; });
    const nombres = hoja.getRange(2, 1, hoja.getLastRow() - 1, 1).getValues();
    const col = nombres.map(function (r) {
      const m = metas[String(r[0]).trim()];
      return [m == null ? '' : m];
    });
    hoja.getRange(2, 8, col.length, 1).setValues(col);
    Logger.log('Columna "Límite/Meta" actualizada en ' + col.length + ' cuentas.');
  } finally { lock.releaseLock(); }
}

/**
 * DIAGNÓSTICO de atribución (solo lectura). Recorre TODO el histórico, resuelve
 * cada movimiento con cuentaDeMovimiento_ y muestra, por combinación, a qué
 * cuentas se traduce y cuántas filas. Sirve para validar las reglas contra los
 * datos reales antes de confiar en calcularSaldos(). No escribe nada.
 */
function diagnosticoAtribucion() {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_MOVIMIENTOS);
  const n = hoja.getLastRow();
  if (n < 2) { Logger.log('La hoja "' + HOJA_MOVIMIENTOS + '" está vacía.'); return; }
  const cuentas = cargarCuentas_();
  if (!cuentas) { Logger.log('No hay hoja "' + HOJA_CUENTAS + '". Corre configurarCuentas().'); return; }

  const filas = hoja.getRange(2, 1, n - 1, 14).getValues();
  const tally = {};   // clave combo → { firma → conteo }
  let sinAtribuir = 0, choqueMoneda = 0;

  filas.forEach(function (f) {
    const tipo = String(f[2]).trim(), moneda = String(f[4]).trim();
    const desc = String(f[5]).trim(), metodo = String(f[7]).trim(), banco = String(f[8]).trim();
    const combo = (banco || '∅') + '·' + (metodo || '∅') + '·' + tipo + '·' + moneda;

    const efectos = cuentaDeMovimiento_(banco, metodo, tipo, moneda, desc);
    let firma;
    if (!efectos) { firma = '⚠ SIN ATRIBUIR'; sinAtribuir++; }
    else {
      firma = efectos.map(function (e) {
        const c = cuentas[e.cuenta];
        if (!c) return '⚠ cuenta inexistente: ' + e.cuenta;
        if (c.moneda !== moneda) { choqueMoneda++; return '⚠ moneda ' + e.cuenta + ' (' + c.moneda + '≠' + moneda + ')'; }
        return (e.signo > 0 ? '+' : '−') + e.cuenta;
      }).join('  ,  ');
    }
    if (!tally[combo]) tally[combo] = {};
    tally[combo][firma] = (tally[combo][firma] || 0) + 1;
  });

  Logger.log('=== Atribución de ' + (n - 1) + ' movimientos ===');
  Object.keys(tally).sort().forEach(function (combo) {
    Logger.log('· ' + combo);
    Object.keys(tally[combo]).forEach(function (firma) {
      Logger.log('     ' + tally[combo][firma] + '×   → ' + firma);
    });
  });
  Logger.log('Sin atribuir: ' + sinAtribuir + ' · choques de moneda: ' + choqueMoneda);
}

/**
 * Calcula el saldo actual de cada cuenta = saldo inicial (hoja `Cuentas`) + los
 * flujos POSTERIORES a la fecha de corte, atribuidos con cuentaDeMovimiento_.
 * Solo lee; imprime el resultado por moneda. Movimientos anteriores al corte no
 * se aplican (el saldo inicial ya los engloba: "foto de hoy y hacia adelante").
 */
function calcularSaldos() {
  const cuentas = cargarCuentas_();
  if (!cuentas) { Logger.log('No hay hoja "' + HOJA_CUENTAS + '". Corre configurarCuentas().'); return; }

  const saldo = {};
  Object.keys(cuentas).forEach(function (c) { saldo[c] = cuentas[c].saldo; });

  const corte = fechaDeIso_(FECHA_CORTE_CUENTAS);
  corte.setHours(23, 59, 59);

  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_MOVIMIENTOS);
  const n = hoja.getLastRow();
  const filas = (n > 1) ? hoja.getRange(2, 1, n - 1, 14).getValues() : [];
  let aplicados = 0, sinAtribuir = 0, choqueMoneda = 0;

  filas.forEach(function (f) {
    const fecha = f[1];
    if (!(fecha instanceof Date) || fecha <= corte) return;  // solo posteriores al corte
    const monto = Number(f[3]) || 0, moneda = String(f[4]).trim();
    const efectos = cuentaDeMovimiento_(String(f[8]), String(f[7]), String(f[2]), moneda, String(f[5]));
    if (!efectos) { sinAtribuir++; return; }
    efectos.forEach(function (e) {
      const c = cuentas[e.cuenta];
      if (!c) return;
      if (c.moneda !== moneda) { choqueMoneda++; return; }  // no mezclar monedas (regla 2)
      saldo[e.cuenta] += e.signo * monto;
    });
    aplicados++;
  });

  Logger.log('=== Saldos al día (corte ' + FECHA_CORTE_CUENTAS + ' + ' + aplicados + ' flujos posteriores) ===');
  const porMoneda = {};
  Object.keys(cuentas).forEach(function (c) {
    const m = cuentas[c].moneda;
    (porMoneda[m] = porMoneda[m] || []).push(c);
  });
  Object.keys(porMoneda).sort().forEach(function (m) {
    const simbolo = (m === 'PEN') ? 'S/' : (m === 'USD') ? 'US$' : m;
    Logger.log('· ' + m);
    porMoneda[m].forEach(function (c) {
      Logger.log('    ' + c + ': ' + simbolo + ' ' + saldo[c].toFixed(2) +
        '  (' + cuentas[c].tipo + ')');
    });
  });
  if (sinAtribuir || choqueMoneda)
    Logger.log('Avisos → sin atribuir: ' + sinAtribuir + ' · choques de moneda: ' + choqueMoneda);
}

// ========================= REDONDEO AUTOMÁTICO AL AHORRO =========================
//
// El BCP redondea cada compra con débito al siguiente múltiplo de 5 y guarda la
// diferencia en un wardadito (compra S/3.50 → cobra 5, ahorra 1.50). NO lo avisa
// por correo, así que si no lo registramos nosotros ese ahorro es invisible.
//
// Estas filas son SINTÉTICAS: un traspaso BCP Corriente → wardadito destino, con
// llave `redondeo|{idCompra}` para que sea idempotente (regla 3). Solo aplica a
// compras POSTERIORES al corte: el saldo inicial ya engloba los redondeos
// históricos que hizo el banco. Se detiene cuando el destino llega a su meta.
//
// Todo configurable: para cambiar la meta o el destino, edita estas variables.

const REDONDEO_MULTIPLO_ = 5;                        // se redondea al siguiente múltiplo de esto
const REDONDEO_CUENTA_DESTINO_ = 'Wardadito Ando';   // dónde se acumula el ahorro
const REDONDEO_META_ = 1500;                         // deja de ahorrar cuando el destino llega aquí

/** Muestra qué redondeos generaría. No escribe. */
function simularRedondeos() { materializarRedondeos_(false); }

/** Escribe los redondeos que falten. Idempotente. Corre el simulacro antes. */
function aplicarRedondeos() { materializarRedondeos_(true); }

function materializarRedondeos_(escribir) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Otra corrida en curso. Salgo.'); return; }

  try {
    const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_MOVIMIENTOS);
    const cuentas = cargarCuentas_();
    if (!cuentas) { Logger.log('No hay hoja "' + HOJA_CUENTAS + '". Corre configurarCuentas().'); return; }
    if (!cuentas[REDONDEO_CUENTA_DESTINO_]) {
      Logger.log('No existe la cuenta destino "' + REDONDEO_CUENTA_DESTINO_ + '" en Cuentas.'); return;
    }

    const idsExistentes = cargarIdsExistentes_(hoja);
    const corte = fechaDeIso_(FECHA_CORTE_CUENTAS);
    corte.setHours(23, 59, 59);

    const n = hoja.getLastRow();
    const filas = (n > 1) ? hoja.getRange(2, 1, n - 1, 14).getValues() : [];

    // 1. Saldo actual del destino = inicial + efectos posteriores al corte
    //    (incluye redondeos ya materializados y aportes/retiros voluntarios).
    let saldoDestino = cuentas[REDONDEO_CUENTA_DESTINO_].saldo;
    const monedaDestino = cuentas[REDONDEO_CUENTA_DESTINO_].moneda;
    filas.forEach(function (f) {
      const fecha = f[1];
      if (!(fecha instanceof Date) || fecha <= corte) return;
      const monto = Number(f[3]) || 0, moneda = String(f[4]).trim();
      if (moneda !== monedaDestino) return;
      const efectos = cuentaDeMovimiento_(String(f[8]), String(f[7]), String(f[2]), moneda, String(f[5]));
      if (!efectos) return;
      efectos.forEach(function (e) {
        if (e.cuenta === REDONDEO_CUENTA_DESTINO_) saldoDestino += e.signo * monto;
      });
    });

    // 2. Compras con débito del BCP posteriores al corte, en PEN, sin redondeo aún.
    const compras = [];
    filas.forEach(function (f) {
      const fecha = f[1];
      if (!(fecha instanceof Date) || fecha <= corte) return;
      if (String(f[2]).trim() !== 'gasto') return;
      if (String(f[7]).trim() !== 'tarjeta_debito') return;
      if (String(f[8]).trim().toUpperCase() !== 'BCP') return;
      if (String(f[4]).trim() !== 'PEN') return;
      if (idsExistentes.has('redondeo|' + String(f[0]))) return;   // ya tiene su redondeo
      compras.push({ id: String(f[0]), fecha: fecha, monto: Number(f[3]) || 0, comercio: String(f[5]) });
    });
    compras.sort(function (a, b) { return a.fecha - b.fecha; });

    // 3. Generar redondeos en orden cronológico, hasta llegar a la meta.
    let generados = 0, sumaAhorro = 0, detenido = false;
    compras.forEach(function (c) {
      if (saldoDestino >= REDONDEO_META_) { detenido = true; return; }

      const resto = +(c.monto % REDONDEO_MULTIPLO_).toFixed(2);
      const ahorro = (resto === 0) ? 0 : +(REDONDEO_MULTIPLO_ - resto).toFixed(2);
      if (ahorro <= 0) return;   // la compra ya es múltiplo de 5

      Logger.log('Compra S/ ' + c.monto.toFixed(2) + ' → ahorra S/ ' + ahorro.toFixed(2) +
        '  (' + c.comercio.slice(0, 28) + ')');

      if (escribir) {
        escribirMovimiento_(hoja, {
          idMensaje: 'redondeo|' + c.id,
          fecha: c.fecha,
          tipo: 'traspaso',
          monto: ahorro,
          moneda: 'PEN',
          comercio: 'Redondeo a ' + REDONDEO_CUENTA_DESTINO_ + ' (compra: ' + c.comercio.slice(0, 30) + ')',
          categoria: 'Traspaso',
          metodo: 'ahorro_redondeo',
          banco: 'BCP',
          ultimos4: '',
          numOperacion: '',
          fuente: 'redondeo',
          referencia: 'https://mail.google.com/mail/u/0/#all/' + c.id
        });
      }
      saldoDestino += ahorro;
      sumaAhorro += ahorro;
      generados++;
    });

    Logger.log('');
    Logger.log('Saldo ' + REDONDEO_CUENTA_DESTINO_ + ' proyectado: S/ ' + saldoDestino.toFixed(2) +
      ' (meta S/ ' + REDONDEO_META_ + ')');
    if (detenido) Logger.log('Se alcanzó la meta: las compras restantes no generan ahorro.');
    Logger.log(escribir
      ? '=== APLICADO: ' + generados + ' redondeos · S/ ' + sumaAhorro.toFixed(2) + ' ahorrado. ==='
      : '=== SIMULACRO: ' + generados + ' redondeos · S/ ' + sumaAhorro.toFixed(2) + '. Nada se escribió. ===');
  } finally {
    lock.releaseLock();
  }
}

// ========================= API PARA LA VISTA =========================

/**
 * Núcleo del motor: devuelve { cuentas, saldo } con el saldo vivo de cada cuenta
 * = saldo inicial + flujos posteriores al corte. Lo usan calcularSaldos() (log)
 * y obtenerSaldos() (vista). No escribe nada.
 */
function saldosVivos_() {
  const cuentas = cargarCuentas_();
  if (!cuentas) return null;

  const saldo = {};
  Object.keys(cuentas).forEach(function (c) { saldo[c] = cuentas[c].saldo; });

  const corte = fechaDeIso_(FECHA_CORTE_CUENTAS);
  corte.setHours(23, 59, 59);

  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_MOVIMIENTOS);
  const n = hoja ? hoja.getLastRow() : 0;
  const filas = (n > 1) ? hoja.getRange(2, 1, n - 1, 14).getValues() : [];

  filas.forEach(function (f) {
    const fecha = f[1];
    if (!(fecha instanceof Date) || fecha <= corte) return;
    const monto = Number(f[3]) || 0, moneda = String(f[4]).trim();
    const efectos = cuentaDeMovimiento_(String(f[8]), String(f[7]), String(f[2]), moneda, String(f[5]));
    if (!efectos) return;
    efectos.forEach(function (e) {
      const c = cuentas[e.cuenta];
      if (!c || c.moneda !== moneda) return;   // cuenta inexistente o moneda distinta
      saldo[e.cuenta] += e.signo * monto;
    });
  });

  return { cuentas: cuentas, saldo: saldo };
}

/**
 * Datos ya listos para `saldos.html`. Devuelve totales por moneda (líquido,
 * bloqueado, deuda, patrimonio) y la lista de cuentas con su saldo vivo, meta y
 * —para tarjetas y ahorros— el porcentaje y el disponible. El HTML no calcula.
 */
function obtenerSaldos() {
  const vivos = saldosVivos_();
  if (!vivos) return { error: 'No hay hoja "Cuentas". Corre configurarCuentas() y actualizarMetasCuentas().' };

  const cuentas = vivos.cuentas, saldo = vivos.saldo;
  const monedas = {};
  const lista = [];

  Object.keys(cuentas).forEach(function (nombre) {
    const c = cuentas[nombre];
    const s = +(saldo[nombre]).toFixed(2);
    const m = c.moneda;
    if (!monedas[m]) monedas[m] = { liquido: 0, bloqueado: 0, deuda: 0 };
    if (c.tipo === 'activo') monedas[m].liquido += s;
    else if (c.tipo === 'activo_bloqueado') monedas[m].bloqueado += s;
    else if (c.tipo === 'deuda') monedas[m].deuda += s;

    const item = { cuenta: nombre, tipo: c.tipo, moneda: m, grupo: c.grupo, saldo: s, meta: c.meta };
    if (c.meta) {
      if (c.tipo === 'deuda') {
        item.disponible = +(c.meta - s).toFixed(2);
        item.pct = Math.max(0, Math.min(100, (item.disponible / c.meta) * 100));
      } else {
        item.pct = Math.max(0, Math.min(100, (s / c.meta) * 100));
      }
    }
    lista.push(item);
  });

  Object.keys(monedas).forEach(function (m) {
    const b = monedas[m];
    b.liquido = +b.liquido.toFixed(2);
    b.bloqueado = +b.bloqueado.toFixed(2);
    b.deuda = +b.deuda.toFixed(2);
    b.patrimonio = +(b.liquido + b.bloqueado - b.deuda).toFixed(2);
  });

  return { corte: FECHA_CORTE_CUENTAS, monedas: monedas, cuentas: lista };
}

// ========================= SALDO DE APERTURA (cuadrar el registro) =========================
//
// `analisis.html` suma ingresos − gastos de TODO el histórico, pero al registro
// le falta el punto de partida: lo que ya tenías antes de la primera fila. Sin
// eso, el balance del análisis no coincide con tu saldo real.
//
// Esto agrega UNA línea de "Saldo de apertura" por moneda —un supuesto que
// engloba todo lo previo y no mapeado— para que el balance del registro aterrice
// en tu saldo real de la hoja `Cuentas`. Es idempotente (llave `apertura|{moneda}`).
//
// A qué cuadrar: 'liquido' (lo que tienes) o 'patrimonio' (líquido − deuda).

const AJUSTE_OBJETIVO_ = 'liquido';   // 'liquido' o 'patrimonio'

/** Muestra el ajuste que haría falta por moneda. No escribe. */
function simularSaldoApertura() { saldoApertura_(false); }

/** Escribe la línea de apertura por moneda. Corre el simulacro antes. */
function aplicarSaldoApertura() { saldoApertura_(true); }

function saldoApertura_(escribir) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Otra corrida en curso. Salgo.'); return; }

  try {
    const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_MOVIMIENTOS);
    const cuentas = cargarCuentas_();
    if (!cuentas) { Logger.log('No hay hoja "' + HOJA_CUENTAS + '". Corre configurarCuentas().'); return; }

    const idsExistentes = cargarIdsExistentes_(hoja);
    const n = hoja.getLastRow();
    const filas = (n > 1) ? hoja.getRange(2, 1, n - 1, 14).getValues() : [];

    // Net de flujos por moneda (traspasos excluidos) + fecha más antigua.
    const net = {}; let minFecha = null;
    filas.forEach(function (f) {
      const tipo = String(f[2]).trim(), moneda = String(f[4]).trim(), monto = Number(f[3]) || 0, fecha = f[1];
      if (fecha instanceof Date && (!minFecha || fecha < minFecha)) minFecha = fecha;
      if (tipo === 'traspaso') return;
      if (!net[moneda]) net[moneda] = { ing: 0, gas: 0 };
      if (tipo === 'ingreso') net[moneda].ing += monto;
      else if (tipo === 'gasto') net[moneda].gas += monto;
    });

    // Objetivos reales por moneda desde la hoja Cuentas.
    const obj = {};
    Object.keys(cuentas).forEach(function (nm) {
      const c = cuentas[nm], m = c.moneda;
      if (!obj[m]) obj[m] = { liquido: 0, bloqueado: 0, deuda: 0 };
      if (c.tipo === 'activo') obj[m].liquido += c.saldo;
      else if (c.tipo === 'activo_bloqueado') obj[m].bloqueado += c.saldo;
      else if (c.tipo === 'deuda') obj[m].deuda += c.saldo;
    });

    const fechaApertura = minFecha ? new Date(minFecha.getTime() - 86400000) : new Date();

    Logger.log('=== Saldo de apertura (objetivo: ' + AJUSTE_OBJETIVO_ + ') ===');
    Object.keys(net).forEach(function (m) {
      const balance = +(net[m].ing - net[m].gas).toFixed(2);
      const o = obj[m] || { liquido: 0, bloqueado: 0, deuda: 0 };
      const patrimonio = +(o.liquido + o.bloqueado - o.deuda).toFixed(2);
      const objetivo = (AJUSTE_OBJETIVO_ === 'patrimonio') ? patrimonio : +o.liquido.toFixed(2);
      const ajuste = +(objetivo - balance).toFixed(2);
      const simbolo = (m === 'PEN') ? 'S/' : (m === 'USD') ? 'US$' : m;

      Logger.log('· ' + m + ': ingresos ' + simbolo + ' ' + net[m].ing.toFixed(2) +
        ' − gastos ' + simbolo + ' ' + net[m].gas.toFixed(2) + ' = balance ' + simbolo + ' ' + balance.toFixed(2));
      Logger.log('     líquido ' + simbolo + ' ' + o.liquido.toFixed(2) +
        ' · patrimonio ' + simbolo + ' ' + patrimonio.toFixed(2));
      Logger.log('     → APERTURA: ' + (ajuste >= 0 ? '+' : '') + simbolo + ' ' + ajuste.toFixed(2) +
        ' como ' + (ajuste >= 0 ? 'ingreso' : 'gasto'));

      if (escribir && Math.abs(ajuste) >= 0.01) {
        const llave = 'apertura|' + m;
        if (idsExistentes.has(llave)) { Logger.log('     ya existe, no se duplica.'); return; }
        escribirMovimiento_(hoja, {
          idMensaje: llave, fecha: fechaApertura,
          tipo: ajuste >= 0 ? 'ingreso' : 'gasto', monto: Math.abs(ajuste), moneda: m,
          comercio: 'Saldo de apertura y ajustes previos (supuesto)',
          categoria: 'Saldo de apertura', metodo: 'ajuste', banco: '',
          ultimos4: '', numOperacion: '', fuente: 'ajuste', referencia: ''
        });
      }
    });

    Logger.log(escribir ? '=== APLICADO ===' : '=== SIMULACRO: nada se escribió. ===');
  } finally {
    lock.releaseLock();
  }
}
