const test = require("node:test");
const assert = require("node:assert/strict");
const { createSunat, normalizar } = require("../sunat");

test("normalizar acepta las distintas formas de respuesta", () => {
  assert.equal(normalizar("20100047218", { razonSocial: "BANCO DE CREDITO DEL PERU", estado: "ACTIVO", condicion: "HABIDO" }).razon_social, "BANCO DE CREDITO DEL PERU");
  const b = normalizar("20100047218", { nombre_o_razon_social: "BCP", estado_del_contribuyente: "activo", condicion_de_domicilio: "habido", direccion_completa: "Av. X" });
  assert.equal(b.razon_social, "BCP"); assert.equal(b.estado, "ACTIVO"); assert.equal(b.condicion, "HABIDO"); assert.equal(b.direccion, "Av. X");
  assert.equal(normalizar("1", {}), null);
  assert.equal(normalizar("1", null), null);
});

test("consultar: usa el proveedor, cachea y no rompe ante errores", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (url.includes("20100047218")) return { ok: true, status: 200, json: async () => ({ razonSocial: "BANCO DE CREDITO DEL PERU", estado: "ACTIVO", condicion: "HABIDO" }) };
    if (url.includes("20100053455")) return { ok: false, status: 404, json: async () => ({}) };
    throw new Error("red caída");
  };
  const s = createSunat({ provider: "apisnet", token: "t", fetchImpl });
  assert.ok(s.enabled);
  const a = await s.consultar("20100047218");
  assert.equal(a.razon_social, "BANCO DE CREDITO DEL PERU");
  await s.consultar("20100047218");
  assert.equal(calls, 1, "segunda consulta sale del caché");
  assert.equal(await s.consultar("20100053455"), null);
  assert.equal(await s.consultar("20131312955"), null, "error de red → null (razón social manual)");
  assert.equal(await s.consultar("123"), null, "RUC inválido no consulta");
});

test("custom sin URL queda desactivado", () => {
  delete process.env.RUC_API_URL;
  const s = createSunat({ provider: "custom", fetchImpl: async () => { throw new Error("no debe llamar"); } });
  assert.equal(s.enabled, false);
});
