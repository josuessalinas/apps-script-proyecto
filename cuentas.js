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

    // Movimientos del wardadito (sub-bolsillo por descripción).
    if (desc.indexOf('wardadito') >= 0 || desc.indexOf('vivienda') >= 0 || desc.indexOf('ando') >= 0) {
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

/** Lee la hoja `Cuentas` y devuelve { nombre: {moneda, tipo, saldo} }. */
function cargarCuentas_() {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_CUENTAS);
  if (!hoja || hoja.getLastRow() < 2) return null;
  const filas = hoja.getRange(2, 1, hoja.getLastRow() - 1, ENCABEZADOS_CUENTAS.length).getValues();
  const mapa = {};
  filas.forEach(function (f) {
    mapa[String(f[0]).trim()] = { moneda: String(f[2]).trim(), tipo: String(f[1]).trim(), saldo: Number(f[4]) || 0 };
  });
  return mapa;
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
