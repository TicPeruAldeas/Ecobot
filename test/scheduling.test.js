const test = require("node:test");
const assert = require("node:assert/strict");
const { fechasDisponibles } = require("../scheduling");

// Lunes 14-sep-2026 10:00 Lima = 15:00Z
const NOW = new Date("2026-09-14T15:00:00Z");
const cfg = { anticipacion_horas: "24", hora_inicio_recojo: "09:00", horizonte_dias: "30", max_fechas: "6", cupos_por_fecha: "5" };

test("solo días de ruta del distrito, respetando anticipación de 24 h", () => {
  const f = fechasDisponibles({ now: NOW, distrito: { dias: [1, 5] }, config: cfg });
  // Lunes 14 (hoy) ya pasó la anticipación; viernes 18 sí; lunes 21, viernes 25, …
  assert.deepEqual(f.map((x) => x.iso), ["2026-09-18", "2026-09-21", "2026-09-25", "2026-09-28", "2026-10-02", "2026-10-05"]);
  assert.equal(f[0].libres, 5);
});

test("mañana solo si faltan al menos 24 h hasta la hora de inicio", () => {
  // Domingo 13-sep 08:00 Lima → lunes 14 09:00 está a 25 h → se ofrece
  const f1 = fechasDisponibles({ now: new Date("2026-09-13T13:00:00Z"), distrito: { dias: [1] }, config: cfg });
  assert.equal(f1[0].iso, "2026-09-14");
  // Domingo 13-sep 10:00 Lima → faltan 23 h → NO se ofrece el lunes 14
  const f2 = fechasDisponibles({ now: new Date("2026-09-13T15:00:00Z"), distrito: { dias: [1] }, config: cfg });
  assert.equal(f2[0].iso, "2026-09-21");
});

test("excluye bloqueadas y llenas; respeta cupo especial", () => {
  const f = fechasDisponibles({
    now: NOW, distrito: { dias: [1, 5] }, config: cfg,
    fechas: { "2026-09-18": { bloqueada: true }, "2026-09-25": { cupo_maximo: 2 } },
    ocupacion: { "2026-09-21": 5, "2026-09-25": 1 },
  });
  assert.deepEqual(f.map((x) => x.iso).slice(0, 3), ["2026-09-25", "2026-09-28", "2026-10-02"]);
  assert.equal(f[0].libres, 1);
});

test("excluir fecha actual al reprogramar y distrito sin días", () => {
  const f = fechasDisponibles({ now: NOW, distrito: { dias: [5] }, config: cfg, excluir: "2026-09-18" });
  assert.equal(f[0].iso, "2026-09-25");
  assert.deepEqual(fechasDisponibles({ now: NOW, distrito: { dias: [] }, config: cfg }), []);
});
