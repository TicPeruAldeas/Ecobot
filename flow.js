// Motor conversacional de ECO: máquina de estados por usuario.
// Cada paso recibe la entrada (texto, botón, imagen), valida, guarda en la
// sesión y responde. La verdad de cupos vive en Supabase (eco_reservar).
const U = require("./util");
const { fechasDisponibles } = require("./scheduling");

const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_HOURS) || 12) * 60 * 60 * 1000;
const CONSENT_DAYS = Number(process.env.CONSENT_DAYS) || 30;

const RE_MENU = /^\s*(menu|menú|inicio|volver|salir|reiniciar|empezar de nuevo)\s*$/i;
const RE_SOLO_SALUDO = /^\s*(hola|buenas|buenos d[ií]as|buenas tardes|buenas noches|hi|hello|ola)[\s!.,]*$/i;
const RE_HOLA = /^\s*(hola|buenas|buenos d[ií]as|buenas tardes|buenas noches|hi|hello|ola)\b/i;
const RE_OMITIR = /^\s*(omitir|ninguna|ninguno|no|n\/a|-|sin referencia|sin comentario)\s*$/i;
const RE_LISTA = /^\s*(lista|ver lista|distritos|zonas|cobertura|ver distritos)\s*$/i;

const BTN = {
  acepto: "consent_ok", noAcepto: "consent_no",
  donar: "menu_donar", misRecojos: "menu_recojos", info: "menu_info", menu: "go_menu",
  persona: "td_persona", empresa: "td_empresa",
  usarDatos: "prev_usar", datosNuevos: "prev_nuevos",
  mismaDir: "dir_misma", otraDir: "dir_otra",
  omitir: "omitir",
  matMas: "mat_mas", matListo: "mat_listo",
  fotoMas: "foto_mas", fotoListo: "foto_listo",
  confirmar: "res_confirmar", corregir: "res_corregir", cancelarFlujo: "res_cancelar",
  reprogramar: "r_reprogramar", cancelarReserva: "r_cancelar", volver: "r_volver",
  siCancelar: "rc_si", noCancelar: "rc_no",
  rucSi: "ruc_si", rucNo: "ruc_no",
  dispLV: "disp_lv", dispSab: "disp_sab",
};
const DISPONIBILIDAD = { lun_vie: "Lunes a viernes", incluye_sab: "Incluye sábados" };

const CAMPOS_CORREGIBLES = [
  { id: "fix:nombre", title: "Nombre / empresa" },
  { id: "fix:documento", title: "DNI / RUC" },
  { id: "fix:correo", title: "Correo" },
  { id: "fix:distrito", title: "Distrito" },
  { id: "fix:direccion", title: "Dirección" },
  { id: "fix:disponibilidad", title: "Horario y acceso" },
  { id: "fix:materiales", title: "Materiales" },
  { id: "fix:cantidad", title: "Cantidad" },
  { id: "fix:foto", title: "Fotos" },
  { id: "fix:fecha", title: "Fecha de recojo" },
];

function createFlow({ store, wa, sunat = null, mailer = null }) {
  // Correos fire-and-forget: registran un evento en la reserva y nunca bloquean el flujo.
  function correo(tipo, reserva, extra) {
    if (!mailer?.enabled) return;
    const cb = (err, r) => store.addEvento(reserva.id, err ? "correo_error" : "correo", { tipo, ...(err ? { error: err.message } : { a: reserva.correo }) }, "sistema");
    if (tipo === "reserva") { mailer.reserva(reserva, cb); mailer.avisoInterno(reserva); }
    else if (tipo === "reprogramacion") mailer.reprogramacion(reserva, cb);
    else if (tipo === "cancelacion") mailer.cancelacion(reserva, extra, cb);
  }
  // ── Respuestas con registro ──
  async function say(ctx, text) {
    await wa.text(ctx.from, text);
    await store.logMensaje(ctx.from, "assistant", text, { paso: ctx.paso });
  }
  async function ask(ctx, text, buttons, opts) {
    await wa.buttons(ctx.from, text, buttons, opts);
    await store.logMensaje(ctx.from, "assistant", `${text}\n[${buttons.map((b) => b.title).join(" | ")}]`, { paso: ctx.paso });
  }
  async function pick(ctx, text, buttonText, rows, opts) {
    await wa.list(ctx.from, text, buttonText, rows, opts);
    await store.logMensaje(ctx.from, "assistant", `${text}\n[${rows.map((r) => r.title).join(" | ")}]`, { paso: ctx.paso });
  }

  // ── Sesión ──
  async function go(ctx, paso, patch = {}) {
    ctx.paso = paso;
    ctx.datos = { ...ctx.datos, ...patch };
    await store.saveSesion(ctx.from, paso, ctx.datos, ctx.name);
  }

  // ── Pantallas reutilizables ──
  async function showConsent(ctx) {
    const cfg = await store.getConfig();
    // Si el mensaje configurado ya empieza con "¡Hola", se personaliza en vez de duplicar el saludo.
    const nombre = ctx.name ? ctx.name.split(" ")[0] : null;
    let bienvenida = String(cfg.mensaje_bienvenida || "");
    if (/^¡?hola!?/i.test(bienvenida)) bienvenida = bienvenida.replace(/^¡?hola!?/i, nombre ? `¡Hola, ${nombre}!` : "¡Hola!");
    else if (nombre) bienvenida = `¡Hola, ${nombre}! ${bienvenida}`;
    const texto = `${bienvenida}\n\n` +
      `Para programar un recojo te pediré tus datos de contacto, la dirección, qué materiales donas y una foto. ` +
      `Usaremos esa información solo para coordinar el recojo y emitir tu constancia, conforme a la Ley N.° 29733 de Protección de Datos Personales.\n\n` +
      `¿Aceptas continuar?`;
    await go(ctx, "consentimiento");
    await ask(ctx, texto, [{ id: BTN.acepto, title: "Acepto" }, { id: BTN.noAcepto, title: "No por ahora" }]);
  }

  async function showMenu(ctx, intro = null) {
    await go(ctx, "menu", { flujo: null });
    const texto = intro || "¿Qué deseas hacer?";
    await ask(ctx, texto, [
      { id: BTN.donar, title: "Donar reciclables" },
      { id: BTN.misRecojos, title: "Mis recojos" },
      { id: BTN.info, title: "Más información" },
    ]);
  }

  async function showInfo(ctx) {
    const [cfg, distritos] = await Promise.all([store.getConfig(), store.getDistritos()]);
    const porDia = {};
    for (const d of distritos) for (const dia of d.dias || []) (porDia[dia] = porDia[dia] || []).push(d.nombre);
    const rutas = Object.keys(porDia).map(Number).sort().map((dia) => `• *${U.nombreDia(dia)}*: ${porDia[dia].join(", ")}`).join("\n");
    const texto = `*¿Cómo funciona ECO?*\n` +
      `1. Registras tus datos y los materiales que donas (con foto).\n` +
      `2. Te muestro las fechas disponibles según tu distrito.\n` +
      `3. Confirmas y nuestro equipo pasa a recoger la donación.\n` +
      `4. Recibes tu constancia de donación por correo.\n\n` +
      `*Días de recojo por distrito:*\n${rutas}\n\n` +
      `Reservas con al menos ${cfg.anticipacion_horas || 24} horas de anticipación. Hay ${cfg.cupos_por_fecha || 5} recojos por día, así que te recomiendo programar con tiempo.\n\n` +
      `¿Necesitas ayuda de una persona? ${cfg.contacto_humano || ""}`;
    await say(ctx, texto);
    await ask(ctx, "¿Quieres programar un recojo?", [{ id: BTN.donar, title: "Donar reciclables" }, { id: BTN.menu, title: "Menú" }]);
    await go(ctx, "menu");
  }

  // ── Inicio del flujo de donación ──
  async function startDonacion(ctx) {
    const previa = await store.ultimaReservaDeUsuario(ctx.from);
    await go(ctx, "tipo_donante", { flujo: "donacion", materiales: [], fotos: [], corrigiendo: false, previa: null });
    if (previa) {
      const quien = previa.empresa ? `${previa.empresa} (${previa.nombre})` : previa.nombre;
      const texto = `Veo que ya donaste antes. ¿Uso estos datos?\n\n` +
        `👤 ${quien}\n🪪 ${previa.documento_tipo || "Doc."} ${previa.documento || "-"}\n✉️ ${previa.correo || "-"}\n📍 ${previa.direccion}, ${previa.distrito}`;
      await go(ctx, "reutilizar", {
        previa: {
          tipo_donante: previa.tipo_donante, nombre: previa.nombre, empresa: previa.empresa, documento_tipo: previa.documento_tipo,
          documento: previa.documento, correo: previa.correo, distrito: previa.distrito, distrito_id: previa.distrito_id,
          direccion: previa.direccion, referencia: previa.referencia,
        },
      });
      await ask(ctx, texto, [{ id: BTN.usarDatos, title: "Sí, usar mis datos" }, { id: BTN.datosNuevos, title: "Ingresar nuevos" }]);
      return;
    }
    await askTipoDonante(ctx);
  }

  async function askTipoDonante(ctx) {
    await go(ctx, "tipo_donante");
    await ask(ctx, "¿Donas como persona o en nombre de una empresa?", [{ id: BTN.persona, title: "Persona" }, { id: BTN.empresa, title: "Empresa" }]);
  }
  async function askNombre(ctx, prefijo = "") {
    await go(ctx, "nombre");
    if (ctx.datos.tipo_donante === "empresa") await say(ctx, `${prefijo}¿Cuál es la *razón social* de la empresa?`);
    else await say(ctx, `${prefijo}¿Cuál es tu *nombre completo*?`);
  }
  // Tras validar el RUC: consulta SUNAT y pide confirmar la razón social.
  async function confirmarRuc(ctx, info) {
    await go(ctx, "ruc_confirmar", { sunat: info });
    const alerta = (info.estado && info.estado !== "ACTIVO") || (info.condicion && info.condicion !== "HABIDO")
      ? `\n⚠️ SUNAT la reporta como *${[info.estado, info.condicion].filter(Boolean).join(" / ")}*.` : "";
    await ask(ctx, `Encontré en SUNAT:\n🏢 *${info.razon_social}*${info.nombre_comercial ? ` (${info.nombre_comercial})` : ""}${info.direccion ? `\n📍 ${info.direccion}` : ""}${alerta}\n\n¿Es la empresa correcta?`,
      [{ id: BTN.rucSi, title: "Sí, es correcta" }, { id: BTN.rucNo, title: "No" }]);
  }
  async function askDisponibilidad(ctx) {
    await go(ctx, "disponibilidad");
    await ask(ctx, "¿Qué días pueden atender al equipo de recojo?", [{ id: BTN.dispLV, title: "Lunes a viernes" }, { id: BTN.dispSab, title: "Incluye sábados" }]);
  }
  async function askHorario(ctx) {
    await go(ctx, "horario");
    await say(ctx, "¿En qué *horario* pueden recibir al equipo? Por ejemplo: _9:00 a 13:00 y 14:00 a 17:00_.");
  }
  async function askRequisitos(ctx) {
    await go(ctx, "requisitos");
    await ask(ctx, "¿Hay *requisitos de acceso* a sus instalaciones para nuestro personal? (SCTR, documentos de identidad, EPP, registro en recepción…)", [{ id: BTN.omitir, title: "Ninguno" }]);
  }
  async function askContacto(ctx) {
    await go(ctx, "contacto");
    await say(ctx, "¿Nombre de la *persona de contacto* para coordinar el recojo?");
  }
  async function askDocumento(ctx) {
    await go(ctx, "documento");
    if (ctx.datos.tipo_donante === "empresa") await say(ctx, "Indícame el *RUC* de la empresa (11 dígitos). Lo necesitamos para la constancia de donación.");
    else await say(ctx, "Indícame tu *DNI* (8 dígitos). Si prefieres la constancia a nombre de tu RUC, escribe el RUC (11 dígitos).");
  }
  async function askCorreo(ctx) {
    await go(ctx, "correo");
    await say(ctx, "¿A qué *correo electrónico* enviamos la constancia de donación?");
  }
  async function askDistrito(ctx) {
    await go(ctx, "distrito");
    await say(ctx, "¿En qué *distrito* está la dirección de recojo? Escríbelo (por ejemplo: Miraflores, SJL, Callao). Escribe *lista* para ver los distritos con cobertura.");
  }
  async function askDireccion(ctx) {
    await go(ctx, "direccion");
    await say(ctx, `Escribe la *dirección exacta* del recojo en ${ctx.datos.distrito} (calle, número, piso u oficina).`);
  }
  async function askReferencia(ctx) {
    await go(ctx, "referencia");
    await ask(ctx, "¿Alguna *referencia* para ubicar el lugar? (parque cercano, color de la fachada, horario de atención…)", [{ id: BTN.omitir, title: "Omitir" }]);
  }
  async function askMaterial(ctx) {
    const cfg = await store.getConfig();
    const mats = String(cfg.materiales || "Papelería|Plástico|Otros").split("|").map((s) => s.trim()).filter(Boolean).slice(0, 10);
    await go(ctx, "materiales");
    const ya = ctx.datos.materiales.length ? `Llevas: ${ctx.datos.materiales.join(", ")}.\n` : "";
    await pick(ctx, `${ya}¿Qué *material* vas a donar?`, "Elegir material", mats.map((m) => ({ id: `mat:${m}`, title: U.truncar(m, 24) })), { sectionTitle: "Materiales" });
  }
  async function askMaterialMas(ctx) {
    await go(ctx, "materiales_mas");
    await ask(ctx, `Materiales: *${ctx.datos.materiales.join(", ")}*.\n¿Agregas otro material?`, [{ id: BTN.matMas, title: "Agregar otro" }, { id: BTN.matListo, title: "Continuar" }]);
  }
  async function askCantidad(ctx) {
    await go(ctx, "cantidad");
    await say(ctx, "¿Qué *cantidad aproximada* donas? Por ejemplo: _20 kg de cartón, 3 cajas de papel, 2 monitores_.");
  }
  async function askComentario(ctx) {
    await go(ctx, "comentario");
    await ask(ctx, "¿Algún *comentario* adicional para el equipo de recojo?", [{ id: BTN.omitir, title: "Omitir" }]);
  }
  async function askFoto(ctx) {
    await go(ctx, "foto");
    await say(ctx, "Envíame una *foto* de los materiales 📷. Nos ayuda a verificar la donación antes de enviar la unidad de recojo.");
  }
  async function askFotoMas(ctx) {
    await go(ctx, "foto_mas");
    await ask(ctx, `Recibí ${ctx.datos.fotos.length} foto(s). ¿Quieres enviar otra?`, [{ id: BTN.fotoMas, title: "Enviar otra" }, { id: BTN.fotoListo, title: "Continuar" }]);
  }

  async function calcularFechas(ctx, distritoNombre, excluir = null) {
    const [cfg, distritos] = await Promise.all([store.getConfig(), store.getDistritos()]);
    const distrito = distritos.find((d) => d.nombre === distritoNombre);
    if (!distrito) return { fechas: [], cfg };
    const hoy = U.limaParts(new Date()).iso;
    const hasta = U.addDays(hoy, Math.min(Number(cfg.horizonte_dias) || 30, 120));
    const [fechas, ocupacion] = await Promise.all([store.getFechasMap(hoy, hasta), store.getOcupacionMap(hoy, hasta)]);
    // Si el donante solo atiende de lunes a viernes, no se ofrecen sábados/domingos aunque la ruta los tenga.
    const excluirDias = ctx.datos.disponibilidad === "lun_vie" ? [6, 7] : [];
    return { fechas: fechasDisponibles({ now: new Date(), distrito, config: cfg, fechas, ocupacion, excluir, excluirDias }), cfg };
  }

  async function askFecha(ctx, { excluir = null, prefijo = "" } = {}) {
    const { fechas, cfg } = await calcularFechas(ctx, ctx.datos.distrito, excluir);
    if (fechas.length === 0) {
      await say(ctx, `${prefijo}Por ahora no tengo fechas disponibles para *${ctx.datos.distrito}* en las próximas semanas. ${cfg.contacto_humano || ""}`);
      await showMenu(ctx);
      return false;
    }
    await go(ctx, ctx.datos.flujo === "reprogramar" ? "reprog_fecha" : "fecha");
    const rows = fechas.map((f) => ({ id: `fecha:${f.iso}`, title: U.fechaCorta(f.iso), description: `${U.fechaLarga(f.iso)} · ${f.libres} cupo${f.libres === 1 ? "" : "s"}` }));
    await pick(ctx, `${prefijo}Estas son las próximas fechas de recojo para *${ctx.datos.distrito}*. Elige una:`, "Ver fechas", rows, { sectionTitle: "Fechas disponibles" });
    return true;
  }

  function resumen(d) {
    const quien = d.tipo_donante === "empresa" ? `🏢 ${d.nombre}\n👤 Contacto: ${d.contacto || "-"}` : `👤 ${d.nombre}`;
    const atencion = d.disponibilidad ? `\n🕘 Atención: ${DISPONIBILIDAD[d.disponibilidad] || d.disponibilidad}${d.horario ? `, ${d.horario}` : ""}` : "";
    const acceso = d.requisitos ? `\n🔐 Acceso: ${d.requisitos}` : "";
    return `${quien}\n🪪 ${d.documento_tipo} ${d.documento}\n✉️ ${d.correo}\n📍 ${d.direccion}${d.referencia ? ` (${d.referencia})` : ""}, ${d.distrito}${atencion}${acceso}\n` +
      `♻️ ${d.materiales.join(", ")}\n⚖️ ${d.cantidad}${d.comentario ? `\n📝 ${d.comentario}` : ""}\n📷 ${d.fotos.length} foto(s)\n📅 *${U.fechaLarga(d.fecha)}*`;
  }
  async function askConfirmar(ctx) {
    await go(ctx, "confirmar", { corrigiendo: false });
    await ask(ctx, `Revisa los datos de tu recojo:\n\n${resumen(ctx.datos)}\n\n¿Confirmamos la reserva?`, [
      { id: BTN.confirmar, title: "Confirmar" }, { id: BTN.corregir, title: "Corregir algo" }, { id: BTN.cancelarFlujo, title: "Cancelar" },
    ]);
  }

  // Tras corregir un campo, volver al resumen (o seguir el flujo normal).
  async function next(ctx, siguiente) {
    if (ctx.datos.corrigiendo) return askConfirmar(ctx);
    return siguiente(ctx);
  }

  async function crearReserva(ctx) {
    const d = ctx.datos;
    const payload = {
      user_id: ctx.from, tipo_donante: d.tipo_donante, nombre: d.tipo_donante === "empresa" ? (d.contacto || d.nombre) : d.nombre,
      empresa: d.tipo_donante === "empresa" ? d.nombre : null,
      documento_tipo: d.documento_tipo, documento: d.documento, correo: d.correo,
      distrito_id: d.distrito_id || null, distrito: d.distrito, direccion: d.direccion, referencia: d.referencia || null,
      materiales: d.materiales, cantidad: d.cantidad, comentario: d.comentario || null, fotos: d.fotos, fecha_recojo: d.fecha, actor: "donante",
      disponibilidad: d.disponibilidad || null, horario: d.horario || null, requisitos: d.requisitos || null, sunat: d.sunat || null,
    };
    let reserva;
    try {
      reserva = await store.reservar(payload);
    } catch (err) {
      if (err.code === "CUPO_LLENO" || err.code === "FECHA_BLOQUEADA") {
        await askFecha(ctx, { prefijo: "Uy, ese cupo acaba de ocuparse 😔. Tus datos siguen guardados. " });
        return;
      }
      throw err;
    }
    const texto = `✅ *¡Recojo programado!*\n\nCódigo: *${reserva.codigo}*\n📅 ${U.fechaLarga(reserva.fecha_recojo)}\n📍 ${reserva.direccion}, ${reserva.distrito}\n♻️ ${reserva.materiales.join(", ")}\n\n` +
      `Te enviaremos un recordatorio antes del recojo. Ten los materiales listos y accesibles ese día.\n` +
      `Si necesitas cambiar la fecha o cancelar, escribe *menú* y elige *Mis recojos*.\n\n¡Gracias por reciclar con Aldeas Infantiles SOS! 💚`;
    await say(ctx, texto);
    console.log(`📦 Reserva ${reserva.codigo} — ${reserva.distrito} ${reserva.fecha_recojo} (${ctx.from})`);
    correo("reserva", reserva);
    await go(ctx, "menu", { flujo: null, materiales: [], fotos: [], previa: null });
  }


  // ── Mis recojos ──
  async function showMisRecojos(ctx) {
    const hoy = U.limaParts(new Date()).iso;
    const activas = await store.reservasActivasDeUsuario(ctx.from, hoy);
    if (activas.length === 0) {
      await say(ctx, "No tienes recojos programados en este momento.");
      return showMenu(ctx);
    }
    await go(ctx, "recojos_lista", { flujo: "recojos" });
    const rows = activas.map((r) => ({ id: `res:${r.id}`, title: U.fechaCorta(r.fecha_recojo), description: U.truncar(`${r.codigo} · ${r.distrito} · ${r.materiales.join(", ")}`, 72) }));
    await pick(ctx, "Estos son tus recojos programados. Elige uno para ver opciones:", "Ver recojos", rows, { sectionTitle: "Mis recojos" });
  }
  async function showReservaOpciones(ctx, reserva) {
    await go(ctx, "recojo_opciones", { reserva_id: reserva.id, distrito: reserva.distrito, fecha: reserva.fecha_recojo });
    const texto = `*${reserva.codigo}*\n📅 ${U.fechaLarga(reserva.fecha_recojo)}\n📍 ${reserva.direccion}, ${reserva.distrito}\n♻️ ${reserva.materiales.join(", ")}\n\n¿Qué deseas hacer?`;
    await ask(ctx, texto, [{ id: BTN.reprogramar, title: "Cambiar fecha" }, { id: BTN.cancelarReserva, title: "Cancelar recojo" }, { id: BTN.volver, title: "Volver" }]);
  }

  // ── Manejo de imagen (foto de materiales) ──
  async function handleImage(ctx, image) {
    try {
      const { buffer, mimeType, size } = await wa.downloadMedia(image.id);
      if (size > 10 * 1024 * 1024) { await say(ctx, "La foto es muy pesada. Envía una de menos de 10 MB, por favor."); return; }
      const url = await store.uploadFoto(buffer, mimeType, ctx.from);
      const fotos = [...(ctx.datos.fotos || []), url];
      ctx.datos.fotos = fotos;
      await store.logMensaje(ctx.from, "user", `[foto] ${url}`, { paso: ctx.paso });
      if (ctx.datos.corrigiendo) { await go(ctx, "confirmar", { fotos }); return askConfirmar(ctx); }
      await go(ctx, "foto_mas", { fotos });
      await askFotoMas(ctx);
    } catch (err) {
      console.error("❌ Foto:", err.message);
      await say(ctx, "No pude recibir la foto 😕. ¿Puedes enviarla de nuevo?");
    }
  }

  // ── Distrito ──
  async function handleDistrito(ctx, texto) {
    const distritos = await store.getDistritos();
    if (RE_LISTA.test(texto)) {
      await say(ctx, `Distritos con cobertura:\n${distritos.map((d) => d.nombre).join(", ")}.\n\nEscribe el tuyo.`);
      return;
    }
    const r = U.buscarDistrito(texto, distritos);
    if (r.exact) return setDistrito(ctx, r.exact);
    if (r.candidates) {
      await go(ctx, "distrito_elegir");
      await pick(ctx, "¿Cuál de estos distritos?", "Elegir distrito", [
        ...r.candidates.map((d) => ({ id: `dist:${d.id}`, title: U.truncar(d.nombre, 24) })),
        { id: "dist:otro", title: "Ninguno de estos" },
      ], { sectionTitle: "Distritos" });
      return;
    }
    const cfg = await store.getConfig();
    await say(ctx, `Por ahora *no tenemos cobertura en "${texto.trim()}"* o no reconocí el nombre. Revisa la escritura o escribe *lista* para ver los distritos atendidos.\n\nSi tu distrito no está, ${cfg.contacto_humano || "escríbenos para evaluar tu caso"}.`);
  }
  async function setDistrito(ctx, d) {
    if (!d.dias || d.dias.length === 0) {
      const cfg = await store.getConfig();
      await say(ctx, `*${d.nombre}* no tiene ruta de recojo activa por ahora. ${cfg.contacto_humano || ""}`);
      return;
    }
    ctx.datos.distrito = d.nombre; ctx.datos.distrito_id = d.id;
    if (ctx.datos.corrigiendo) {
      // Si cambia el distrito, la fecha deja de ser válida.
      ctx.datos.fecha = null;
      await go(ctx, "fecha", { distrito: d.nombre, distrito_id: d.id, fecha: null });
      return askFecha(ctx, { prefijo: "Como cambió el distrito, elige de nuevo la fecha. " });
    }
    await go(ctx, "direccion", { distrito: d.nombre, distrito_id: d.id });
    await askDireccion(ctx);
  }

  // ── Punto de entrada ──
  async function handle({ from, name, msg }) {
    const ahora = Date.now();
    const sesion = await store.getSesion(from);
    const expirada = !sesion || ahora - new Date(sesion.updated_at).getTime() > SESSION_TTL_MS;
    const ctx = { from, name, paso: expirada ? "inicio" : sesion.paso, datos: sesion?.datos || {} };
    if (expirada) ctx.datos = { consent_at: sesion?.datos?.consent_at || null };

    const texto = msg.text || "";
    const btn = msg.buttonId || null;
    if (texto) await store.logMensaje(from, "user", texto, { paso: ctx.paso });
    else if (btn) await store.logMensaje(from, "user", msg.buttonTitle || btn, { paso: ctx.paso, button: btn });

    // Consentimiento vigente → saltar la tarjeta
    const consentOk = ctx.datos.consent_at && ahora - new Date(ctx.datos.consent_at).getTime() < CONSENT_DAYS * 86400000;

    // Comandos globales
    if (btn === BTN.menu || (texto && RE_MENU.test(texto))) {
      if (!consentOk) return showConsent(ctx);
      return showMenu(ctx, /salir|reiniciar/i.test(texto) && ctx.datos.flujo ? "Listo, cancelé el proceso. ¿Qué deseas hacer?" : null);
    }

    switch (ctx.paso) {
      case "inicio":
        if (consentOk) return showMenu(ctx, ctx.name ? `¡Hola de nuevo, ${ctx.name.split(" ")[0]}! 👋 ¿Qué deseas hacer?` : "¡Hola de nuevo! 👋 ¿Qué deseas hacer?");
        return showConsent(ctx);

      case "consentimiento":
        if (btn === BTN.acepto || /^\s*(acepto|s[ií]|acepta|de acuerdo|ok|continuar)\b/i.test(texto)) {
          await go(ctx, "menu", { consent_at: new Date().toISOString() });
          return showMenu(ctx, "¡Gracias! ¿Qué deseas hacer?");
        }
        if (btn === BTN.noAcepto || /^\s*no\b/i.test(texto)) {
          await say(ctx, "Entendido. Cuando quieras donar, escríbeme *hola* y retomamos. ¡Gracias por pensar en reciclar! 💚");
          return go(ctx, "inicio");
        }
        return showConsent(ctx);

      case "menu":
        if (btn === BTN.donar || /donar|reciclar|recojo|donaci[oó]n|programar/i.test(texto)) return startDonacion(ctx);
        if (btn === BTN.misRecojos || /mis recojos|reprogramar|cambiar fecha|cancelar/i.test(texto)) return showMisRecojos(ctx);
        if (btn === BTN.info || /info|informaci[oó]n|c[oó]mo funciona|ayuda|distritos|cobertura/i.test(texto)) return showInfo(ctx);
        if (RE_HOLA.test(texto)) return showMenu(ctx, "¡Hola! 👋 ¿Qué deseas hacer?");
        return showMenu(ctx, "No entendí tu mensaje. Elige una opción:");

      // ── Donación ──
      case "reutilizar":
        if (btn === BTN.usarDatos) {
          const p = ctx.datos.previa || {};
          await go(ctx, "direccion_confirmar", { ...p, contacto: p.tipo_donante === "empresa" ? p.nombre : null, nombre: p.tipo_donante === "empresa" ? p.empresa : p.nombre, previa: null });
          return ask(ctx, `¿El recojo es en la misma dirección?\n📍 ${p.direccion}, ${p.distrito}`, [{ id: BTN.mismaDir, title: "Sí, la misma" }, { id: BTN.otraDir, title: "Otra dirección" }]);
        }
        if (btn === BTN.datosNuevos) { ctx.datos.previa = null; return askTipoDonante(ctx); }
        return ask(ctx, "¿Uso tus datos anteriores?", [{ id: BTN.usarDatos, title: "Sí, usar mis datos" }, { id: BTN.datosNuevos, title: "Ingresar nuevos" }]);

      case "direccion_confirmar":
        if (btn === BTN.mismaDir) return askDisponibilidad(ctx);
        if (btn === BTN.otraDir) return askDistrito(ctx);
        return ask(ctx, "¿Es la misma dirección?", [{ id: BTN.mismaDir, title: "Sí, la misma" }, { id: BTN.otraDir, title: "Otra dirección" }]);

      case "tipo_donante":
        // Persona: nombre → DNI/RUC → correo.  Empresa: RUC (SUNAT) → contacto → correo.
        if (btn === BTN.persona || /\b(persona|natural|yo)\b/i.test(texto)) { await go(ctx, "nombre", { tipo_donante: "persona" }); return askNombre(ctx); }
        if (btn === BTN.empresa || /\b(empresa|negocio|compa[ñn][ií]a|ruc)\b/i.test(texto)) { await go(ctx, "documento", { tipo_donante: "empresa" }); return askDocumento(ctx); }
        return askTipoDonante(ctx);

      case "nombre": {
        if (RE_SOLO_SALUDO.test(texto)) return askNombre(ctx);
        const v = U.validarNombre(texto);
        if (!v) return say(ctx, "Necesito un nombre válido (mínimo 3 letras). Inténtalo de nuevo.");
        ctx.datos.nombre = ctx.datos.tipo_donante === "empresa" ? v : U.capitalizarNombre(v);
        if (ctx.datos.tipo_donante === "empresa") {
          if (ctx.datos.corrigiendo) { await go(ctx, "confirmar", { nombre: ctx.datos.nombre }); return askConfirmar(ctx); }
          await go(ctx, "contacto", { nombre: ctx.datos.nombre }); return askContacto(ctx);
        }
        await go(ctx, "documento", { nombre: ctx.datos.nombre });
        return next(ctx, askDocumento);
      }
      case "contacto": {
        if (RE_SOLO_SALUDO.test(texto)) return askContacto(ctx);
        const v = U.validarNombre(texto);
        if (!v) return say(ctx, "Escribe el nombre de la persona de contacto, por favor.");
        await go(ctx, "correo", { contacto: U.capitalizarNombre(v) });
        return next(ctx, askCorreo);
      }
      case "documento": {
        const doc = U.validarDocumento(texto);
        if (!doc) return say(ctx, ctx.datos.tipo_donante === "empresa" ? "El RUC debe tener *11 dígitos* válidos (empieza en 10, 15, 16, 17 o 20). Escríbelo de nuevo." : "El DNI debe tener *8 dígitos* (o el RUC 11 dígitos válidos). Escríbelo de nuevo, solo números.");
        if (ctx.datos.tipo_donante === "empresa" && doc.tipo !== "RUC") return say(ctx, "Para empresas necesito el *RUC* (11 dígitos).");
        const info = doc.tipo === "RUC" && sunat ? await sunat.consultar(doc.valor) : null;
        ctx.datos.documento_tipo = doc.tipo; ctx.datos.documento = doc.valor; ctx.datos.sunat = info;
        if (ctx.datos.tipo_donante === "empresa") {
          if (info?.razon_social) return confirmarRuc(ctx, info);
          await go(ctx, "nombre", { documento_tipo: doc.tipo, documento: doc.valor, sunat: null });
          return askNombre(ctx, sunat?.enabled ? "No encontré ese RUC en SUNAT. " : "");
        }
        await go(ctx, "correo", { documento_tipo: doc.tipo, documento: doc.valor, sunat: info });
        return next(ctx, askCorreo);
      }
      case "ruc_confirmar": {
        const info = ctx.datos.sunat;
        if (btn === BTN.rucSi || /^\s*(s[ií]|correcta|correcto|ok)\b/i.test(texto)) {
          if (!info?.razon_social) return askNombre(ctx);
          if (ctx.datos.corrigiendo) { await go(ctx, "confirmar", { nombre: info.razon_social }); return askConfirmar(ctx); }
          await go(ctx, "contacto", { nombre: info.razon_social }); return askContacto(ctx);
        }
        if (btn === BTN.rucNo || /^\s*no\b/i.test(texto)) {
          ctx.datos.sunat = null;
          await go(ctx, "documento", { sunat: null });
          return say(ctx, "Revisa el *RUC* y escríbelo de nuevo (11 dígitos).");
        }
        return info ? confirmarRuc(ctx, info) : askNombre(ctx);
      }
      case "disponibilidad": {
        const disp = btn === BTN.dispLV || /lunes|l-v|semana/i.test(texto) ? "lun_vie" : btn === BTN.dispSab || /s[aá]bado/i.test(texto) ? "incluye_sab" : null;
        if (!disp) return askDisponibilidad(ctx);
        await go(ctx, "horario", { disponibilidad: disp });
        return askHorario(ctx);
      }
      case "horario": {
        if (!texto || texto.length < 3) return say(ctx, "Indícame el horario de atención, por ejemplo: _9:00 a 17:00_.");
        await go(ctx, "requisitos", { horario: texto.slice(0, 120) });
        if (ctx.datos.tipo_donante === "empresa") return askRequisitos(ctx);
        return next(ctx, askMaterial);
      }
      case "requisitos": {
        const req = btn === BTN.omitir || RE_OMITIR.test(texto) ? null : (texto || null);
        await go(ctx, "materiales", { requisitos: req ? req.slice(0, 300) : null });
        return next(ctx, askMaterial);
      }
      case "correo": {
        const v = U.validarCorreo(texto);
        if (!v) return say(ctx, "Ese correo no parece válido. Escríbelo así: nombre@dominio.com");
        await go(ctx, "distrito", { correo: v });
        return next(ctx, askDistrito);
      }
      case "distrito":
        if (!texto) return askDistrito(ctx);
        return handleDistrito(ctx, texto);
      case "distrito_elegir": {
        if (btn === "dist:otro") return askDistrito(ctx);
        if (btn && btn.startsWith("dist:")) {
          const distritos = await store.getDistritos();
          const d = distritos.find((x) => x.id === btn.slice(5));
          if (d) return setDistrito(ctx, d);
        }
        if (texto) return handleDistrito(ctx, texto);
        return askDistrito(ctx);
      }
      case "direccion": {
        let dir = texto;
        if (msg.location) dir = [msg.location.name, msg.location.address].filter(Boolean).join(", ") || `${msg.location.lat},${msg.location.lng}`;
        if (!dir || dir.length < 6) return say(ctx, "Escribe la dirección completa (calle y número), por favor.");
        await go(ctx, "referencia", { direccion: dir.slice(0, 200) });
        return next(ctx, askReferencia);
      }
      case "referencia":
        await go(ctx, "disponibilidad", { referencia: btn === BTN.omitir || RE_OMITIR.test(texto) ? null : texto.slice(0, 200) });
        return next(ctx, askDisponibilidad);

      case "materiales": {
        let mat = btn && btn.startsWith("mat:") ? btn.slice(4) : (texto && texto.length >= 3 ? texto.trim() : null);
        if (!mat) return askMaterial(ctx);
        if (/^otro/i.test(mat) && btn) { await go(ctx, "material_otro"); return say(ctx, "¿Qué material es? Descríbelo brevemente."); }
        const materiales = [...new Set([...(ctx.datos.materiales || []), U.truncar(mat, 40)])];
        await go(ctx, "materiales_mas", { materiales });
        return askMaterialMas(ctx);
      }
      case "material_otro": {
        if (!texto || texto.length < 3) return say(ctx, "Descríbeme el material, por favor.");
        const materiales = [...new Set([...(ctx.datos.materiales || []), U.truncar(texto, 40)])];
        await go(ctx, "materiales_mas", { materiales });
        return askMaterialMas(ctx);
      }
      case "materiales_mas":
        if (btn === BTN.matListo || /^\s*(no|listo|continuar|seguir|ya)\b/i.test(texto)) { await go(ctx, "cantidad"); return next(ctx, askCantidad); }
        if (btn === BTN.matMas || /^\s*(s[ií]|otro|m[aá]s|agregar)\b/i.test(texto)) return askMaterial(ctx);
        return askMaterialMas(ctx);

      case "cantidad":
        if (!texto || texto.length < 2) return say(ctx, "Indícame una cantidad aproximada (kilos, cajas, bolsas, unidades…).");
        await go(ctx, "comentario", { cantidad: texto.slice(0, 200) });
        return next(ctx, askComentario);

      case "comentario": {
        const comentario = btn === BTN.omitir || RE_OMITIR.test(texto) ? null : (texto || null);
        const cfg = await store.getConfig();
        await go(ctx, "foto", { comentario: comentario ? comentario.slice(0, 500) : null });
        if (ctx.datos.corrigiendo) return askConfirmar(ctx);
        if (String(cfg.foto_obligatoria) === "0" ) { await go(ctx, "fecha"); return askFecha(ctx); }
        return askFoto(ctx);
      }
      case "foto":
        if (msg.image) return handleImage(ctx, msg.image);
        if (msg.document && /image\//.test(msg.document.mimeType || "")) return handleImage(ctx, { id: msg.document.id });
        return say(ctx, "Necesito una *foto* de los materiales para continuar 📷. Adjúntala desde el clip o la cámara de WhatsApp.");
      case "foto_mas":
        if (msg.image) return handleImage(ctx, msg.image);
        if (btn === BTN.fotoListo || /^\s*(no|listo|continuar|seguir|ya)\b/i.test(texto)) {
          if (ctx.datos.corrigiendo) return askConfirmar(ctx);
          await go(ctx, "fecha");
          return askFecha(ctx);
        }
        if (btn === BTN.fotoMas || /^\s*(s[ií]|otra|m[aá]s)\b/i.test(texto)) { await go(ctx, "foto"); return say(ctx, "Envía la siguiente foto 📷"); }
        return askFotoMas(ctx);

      case "fecha": {
        if (btn && btn.startsWith("fecha:")) {
          const iso = btn.slice(6);
          if (!U.parseIsoDate(iso)) return askFecha(ctx);
          await go(ctx, "confirmar", { fecha: iso });
          return askConfirmar(ctx);
        }
        return askFecha(ctx, { prefijo: "Elige una fecha de la lista. " });
      }
      case "confirmar":
        if (btn === BTN.confirmar || /^\s*(confirmar|confirmo|s[ií]|ok|listo)\b/i.test(texto)) return crearReserva(ctx);
        if (btn === BTN.cancelarFlujo) return showMenu(ctx, "Cancelé el registro. Cuando quieras retomarlo, elige *Donar reciclables*.");
        if (btn === BTN.corregir || /corregir|cambiar|editar/i.test(texto)) {
          await go(ctx, "corregir");
          return pick(ctx, "¿Qué dato quieres corregir?", "Elegir dato", CAMPOS_CORREGIBLES, { sectionTitle: "Datos" });
        }
        return askConfirmar(ctx);
      case "corregir": {
        if (!btn || !btn.startsWith("fix:")) return askConfirmar(ctx);
        const campo = btn.slice(4);
        ctx.datos.corrigiendo = true;
        await go(ctx, campo, { corrigiendo: true });
        const map = { nombre: askNombre, documento: askDocumento, correo: askCorreo, distrito: askDistrito, direccion: askDireccion, disponibilidad: askDisponibilidad, cantidad: askCantidad, fecha: askFecha };
        if (campo === "materiales") { await go(ctx, "materiales", { materiales: [] }); return askMaterial(ctx); }
        if (campo === "foto") { await go(ctx, "foto", { fotos: [] }); return askFoto(ctx); }
        return map[campo] ? map[campo](ctx) : askConfirmar(ctx);
      }

      // ── Mis recojos ──
      case "recojos_lista": {
        if (btn && btn.startsWith("res:")) {
          const r = await store.getReserva(btn.slice(4));
          if (r && r.user_id === ctx.from && r.estado === "programado") return showReservaOpciones(ctx, r);
        }
        return showMisRecojos(ctx);
      }
      case "recojo_opciones": {
        const r = await store.getReserva(ctx.datos.reserva_id);
        if (!r || r.estado !== "programado") return showMisRecojos(ctx);
        if (btn === BTN.volver) return showMenu(ctx);
        if (btn === BTN.reprogramar || /cambiar|reprogramar|otra fecha/i.test(texto)) {
          await go(ctx, "reprog_fecha", { flujo: "reprogramar", distrito: r.distrito, fecha: r.fecha_recojo });
          return askFecha(ctx, { excluir: r.fecha_recojo, prefijo: `Tu recojo actual es el ${U.fechaLarga(r.fecha_recojo)}. ` });
        }
        if (btn === BTN.cancelarReserva || /cancelar/i.test(texto)) {
          await go(ctx, "recojo_cancelar");
          return ask(ctx, `¿Seguro que cancelas el recojo *${r.codigo}* del ${U.fechaLarga(r.fecha_recojo)}?`, [{ id: BTN.siCancelar, title: "Sí, cancelar" }, { id: BTN.noCancelar, title: "No, mantener" }]);
        }
        return showReservaOpciones(ctx, r);
      }
      case "reprog_fecha": {
        if (btn && btn.startsWith("fecha:")) {
          const iso = btn.slice(6);
          try {
            const r = await store.reprogramar(ctx.datos.reserva_id, iso, "donante");
            await say(ctx, `✅ Listo. Tu recojo *${r.codigo}* quedó reprogramado para el *${U.fechaLarga(r.fecha_recojo)}*.\n📍 ${r.direccion}, ${r.distrito}`);
            correo("reprogramacion", r);
            return showMenu(ctx);
          } catch (err) {
            if (err.code === "CUPO_LLENO" || err.code === "FECHA_BLOQUEADA") return askFecha(ctx, { excluir: ctx.datos.fecha, prefijo: "Ese cupo acaba de ocuparse 😔. " });
            if (err.code === "ESTADO_INVALIDO" || err.code === "NO_EXISTE") { await say(ctx, "Esa reserva ya no está activa."); return showMenu(ctx); }
            throw err;
          }
        }
        return askFecha(ctx, { excluir: ctx.datos.fecha, prefijo: "Elige una fecha de la lista. " });
      }
      case "recojo_cancelar": {
        if (btn === BTN.siCancelar || /^\s*s[ií]\b/i.test(texto)) {
          try {
            const r = await store.cambiarEstado(ctx.datos.reserva_id, "cancelado", { nota: "Cancelado por el donante desde WhatsApp", actor: "donante" });
            await say(ctx, `Tu recojo *${r.codigo}* fue cancelado. Cuando quieras volver a donar, aquí estaré 💚`);
            correo("cancelacion", r, "Cancelado por el donante desde WhatsApp");
          } catch (err) { console.error("❌ cancelar:", err.message); await say(ctx, "No pude cancelar la reserva. Intenta de nuevo en unos minutos."); }
          return showMenu(ctx);
        }
        if (btn === BTN.noCancelar || /^\s*no\b/i.test(texto)) { await say(ctx, "Perfecto, tu recojo sigue programado."); return showMenu(ctx); }
        return ask(ctx, "¿Cancelo el recojo?", [{ id: BTN.siCancelar, title: "Sí, cancelar" }, { id: BTN.noCancelar, title: "No, mantener" }]);
      }

      default:
        return showMenu(ctx);
    }
  }

  return { handle, BTN };
}

module.exports = { createFlow, BTN, SESSION_TTL_MS };
