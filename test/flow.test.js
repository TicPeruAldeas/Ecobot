// Recorrido completo del flujo con un almacén en memoria (sin Supabase ni WhatsApp).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFlow } = require("../flow");
const { fechasDisponibles } = require("../scheduling");
const U = require("../util");

function memStore() {
  const config = { cupos_por_fecha: "2", anticipacion_horas: "24", hora_inicio_recojo: "09:00", horizonte_dias: "30", max_fechas: "6", recordatorio_horas: "24", contacto_humano: "Llama al 999", materiales: "Papelería|Plástico|RAEE|Otros", foto_obligatoria: "1", mensaje_bienvenida: "Hola, soy ECO." };
  const distritos = [
    { id: "d1", nombre: "Miraflores", aliases: [], dias: [1, 5], activo: true },
    { id: "d2", nombre: "San Juan de Lurigancho", aliases: ["SJL"], dias: [4], activo: true },
    { id: "d3", nombre: "San Juan de Miraflores", aliases: ["SJM"], dias: [1], activo: true },
  ];
  const sesiones = new Map(); const reservas = []; const eventos = []; const mensajes = []; const fechas = {};
  let seq = 0;
  const ocup = (iso) => reservas.filter((r) => r.fecha_recojo === iso && r.estado === "programado").length;
  return {
    reservas, eventos, mensajes, fechas, sesiones,
    getConfig: async () => config,
    getDistritos: async () => distritos,
    getSesion: async (u) => sesiones.get(u) || null,
    saveSesion: async (u, paso, datos, nombre_wa) => sesiones.set(u, { user_id: u, paso, datos, nombre_wa, updated_at: new Date().toISOString() }),
    getFechasMap: async () => fechas,
    getOcupacionMap: async () => { const m = {}; for (const r of reservas) if (r.estado === "programado") m[r.fecha_recojo] = (m[r.fecha_recojo] || 0) + 1; return m; },
    reservar: async (p) => {
      if (fechas[p.fecha_recojo]?.bloqueada) { const e = new Error("FECHA_BLOQUEADA"); e.code = "FECHA_BLOQUEADA"; throw e; }
      if (ocup(p.fecha_recojo) >= Number(config.cupos_por_fecha)) { const e = new Error("CUPO_LLENO"); e.code = "CUPO_LLENO"; throw e; }
      const r = { id: `r${++seq}`, codigo: `ECO-TEST-${seq}`, estado: "programado", reprogramaciones: 0, created_at: new Date().toISOString(), ...p };
      reservas.push(r); eventos.push({ reserva_id: r.id, evento: "creada" }); return r;
    },
    reprogramar: async (id, fecha) => {
      const r = reservas.find((x) => x.id === id);
      if (ocup(fecha) >= Number(config.cupos_por_fecha)) { const e = new Error("CUPO_LLENO"); e.code = "CUPO_LLENO"; throw e; }
      r.fecha_anterior = r.fecha_recojo; r.fecha_recojo = fecha; r.reprogramaciones++; return r;
    },
    cambiarEstado: async (id, estado, { nota }) => { const r = reservas.find((x) => x.id === id); r.estado = estado; r.nota = nota; return r; },
    getReserva: async (id) => reservas.find((x) => x.id === id) || null,
    reservasActivasDeUsuario: async (u, hoy) => reservas.filter((r) => r.user_id === u && r.estado === "programado" && r.fecha_recojo >= hoy),
    ultimaReservaDeUsuario: async (u) => [...reservas].reverse().find((r) => r.user_id === u) || null,
    addEvento: async (reserva_id, evento) => eventos.push({ reserva_id, evento }),
    marcarMake: async () => {},
    logMensaje: async (user_id, role, message, metadata) => mensajes.push({ user_id, role, message, metadata }),
    uploadFoto: async () => `https://fotos.test/${++seq}.jpg`,
  };
}

function fakeWa(out) {
  return {
    phoneNumberId: "x",
    text: async (_t, body) => out.push({ type: "text", body }),
    buttons: async (_t, body, buttons) => out.push({ type: "buttons", body, buttons }),
    list: async (_t, body, _b, rows) => out.push({ type: "list", body, rows }),
    template: async () => {}, markRead: async () => {},
    downloadMedia: async () => ({ buffer: Buffer.alloc(10), mimeType: "image/jpeg", size: 10 }),
  };
}

function harness() {
  const store = memStore(); const out = [];
  const make = { send: async () => ({ skipped: true }), enabled: false };
  const sunat = { enabled: true, consultar: async (ruc) => ruc === "20100047218" ? { ruc, razon_social: "BANCO DE CREDITO DEL PERU", estado: "ACTIVO", condicion: "HABIDO", direccion: "Av. Centenario 156, La Molina" } : null };
  const flow = createFlow({ store, wa: fakeWa(out), make, sunat });
  const from = "51999000111";
  const send = async (m) => { out.length = 0; await flow.handle({ from, name: "Ana Prueba", msg: { text: null, buttonId: null, buttonTitle: null, image: null, document: null, location: null, ...m } }); return out; };
  const text = (t) => send({ text: t });
  const btn = (id) => send({ buttonId: id, buttonTitle: id });
  const image = () => send({ image: { id: "img1" } });
  const last = () => out[out.length - 1];
  return { store, out, send, text, btn, image, last, from };
}

test("flujo completo: consentimiento → datos → foto → fecha → reserva; luego reutilizar datos y reprogramar/cancelar", async () => {
  const h = harness();

  let r = await h.text("hola");
  assert.equal(r[0].type, "buttons"); assert.match(r[0].body, /Acept/);
  r = await h.btn("consent_ok");
  assert.equal(h.last().type, "buttons"); assert.match(h.last().body, /Qué deseas hacer/);

  await h.btn("menu_donar");
  assert.match(h.last().body, /persona o en nombre de una empresa/);
  await h.btn("td_empresa");
  assert.match(h.last().body, /RUC/);         // empresa: primero el RUC
  await h.text("12345678");                   // DNI no vale para empresa
  assert.match(h.last().body, /RUC/);
  await h.text("20100053455");                // RUC válido pero SUNAT no lo encuentra → razón social a mano
  assert.match(h.last().body, /No encontré ese RUC en SUNAT.*razón social/);
  await h.text("menú"); await h.btn("menu_donar"); await h.btn("td_empresa");
  await h.text("20100047218");                // encontrado en SUNAT
  assert.equal(h.last().type, "buttons"); assert.match(h.last().body, /BANCO DE CREDITO DEL PERU/); assert.match(h.last().body, /empresa correcta/);
  await h.btn("ruc_no");                      // no es → pide el RUC de nuevo
  assert.match(h.last().body, /RUC/);
  await h.text("20100047218");
  await h.btn("ruc_si");
  assert.match(h.last().body, /persona de contacto/);
  await h.text("hola");                       // saludo suelto no se toma como nombre
  assert.match(h.last().body, /persona de contacto/);
  await h.text("roxana salazar");
  assert.match(h.last().body, /correo/);
  await h.text("roxana@bergman");
  assert.match(h.last().body, /no parece válido/);
  await h.text("Roxana.Salazar@BergmanRivera.com");
  assert.match(h.last().body, /distrito/);
  await h.text("san juan");                   // ambiguo → lista
  assert.equal(h.last().type, "list"); assert.equal(h.last().rows.length, 3);
  await h.btn("dist:d2");                     // SJL (jueves)
  assert.match(h.last().body, /dirección exacta/);
  await h.text("Av. Próceres 1234, of. 301");
  assert.match(h.last().body, /referencia/);
  await h.btn("omitir");
  assert.match(h.last().body, /días pueden atender/);   // punto 1 del correo de Erika
  await h.btn("disp_lv");
  assert.match(h.last().body, /horario/);
  await h.text("9:00 a 13:00 y 14:00 a 17:00");
  assert.match(h.last().body, /requisitos de acceso/);  // solo empresas
  await h.text("SCTR vigente y DNI en recepción");
  assert.equal(h.last().type, "list"); assert.match(h.last().body, /material/);
  await h.btn("mat:Papelería");
  assert.match(h.last().body, /Agregas otro/);
  await h.btn("mat_mas");
  await h.btn("mat:Otros");
  assert.match(h.last().body, /Qué material es/);
  await h.text("Tapas de botella");
  await h.btn("mat_listo");
  assert.match(h.last().body, /cantidad/);
  await h.text("20 kg cartón, 30 kg papel");
  assert.match(h.last().body, /comentario/);
  await h.text("Tocar el timbre 2");
  assert.match(h.last().body, /foto/);
  await h.text("no tengo");                   // foto obligatoria
  assert.match(h.last().body, /Necesito una \*foto\*/);
  await h.image();
  assert.match(h.last().body, /1 foto/);
  await h.btn("foto_listo");
  assert.equal(h.last().type, "list"); assert.match(h.last().body, /San Juan de Lurigancho/);
  const fechaRow = h.last().rows[0];
  assert.match(fechaRow.id, /^fecha:\d{4}-\d{2}-\d{2}$/);
  assert.equal(U.parseIsoDate(fechaRow.id.slice(6)).isoDow, 4); // jueves

  await h.btn(fechaRow.id);
  assert.match(h.last().body, /Confirmamos la reserva/);
  assert.match(h.last().body, /BANCO DE CREDITO DEL PERU/);
  assert.match(h.last().body, /Lunes a viernes, 9:00 a 13:00/);
  assert.match(h.last().body, /SCTR vigente/);
  assert.match(h.last().body, /Papelería, Tapas de botella/);

  // Corregir el correo y volver al resumen
  await h.btn("res_corregir");
  assert.equal(h.last().type, "list");
  await h.btn("fix:correo");
  await h.text("nuevo@bergmanrivera.com");
  assert.match(h.last().body, /nuevo@bergmanrivera.com/);

  await h.btn("res_confirmar");
  const conf = h.out.find((m) => /Recojo programado/.test(m.body));
  assert.ok(conf, "debe confirmar la reserva");
  assert.equal(h.store.reservas.length, 1);
  const res = h.store.reservas[0];
  assert.equal(res.empresa, "BANCO DE CREDITO DEL PERU");
  assert.equal(res.nombre, "Roxana Salazar");
  assert.equal(res.documento, "20100047218");
  assert.equal(res.sunat.estado, "ACTIVO");
  assert.equal(res.disponibilidad, "lun_vie");
  assert.equal(res.horario, "9:00 a 13:00 y 14:00 a 17:00");
  assert.equal(res.requisitos, "SCTR vigente y DNI en recepción");
  assert.equal(res.correo, "nuevo@bergmanrivera.com");
  assert.equal(res.distrito, "San Juan de Lurigancho");
  assert.deepEqual(res.materiales, ["Papelería", "Tapas de botella"]);
  assert.equal(res.fotos.length, 1);
  assert.equal(res.fecha_recojo, fechaRow.id.slice(6));

  // Segunda donación: reutiliza datos, misma dirección
  await h.btn("menu_donar");
  assert.match(h.last().body, /ya donaste antes/);
  await h.btn("prev_usar");
  assert.match(h.last().body, /misma dirección/);
  await h.btn("dir_misma");
  assert.match(h.last().body, /días pueden atender/);
  await h.btn("disp_sab"); await h.text("8 a 18"); await h.btn("omitir");
  assert.match(h.last().body, /material/);
  await h.btn("mat:RAEE"); await h.btn("mat_listo"); await h.text("2 monitores"); await h.btn("omitir");
  await h.image(); await h.btn("foto_listo");
  const f2 = h.last().rows[0].id;
  await h.btn(f2); await h.btn("res_confirmar");
  assert.equal(h.store.reservas.length, 2);
  assert.equal(h.store.reservas[1].empresa, "BANCO DE CREDITO DEL PERU");
  assert.equal(h.store.reservas[1].direccion, "Av. Próceres 1234, of. 301");
  assert.equal(h.store.reservas[1].requisitos, null);

  // Tercera: cupo (2) lleno para esa fecha → no debe aparecer
  await h.btn("menu_donar"); await h.btn("prev_usar"); await h.btn("dir_misma");
  await h.btn("disp_lv"); await h.text("9 a 17"); await h.btn("omitir");
  await h.btn("mat:RAEE"); await h.btn("mat_listo"); await h.text("1 cpu"); await h.btn("omitir"); await h.image(); await h.btn("foto_listo");
  assert.ok(!h.last().rows.some((r) => r.id === f2), "fecha llena no se ofrece");

  // Mis recojos → reprogramar y cancelar
  await h.text("menú");
  await h.btn("menu_recojos");
  assert.equal(h.last().type, "list"); assert.equal(h.last().rows.length, 2);
  await h.btn(`res:${h.store.reservas[0].id}`);
  assert.match(h.last().body, /Qué deseas hacer/);
  await h.btn("r_reprogramar");
  assert.equal(h.last().type, "list");
  assert.ok(!h.last().rows.some((r) => r.id === `fecha:${h.store.reservas[0].fecha_recojo}`), "excluye la fecha actual");
  const nueva = h.last().rows[0].id;
  await h.btn(nueva);
  assert.match(h.out[0].body, /reprogramado/);
  assert.equal(h.store.reservas[0].fecha_recojo, nueva.slice(6));
  assert.equal(h.store.reservas[0].reprogramaciones, 1);

  await h.btn("menu_recojos");
  await h.btn(`res:${h.store.reservas[1].id}`);
  await h.btn("r_cancelar");
  assert.match(h.last().body, /Seguro/);
  await h.btn("rc_si");
  assert.equal(h.store.reservas[1].estado, "cancelado");
});

test("cupo tomado por otro usuario entre la selección y la confirmación → ofrece nuevas fechas sin perder datos", async () => {
  const h = harness();
  await h.text("hola"); await h.btn("consent_ok"); await h.btn("menu_donar"); await h.btn("td_persona");
  await h.text("Juan Perez"); await h.text("40404040"); await h.text("juan@mail.com"); await h.text("Miraflores");
  await h.text("Calle Lima 123"); await h.btn("omitir");
  await h.btn("disp_lv"); await h.text("todo el día");
  assert.match(h.last().body, /material/);            // persona: no se piden requisitos de acceso
  await h.btn("mat:Plástico"); await h.btn("mat_listo"); await h.text("5 kg"); await h.btn("omitir");
  await h.image(); await h.btn("foto_listo");
  const iso = h.last().rows[0].id.slice(6);
  await h.btn(`fecha:${iso}`);
  // Otro usuario llena la fecha
  h.store.reservas.push({ id: "z1", user_id: "x", fecha_recojo: iso, estado: "programado" }, { id: "z2", user_id: "y", fecha_recojo: iso, estado: "programado" });
  await h.btn("res_confirmar");
  assert.match(h.last().body, /acaba de ocuparse/);
  assert.equal(h.last().type, "list");
  assert.ok(!h.last().rows.some((r) => r.id === `fecha:${iso}`));
  await h.btn(h.last().rows[0].id);
  await h.btn("res_confirmar");
  const mia = h.store.reservas.find((r) => r.user_id === h.from);
  assert.ok(mia); assert.equal(mia.nombre, "Juan Perez"); assert.notEqual(mia.fecha_recojo, iso);
});

test("distrito sin cobertura y 'lista'", async () => {
  const h = harness();
  await h.text("hola"); await h.btn("consent_ok"); await h.btn("menu_donar"); await h.btn("td_persona");
  await h.text("Ana Lopez"); await h.text("12345678"); await h.text("ana@mail.com");
  await h.text("Marte");
  assert.match(h.last().body, /no tenemos cobertura/);
  await h.text("lista");
  assert.match(h.last().body, /Miraflores/);
  await h.text("mirafores");
  assert.match(h.last().body, /dirección exacta/);
});

test("consentimiento rechazado y 'no por ahora'", async () => {
  const h = harness();
  await h.text("hola");
  await h.btn("consent_no");
  assert.match(h.last().body, /Cuando quieras donar/);
  await h.text("hola");
  assert.match(h.last().body, /Aceptas continuar/);
});
