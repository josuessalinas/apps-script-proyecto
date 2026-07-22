/**
 * FASE 2 — Tablero mínimo (web app privada)
 *
 * Instalación:
 *   1. En el mismo proyecto de Apps Script, crear un archivo de script nuevo
 *      y pegar este contenido.
 *   2. Crear un archivo HTML llamado exactamente "tablero" y pegar tablero.html.
 *   3. Implementar → Nueva implementación → Aplicación web:
 *        Ejecutar como: Yo mismo
 *        Quién tiene acceso: Solo yo
 *   4. Abrir la URL /exec. El login de Google es la autenticación.
 *
 * El tablero es desechable: solo LEE el Sheet, nunca escribe.
 */

// Asegúrate de tener declarada esta constante en algún lugar de tu proyecto.
// const HOJA_MOVIMIENTOS = 'Movimientos'; 

const MESES_ES_ = ['enero','febrero','marzo','abril','mayo','junio',
  'julio','agosto','septiembre','octubre','noviembre','diciembre'];

function doGet(e) {
  const pagina = e && e.parameter ? e.parameter : {};

  // Ruta: análisis
  if (pagina.page === 'analisis') {
    const t = HtmlService.createTemplateFromFile('analisis');
    t.url = ScriptApp.getService().getUrl();
    return t.evaluate()
      .setTitle('Análisis financiero')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  // Ruta: móvil
  if (pagina.page === 'movil') {
    const t = HtmlService.createTemplateFromFile('movil');
    t.url = ScriptApp.getService().getUrl();
    return t.evaluate()
      .setTitle('Móvil')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
  }

  // Ruta: conciliar / tablero (por defecto)
  const esConciliar = pagina.pagina === 'conciliar';
  const plantilla = HtmlService.createTemplateFromFile(esConciliar ? 'conciliar' : 'tablero');
  plantilla.url = ScriptApp.getService().getUrl();
  return plantilla.evaluate()
    .setTitle(esConciliar ? 'Conciliación' : 'Registro financiero')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Agrega los movimientos del mes indicado por offset (0 = mes actual, -1 = anterior).
 * Devuelve solo datos ya formateados: el HTML no calcula nada.
 */
function obtenerDatosTablero(offsetMes) {
  offsetMes = Number(offsetMes) || 0;
  const hoy = new Date();
  const ini = new Date(hoy.getFullYear(), hoy.getMonth() + offsetMes, 1);
  const fin = new Date(ini.getFullYear(), ini.getMonth() + 1, 1);

  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_MOVIMIENTOS);
  const n = hoja.getLastRow();
  const filas = n < 2 ? [] : hoja.getRange(2, 1, n - 1, 14).getValues();

  // Índices de columna (base 0): 1 Fecha, 2 Tipo, 3 Monto, 4 Moneda, 5 Comercio, 6 Categoría
  const gastos = { PEN: 0, USD: 0 };
  const ingresos = { PEN: 0, USD: 0 };
  const porCategoria = {}; // nombre → {PEN, USD}
  const movimientos = [];
  let conciliables = 0, conciliados = 0; // fuente correo / estado_cuenta

  filas.forEach(function (f) {
    const fecha = f[1];
    if (!(fecha instanceof Date) || fecha < ini || fecha >= fin) return;
    const tipo = String(f[2]);
    const monto = Number(f[3]);
    const moneda = String(f[4]);
    if (!(monto > 0) || (moneda !== 'PEN' && moneda !== 'USD')) return;

    if (tipo === 'ingreso') {
      ingresos[moneda] += monto;
    } else {
      gastos[moneda] += monto;
      const cat = String(f[6]) || 'sin_categoria';
      if (!porCategoria[cat]) porCategoria[cat] = { PEN: 0, USD: 0 };
      porCategoria[cat][moneda] += monto;
    }

    const fuente = String(f[11]);
    if (fuente === 'correo' || fuente === 'estado_cuenta') {
      conciliables++;
      if (f[12] === true) conciliados++;
    }

    movimientos.push({
      fecha: fecha.getTime(),
      dia: fecha.getDate() + ' ' + MESES_ES_[fecha.getMonth()].slice(0, 3),
      tipo: tipo, monto: monto, moneda: moneda,
      comercio: String(f[5]), categoria: String(f[6])
    });
  });

  movimientos.sort(function (a, b) { return b.fecha - a.fecha; });

  const categorias = Object.keys(porCategoria).map(function (nombre) {
    return { nombre: nombre, PEN: porCategoria[nombre].PEN, USD: porCategoria[nombre].USD };
  }).sort(function (a, b) { return (b.PEN + b.USD * 4) - (a.PEN + a.USD * 4); });
  // El *4 es solo para ORDENAR categorías mixtas de forma razonable; jamás se muestra convertido.

  return {
    etiquetaMes: MESES_ES_[ini.getMonth()] + ' ' + ini.getFullYear(),
    offset: offsetMes,
    gastos: gastos,
    ingresos: ingresos,
    categorias: categorias,
    recientes: movimientos.slice(0, 8),
    totalMovimientos: movimientos.length,
    conciliacion: {
      conciliables: conciliables,
      conciliados: conciliados,
      pct: conciliables > 0 ? Math.round(conciliados / conciliables * 100) : null
    }
  }; // <- El error de sintaxis estaba aquí (faltaba cerrar el objeto y la función)
}