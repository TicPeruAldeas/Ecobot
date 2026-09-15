const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../constancia");
const { createMailer, PLANTILLAS } = require("../mailer");

test("impacto: reproduce la constancia de referencia (537 kg → 5 árboles, ~5,800 m³, ~1,133 kWh, ~508 kg CO₂, 100 platos)", () => {
  const imp = C.calcularImpacto({ "Papel": 108, "Cartón": 418, "PET (botellas)": 11 });
  assert.equal(imp.kg, 537);
  assert.equal(imp.arboles, 5);
  assert.ok(Math.abs(imp.agua - 5804.5) < 1);
  assert.ok(Math.abs(imp.energia - 1132.5) < 1);
  assert.ok(Math.abs(imp.co2 - 507.6) < 1);
  assert.equal(imp.platos, 100);
});

test("sumarDetalle ignora valores inválidos y suma por material", () => {
  const d = C.sumarDetalle([{ Papel: 10, Cartón: "5" }, { Papel: 2.5, Vidrio: -3, Otro: "x" }, null]);
  assert.deepEqual(d, { Papel: 12.5, Cartón: 5 });
});

test("generarPdf produce un PDF válido", async () => {
  const pdf = await C.generarPdf({
    id: "abc12345-0000", numero: 7, fecha: "2026-09-15", razon_social: "RENA WARE DEL PERU S A", direccion: "AV. JORGE BASADRE NRO 152",
    desde: "2026-01-01", hasta: "2026-09-15", detalle: { "Papel": 108, "Cartón": 418, "PET (botellas)": 11 }, firmante: "Nombre Apellido",
  });
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 2000);
});

test("mailer desactivado sin SMTP y plantillas con datos", async () => {
  const m = createMailer({});
  assert.equal(m.enabled, false);
  assert.deepEqual(await m.reserva({ correo: "a@b.com" }), { skipped: true });
  const r = { codigo: "ECO-1", fecha_recojo: "2026-09-17", direccion: "Av. X 1", distrito: "Lima", materiales: ["Papel"], cantidad: "5 kg", nombre: "Ana", tipo_donante: "persona", correo: "a@b.com" };
  const t = PLANTILLAS.reserva(r);
  assert.match(t.subject, /ECO-1/);
  assert.match(t.html, /jueves 17 de septiembre/);
  assert.match(PLANTILLAS.avisoInterno(r).subject, /^Nueva reserva ECO-1/);
  assert.match(PLANTILLAS.avisoInterno({ ...r, fecha_anterior: "2026-09-16" }, { tipo: "reprogramacion" }).subject, /^Reprogramación ECO-1/);
  assert.match(PLANTILLAS.avisoInterno(r, { tipo: "cancelacion", motivo: "lluvia" }).html, /lluvia/);
  const rec = PLANTILLAS.recordatorio({ ...r, requisitos: "SCTR" });
  assert.match(rec.subject, /Recordatorio/);
  assert.match(rec.html, /SCTR/);
  assert.match(PLANTILLAS.constancia({ numero: 3, razon_social: "ACME", total: 120, desde: "2026-01-01", hasta: "2026-06-30" }).subject, /00003/);
});
