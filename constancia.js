// Constancia de donación de reciclaje: cálculo de impacto ambiental y PDF.
// Sigue el formato de la constancia que Aldeas emitía a mano (ver NOTAS-CONFIG §6).
const PDFDocument = require("pdfkit");
const U = require("./util");

// Materiales que aparecen en la constancia (y en el cierre de cada recojo).
const MATERIALES = ["Papel", "Cartón", "Papel periódico", "PET (botellas)", "Plástico mixto", "RAEE", "Vidrio", "Metal (aluminio)", "Otro"];

// Factores por TONELADA (hoja "Valores en donación" → Estadistica). Editables en eco_config.factores_impacto.
const FACTORES_DEFAULT = {
  "Papel":            { arboles: 17, agua: 26500, energia: 4100, co2: 1400 },
  "Cartón":           { arboles: 8,  agua: 7000,  energia: 1500, co2: 800 },
  "Papel periódico":  { arboles: 12, agua: 18000, energia: 3000, co2: 1100 },
  "PET (botellas)":   { arboles: 0,  agua: 1500,  energia: 5700, co2: 2000 },
  "Plástico mixto":   { arboles: 0,  agua: 1000,  energia: 5000, co2: 1800 },
  "RAEE":             { arboles: 0,  agua: 0,     energia: 10000, co2: 2500 },
  "Vidrio":           { arboles: 0,  agua: 0,     energia: 1000, co2: 315 },
  "Metal (aluminio)": { arboles: 0,  agua: 0,     energia: 14000, co2: 3000 },
  "Otro":             { arboles: 0,  agua: 0,     energia: 0,    co2: 0 },
};
const PLATOS_POR_KG_DEFAULT = 0.186; // 537 kg → 100 platos en la constancia de referencia

// Suma kilos por material de varias reservas ({ material: kg }).
function sumarDetalle(detalles) {
  const total = {};
  for (const d of detalles) for (const [m, v] of Object.entries(d || {})) {
    const n = Number(v); if (!Number.isFinite(n) || n <= 0) continue;
    total[m] = (total[m] || 0) + n;
  }
  return total;
}

function calcularImpacto(detalle, factores = FACTORES_DEFAULT, platosPorKg = PLATOS_POR_KG_DEFAULT) {
  let kg = 0, arboles = 0, agua = 0, energia = 0, co2 = 0;
  for (const [m, v] of Object.entries(detalle || {})) {
    const n = Number(v) || 0; if (n <= 0) continue;
    const f = factores[m] || factores["Otro"] || {};
    const t = n / 1000;
    kg += n; arboles += t * (f.arboles || 0); agua += t * (f.agua || 0); energia += t * (f.energia || 0); co2 += t * (f.co2 || 0);
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return { kg: r2(kg), arboles: Math.round(arboles), agua: r2(agua), energia: r2(energia), co2: r2(co2), platos: Math.round(kg * (Number(platosPorKg) || 0)) };
}

const num = (n, d = 2) => Number(n || 0).toLocaleString("es-PE", { minimumFractionDigits: d, maximumFractionDigits: d });
const fechaTexto = (iso) => { const p = U.parseIsoDate(iso); return p ? `${p.d} de ${U.MESES[p.m - 1]} del ${p.y}` : String(iso || ""); };

/**
 * Genera el PDF. Devuelve una Promise<Buffer>.
 * c: { numero, fecha (iso), razon_social, direccion, desde, hasta, detalle {material: kg}, impacto, firmante, cargo, organizacion }
 */
function generarPdf(c) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 60, bottom: 60, left: 64, right: 64 } });
    const chunks = [];
    doc.on("data", (b) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const org = c.organizacion || "ALDEAS INFANTILES SOS PERU - ASOCIACION NACIONAL";
    const imp = c.impacto || calcularImpacto(c.detalle);
    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Encabezado
    doc.fillColor("#1b5e20").font("Helvetica-Bold").fontSize(11).text("Aldeas Infantiles SOS Perú", { align: "right" });
    doc.fillColor("#6b7280").font("Helvetica").fontSize(9).text(`Constancia N.° ${String(c.numero).padStart(5, "0")}`, { align: "right" });
    doc.moveDown(1.2).fillColor("#111");

    doc.font("Helvetica-Bold").fontSize(11).text(`Estimados Srs. ${c.razon_social}`);
    if (c.direccion) doc.text(String(c.direccion).toUpperCase());
    doc.font("Helvetica").text(`Fecha: ${fechaTexto(c.fecha)}`);
    doc.moveDown(1);
    doc.text("A quien corresponda,");
    doc.moveDown(0.6);
    doc.text(`Por la presente queremos dejar constancia que ${c.razon_social}${c.direccion ? `, con domicilio en ${c.direccion}` : ""}, ha realizado una donación de residuos sólidos reciclables a ${org}, en beneficio de sus actividades de reciclaje y fomento a la economía circular.`, { align: "justify", lineGap: 2 });
    doc.moveDown(0.8);
    doc.font("Helvetica-Bold").text(`Detalle de los materiales donados del: ${U.fechaDdMmYyyy(c.desde)} - ${U.fechaDdMmYyyy(c.hasta)}`, { align: "center" });
    doc.moveDown(0.5);

    // Tabla
    const x0 = doc.page.margins.left + 60, colW = [W - 120 - 130, 130], rowH = 18;
    let y = doc.y;
    const fila = (a, b, bold = false, fill = null) => {
      if (fill) doc.rect(x0, y, colW[0] + colW[1], rowH).fill(fill).fillColor("#111");
      doc.rect(x0, y, colW[0], rowH).stroke("#444"); doc.rect(x0 + colW[0], y, colW[1], rowH).stroke("#444");
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor("#111")
        .text(a, x0 + 6, y + 5, { width: colW[0] - 12, align: bold && !b ? "right" : "left" })
        .text(b, x0 + colW[0] + 6, y + 5, { width: colW[1] - 12, align: bold ? "center" : "left" });
      y += rowH;
    };
    fila("Tipo de material", "Cantidad (kg/und)", true, "#f3f4f6");
    for (const m of MATERIALES) {
      const v = Number(c.detalle?.[m] || 0);
      fila(m === "Otro" ? (c.otro_detalle ? `Otro: ${c.otro_detalle}` : "(Otro detallar)") : m, v > 0 ? num(v, v % 1 ? 2 : 0) : "");
    }
    fila("Total", `${num(imp.kg, 1)} kg`, true);
    doc.x = doc.page.margins.left; doc.y = y + 14;

    doc.font("Helvetica").fontSize(11).text(
      `La reutilización de estos materiales ha logrado: (a) salvar ${imp.arboles} ${imp.arboles === 1 ? "árbol" : "árboles"}, lo que al mismo tiempo contribuye a conservar la biodiversidad y mejora la capacidad de los bosques para captar dióxido de carbono. (b) Ahorrar el consumo de ${num(imp.agua)} m³ de agua, lo que contribuye a mitigar la situación de estrés hídrico. (c) Ahorrar el consumo de ${num(imp.energia)} kWh de energía, reduciendo emisiones asociadas a la generación eléctrica. (d) Y evitar la emisión de ${num(imp.co2)} kg de dióxido de carbono (CO2). La gestión responsable de estos materiales ha prevenido que ${num(imp.kg, 1)} kg de residuos terminen en rellenos sanitarios, prolongando la vida útil de estos sitios y reduciendo la contaminación.`,
      { align: "justify", lineGap: 2 });
    doc.moveDown(0.8);
    if (imp.platos > 0) {
      doc.text(`Gracias al reciclaje de ${num(imp.kg, 1)} kilogramos, se ha logrado garantizar ${imp.platos} platos de comida para niñas, niños y adolescentes en situación de vulnerabilidad y desprotección.`, { align: "justify", lineGap: 2 });
      doc.moveDown(0.8);
    }
    doc.text(`Agradecemos profundamente el compromiso de ${c.razon_social} con el cuidado del medio ambiente y el bienestar social.`, { align: "justify", lineGap: 2 });
    doc.moveDown(1.2);
    doc.text("Atentamente,");
    doc.moveDown(3);
    doc.font("Helvetica-Bold").text(c.firmante || "", { align: "center" });
    doc.text(c.cargo || "Director de Recaudación de Fondos", { align: "center" });
    doc.text("Aldeas Infantiles SOS Perú", { align: "center" });

    // Pie (dentro del margen inferior; sin salto de línea para no abrir una segunda página)
    doc.page.margins.bottom = 0;
    doc.fontSize(8).fillColor("#6b7280").font("Helvetica")
      .text(`Constancia generada por ECO el ${U.fechaHoraLima(new Date())}. Código de verificación: ${c.id ? String(c.id).slice(0, 8).toUpperCase() : "-"}`, doc.page.margins.left, doc.page.height - 40, { width: W, align: "center", lineBreak: false });
    doc.end();
  });
}

module.exports = { MATERIALES, FACTORES_DEFAULT, PLATOS_POR_KG_DEFAULT, sumarDetalle, calcularImpacto, generarPdf };
