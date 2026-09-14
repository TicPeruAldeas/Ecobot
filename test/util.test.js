const test = require("node:test");
const assert = require("node:assert/strict");
const U = require("../util");

test("DNI: 8 dígitos", () => {
  assert.equal(U.validarDNI("12345678"), "12345678");
  assert.equal(U.validarDNI("1234567"), null);
  assert.equal(U.validarDNI("12.345.678"), "12345678");
});

test("RUC: 11 dígitos con dígito verificador", () => {
  assert.equal(U.validarRUC("20100047218"), "20100047218"); // RUC válido (DV correcto)
  assert.equal(U.validarRUC("10751420426"), "10751420426");
  assert.equal(U.validarRUC("20516438345"), null); // DV incorrecto (así figura en la hoja: dato mal tipeado)
  assert.equal(U.validarRUC("12345678901"), null); // prefijo inválido
});

test("documento: DNI o RUC", () => {
  assert.deepEqual(U.validarDocumento("40404040"), { tipo: "DNI", valor: "40404040" });
  assert.deepEqual(U.validarDocumento("20100047218"), { tipo: "RUC", valor: "20100047218" });
  assert.equal(U.validarDocumento("123"), null);
});

test("correo", () => {
  assert.equal(U.validarCorreo(" Ana@Empresa.com "), "ana@empresa.com");
  assert.equal(U.validarCorreo("ana@empresa"), null);
  assert.equal(U.validarCorreo("hola"), null);
});

test("nombre", () => {
  assert.equal(U.validarNombre("  juan   perez "), "juan perez");
  assert.equal(U.validarNombre("ab"), null);
  assert.equal(U.validarNombre("12345678"), null);
});

test("buscarDistrito: exacto, alias, acentos, parcial y typo", () => {
  const ds = [
    { id: "1", nombre: "San Juan de Lurigancho", aliases: ["SJL"], dias: [4], activo: true },
    { id: "2", nombre: "San Juan de Miraflores", aliases: ["SJM"], dias: [1], activo: true },
    { id: "3", nombre: "Miraflores", aliases: [], dias: [1, 5], activo: true },
    { id: "4", nombre: "Jesús María", aliases: ["Jesus Maria"], dias: [2], activo: true },
    { id: "5", nombre: "Santiago de Surco", aliases: ["Surco"], dias: [1, 5], activo: true },
    { id: "6", nombre: "Ventanilla", aliases: [], dias: [2], activo: false },
  ];
  assert.equal(U.buscarDistrito("sjl", ds).exact.id, "1");
  assert.equal(U.buscarDistrito("Jesus maria", ds).exact.id, "4");
  assert.equal(U.buscarDistrito("surco", ds).exact.id, "5");
  assert.equal(U.buscarDistrito("miraflores", ds).exact.id, "3"); // exacto gana sobre "San Juan de Miraflores"
  assert.ok(U.buscarDistrito("san juan", ds).candidates.length === 2);
  assert.equal(U.buscarDistrito("mirafores", ds).exact.id, "3"); // typo
  assert.ok(U.buscarDistrito("ventanilla", ds).none); // inactivo
  assert.ok(U.buscarDistrito("marte", ds).none);
});

test("fechas en hora de Lima", () => {
  // 2026-09-14 03:00 UTC = 2026-09-13 22:00 Lima (domingo)
  const p = U.limaParts(new Date("2026-09-14T03:00:00Z"));
  assert.equal(p.iso, "2026-09-13");
  assert.equal(p.isoDow, 7);
  assert.equal(U.addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(U.fechaLarga("2026-09-14"), "lunes 14 de septiembre");
  assert.equal(U.fechaCorta("2026-09-14"), "Lun 14 sep");
  assert.equal(U.fechaDdMmYyyy("2026-09-14"), "14/09/2026");
  assert.equal(U.limaDateTime("2026-09-14", "09:00").toISOString(), "2026-09-14T14:00:00.000Z");
});
