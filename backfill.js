/**
 * FASE 7 — Backfill histórico (por trimestres, desde 2025)
 *
 * Dos frentes, ambos 100% idempotentes (correr mil veces no duplica nada):
 *
 *   A) backfillBCP()         → correos históricos de consumo, acotados por fecha.
 *   B) backfillRecurrentes() → materializa sueldo/padres para meses pasados.
 *
 * Y el tercer frente ya existe: los estados de cuenta históricos entran por la
 * página Conciliar, mes a mes, rellenando lo que el correo no cubra (como
 * acaba de pasar con junio: 5 insertadas).
 *
 * MÉTODO DE TRABAJO POR TRIMESTRE:
 *   1. Editar BACKFILL_DESDE_ / BACKFILL_HASTA_ con el trimestre.
 *   2. Correr backfillBCP() las veces que haga falta hasta que el log diga
 *      "TRIMESTRE COMPLETO". (Apps Script corta ejecuciones a los 6 min; esta
 *      función se auto-detiene a los ~4.5 min y retoma donde quedó, porque
 *      lo procesado sale de la búsqueda por etiqueta.)
 *   3. Conciliar los estados de cuenta de esos meses en la página Conciliar.
 *   4. Revisar en el tablero cada mes del trimestre (navegación ‹ ›) y su %.
 *   5. Siguiente trimestre.
 *
 * NOTA sobre volumen: la corrida horaria normal sigue activa y no estorba
 * (busca lo no-etiquetado, igual que el backfill; se reparten el trabajo).
 * La categorización irá resolviendo los comercios nuevos en lotes de 50 por
 * corrida — o corre categorizarPendientes() a mano varias veces para acelerar.
 */

// ============ EDITAR AQUÍ EL TRIMESTRE A PROCESAR (formato Gmail yyyy/MM/dd) ============
const BACKFILL_DESDE_ = '2025/01/01';  // inclusivo
const BACKFILL_HASTA_ = '2026/08/01';  // EXCLUSIVO: primer día del trimestre siguiente
// ========================================================================================

const BACKFILL_LOTE_ = 50;        // hilos por página de búsqueda
const BACKFILL_LIMITE_MS_ = 270000; // ~4.5 min: margen ante el corte de 6 min

function backfillBCP() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Otra corrida en curso. Salgo.'); return; }

  const t0 = Date.now();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const hoja = ss.getSheetByName(HOJA_MOVIMIENTOS);
    const labelOk = obtenerOCrearLabel_(LABEL_PROCESADO);
    const labelErr = obtenerOCrearLabel_(LABEL_ERROR);
    const ids = cargarIdsExistentes_(hoja);
    const mapeo = cargarMapeoCategorias_(ss);

    const query = 'from:notificacionesbcp.com.pe subject:consumo' +
      ' after:' + BACKFILL_DESDE_ + ' before:' + BACKFILL_HASTA_ +
      ' -label:' + LABEL_PROCESADO + ' -label:' + LABEL_ERROR;

    let ok = 0, dup = 0, err = 0;
    let sinTiempo = false;

    while (!sinTiempo) {
      // Siempre desde 0: lo etiquetado sale solo de la búsqueda.
      const hilos = GmailApp.search(query, 0, BACKFILL_LOTE_);
      if (hilos.length === 0) break;

      for (let h = 0; h < hilos.length; h++) {
        if (Date.now() - t0 > BACKFILL_LIMITE_MS_) { sinTiempo = true; break; }
        const hilo = hilos[h];
        let hiloConError = false;

        hilo.getMessages().forEach(function (msg) {
          const id = msg.getId();
          if (ids.has(id)) { dup++; return; }
          try {
            const mov = parseBCP_(limpiarHtml_(msg.getBody()), id);
            validarMovimiento_(mov);
            mov.categoria = categorizar_(mov.comercio, mapeo);
            mov.referencia = 'https://mail.google.com/mail/u/0/#all/' + id;
            escribirMovimiento_(hoja, mov);
            ids.add(id);
            ok++;
          } catch (e) {
            hiloConError = true;
            err++;
            Logger.log('error_parseo en ' + id + ': ' + e.message);
          }
        });

        if (hiloConError) hilo.addLabel(labelErr);
        else hilo.addLabel(labelOk);
      }
    }

    const resumen = 'Backfill ' + BACKFILL_DESDE_ + ' → ' + BACKFILL_HASTA_ +
      ' · insertados: ' + ok + ' · duplicados: ' + dup + ' · errores: ' + err;
    if (sinTiempo) {
      Logger.log(resumen + ' · TIEMPO AGOTADO: vuelve a correr backfillBCP(), retoma solo.');
    } else {
      Logger.log(resumen + ' · TRIMESTRE COMPLETO (0 pendientes en el rango).');
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * B) Recurrentes históricos: materializa las reglas ACTIVAS de `Recurrentes`
 * para cada mes del rango, con las mismas llaves idempotentes de la Fase 4.
 *
 * ADVERTENCIA: usa los montos ACTUALES de las reglas. Si tu sueldo era distinto
 * en 2025, corre igual y luego edita el Monto en las filas creadas (la regla es
 * el molde; la fila es el registro).
 */

// ============ EDITAR AQUÍ EL RANGO DE MESES (yyyy-MM, ambos inclusivos) ============
const BACKFILL_REC_DESDE_ = '2025-01';
const BACKFILL_REC_HASTA_ = '2026-06';
// ===================================================================================

function backfillRecurrentes() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Otra corrida en curso. Salgo.'); return; }

  try {
    const d = BACKFILL_REC_DESDE_.split('-').map(Number);
    const h = BACKFILL_REC_HASTA_.split('-').map(Number);
    if (d.length !== 2 || h.length !== 2 || !d[0] || !h[0])
      throw new Error('Rango inválido. Formato yyyy-MM, ej. 2025-01.');

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const hojaMov = ss.getSheetByName(HOJA_MOVIMIENTOS);
    const hojaRec = ss.getSheetByName(HOJA_RECURRENTES);
    const ids = cargarIdsExistentes_(hojaMov);
    const tz = Session.getScriptTimeZone();
    const hoy = new Date();

    const n = hojaRec.getLastRow();
    const reglas = n < 2 ? [] : hojaRec.getRange(2, 1, n - 1, 8).getValues()
      .map(validarRegla_).filter(function (r) { return r && r.activo; });

    let creados = 0, saltados = 0;
    let cursor = new Date(d[0], d[1] - 1, 1);
    const tope = new Date(h[0], h[1] - 1, 1);

    while (cursor <= tope) {
      if (cursor <= hoy) { // nunca materializar meses futuros
        const diasDelMes = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
        reglas.forEach(function (regla) {
          ocurrenciasDelMes_(regla, cursor, diasDelMes, tz).forEach(function (oc) {
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
      }
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }

    Logger.log('Backfill recurrentes ' + BACKFILL_REC_DESDE_ + ' → ' + BACKFILL_REC_HASTA_ +
      ' · creados: ' + creados + ' · ya existentes: ' + saltados);
  } finally {
    lock.releaseLock();
  }
}