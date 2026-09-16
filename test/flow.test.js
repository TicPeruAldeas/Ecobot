// Recorrido completo del flujo (guion del ECO anterior) con un almacén en memoria.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFlow, detectarMateriales } = require("../flow");
const U = require("../util");

function memStore({ conZonas = true } = {}) {
  const config = {
    cupos_por_fecha: "2", anticipacion_horas: "24", hora_inicio_recojo: "09:00", horizonte_dias: "30", max_fechas: "6", recordatorio_horas: "24",
    contacto_humano: "Llama al 999", foto_obligatoria: "1", peso_minimo_kg: "250", horario_recojo: "9:00 a. m. a 5:30 p. m.",
    mensaje_bienvenida: "¡Hola! *{nombre}*\nSoy Eco ♻️, tu asistente de reciclaje.", mensaje_peso_minimo: "Peso mínimo *{peso} kg*.",
    mensaje_final: "✅ ¡Reserva registrada exitosamente!\n\n📋 *Cód. Reserva: {codigo}*\n\nHorario {horario}.",
  };
  const distritos = [
    { id: "d1", nombre: "Miraflores", aliases: [], dias: [1, 5], activo: true, zona: conZonas ? "Lima Centro" : null },
    { id: "d2", nombre: "San Juan de Lurigancho", aliases: ["SJL"], dias: [4], activo: true, zona: conZonas ? "Lima Este" : null },
    { id: "d3", nombre: "Santiago de Surco", aliases: ["Surco"], dias: [1, 5], activo: true, zona: conZonas ? "Lima Sur" : null },
    { id: "d4", nombre: "San Juan de Miraflores", aliases: ["SJM"], dias: [5], activo: true, zona: conZonas ? "Lima Sur" : null },
  ];
  const sesiones = new Map(); const reservas = []; const eventos = []; const mensajes = []; const fechas = {}; const constancias = [];
  let seq = 0;
  const ocup = (iso) => reservas.filter((r) => r.fecha_recojo === iso && r.estado === "programado").length;
  return {
    reservas, eventos, mensajes, fechas, sesiones, constancias,
    getConfig: async () => config,
    getDistritos: async () => distritos,
    getSesion: async (u) => sesiones.get(u) || null,
    saveSesion: async (u, paso, datos, nombre_wa) => sesiones.set(u, { user_id: u, paso, datos, nombre_wa, updated_at: new Date().toISOString() }),
    getFechasMap: async () => fechas,
    getOcupacionMap: async () => { const m = {}; for (const r of reservas) if (r.estado === "programado") m[r.fecha_recojo] = (m[r.fecha_recojo] || 0) + 1; return m; },
    reservar: async (p) => {
      if (ocup(p.fecha_recojo) >= Number(config.cupos_por_fecha)) { const e = new Error("CUPO_LLENO"); e.code = "CUPO_LLENO"; throw e; }
      const r = { id: `r${++seq}`, codigo: `RESER-${String(100 + seq).padStart(5, "0")}`, estado: "programado", reprogramaciones: 0, created_at: new Date().toISOString(), ...p };
      reservas.push(r); return r;
    },
    reprogramar: async (id, fecha) => { const r = reservas.find((x) => x.id === id); r.fecha_anterior = r.fecha_recojo; r.fecha_recojo = fecha; r.reprogramaciones++; return r; },
    cambiarEstado: async (id, estado, { nota }) => { const r = reservas.find((x) => x.id === id); r.estado = estado; r.nota = nota; return r; },
    getReserva: async (id) => reservas.find((x) => x.id === id) || null,
    reservasActivasDeUsuario: async (u, hoy) => reservas.filter((r) => r.user_id === u && r.estado === "programado" && r.fecha_recojo >= hoy),
    ultimaReservaDeUsuario: async (u) => [...reservas].reverse().find((r) => r.user_id === u) || null,
    addEvento: async (reserva_id, evento) => eventos.push({ reserva_id, evento }),
    logMensaje: async (user_id, role, message, metadata) => mensajes.push({ user_id, role, message, metadata }),
    uploadFoto: async () => `https://fotos.test/${++seq}.jpg`,
    listarConstancias: async ({ documento }) => constancias.filter((c) => c.documento === documento),
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
    uploadMedia: async () => "media-1",
    document: async (_t, id, filename, caption) => out.push({ type: "document", id, filename, caption }),
  };
}
function harness(opts) {
  const store = memStore(opts); const out = [];
  const sunat = { enabled: true, consultar: async (ruc) => ruc === "20100047218" ? { ruc, razon_social: "BANCO DE CREDITO DEL PERU", estado: "ACTIVO", condicion: "HABIDO" } : null };
  const constancias = { generarPdf: async () => Buffer.from("%PDF-fake") };
  const flow = createFlow({ store, wa: fakeWa(out), sunat, constancias, fotoAgruparMs: 0 });
  const from = "51999000111";
  const send = async (m) => { out.length = 0; await flow.handle({ from, name: "Carla Prueba", msg: { text: null, buttonId: null, buttonTitle: null, image: null, document: null, location: null, ...m } }); return out; };
  return { store, out, text: (t) => send({ text: t }), btn: (id) => send({ buttonId: id, buttonTitle: id }), image: () => send({ image: { id: "img1" } }), last: () => out[out.length - 1], all: () => out.map((m) => m.body || "").join("\n"), from };
}

test("detectarMateriales", () => {
  assert.deepEqual(detectarMateriales("papel y plastico"), ["Papel", "Plástico"]);
  assert.deepEqual(detectarMateriales("20 cajas de cartón, 3 monitores y sillas"), ["Cartón", "RAEE", "Mobiliario"]);
  assert.deepEqual(detectarMateriales("cosas varias"), ["Otros"]);
});

test("guion completo: RUC → SUNAT → peso mínimo → residuos → fotos → zona → distrito → día → fecha → dirección → correo → acceso → comentario → resumen → código", async () => {
  const h = harness();
  await h.text("hola");
  assert.match(h.last().body, /¡Hola! \*Carla Prueba\*/); assert.doesNotMatch(h.last().body, /29733/);
  assert.deepEqual(h.last().buttons.map((b) => b.title), ["👉 Iniciar solicitud", "Constancias"]);

  await h.btn("menu_reservar");
  assert.match(h.all(), /Vamos a proceder/); assert.match(h.last().body, /Ingrese el número de \*RUC\*/);
  await h.text("12345678");
  assert.match(h.last().body, /necesitamos el \*RUC\*/);
  await h.text("20100047218");
  assert.match(h.last().body, /RUC ingresado: \*20100047218\*/);
  await h.btn("no");
  assert.match(h.last().body, /Ingrese el número de \*RUC\*/);
  await h.text("20100047218"); await h.btn("si");
  assert.match(h.all(), /Hola \*BANCO DE CREDITO DEL PERU\*, bienvenido/);
  assert.match(h.all(), /Peso mínimo \*250 kg\*/);
  assert.match(h.last().body, /mínimo requerido/);
  await h.btn("si");
  assert.match(h.last().body, /cantidad y el tipo de residuos/);
  await h.text("papel y plastico, unas 300 kg");
  assert.match(h.last().body, /Obligatorio.*fotografía/);
  await h.text("no tengo");
  assert.match(h.last().body, /Necesito al menos una \*fotografía\*/);
  await h.image();
  assert.match(h.last().body, /Imagen válida recibida! ¿Deseas adjuntar otra foto/);
  await h.btn("foto_mas"); await h.image();
  assert.match(h.last().body, /2 imágenes recibidas/);
  await h.btn("foto_listo");
  assert.equal(h.last().type, "list"); assert.match(h.last().body, /Seleccione la Zona/);
  assert.deepEqual(h.last().rows.map((r) => r.id), ["zona:Lima Sur", "zona:Lima Centro", "zona:Lima Este"]);   // orden del ECO anterior
  assert.equal(h.last().rows[0].title, "🟠 LIMA SUR");
  await h.btn("zona:Lima Sur");
  assert.equal(h.last().type, "list"); assert.match(h.last().body, /Distritos Lima Sur 🟠/); assert.match(h.last().body, /9:00 a\. m\. a 5:30 p\. m\./);
  assert.deepEqual(h.last().rows.map((r) => r.id), ["dist:d4", "dist:d3", "dist:zona", "dist:escribir"]);
  assert.deepEqual(h.last().rows.slice(0, 2).map((r) => r.description), ["Solo viernes", "Solo lunes y viernes"]);
  await h.btn("dist:zona");
  assert.match(h.last().body, /Seleccione la Zona/);
  await h.btn("zona:Lima Sur"); await h.btn("dist:d3");
  assert.match(h.all(), /Santiago de Surco\*\nSolo lunes y viernes/);
  assert.equal(h.last().type, "buttons"); assert.deepEqual(h.last().buttons.map((b) => b.id), ["dia:1", "dia:5"]);
  await h.btn("dia:5");
  assert.match(h.all(), /fechas disponibles de los días \*Viernes\*/);
  assert.equal(h.last().type, "list");
  for (const r of h.last().rows) assert.equal(U.parseIsoDate(r.id.slice(6)).isoDow, 5, "solo viernes");
  assert.match(h.last().rows[0].title, /^\d{2} de \w+/);
  const fecha = h.last().rows[0].id.slice(6);
  await h.btn(h.last().rows[0].id);
  assert.match(h.last().body, /Fecha seleccionada/);
  await h.btn("no");
  assert.equal(h.last().type, "list");
  await h.btn(`fecha:${fecha}`); await h.btn("si");
  assert.match(h.last().body, /dirección de \*recojo\*/);
  await h.text("Av. Circunvalación del Golf 134, Edificio Panorama");
  assert.match(h.last().body, /Dirección registrada/);
  await h.btn("si");
  assert.match(h.last().body, /correo electrónico/);
  await h.text("cpitam@primax");
  assert.match(h.last().body, /no parece válido/);
  await h.text("cpitam@primax.com");
  assert.match(h.last().body, /Correo ingresado: \*cpitam@primax.com\*/);
  await h.btn("si");
  assert.match(h.last().body, /días y horario pueden recibir/);
  await h.text("solo sábados de 9 a 1");
  assert.match(h.last().body, /requisito de acceso/);
  await h.text("SCTR y DNI");
  assert.match(h.last().body, /comentario u observación/);
  await h.btn("si");
  assert.match(h.last().body, /Escriba su comentario/);
  await h.text("El recojo debe ser sábado por restricciones del edificio");
  assert.match(h.last().body, /Resumen de tu reserva/);
  assert.match(h.last().body, /\*RUC\*: _20100047218_/); assert.match(h.last().body, /\*Empresa\*: _BANCO DE CREDITO DEL PERU_/);
  assert.match(h.last().body, /\*Fotos\*: _2_/); assert.match(h.last().body, /acceso: SCTR y DNI/);

  // Corregir el correo y volver al resumen
  await h.btn("res_corregir"); await h.btn("fix:correo"); await h.text("nuevo@primax.com"); await h.btn("si");
  assert.match(h.last().body, /\*Correo\*: _nuevo@primax.com_/);

  await h.btn("res_confirmar");
  assert.match(h.all(), /Reserva registrada exitosamente/); assert.match(h.all(), /Cód\. Reserva: RESER-\d{5}/); assert.match(h.all(), /Horario 9:00 a\. m\./);
  const res = h.store.reservas[0];
  assert.equal(res.empresa, "BANCO DE CREDITO DEL PERU"); assert.equal(res.nombre, "Carla Prueba"); assert.equal(res.documento, "20100047218");
  assert.equal(res.distrito, "Santiago de Surco"); assert.equal(res.fecha_recojo, fecha); assert.equal(res.fotos.length, 2);
  assert.deepEqual(res.materiales, ["Papel", "Plástico"]); assert.equal(res.cantidad, "papel y plastico, unas 300 kg");
  assert.equal(res.disponibilidad, "incluye_sab"); assert.equal(res.horario, "solo sábados de 9 a 1"); assert.equal(res.requisitos, "SCTR y DNI");
  assert.equal(res.correo, "nuevo@primax.com"); assert.match(res.comentario, /sábado/);

  // Segunda reserva: reutiliza datos; dirección y correo se confirman en vez de reescribirse
  await h.btn("menu_reservar");
  assert.match(h.last().body, /ya has reservado antes/);
  await h.btn("prev_usar");
  assert.match(h.all(), /Hola \*BANCO DE CREDITO DEL PERU\*/); assert.match(h.last().body, /mínimo requerido/);
  await h.btn("si"); await h.text("cartón"); await h.image(); await h.btn("foto_listo");
  await h.btn("zona:Lima Este"); await h.btn("dist:d2");           // SJL: un solo día → directo a fechas
  assert.equal(h.last().type, "list"); assert.match(h.last().body, /San Juan de Lurigancho/);
  await h.btn(h.last().rows[0].id); await h.btn("si");
  assert.match(h.last().body, /Dirección registrada: \*Av\. Circunvalación/);
  await h.btn("si");
  assert.match(h.last().body, /Correo ingresado: \*nuevo@primax.com\*/);
  await h.btn("si"); await h.btn("acc_sin"); await h.btn("req_ninguno"); await h.btn("no");
  assert.match(h.last().body, /Resumen de tu reserva/);
  await h.btn("res_confirmar");
  assert.equal(h.store.reservas.length, 2);
  assert.equal(h.store.reservas[1].horario, "Sin restricción"); assert.equal(h.store.reservas[1].requisitos, null);

  // Mis reservas: reprogramar y cancelar
  // Autoservicio de reprogramar/cancelar DESACTIVADO para el donante: se deriva al equipo (panel).
  await h.text("mis reservas");
  assert.match(h.all(), /nuestro equipo te ayuda: Llama al 999/); assert.deepEqual(h.last().buttons.map((b) => b.id), ["menu_reservar", "menu_constancias"]);
  await h.text("quiero cancelar mi reserva");
  assert.match(h.all(), /nuestro equipo te ayuda: Llama al 999/);
  await h.btn("menu_recojos");                              // botón viejo: no abre nada
  assert.deepEqual(h.last().buttons.map((b) => b.id), ["menu_reservar", "menu_constancias"]);
  assert.equal(h.store.reservas[0].reprogramaciones, 0); assert.equal(h.store.reservas[1].estado, "programado");
});

test("saludos globales reinician; 'reservar' arranca la reserva; 30 min sin actividad reinician con aviso", async () => {
  const h = harness();
  await h.text("hola"); await h.btn("menu_reservar"); await h.text("20100047218"); await h.btn("si"); await h.btn("si");
  assert.match(h.last().body, /cantidad y el tipo de residuos/);
  await h.text("Eco");                                     // saludo suelto a mitad del flujo → bienvenida
  assert.match(h.last().body, /¡Hola! \*Carla Prueba\*/); assert.equal(h.last().buttons[0].id, "menu_reservar");
  await h.text("reservar");                                // palabra suelta → empieza la reserva
  assert.match(h.last().body, /Ingrese el número de \*RUC\*/);
  await h.text("Eco Reciclaje SAC");                       // no es saludo suelto: se trata como respuesta del paso (RUC inválido)
  assert.match(h.last().body, /RUC debe tener/);
  // Sesión vencida: simulamos 31 minutos de inactividad en medio de la reserva
  const s = h.store.sesiones.get(h.from);
  s.updated_at = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  await h.text("20100047218");
  assert.match(h.last().body, /Pasaron más de 30 minutos sin actividad/); assert.match(h.last().body, /¡Hola! \*Carla Prueba\*/);
  assert.equal(h.store.sesiones.get(h.from).paso, "menu");
});

test("álbum de fotos: varias fotos seguidas → una sola respuesta con el total", async () => {
  const store = memStore(); const out = [];
  const sunat = { enabled: true, consultar: async () => ({ razon_social: "ACME SAC", estado: "ACTIVO", condicion: "HABIDO" }) };
  const flow = createFlow({ store, wa: fakeWa(out), sunat, fotoAgruparMs: 30 });
  const from = "51999000222";
  const send = (m) => flow.handle({ from, name: "Ana", msg: { text: null, buttonId: null, buttonTitle: null, image: null, document: null, location: null, ...m } });
  await send({ text: "hola" }); await send({ buttonId: "menu_reservar" }); await send({ text: "20100047218" }); await send({ buttonId: "si" }); await send({ buttonId: "si" }); await send({ text: "papel" });
  out.length = 0;
  await send({ image: { id: "a" } }); await send({ image: { id: "b" } }); await send({ image: { id: "c" } }); await send({ image: { id: "d" } });
  assert.equal(out.length, 0, "no responde por cada foto");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(out.length, 1, "una sola respuesta");
  assert.match(out[0].body, /4 imágenes recibidas/);
  assert.equal(store.sesiones.get(from).datos.fotos.length, 4);
});

test("peso mínimo: 'No' termina amablemente y vuelve al menú", async () => {
  const h = harness();
  await h.text("hola"); await h.btn("menu_reservar"); await h.text("20100047218"); await h.btn("si");
  await h.btn("no");
  assert.match(h.all(), /Cuando cuente con el mínimo de \*250 kg\*/);
  assert.deepEqual(h.last().buttons.map((b) => b.id), ["menu_reservar", "menu_constancias"]);
});

test("RUC no encontrado en SUNAT → razón social manual; distrito escrito a mano en el paso de zona", async () => {
  const h = harness();
  await h.text("hola"); await h.btn("menu_reservar"); await h.text("20100053455"); await h.btn("si");
  assert.match(h.last().body, /No encontré ese RUC en SUNAT.*razón social/);
  await h.text("Empresa Demo SAC");
  assert.match(h.all(), /Hola \*Empresa Demo SAC\*/);
  await h.btn("si"); await h.text("vidrio"); await h.image(); await h.btn("foto_listo");
  await h.text("sjl");                                    // escribe el distrito en vez de elegir zona
  assert.equal(h.last().type, "list"); assert.match(h.last().body, /San Juan de Lurigancho/);
});

test("sin zonas definidas: pide el distrito por texto", async () => {
  const h = harness({ conZonas: false });
  await h.text("hola"); await h.btn("menu_reservar"); await h.text("20100047218"); await h.btn("si"); await h.btn("si");
  await h.text("papel"); await h.image(); await h.btn("foto_listo");
  assert.match(h.last().body, /Escriba el \*distrito\*/);
  await h.text("mirafores");
  assert.equal(h.last().type, "buttons"); assert.deepEqual(h.last().buttons.map((b) => b.id), ["dia:1", "dia:5"]);
});

test("cupo tomado entre la selección y la confirmación → nuevas fechas sin perder datos", async () => {
  const h = harness();
  await h.text("hola"); await h.btn("menu_reservar"); await h.text("20100047218"); await h.btn("si"); await h.btn("si");
  await h.text("papel"); await h.image(); await h.btn("foto_listo"); await h.btn("zona:Lima Este"); await h.btn("dist:d2");
  const iso = h.last().rows[0].id.slice(6);
  await h.btn(`fecha:${iso}`); await h.btn("si"); await h.text("Calle Lima 123"); await h.btn("si"); await h.text("a@b.com"); await h.btn("si");
  await h.btn("acc_sin"); await h.btn("req_ninguno"); await h.btn("no");
  h.store.reservas.push({ id: "z1", user_id: "x", fecha_recojo: iso, estado: "programado" }, { id: "z2", user_id: "y", fecha_recojo: iso, estado: "programado" });
  await h.btn("res_confirmar");
  assert.match(h.last().body, /acaba de ocuparse/); assert.equal(h.last().type, "list");
  assert.ok(!h.last().rows.some((r) => r.id === `fecha:${iso}`));
  await h.btn(h.last().rows[0].id); await h.btn("si"); await h.btn("res_confirmar");
  const mia = h.store.reservas.find((r) => r.user_id === h.from);
  assert.ok(mia); assert.equal(mia.empresa, "BANCO DE CREDITO DEL PERU"); assert.notEqual(mia.fecha_recojo, iso);
});

test("constancias por WhatsApp: sin constancias avisa; con constancias envía el PDF", async () => {
  const h = harness();
  await h.text("hola"); await h.btn("menu_constancias");
  assert.match(h.last().body, /ingresa el \*RUC\*/);
  await h.text("20100047218");
  assert.match(h.all(), /Aún no hay constancias emitidas/);
  h.store.constancias.push({ id: "c1", numero: 7, documento: "20100047218", razon_social: "BANCO DE CREDITO DEL PERU", total: 537, desde: "2026-01-01", hasta: "2026-09-15", detalle: {}, created_at: new Date().toISOString() });
  await h.btn("menu_constancias"); await h.text("20100047218");
  const doc = h.out.find((m) => m.type === "document");
  assert.ok(doc); assert.match(doc.filename, /Constancia-00007/); assert.match(doc.caption, /537 kg/);
});
