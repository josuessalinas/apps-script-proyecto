# Guía de trabajo — Registro financiero personal (Google Apps Script)

Sistema personal de registro de gastos e ingresos. Vive en Google Apps Script,
lee correos del BCP, categoriza con un LLM, concilia contra estados de cuenta en
PDF y lo muestra en cuatro vistas web privadas.

**Idioma del proyecto: español.** Código, comentarios, mensajes de commit e
interfaz están en español. Mantenlo así.

---

## Lo primero: el flujo de sincronización

Esta carpeta se sincroniza a **dos** destinos independientes. Ninguno se
actualiza solo.

```
carpeta local  ──git push──▶  GitHub (respaldo e historial)
      │
      └────clasp push────▶  proyecto Apps Script  ──clasp deploy──▶  URL en vivo
```

**Después de editar cualquier archivo, corre los tres pasos:**

```bash
git add <archivos>                     # nunca -A, ver "Trampa conocida"
git commit -m "..."
git push

clasp push
clasp deploy -i AKfycbwlEON3N_2gq63l1TrZoUFcfW1v04WqsPwz2-OFhw3bnXG5_wfhMtKFldPOZecKfTynzg -d "descripción"
```

El dueño de la carpeta pidió explícitamente que esto se haga **automáticamente,
sin preguntar**, porque se le olvida hacerlo a mano. Es una autorización
permanente para este repositorio. Usa criterio igual: si algo quedó a medias o
te pidieron no publicar todavía, espera.

### Sobre el tercer paso (`clasp deploy`)

| Qué cambiaste | ¿Hace falta desplegar? |
|---|---|
| Funciones que corren por trigger o a mano (`ingestarBCP`, `categorizarPendientes`, `materializarRecurrentes`, `backfillBCP`) | **No.** Siempre usan el código más reciente. |
| Archivos `.html` o `doGet` | **Sí.** La URL apunta a una versión congelada. |

El usuario navega con la **implementación versionada**, no con la de prueba
`@HEAD`. Si no despliegas, sus cambios de interfaz **no se ven** y parecerá que
no hiciste nada. El ID de arriba es el correcto — confírmalo con
`clasp list-deployments` si algún día deja de funcionar, y asegúrate de tomar el
versionado, no el `@HEAD`.

### URL en vivo

```
https://script.google.com/macros/s/AKfycbwlEON3N_2gq63l1TrZoUFcfW1v04WqsPwz2-OFhw3bnXG5_wfhMtKFldPOZecKfTynzg/exec
```

Es fija: el ID no cambia al redesplegar, solo sube el número de versión. Rutas:
`?page=analisis`, `?page=movil`, `?pagina=conciliar` (ojo: `pagina`, no `page`,
en esta última — así lo lee `doGet`).

### Entorno

`clasp` v3 ya está instalado y con sesión iniciada. La API de Apps Script ya está
habilitada en la cuenta. `.clasp.json` ya tiene el `scriptId`. No hace falta
configurar nada.

---

## ⚠ Trampa conocida: `git add -A` deshace correcciones

**Ya pasó una vez y costó trabajo.** Algo externo —el editor web de Apps Script,
o un `clasp pull`— a veces restaura archivos locales a su versión anterior sin
avisar. Si en ese momento haces `git add -A`, commiteas la regresión encima de
tus propias correcciones y quedan revertidas en silencio.

**Lista siempre los archivos explícitamente en `git add`.** Y si vas a hacer un
commit grande, revisa `git status` antes: un archivo que no tocaste apareciendo
como modificado es la señal de alarma.

---

## Arquitectura

### Backend (`.js` — se ejecutan en el servidor de Google)

| Archivo | Qué hace |
|---|---|
| `ingesta inicial bcp.js` | **Base del sistema.** Constantes globales (`HOJA_MOVIMIENTOS`, etiquetas), `setupInicial()`, el parser `parseBCP_()` y utilidades que todos los demás reutilizan: `cargarIdsExistentes_`, `escribirMovimiento_`, `categorizar_`, `validarMovimiento_`. `ingestarBCP()` quedó en desuso: cubría solo `subject:consumo`. |
| `ingesta llm.js` | **Ingesta ampliada.** `ingestarBCPAmplia()` lee *todos* los correos del BCP. Cada uno pasa primero por `parseBCP_()`; solo si falla, el cuerpo saneado va a DeepSeek. Aquí viven las redes deterministas que corrigen al LLM: `REGLAS_TIPO_POR_ASUNTO_`, `esMismoTitular_`. `probarIngestaLLM()` es el simulacro. |
| `categorizacion.js` | Categoriza con DeepSeek en lote, cacheando en la hoja `Mapeo de Categorías`. Aquí vive `corridaHoraria()` (ingesta → categorización) y el `instalarTriggerHorario()` bueno. |
| `conciliacion.js` | Recibe el texto del PDF ya extraído en el navegador, lo pasa por DeepSeek y cruza contra `Movimientos` **del mismo banco** por moneda + monto + fecha ±3 días. `detectarBanco_()` identifica el banco contando apariciones en el texto; si no hay ganador claro, exige elegirlo a mano. **Nunca asumas un banco por defecto** — tenerlo fijo en `'BCP'` hizo que un estado del BBVA se registrara como BCP. |
| `reparacion.js` | De un solo uso: arregla las filas que quedaron con el banco equivocado. Todo viene en pareja `simular…` / `aplicar…`. Borrable una vez usado. |
| `recurrentes.js` | Materializa ingresos fijos (sueldo, etc.) por mes, de forma idempotente. |
| `backfill.js` | Carga histórica de correos y de recurrentes. Se auto-detiene a los ~4.5 min por el corte de 6 min de Apps Script. |
| `tablero backend.js` | `doGet()` (enrutador de las 4 vistas) y `obtenerDatosTablero()`. |
| `visualizer.js` | Solo `obtenerDatosAnalisis()`, que alimenta `analisis.html` y `movil.html`. |

### Frontend (`.html`)

| Archivo | Ruta | Llama a |
|---|---|---|
| `tablero.html` | por defecto | `obtenerDatosTablero(offset)` |
| `analisis.html` | `?page=analisis` | `obtenerDatosAnalisis()` |
| `movil.html` | `?page=movil` | `obtenerDatosAnalisis()` |
| `conciliar.html` | `?pagina=conciliar` | `conciliarTextoEstado(texto, etiqueta)` |

---

## Reglas del dominio — no las rompas

1. **Nunca contar el mismo dinero dos veces.** Existe un tercer tipo de
   movimiento además de `gasto` e `ingreso`: **`traspaso`**, para dinero que se
   mueve entre cuentas del mismo titular — pagar la tarjeta de crédito propia,
   transferir a tu cuenta en otro banco, depositar efectivo en tu cajero. Se
   registra (el registro es literal) pero **no entra a los totales**. Pagar el
   estado de cuenta de la tarjeta no es un gasto nuevo: el gasto ya se registró
   en cada consumo.

   Cuidado al tocar los agregadores: `tablero backend.js` tenía un `else` que
   contaba como gasto todo lo que no fuera `ingreso`. Ahora la comparación de
   `gasto` es explícita en las dos vistas. Si agregas un tipo nuevo, revisa
   `obtenerDatosTablero` **y** `obtenerDatosAnalisis`.

   El dinero entra al registro por **dos** puertas y las dos tienen que conocer
   el tipo: los correos (`ingesta llm.js`) y los estados de cuenta en PDF
   (`conciliacion.js`). Cerrar solo una deja el doble conteo entrando por la
   otra. Cada una tiene sus reglas deterministas —`REGLAS_TIPO_POR_ASUNTO_` y
   `REGLAS_TIPO_POR_DESCRIPCION_`— más `esMismoTitular_`, que comparten.

   El retiro de efectivo en cajero sí es `gasto`: el sistema no rastrea el
   efectivo, así que se cuenta al salir. Es una asimetría deliberada respecto
   del depósito.

2. **Nunca convertir monedas.** PEN y USD se tratan como mundos separados en
   todo el sistema. No hay tipo de cambio en ninguna parte y es deliberado: el
   registro debe ser literal. Si algún día se agrega una vista consolidada,
   tiene que mostrar la tasa usada y su fecha, explícitamente.

3. **Todo es idempotente.** Cada movimiento lleva una llave única en la columna
   `ID Mensaje`: el ID del correo de Gmail, o una llave determinista como
   `recurrente|{id}|{yyyy-MM}` o `estado_cuenta|{fecha}|{monto}|{moneda}|{n}`.
   Correr cualquier función mil veces no debe duplicar ni una fila. Si agregas
   una fuente nueva, diséñale su llave antes de escribir código.

   **Las etiquetas de Gmail NO sirven para decidir qué procesar.** Son por
   *hilo*, y nosotros procesamos por *mensaje*: cuando el BCP manda un correo
   con un asunto repetido, Gmail lo cuelga del hilo existente, que ya está
   etiquetado `procesado`. Una búsqueda con `-label:procesado` descarta el hilo
   entero y ese correo nuevo no se lee nunca, pero se ve etiquetado como
   procesado. Pasó el 2026-07-22.

   Lo que deduplica es el `ID Mensaje` en la hoja, más la hoja
   `Correos Ignorados` para los que ya se evaluaron y se descartaron. Las
   etiquetas quedaron solo para que se vea el estado en Gmail y para acotar la
   búsqueda de atraso; por eso hay además un barrido reciente que las ignora.

4. **El registro es el activo.** Ante la duda, prioriza no perder ni corromper
   datos por encima de cualquier otra cosa. Por eso `corridaHoraria()` envuelve
   la categorización en `try/catch`: si el LLM falla, la ingesta ya quedó a
   salvo.

5. **Cero pérdidas silenciosas.** Un correo que no se pudo parsear se etiqueta
   `error_parseo` y queda visible, nunca se descarta sin dejar rastro.

6. **Lo que sale hacia DeepSeek está acotado, y el LLM nunca tiene la última
   palabra.** La regla vieja era "solo el nombre del comercio, nunca la
   transacción". Con la ingesta ampliada dejó de ser cierta y así quedó:

   - `categorizacion.js` sigue mandando **solo nombres de comercio**, en lote y
     cacheados. No lo aflojes.
   - `ingesta llm.js` manda el **cuerpo del correo**, pero únicamente de los que
     `parseBCP_()` no supo leer — los consumos con tarjeta, que son la mayoría,
     nunca salen. Antes de enviarlo, `sanearParaLLM_()` quita el HTML, enmascara
     tarjetas y cuentas dejando los últimos 4 dígitos, y recorta a 2500
     caracteres.
   - **Todo lo que el LLM devuelve se re-valida de forma determinista** en
     `movimientoDesdeLLM_()`: tipo, moneda, método y fecha con parseo estricto.
     Si DeepSeek reporta `confianza: "baja"`, el correo se rechaza a
     `error_parseo` en vez de entrar al registro.
   - Cuando una decisión ya está tomada a nivel de dominio, **no se le pregunta
     al LLM**: se fija en código (`REGLAS_TIPO_POR_ASUNTO_`). Se intentó
     resolver el depósito en cajero afinando el prompt y el modelo lo ignoró
     tres corridas seguidas. Afinar el prompt no es una estrategia de corrección.

   No confíes en `ultimos4` cuando `Fuente` sea `correo_llm`: en correos con más
   de una cuenta, DeepSeek elige una arbitrariamente y el valor cambia entre
   corridas pese a `temperature: 0`. La conciliación cruza por moneda + monto +
   fecha, no por ese campo.

7. **La clave del PDF jamás llega al servidor.** `conciliar.html` descifra el
   PDF en el navegador con pdf.js y solo envía el texto extraído. No muevas esa
   frontera.

8. **Todas las funciones que escriben toman `LockService`.** Respétalo al
   agregar funciones nuevas que toquen el Sheet.

---

## Convenciones de estilo

- Las funciones que terminan en guion bajo (`parseBCP_`, `cargarIdsExistentes_`)
  son privadas por convención de Apps Script: no aparecen en el menú de
  ejecución del editor.
- Apps Script junta **todos** los `.js` en un mismo ámbito global. Dos funciones
  con el mismo nombre en archivos distintos no dan error: gana una según el
  orden de carga, en silencio. Antes de agregar una función, verifica que el
  nombre no exista ya (`grep -rn "function nombre" *.js`).
- Los `.html` son plantillas: `<?= url ?>` lo inyecta `doGet`. Si creas una
  vista nueva, hay que registrarla en el enrutador de `doGet`.
- Escapa siempre lo que venga del Sheet antes de meterlo en `innerHTML`. Cada
  vista tiene su `esc()`. Para texto plano, `textContent` es mejor.
- El CSS está duplicado en las cuatro vistas. Es deuda conocida; la solución
  sería un helper `include()` en el backend y un `estilos.html` compartido.

---

## Preferencias de diseño (aprendidas a las malas)

- **Se intentó un rediseño estilo Bloomberg Terminal (ámbar sobre negro,
  monoespaciada, alta densidad) y fue rechazado.** No lo reintentes sin que te
  lo pidan.
- El diseño vigente es el de siempre: **IBM Plex Sans**, tarjetas redondeadas,
  espaciado amplio. `tablero.html`, `analisis.html` y `conciliar.html` usan
  fondo azul-grisáceo (`#131722`) con azul TradingView para PEN y naranja para
  USD. `movil.html` tiene su propia identidad, más terrosa (verde salvia + azul).
- **Las cuatro vistas respetan el tema claro/oscuro del dispositivo**, con botón
  para cambiarlo a mano. En `movil.html` y en las que usan gráficos, la elección
  se guarda en `localStorage` (con `try/catch`: la página corre dentro de un
  iframe).
- Prefiere **cambios incrementales y revisables** a reescrituras completas. El
  usuario quiere ver cada cambio, no recibir todo rehecho de golpe.

### Bug recurrente con el botón de tema

Ya apareció dos veces. Al agregar un botón de tema, verifica las tres cosas:

1. Que el CSS incluya `.tema svg{width:16px;height:16px;display:none}` — sin
   tamaño explícito los íconos salen gigantes.
2. Que estén las reglas `html[data-theme="dark"] .tema .i-sun{display:block}` y
   su equivalente para `light` — si no, se ven el sol y la luna a la vez.
3. Que el `addEventListener` esté **fuera** de la función de carga de datos. Si
   está dentro, se acumula un listener por cada recarga y un clic termina
   alternando N veces.

---

## Antes de dar algo por terminado

No hay pruebas automatizadas. Como mínimo, verifica la sintaxis de los bloques
`<script>` antes de desplegar — un error ahí rompe la vista entera y solo se
descubre abriéndola:

```bash
node -e "
const fs=require('fs'),vm=require('vm');
for(const f of ['tablero.html','conciliar.html','movil.html','analisis.html']){
  const html=fs.readFileSync(f,'utf8');
  const re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m,i=0;
  while((m=re.exec(html))!==null){ i++;
    try{ new vm.Script(m[1]); console.log('OK   '+f+' bloque '+i); }
    catch(e){ console.log('FAIL '+f+' bloque '+i+' -> '+e.message); process.exitCode=1; }
  }
}"
```

Para los `.js` del backend no sirve `node --check` tal cual (usan APIs de Apps
Script), pero sí puedes revisar que no haya nombres de función duplicados entre
archivos.

Y sé honesto al reportar: si algo quedó sin verificar, dilo. Estos archivos
manejan el registro financiero real de una persona.

---

## Mejoras pendientes, por prioridad

Discutidas con el usuario, aún sin hacer:

## ⏸ RETOMAR AQUÍ — sesión del 2026-07-22

El backfill del histórico quedó **construido, probado en frío y sin correr**.
Nada de lo que sigue está hecho a medias en el registro: la hoja está sana.

**Paso 1 — verificar los consumos con tarjeta de crédito (bloqueante).**
Son 66 correos del histórico que `parseBCP_` procesará, apoyados en un
comentario de `ingesta inicial bcp.js:174` que admite que el caso crédito es
*"PROVISIONAL hasta traer un correo real de crédito"*. Nunca se verificó. Hay
que exportar el correo de ejemplo `19f7b28165262d17` (guardarlo con un nombre
terminado en `-BCP.html`, que el `.gitignore` ya excluye) y comprobar el parser
contra él, como se hizo con `parseTransferenciaBCP_`. Si el parser falla,
entran 66 filas malas de golpe.

**Paso 2 — backfill de prueba, un solo mes.** Poner
`BACKFILL_AMPLIO_DESDE_ = '2026-06'` en `backfill llm.js`, correr
`backfillBCPAmplio()` una vez y revisar en la hoja cómo quedaron esas filas.

**Paso 3 — backfill completo.** Si el mes de prueba se ve bien: poner
`'2025-01'`, correr `reiniciarBackfillAmplio()` y repetir `backfillBCPAmplio()`
hasta que el log diga `TERMINADO`. Costo medido: ~21 llamadas al LLM para 19
meses, porque ~532 correos los resuelve un parser y ~59 se descartan por asunto.

**Paso 4 — bajar `INGESTA_LLM_DESDE_`** (hoy `2026/07/22`) para que la corrida
horaria deje de ignorar lo anterior. Después del backfill ya no hay riesgo de
avalancha: lo viejo estará registrado y se salta por `ID Mensaje`.

Decidido y ya implementado en esta sesión, no volver a discutirlo:
- El **wardadito** es el bolsillo de ahorro propio: aportes y retiros son
  `traspaso` en ambos sentidos.
- **Retiro** de efectivo en cajero o agente es `gasto`; **depósito** en cajero
  es `traspaso`. Asimetría deliberada: el efectivo no se rastrea después.
- `Se rechazó tu compra` **no es un movimiento** y se descarta por asunto, no
  se le pregunta al LLM: una compra rechazada no ocurrió.

Sin verificar todavía, ser escéptico:
- El prompt de conciliación con `traspaso` **nunca se ejercitó contra un PDF
  real**, ni la detección de banco.
- Formatos de correo nunca vistos: Yape enviado y recibido, pago de servicio,
  retiro en agente, y **cualquier movimiento en USD**.
- `ultimos4` es inestable cuando viene del LLM (ver regla 6).

---

## Mejoras pendientes, por prioridad

**1. Cobertura de ingesta — ~~el hueco más grande~~ hecho para el BCP
(2026-07-22).** `ingestarBCPAmplia()` en `ingesta llm.js` cubre todo correo del
BCP, no solo `subject:consumo`, con la cadena parser determinista → descarte por
asunto → DeepSeek. Verificado en simulacro contra 5 correos reales y contra los
44 asuntos distintos que devolvió `inventarioCorreosBCP()`.

Lo que queda de este punto:
- **Otros bancos** siguen sin ingesta por correo. El BBVA solo existe si se sube
  su PDF. Un banco nuevo necesita su propia búsqueda de Gmail; el resto del flujo
  se reutiliza tal cual.
- **Más parsers deterministas.** Cada formato que deja de ir al LLM es una
  llamada que no se paga nunca más. Por volumen convienen: retiro en cajero
  (34), retiro de wardadito (31), pago de tarjeta propia (29), aporte a
  wardadito (13), pago de servicio (13), retiro en agente (10) — 130 correos.
  Hace falta un correo de muestra de cada uno. **Nunca escribir un parser a
  ciegas**: sin muestra, que lo haga el LLM.

**2. Reparación pendiente de correr (`reparacion.js`).** El usuario ya corrigió
a mano la columna `Banco` de las filas del BBVA, pero quedaron dos cosas sin
hacer. Nada de esto se ha ejecutado todavía:

- `simular/aplicarNormalizarLlaves()` — esas filas conservan la llave en
  formato viejo `estado_cuenta|fecha|monto|moneda|n`, sin el banco. Volver a
  subir ese PDF del BBVA **insertaría todo duplicado**: la compatibilidad hacia
  atrás de `cruzarItems_` solo cubre el BCP. Es mecánico, no hay que
  identificar filas.
- `simular/aplicarResetConciliado()` — durante la corrida con el banco fijo en
  BCP, cualquier movimiento del BCP que coincidiera en moneda, monto y fecha
  ±3 días con una transacción del BBVA quedó `Conciliado = TRUE` sin respaldo.
  No hay forma de distinguir cuáles. La salida limpia es desmarcar el período y
  volver a subir el estado del BCP. `Conciliado` es dato derivado: se regenera.

`reparacion.js` es de un solo uso; se borra cuando esto quede hecho.

**3. `ultimos4` inestable desde el LLM — decisión pendiente.** Para el mismo
correo, DeepSeek devolvió `9055` y `4555` en dos corridas, pese a
`temperature: 0`: son las cuentas origen y destino, y elige una arbitrariamente.
`parseTransferenciaBCP_` confirmó que la correcta es la origen (`9055`).
Propuesta sin aprobar: dejar el campo vacío cuando el movimiento venga por LLM
en una transferencia, porque un número plausible pero falso es peor que un campo
vacío. No afecta la conciliación, que cruza por moneda + monto + fecha.

**4. Presupuestos por categoría.** Hoy el sistema registra pero no gobierna. Una
hoja `Presupuestos` y una columna de varianza lo volverían una herramienta de
decisión.

**5. Saldos de cuentas.** Se registran flujos, no saldos. El sistema no puede
responder "¿cuánto tengo?".

**6. Escrituras por lote.** `cruzarItems_` y el backfill hacen `appendRow()` y
`setValue()` dentro de bucles: una llamada a la API de Sheets por fila. Agrupar
en `setValues()` sería órdenes de magnitud más rápido y aliviaría el límite de
6 minutos.

**7. `categorizar_` depende del orden de la hoja.** Gana el primer patrón que
haga `indexOf`, así que uno corto y genérico se come a los específicos. Debería
ordenar por longitud de patrón descendente.

**8. Sin pruebas.** `parseBCP_` y el emparejador de `cruzarItems_` merecen tests
con correos y estados de ejemplo.

**9. Sin bitácora.** No hay rastro de qué corrida insertó o categorizó qué.

**10. Configuración incrustada.** `BACKFILL_DESDE_`, `BACKFILL_HASTA_` y
`FECHA_INICIO_RECURRENTES` obligan a editar código y redesplegar para cada
trimestre. Deberían vivir en Script Properties o en una hoja `Config`.

**11. `obtenerDatosAnalisis()` manda la hoja entera al navegador** en cada carga.
A unos miles de filas va bien; más allá conviene agregar en el servidor y cachear.

---

## Secretos

`DEEPSEEK_API_KEY` vive en las Propiedades del script (Configuración del
proyecto → Propiedades del script). **Nunca** la escribas en el código ni la
commitees.
