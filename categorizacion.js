/**
 * FASE 5 — Categorización con DeepSeek (cacheada)
 *
 * Regla de oro de tokens (sección 6 del plan):
 *   - Se envía SOLO el nombre del comercio, nunca la transacción.
 *   - Todos los comercios nuevos de la corrida van en 1 sola llamada batch.
 *   - Comercio ya mapeado nunca se re-consulta: 1 llamada de por vida.
 *   - Si no hay comercios nuevos → 0 llamadas.
 *
 * Flujo de categorizarPendientes():
 *   1. Busca filas de Movimientos con Categoría = sin_categoria.
 *   2. Primero re-aplica el caché de `Mapeo de Categorías` (cubre patrones
 *      manuales agregados después de la ingesta).
 *   3. Los comercios que sigan sin match → 1 llamada batch a DeepSeek.
 *   4. Validación determinista: solo se acepta una categoría del set oficial.
 *      Respuesta inválida → el comercio queda sin_categoria y se loguea.
 *   5. Lo validado se guarda en Mapeo (Origen = llm) y se aplica a las filas.
 *
 * Instalación:
 *   1. Script Properties (Configuración del proyecto → Propiedades del script):
 *        DEEPSEEK_API_KEY = tu key (ya generada en Fase 0).
 *   2. Pegar este archivo en el proyecto.
 *   3. probarDeepSeek() para verificar la conexión.
 *   4. Reemplazar el trigger horario: correr instalarTriggerHorario() de ESTE
 *      archivo (borra el viejo y apunta a corridaHoraria, que hace
 *      ingesta → categorización en secuencia).
 */

const CATEGORIAS_OFICIALES_ = [
  'Alimentación', 'Restaurantes/Delivery', 'Transporte', 'Hogar',
  'Servicios/Suscripciones', 'Salud', 'Entretenimiento', 'Compras',
  'Retiros efectivo', 'Educación', 'Otros'
];

const DEEPSEEK_URL_ = 'https://api.deepseek.com/chat/completions';
const MAX_COMERCIOS_POR_LLAMADA_ = 50;

/** Corrida completa: ingesta y luego categorización. El trigger apunta aquí. */
function corridaHoraria() {
  ingestarBCP();
  try {
    categorizarPendientes();
  } catch (e) {
    // La categorización nunca debe tumbar la ingesta: el registro es el activo.
    Logger.log('categorizarPendientes falló (la ingesta ya quedó a salvo): ' + e.message);
  }
}

function categorizarPendientes() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Otra corrida en curso. Salgo.'); return; }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const hojaMov = ss.getSheetByName(HOJA_MOVIMIENTOS);
    const n = hojaMov.getLastRow();
    if (n < 2) return;

    // 1. Filas pendientes: [filaSheet, comercio]
    const datos = hojaMov.getRange(2, 6, n - 1, 2).getValues(); // F=Comercio, G=Categoría
    const pendientes = [];
    datos.forEach(function (f, i) {
      if (String(f[1]).trim() === 'sin_categoria' && String(f[0]).trim() !== '') {
        pendientes.push({ fila: i + 2, comercio: String(f[0]).trim() });
      }
    });
    if (pendientes.length === 0) { Logger.log('Sin pendientes. 0 llamadas.'); return; }

    // 2. Re-aplicar caché existente (patrones manuales o de corridas previas)
    let mapeo = cargarMapeoCategorias_(ss);
    let porCache = aplicarCategorias_(hojaMov, pendientes, mapeo);

    // 3. Comercios únicos aún sin match → batch a DeepSeek
    const sinMatch = {};
    pendientes.forEach(function (p) {
      if (categorizar_(p.comercio, mapeo) === 'sin_categoria') sinMatch[p.comercio] = true;
    });
    const nuevos = Object.keys(sinMatch).slice(0, MAX_COMERCIOS_POR_LLAMADA_);
    if (nuevos.length === 0) {
      Logger.log('Resueltos por caché: ' + porCache + '. 0 llamadas.');
      return;
    }

    const respuesta = llamarDeepSeek_(nuevos);

    // 4. Validación determinista + 5. guardar en caché y aplicar
    const hojaMapeo = ss.getSheetByName(HOJA_MAPEO);
    let validados = 0;
    nuevos.forEach(function (comercio) {
      const cat = String(respuesta[comercio] || '').trim();
      if (CATEGORIAS_OFICIALES_.indexOf(cat) === -1) {
        Logger.log('Categoría inválida para "' + comercio + '": "' + cat + '". Queda sin_categoria.');
        return;
      }
      hojaMapeo.appendRow([comercio.toLowerCase(), cat, 'llm']);
      validados++;
    });

    mapeo = cargarMapeoCategorias_(ss);
    const porLLM = aplicarCategorias_(hojaMov, pendientes, mapeo);

    Logger.log('Categorización → caché: ' + porCache + ' filas · LLM: ' + validados +
      '/' + nuevos.length + ' comercios válidos · filas actualizadas: ' + porLLM);
  } finally {
    lock.releaseLock();
  }
}

/** Escribe la categoría en las filas pendientes que ahora tengan match. Devuelve cuántas. */
function aplicarCategorias_(hojaMov, pendientes, mapeo) {
  let actualizadas = 0;
  pendientes.forEach(function (p) {
    const cat = categorizar_(p.comercio, mapeo);
    if (cat !== 'sin_categoria') {
      hojaMov.getRange(p.fila, 7).setValue(cat); // G = Categoría
      actualizadas++;
    }
  });
  return actualizadas;
}

/** 1 llamada batch. Entrada: nombres de comercio. Salida: {comercio: categoría}. */
function llamarDeepSeek_(comercios) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('DEEPSEEK_API_KEY');
  if (!apiKey) throw new Error('Falta DEEPSEEK_API_KEY en Script Properties.');

  const payload = {
    model: 'deepseek-chat',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'Clasificas comercios de Perú en categorías de gasto. ' +
          'Responde SOLO un objeto JSON {"comercio":"categoria"}, sin prosa. ' +
          'Categorías permitidas: ' + CATEGORIAS_OFICIALES_.join(' | ') +
          '. Si dudas, usa "Otros".'
      },
      { role: 'user', content: JSON.stringify(comercios) }
    ]
  };

  const res = UrlFetchApp.fetch(DEEPSEEK_URL_, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200)
    throw new Error('DeepSeek HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));

  const cuerpo = JSON.parse(res.getContentText());
  const texto = String(cuerpo.choices[0].message.content)
    .replace(/```json|```/g, '').trim();
  const obj = JSON.parse(texto);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj))
    throw new Error('Respuesta no es un objeto JSON.');
  return obj;
}

/** Prueba de humo: 1 llamada con 2 comercios conocidos. Revisar el log. */
function probarDeepSeek() {
  const r = llamarDeepSeek_(['IZI*BENDITA BURGER', 'FARMACIA INKAFARMA']);
  Logger.log(JSON.stringify(r));
}

/** Reemplaza el trigger de Fase 1: ahora la corrida horaria es ingesta + categorización. */
function instalarTriggerHorario() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'ingestarBCP' || fn === 'corridaHoraria') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('corridaHoraria').timeBased().everyHours(1).create();
  Logger.log('Trigger horario apuntando a corridaHoraria (ingesta → categorización).');
}