/**
 * FASE 6 — Ingesta ampliada del BCP con interpretación por DeepSeek
 *
 * Problema que resuelve:
 *   `BUSQUEDA_BCP` solo mira `subject:consumo`, o sea consumos con tarjeta.
 *   Yape, Plin, transferencias, retiros de cajero y débitos automáticos nunca
 *   entraban al registro. El parser determinista no puede cubrirlos porque no
 *   conocemos sus formatos de antemano.
 *
 * Estrategia HÍBRIDA (decidida con el usuario). El LLM es red de emergencia,
 * no la puerta de entrada:
 *
 *   1. Todo correo del BCP pasa PRIMERO por `parseBCP_()`, el parser
 *      determinista ya verificado. Es exacto, gratis y no manda nada afuera.
 *   2. Solo si el parser falla —o sea, es un correo cuyo formato no conocemos—
 *      el cuerpo saneado va a DeepSeek para que lo interprete.
 *
 *   Consecuencia: los consumos con tarjeta, que son la mayoría, siguen sin
 *   generar una sola llamada al LLM. El costo escala con lo raro, no con el
 *   volumen.
 *
 * Frontera de privacidad (esto AMPLÍA la regla de tokens de categorizacion.js,
 * que decía "solo el nombre del comercio, nunca la transacción"):
 *   - Solo sale el cuerpo de correos que el parser NO pudo leer.
 *   - Se manda sin HTML, recortado a MAX_CHARS_LLM_ y con los números largos
 *     (tarjetas, cuentas) enmascarados salvo los últimos 4 dígitos.
 *   - Ver `sanearParaLLM_()`. Si se toca, se toca a conciencia.
 *
 * Uso:
 *   1. probarIngestaLLM()   → SIMULACRO. Lee los últimos 5 correos del BCP, los
 *                             interpreta y escribe el resultado en el Log.
 *                             NO toca la hoja ni pone etiquetas.
 *   2. Si la interpretación se ve correcta → ingestarBCPAmplia() en serio.
 *   3. Recién entonces, apuntar corridaHoraria() a ingestarBCPAmplia().
 */

// ========================= CONFIGURACIÓN =========================

/**
 * Correos del BCP que no son movimientos (claves temporales, promociones,
 * avisos de estado de cuenta). Se etiquetan para no volver a pagarle al LLM
 * por releerlos en cada corrida. Regla 4: quedan visibles, no se descartan.
 */
const LABEL_NO_MOVIMIENTO = 'no_movimiento';

/**
 * Piso de fecha: "empezando desde ahora". Sin esto, la primera corrida ampliada
 * se tragaría TODO el histórico de correos no-consumo del BCP, que nunca fueron
 * etiquetados, en una sola pasada de llamadas al LLM.
 * Formato Gmail: yyyy/MM/dd. Bajarlo es la forma de hacer backfill a propósito.
 */
const INGESTA_LLM_DESDE_ = '2026/07/22';

const BUSQUEDA_BCP_AMPLIA =
  'from:notificacionesbcp.com.pe' +
  ' after:' + INGESTA_LLM_DESDE_ +
  ' -label:' + LABEL_PROCESADO +
  ' -label:' + LABEL_ERROR +
  ' -label:' + LABEL_NO_MOVIMIENTO;

/** Recorte del cuerpo antes de mandarlo. Los correos del BCP son cortos; 2500
 *  caracteres cubren de sobra el bloque de datos de la operación. */
const MAX_CHARS_LLM_ = 2500;

/**
 * Tipos de movimiento válidos.
 *
 * 'traspaso' es dinero que se mueve entre cuentas del mismo titular: pagar la
 * tarjeta de crédito propia, mover de ahorros a corriente. NO es gasto ni
 * ingreso. Se registra igual —el registro debe ser literal— pero las vistas lo
 * excluyen de los totales. Sin esto, pagar el estado de cuenta de la tarjeta
 * contaría el mismo dinero dos veces: una en cada consumo y otra en el pago.
 */
const TIPOS_VALIDOS_ = ['gasto', 'ingreso', 'traspaso'];

/** Métodos de pago que aceptamos del LLM. Validación determinista: cualquier
 *  cosa fuera de esta lista se normaliza a 'otro', no se escribe basura. */
const METODOS_VALIDOS_ = [
  'yape', 'plin', 'transferencia', 'retiro_cajero', 'debito_automatico',
  'tarjeta_debito', 'tarjeta_credito', 'pago_servicio', 'pago_tarjeta', 'otro'
];

// ========================= INGESTA AMPLIADA =========================

function ingestarBCPAmplia() {
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
    const labelNoMov = obtenerOCrearLabel_(LABEL_NO_MOVIMIENTO);

    const idsExistentes = cargarIdsExistentes_(hoja);
    const mapeo = cargarMapeoCategorias_(ss);

    const hilos = GmailApp.search(BUSQUEDA_BCP_AMPLIA, 0, 50);
    let porParser = 0, porLLM = 0, noMov = 0, dup = 0, err = 0;

    hilos.forEach(function (hilo) {
      let conError = false, conMovimiento = false, conNoMov = false;

      hilo.getMessages().forEach(function (msg) {
        const id = msg.getId();
        if (idsExistentes.has(id)) { dup++; return; }

        let mov = null, viaLLM = false;

        // --- Paso 1: parser determinista. Gratis y exacto. ---
        try {
          mov = parseBCP_(limpiarHtml_(msg.getBody()), id);
        } catch (e) {
          mov = null;
        }

        // --- Paso 2: solo si el parser no supo, entra DeepSeek. ---
        if (!mov) {
          try {
            const interpretado = interpretarCorreoBCP_(msg);
            if (!interpretado) {          // el LLM dice: esto no es un movimiento
              conNoMov = true; noMov++;
              return;
            }
            mov = interpretado;
            viaLLM = true;
          } catch (e) {
            conError = true; err++;
            Logger.log('error_parseo (LLM) en ' + id + ': ' + e.message);
            return;
          }
        }

        // --- Paso 3: validación determinista, igual para ambos caminos. ---
        try {
          validarMovimiento_(mov);

          // Un traspaso no necesita categoría de gasto. Dejarlo en
          // 'sin_categoria' haría que categorizarPendientes() le gastara una
          // llamada al LLM para acabar poniéndole "Otros".
          mov.categoria = (mov.tipo === 'traspaso')
            ? 'Traspaso'
            : categorizar_(mov.comercio, mapeo);
          mov.referencia = 'https://mail.google.com/mail/u/0/#all/' + id;

          escribirMovimiento_(hoja, mov);
          idsExistentes.add(id);
          conMovimiento = true;
          if (viaLLM) porLLM++; else porParser++;
        } catch (e) {
          conError = true; err++;
          Logger.log('validación falló en ' + id + ': ' + e.message);
        }
      });

      // Precedencia de etiquetas: un error tapa todo lo demás (queda visible).
      if (conError) hilo.addLabel(labelErr);
      else if (conMovimiento) hilo.addLabel(labelOk);
      else if (conNoMov) hilo.addLabel(labelNoMov);
    });

    Logger.log('Corrida ampliada BCP → parser: ' + porParser + ' · LLM: ' + porLLM +
      ' · no-movimiento: ' + noMov + ' · duplicados: ' + dup + ' · errores: ' + err);
  } finally {
    lock.releaseLock();
  }
}

// ========================= INTERPRETACIÓN CON DEEPSEEK =========================

/**
 * Interpreta un correo del BCP que el parser no supo leer.
 * Devuelve un objeto `mov` listo para validar, o `null` si no es un movimiento.
 * Lanza error si la respuesta del LLM no es utilizable (→ error_parseo).
 */
function interpretarCorreoBCP_(msg) {
  const crudo = interpretarCorreoBCPCrudo_(msg);
  if (!crudo.es_movimiento) return null;

  return movimientoDesdeLLM_(crudo, msg.getId(), msg.getDate());
}

/** La llamada pelada al LLM, sin convertir a `mov`. Separada para que el
 *  simulacro pueda mostrar exactamente lo que respondió DeepSeek. */
function interpretarCorreoBCPCrudo_(msg) {
  const cuerpo = sanearParaLLM_(msg.getBody());
  const entrada = 'ASUNTO: ' + msg.getSubject() + '\n\nCUERPO:\n' + cuerpo;

  const sistema =
    'Eres un extractor de datos de correos del banco BCP (Perú). ' +
    'Recibes UN correo y devuelves SOLO un objeto JSON, sin prosa ni markdown.\n\n' +
    'Esquema exacto:\n' +
    '{\n' +
    '  "es_movimiento": true|false,\n' +
    '  "tipo": "gasto"|"ingreso"|"traspaso",\n' +
    '  "monto": number,\n' +
    '  "moneda": "PEN"|"USD",\n' +
    '  "fecha": "YYYY-MM-DD HH:mm",\n' +
    '  "comercio": string,\n' +
    '  "metodo": ' + METODOS_VALIDOS_.map(function (m) { return '"' + m + '"'; }).join('|') + ',\n' +
    '  "ultimos4": string,\n' +
    '  "num_operacion": string,\n' +
    '  "confianza": "alta"|"media"|"baja"\n' +
    '}\n\n' +
    'Reglas:\n' +
    '- es_movimiento=false si el correo NO registra dinero que entró o salió: ' +
    'claves temporales, promociones, avisos de seguridad, avisos de que tu ' +
    'estado de cuenta está disponible, cambios de datos. En ese caso los demás ' +
    'campos pueden ir vacíos.\n' +
    '- "gasto" es dinero que SALE hacia un tercero (consumo, Yape enviado a ' +
    'otra persona, transferencia a un tercero, pago de un servicio, débito ' +
    'automático).\n' +
    '- "ingreso" es dinero que ENTRA desde un tercero (Yape/Plin recibido, ' +
    'transferencia recibida, abono de sueldo, devolución).\n' +
    '- "traspaso" es dinero que se mueve ENTRE CUENTAS DEL MISMO TITULAR: no ' +
    'es riqueza que entra ni que sale. Es el caso más fácil de equivocar y el ' +
    'más caro: si lo marcas "gasto", el sistema cuenta el mismo dinero dos ' +
    'veces. Usa "traspaso" para:\n' +
    '    * Pago de la tarjeta de crédito PROPIA (el asunto suele decir ' +
    '"Constancia de Pago de Tarjeta de Crédito Propia"). El gasto ya se ' +
    'registró cuando se hizo cada consumo con esa tarjeta; pagar el estado de ' +
    'cuenta no es un gasto nuevo.\n' +
    '    * Transferencias entre cuentas propias (ahorros ↔ corriente), ' +
    'incluidas las enviadas a una cuenta propia en OTRO banco.\n' +
    '    * Depósitos de efectivo en cajero hacia la cuenta propia: es efectivo ' +
    'que vuelve a la cuenta, no dinero nuevo.\n' +
    reglaTitular_() +
    '  OJO: el retiro de efectivo en cajero NO es traspaso, es "gasto". El ' +
    'sistema no sigue el rastro del efectivo, así que se cuenta al salir.\n' +
    '  Si el correo dice "propia", "de tu tarjeta", "entre tus cuentas" o ' +
    'similar, es traspaso. Si la contraparte es OTRA persona o un negocio, no ' +
    'lo es.\n' +
    '- "monto" es el importe de la operación como número, sin símbolo ni comas. ' +
    'Siempre positivo, incluso para gastos: el signo lo da "tipo".\n' +
    '- "moneda": S/ o soles → "PEN". US$ o $ o dólares → "USD". NUNCA conviertas ' +
    'entre monedas ni estimes un tipo de cambio.\n' +
    '- "comercio" es la contraparte: el nombre del negocio, o de la persona a ' +
    'quien se le yapeó / transfirió, o el servicio pagado. Si es un retiro de ' +
    'cajero, usa "Retiro cajero" más la agencia si aparece.\n' +
    '- "fecha": la de la operación, no la del envío del correo. Si el correo no ' +
    'dice la hora, usa 00:00. Si no dice la fecha, devuelve "".\n' +
    '- "ultimos4" y "num_operacion": "" si no aparecen. Nunca los inventes.\n' +
    '- "confianza": "baja" si no estás seguro del monto, la fecha o el tipo. ' +
    'Preferimos que un correo quede marcado para revisión a que entre un dato ' +
    'equivocado al registro financiero. No adivines.';

  return llamarDeepSeekJson_(sistema, entrada);
}

// ================= RECONOCIMIENTO DEL TITULAR =================
//
// Una transferencia a tu propia cuenta en otro banco llega como "Constancia de
// Transferencia a Otros Bancos" y la contraparte es tu propio nombre. Ni el
// parser ni el LLM pueden saber que ese nombre eres tú: hay que decírselo.
//
// El nombre vive en Script Properties (clave TITULAR_NOMBRE), no en el código,
// para no meter datos personales en el repositorio de GitHub.
//
//   Configuración del proyecto → Propiedades del script
//   TITULAR_NOMBRE = Josue Sebastian Salinas Llana
//
// Si la propiedad no está puesta, el sistema NO adivina: sigue funcionando y
// estas transferencias quedan como 'gasto', igual que antes.

/** Nombre del titular, o '' si no está configurado. */
function nombreTitular_() {
  return String(
    PropertiesService.getScriptProperties().getProperty('TITULAR_NOMBRE') || ''
  ).trim();
}

/** Fragmento de prompt que le enseña al LLM a reconocer al titular. */
function reglaTitular_() {
  const t = nombreTitular_();
  if (!t) return '';
  return '    * IMPORTANTE: el titular de estas cuentas se llama "' + t + '". ' +
    'Si la contraparte de una transferencia o depósito es esa misma persona ' +
    '(aunque el nombre venga abreviado o con los apellidos en inicial, por ' +
    'ejemplo "' + t.split(/\s+/).slice(0, 3).join(' ') + '."), entonces se está ' +
    'mandando dinero a sí mismo: es "traspaso", nunca "gasto".\n';
}

/** Quita tildes y puntuación para poder comparar nombres. */
function normalizarNombre_(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Red determinista por si el LLM no reconoce al titular pese al prompt.
 * Exige 2 o más palabras del nombre en común, de 3+ letras, para no dispararse
 * con un apellido suelto.
 *
 * Limitación conocida y aceptada: un familiar que comparta dos apellidos
 * ("Salinas Llana, María") daría falso positivo y su transferencia quedaría
 * como traspaso. Se prefiere ese error —una fila fuera de los totales, pero
 * visible en el detalle— antes que contar dos veces el dinero propio.
 */
function esMismoTitular_(comercio) {
  const titular = nombreTitular_();
  if (!titular || !comercio) return false;

  const tokensComercio = normalizarNombre_(comercio).split(' ');
  const comunes = normalizarNombre_(titular).split(' ').filter(function (t) {
    return t.length >= 3 && tokensComercio.indexOf(t) !== -1;
  });
  return comunes.length >= 2;
}

/**
 * Saneado antes de mandar el correo a DeepSeek.
 * 1. Fuera el HTML.  2. Números largos enmascarados.  3. Recorte.
 * El enmascarado deja los últimos 4 dígitos porque el registro los guarda,
 * pero evita que un número de tarjeta o de cuenta completo salga del script.
 */
function sanearParaLLM_(html) {
  let t = limpiarHtml_(html);

  // Tarjetas escritas en grupos de 4: 4557 8812 3456 7890 → **** **** **** 7890
  t = t.replace(/\b(?:\d{4}[ -]?){3}(\d{4})\b/g, '**** **** **** $1');
  // Cualquier corrida suelta de 9+ dígitos (cuentas, CCI) → ***** + últimos 4.
  // 9 y no menos: los montos y números de operación cortos deben sobrevivir,
  // el LLM los necesita.
  t = t.replace(/\b\d{5,}(\d{4})\b/g, '*****$1');

  if (t.length > MAX_CHARS_LLM_) t = t.slice(0, MAX_CHARS_LLM_);
  return t;
}

/**
 * Convierte la respuesta del LLM en un `mov` del sistema, validando de forma
 * determinista todo lo que el LLM pudo haber alucinado.
 * `fechaCorreo` es el respaldo si el LLM no logró leer la fecha de operación.
 */
function movimientoDesdeLLM_(o, messageId, fechaCorreo) {
  if (String(o.confianza).toLowerCase() === 'baja')
    throw new Error('El LLM reportó confianza baja. Queda para revisión manual.');

  let tipo = String(o.tipo || '').toLowerCase();
  if (TIPOS_VALIDOS_.indexOf(tipo) === -1)
    throw new Error('Tipo inválido del LLM: ' + o.tipo);

  // Red determinista: si la contraparte es el propio titular, es traspaso
  // aunque el LLM haya dicho otra cosa. No confiamos el doble conteo al prompt.
  if (tipo !== 'traspaso' && esMismoTitular_(o.comercio)) {
    Logger.log('Corregido a traspaso (contraparte = titular): ' + o.comercio);
    tipo = 'traspaso';
  }

  const monto = Number(o.monto);
  const moneda = String(o.moneda || '').toUpperCase();

  let metodo = String(o.metodo || '').toLowerCase();
  if (METODOS_VALIDOS_.indexOf(metodo) === -1) metodo = 'otro';

  // Fecha: parseo estricto. Nada de new Date(string), que interpreta zonas
  // horarias distinto según el runtime.
  let fecha = null;
  const m = String(o.fecha || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (m) {
    fecha = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  } else if (fechaCorreo instanceof Date) {
    fecha = fechaCorreo;   // respaldo: la fecha de recepción del correo
  }

  return {
    idMensaje: messageId,
    fecha: fecha,
    tipo: tipo,
    monto: monto,
    moneda: moneda,
    comercio: String(o.comercio || '').trim(),
    metodo: metodo,
    banco: 'BCP',
    ultimos4: String(o.ultimos4 || '').replace(/\D/g, '').slice(-4),
    numOperacion: String(o.num_operacion || '').trim(),
    fuente: 'correo_llm'   // distinguible de 'correo' para poder auditar después
  };
}

/** Llamada genérica a DeepSeek que devuelve un objeto JSON. */
function llamarDeepSeekJson_(sistema, usuario) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('DEEPSEEK_API_KEY');
  if (!apiKey) throw new Error('Falta DEEPSEEK_API_KEY en Script Properties.');

  const payload = {
    model: 'deepseek-chat',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sistema },
      { role: 'user', content: usuario }
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

  const texto = String(JSON.parse(res.getContentText()).choices[0].message.content)
    .replace(/```json|```/g, '').trim();
  const obj = JSON.parse(texto);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj))
    throw new Error('Respuesta no es un objeto JSON.');
  return obj;
}

// ========================= SIMULACRO =========================

/**
 * SIMULACRO — no escribe en la hoja, no pone etiquetas, no consume nada del
 * registro. Toma los últimos 5 correos del BCP (sin importar si ya fueron
 * procesados), los pasa por el mismo flujo híbrido y vuelca el resultado al Log.
 *
 * Correr desde el editor de Apps Script y leer "Registro de ejecución".
 */
function probarIngestaLLM() {
  const hilos = GmailApp.search('from:notificacionesbcp.com.pe', 0, 5);
  if (hilos.length === 0) {
    Logger.log('No se encontró ningún correo del BCP con esa búsqueda.');
    return;
  }

  let n = 0;
  hilos.forEach(function (hilo) {
    hilo.getMessages().forEach(function (msg) {
      if (n >= 5) return;
      n++;

      Logger.log('───────────── ' + n + ' ─────────────');
      Logger.log('Asunto : ' + msg.getSubject());
      Logger.log('Fecha  : ' + msg.getDate());

      // Paso 1: ¿lo resuelve el parser determinista?
      try {
        const mov = parseBCP_(limpiarHtml_(msg.getBody()), msg.getId());
        validarMovimiento_(mov);
        Logger.log('Vía    : PARSER determinista (0 llamadas al LLM)');
        Logger.log('Datos  : ' + JSON.stringify(mov));
        return;
      } catch (e) {
        Logger.log('Vía    : el parser no supo (' + e.message + ') → va a DeepSeek');
      }

      // Paso 2: DeepSeek.
      try {
        const crudo = interpretarCorreoBCPCrudo_(msg);
        Logger.log('LLM    : ' + JSON.stringify(crudo));

        if (!crudo.es_movimiento) {
          Logger.log('Result : NO es movimiento → se etiquetaría "' + LABEL_NO_MOVIMIENTO + '"');
          return;
        }

        const mov = movimientoDesdeLLM_(crudo, msg.getId(), msg.getDate());
        validarMovimiento_(mov);
        Logger.log('Result : SE INSERTARÍA → ' + JSON.stringify(mov));
      } catch (e) {
        Logger.log('Result : quedaría en "' + LABEL_ERROR + '" → ' + e.message);
      }
    });
  });

  Logger.log('═════ Simulacro terminado sobre ' + n + ' correos. Nada se escribió. ═════');
}
