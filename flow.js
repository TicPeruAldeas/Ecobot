// Motor conversacional de ECO: máquina de estados por usuario.
// Sigue el guion del ECO anterior (Chatfuel): RUC → SUNAT → peso mínimo → residuos → fotos →
// zona → distrito → día → fecha → dirección → correo → atención/acceso → comentario → resumen → código.
// La verdad de cupos vive en Supabase (eco_reservar).
const U = require("./util");
const { fechasDisponibles } = require("./scheduling");

// Inactividad tras la cual la conversación se reinicia desde la bienvenida.
// Prioridad: eco_config.sesion_minutos (panel) → SESSION_TTL_MINUTES → SESSION_TTL_HOURS → 30 min.
const SESSION_TTL_MS_DEFAULT = (Number(process.env.SESSION_TTL_MINUTES) || (Number(process.env.SESSION_TTL_HOURS) || 0) * 60 || 30) * 60 * 1000;
const sessionTtlMs = (cfg) => (Number(cfg?.sesion_minutos) > 0 ? Number(cfg.sesion_minutos) * 60 * 1000 : SESSION_TTL_MS_DEFAULT);

const RE_MENU = /^\s*(menu|menú|volver|salir|reiniciar|empezar de nuevo|cancelar todo)\s*$/i;
const RE_HOLA = /^\s*(hola|buenas|buenos d[ií]as|buenas tardes|buenas noches|hi|hello|ola)\b/i;
// Saludo "suelto" en cualquier paso → reinicia desde la bienvenida. "reservar" suelto → empieza la reserva.
const RE_SALUDO_GLOBAL = /^\s*(hola|holi|holaa+|buenas|buen d[ií]a|buenos d[ií]as|buenas tardes|buenas noches|hi|hello|ola|eco|hola eco|eco hola|hey|inicio|empezar|comenzar|start)[\s!.,¡?]*$/i;
const RE_RESERVAR_GLOBAL = /^\s*(reservar|reserva|solicitud|iniciar solicitud|nueva solicitud|quiero reservar|empezar reserva|nueva reserva|agendar|agendar recojo|programar recojo|quiero donar|donar)[\s!.,]*$/i;
const RE_MIS_RESERVAS_GLOBAL = /^\s*(mis reservas|mis solicitudes|mis recojos|reprogramar|cambiar fecha|cancelar reserva|cancelar solicitud)[\s!.,]*$/i;
// Autoservicio de reprogramar/cancelar por WhatsApp. Apagado por decisión del equipo (16-sep-2026); el panel lo hace.
const AUTOSERVICIO = /^(1|true|yes|on)$/i.test(process.env.AUTOSERVICIO_RESERVAS || "");
const RE_SI = /^\s*(s[ií]|si,? continuar|s[ií],? confirmar|s[ií],? a[ñn]adir|correcto|ok|dale|claro|confirmo|continuar)\b/i;
const RE_NO = /^\s*(no|no,? modificar|no,? regresar|no,? continuar|no,? cancelar|ninguno|ninguna|omitir)\b/i;

const BTN = {
  reservar: "menu_reservar", misRecojos: "menu_recojos", constancias: "menu_constancias", menu: "go_menu", info: "menu_info",
  usarDatos: "prev_usar", datosNuevos: "prev_nuevos",
  si: "si", no: "no",
  sinRestriccion: "acc_sin", ninguno: "req_ninguno",
  fotoMas: "foto_mas", fotoListo: "foto_listo",
  confirmar: "res_confirmar", corregir: "res_corregir", cancelarFlujo: "res_cancelar",
  reprogramar: "r_reprogramar", cancelarReserva: "r_cancelar", volver: "r_volver",
  siCancelar: "rc_si", noCancelar: "rc_no",
};
const DISPONIBILIDAD = { lun_vie: "Lunes a viernes", incluye_sab: "Incluye sábados" };

const CAMPOS_CORREGIBLES = [
  { id: "fix:ruc", title: "RUC / empresa" },
  { id: "fix:materiales", title: "Residuos" },
  { id: "fix:foto", title: "Fotografías" },
  { id: "fix:zona", title: "Zona y distrito" },
  { id: "fix:fecha", title: "Fecha de recojo" },
  { id: "fix:direccion", title: "Dirección" },
  { id: "fix:correo", title: "Correo" },
  { id: "fix:acceso", title: "Horario y acceso" },
  { id: "fix:comentario", title: "Comentario" },
];

// Etiquetas de residuos detectadas en el texto libre del donante.
const MATERIAL_KEYS = [
  ["Papel", /papel|hojas|cuaderno|archivo|revista|peri[oó]dico/i],
  ["Cartón", /cart[oó]n|cajas?/i],
  ["Plástico", /pl[aá]stico|pet\b|botellas?|bidones?|tapas?/i],
  ["Metal / chatarra", /metal|chatarra|aluminio|fierro|hierro|latas?|cobre/i],
  ["RAEE", /el[eé]ctric|electr[oó]nic|raee|computador|laptop|monitor|impresora|cpu|celular|cables?|luminaria|fluorescente/i],
  ["Mobiliario", /mobiliario|muebles?|sillas?|escritorios?|estantes?|archivadores?/i],
  ["Vidrio", /vidrio|cristal/i],
  ["Ropa / textil", /ropa|textil|tela|uniformes?/i],
];
function detectarMateriales(texto) {
  const out = MATERIAL_KEYS.filter(([, re]) => re.test(texto)).map(([n]) => n);
  return out.length ? out : ["Otros"];
}
// Color y orden de las zonas (como en el ECO anterior). Otras zonas: 📍 al final.
const ZONA_META = { "callao": { emoji: "🔵", orden: 1 }, "lima sur": { emoji: "🟠", orden: 2 }, "lima norte": { emoji: "🟣", orden: 3 }, "lima centro": { emoji: "🟡", orden: 4 }, "lima este": { emoji: "🟢", orden: 5 } };
const zonaMeta = (z) => ZONA_META[String(z || "").toLowerCase()] || { emoji: "📍", orden: 99 };
const capDia = (isoDow) => { const d = U.nombreDia(isoDow); return d.charAt(0).toUpperCase() + d.slice(1); };
const diasTexto = (dias = []) => {
  const n = [...dias].sort().map(capDia);
  if (n.length === 0) return "Sin ruta";
  if (n.length === 1) return `Solo ${n[0].toLowerCase()}`;
  return `Solo ${n.slice(0, -1).map((x) => x.toLowerCase()).join(", ")} y ${n[n.length - 1].toLowerCase()}`;
};
const fechaTitulo = (iso) => { const p = U.parseIsoDate(iso); return `${String(p.d).padStart(2, "0")} de ${U.MESES[p.m - 1]}`; };

function createFlow({ store, wa, sunat = null, mailer = null, constancias = null }) {
  // ── Correos fire-and-forget ──
  function correo(tipo, reserva, extra) {
    if (!mailer?.enabled) return;
    const cb = (err) => store.addEvento(reserva.id, err ? "correo_error" : "correo", { tipo, ...(err ? { error: err.message } : { a: reserva.correo }) }, "sistema");
    if (tipo === "reserva") mailer.reserva(reserva, cb);
    else if (tipo === "reprogramacion") mailer.reprogramacion(reserva, cb);
    else if (tipo === "cancelacion") mailer.cancelacion(reserva, extra, cb);
    mailer.avisoInterno(reserva, tipo, tipo === "cancelacion" ? extra : null);
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
  const siNo = (ctx, text, si = "✅ Sí, continuar", no = "❌ No, modificar") => ask(ctx, text, [{ id: BTN.si, title: si }, { id: BTN.no, title: no }]);

  async function go(ctx, paso, patch = {}) {
    ctx.paso = paso;
    ctx.datos = { ...ctx.datos, ...patch };
    await store.saveSesion(ctx.from, paso, ctx.datos, ctx.name);
  }
  // Tras corregir un campo, volver al resumen.
  const next = (ctx, siguiente) => (ctx.datos.corrigiendo ? askConfirmar(ctx) : siguiente(ctx));

  // ── Menú ──
  async function showMenu(ctx, { bienvenida = false, intro = null, nota = null } = {}) {
    const cfg = await store.getConfig();
    await go(ctx, "menu", { flujo: null });
    let texto;
    if (bienvenida) {
      // Texto exacto del ECO anterior: nombre completo de WhatsApp, sin añadidos.
      texto = (nota ? `${nota}\n\n` : "") + String(cfg.mensaje_bienvenida || "").replace(/\{nombre\}/g, ctx.name || "").replace(/\s*\n\s*\n\s*\n/g, "\n\n").trim();
    } else texto = intro || "¿Qué deseas hacer?";
    // Botones del ECO anterior. "Mis reservas" (reprogramar/cancelar) se abre escribiendo "mis reservas".
    await ask(ctx, texto, [
      { id: BTN.reservar, title: "👉 Iniciar solicitud" },
      { id: BTN.constancias, title: "Constancias" },
    ]);
  }

  async function showInfo(ctx) {
    const [cfg, distritos] = await Promise.all([store.getConfig(), store.getDistritos()]);
    const porDia = {};
    for (const d of distritos) for (const dia of d.dias || []) (porDia[dia] = porDia[dia] || []).push(d.nombre);
    const rutas = Object.keys(porDia).map(Number).sort().map((dia) => `• *${capDia(dia)}*: ${porDia[dia].join(", ")}`).join("\n");
    await say(ctx, `*¿Cómo funciona ECO?*\n1. Ingresas el RUC de tu empresa y describes los residuos (con fotos).\n2. Eliges zona, distrito y una fecha disponible.\n3. Confirmas y nuestro equipo pasa a recoger la donación entre ${cfg.horario_recojo || "9:00 a. m. y 5:30 p. m."}.\n4. Recibes tu constancia de donación.\n\n*Peso mínimo por punto:* ${cfg.peso_minimo_kg || 250} kg.\n\n*Días de recojo por distrito:*\n${rutas}\n\n¿Necesitas ayuda de una persona? ${cfg.contacto_humano || ""}`);
    return showMenu(ctx);
  }

  // ── Reserva: inicio ──
  async function startReserva(ctx) {
    await go(ctx, "ruc", { flujo: "reserva", fotos: [], corrigiendo: false, previa: null, tipo_donante: "empresa" });
    const previa = await store.ultimaReservaDeUsuario(ctx.from);
    if (previa?.documento) {
      await go(ctx, "reutilizar", { previa: {
        documento: previa.documento, documento_tipo: previa.documento_tipo, empresa: previa.empresa || previa.nombre, sunat: previa.sunat || null,
        direccion: previa.direccion, correo: previa.correo, distrito: previa.distrito, distrito_id: previa.distrito_id,
      } });
      return ask(ctx, `Veo que ya has reservado antes. ¿Uso estos datos?\n\n🏢 ${previa.empresa || previa.nombre}\n🪪 RUC ${previa.documento}\n✉️ ${previa.correo || "-"}\n📍 ${previa.direccion}, ${previa.distrito}`,
        [{ id: BTN.usarDatos, title: "Sí, usar mis datos" }, { id: BTN.datosNuevos, title: "Ingresar nuevos" }]);
    }
    await say(ctx, "¡Perfecto! 🎉 Vamos a proceder con la programación de tu reserva. Por favor, proporciona los siguientes datos para completar el registro ✨.");
    return askRuc(ctx);
  }
  async function askRuc(ctx) {
    await go(ctx, "ruc");
    await say(ctx, "📌 Ingrese el número de *RUC*:");
  }
  async function bienvenidaEmpresa(ctx) {
    await say(ctx, `Hola *${ctx.datos.empresa}*, bienvenido ✊.`);
    return askPesoMinimo(ctx);
  }
  async function askPesoMinimo(ctx) {
    const cfg = await store.getConfig();
    await go(ctx, "peso_minimo");
    await say(ctx, String(cfg.mensaje_peso_minimo || "").replace(/\{peso\}/g, cfg.peso_minimo_kg || "250"));
    await siNo(ctx, "📌 ¿Podría confirmarnos si cuenta con el mínimo requerido para poder agendar el recojo de sus residuos?", "Sí", "No");
  }
  async function askMateriales(ctx) {
    await go(ctx, "materiales");
    await say(ctx, "📌 Especifique la cantidad y el tipo de residuos que desea donar: _(papel, cartón, plástico, metal, chatarra, aparatos eléctricos, mobiliario en desuso)_");
  }
  async function askFoto(ctx) {
    await go(ctx, "foto");
    await say(ctx, "📤 *Obligatorio*: Adjunte una *fotografía* clara de los residuos que desea donar.\n\n_Su imagen nos permitirá calcular con mayor precisión el espacio y peso necesarios para programar el recojo._");
  }
  async function askFotoMas(ctx) {
    await go(ctx, "foto_mas");
    await ask(ctx, `✅ ¡Imagen válida recibida! Llevas ${ctx.datos.fotos.length} foto(s). ¿Deseas adjuntar otra?`, [{ id: BTN.fotoMas, title: "📷 Otra foto" }, { id: BTN.fotoListo, title: "✅ Continuar" }]);
  }

  // ── Zona → distrito → día → fecha ──
  async function zonas() {
    const distritos = await store.getDistritos();
    const map = new Map();
    for (const d of distritos) { if (!(d.dias || []).length) continue; const z = d.zona || "Otras zonas"; if (!map.has(z)) map.set(z, []); map.get(z).push(d); }
    const orden = (a, b) => zonaMeta(a[0]).orden - zonaMeta(b[0]).orden || a[0].localeCompare(b[0]);
    for (const ds of map.values()) ds.sort((a, b) => a.nombre.localeCompare(b.nombre));
    return { distritos, zonas: [...map.entries()].sort(orden) };
  }
  async function askZona(ctx) {
    const { zonas: zs } = await zonas();
    await go(ctx, "zona");
    if (zs.length <= 1) return askDistritoTexto(ctx);
    await pick(ctx, "🌍 *Seleccione la Zona:*\n📍 Escoja primero la zona y luego el distrito donde se encuentra el material que desea donar. 📦✨\n♻️ Gracias por contribuir al cuidado del medio ambiente.\n\n_Si prefiere, escriba directamente el nombre de su distrito._",
      "🔎 Ver Zonas", zs.slice(0, 10).map(([z, ds]) => ({ id: `zona:${z}`, title: U.truncar(`${zonaMeta(z).emoji} ${z.toUpperCase()}`, 24), description: U.truncar(ds.map((d) => d.nombre).join(", "), 72) })), { sectionTitle: "Zonas" });
  }
  async function askDistritoZona(ctx, zona) {
    const cfg = await store.getConfig();
    const { zonas: zs } = await zonas();
    const ds = (zs.find(([z]) => z === zona) || [null, []])[1];
    if (!ds.length) return askZona(ctx);
    await go(ctx, "distrito", { zona });
    const { emoji } = zonaMeta(zona);
    const intro = `*Distritos ${zona} ${emoji}*\n📅 Cada distrito cuenta con un horario establecido. ⏰ Dependiendo de su distrito, habrá días específicos disponibles para realizar la reserva. ✅✨ El horario de recojo es de *${cfg.horario_recojo || "9:00 a. m. a 5:30 p. m."}*.\n\n*Seleccione un distrito:*`;
    const extras = [{ id: "dist:zona", title: "🔄 Cambiar de zona" }, { id: "dist:escribir", title: "✍️ Escribir mi distrito" }];
    const POR_LISTA = 8; // + 2 filas extra = 10 (máximo de WhatsApp)
    for (let i = 0; i < ds.length; i += POR_LISTA) {
      const chunk = ds.slice(i, i + POR_LISTA);
      const ultimo = i + POR_LISTA >= ds.length;
      await pick(ctx, i === 0 ? intro : `Más distritos de ${zona} (${Math.floor(i / POR_LISTA) + 1}):`, "🔎 Ver distritos",
        [...chunk.map((d) => ({ id: `dist:${d.id}`, title: U.truncar(`${emoji} ${d.nombre}`, 24), description: diasTexto(d.dias) })), ...(ultimo ? extras : [])],
        { sectionTitle: U.truncar(zona, 24) });
    }
  }
  async function askDistritoTexto(ctx) {
    await go(ctx, "distrito");
    await say(ctx, "📍 Escriba el *distrito* donde se encuentra el material (por ejemplo: Surco, SJL, Callao). Escriba *lista* para ver los distritos con cobertura.");
  }
  async function handleDistritoTexto(ctx, texto) {
    const distritos = await store.getDistritos();
    if (/^\s*(lista|ver lista|distritos|zonas|cobertura)\s*$/i.test(texto)) {
      const { zonas: zs } = await zonas();
      if (zs.length > 1) return askZona(ctx);
      return say(ctx, `Distritos con cobertura:\n${distritos.filter((d) => d.dias?.length).map((d) => `• ${d.nombre} (${diasTexto(d.dias).toLowerCase()})`).join("\n")}\n\nEscriba el suyo.`);
    }
    const r = U.buscarDistrito(texto, distritos);
    if (r.exact) return setDistrito(ctx, r.exact);
    if (r.candidates) {
      await go(ctx, "distrito");
      return pick(ctx, "¿Cuál de estos distritos?", "Elegir distrito", [...r.candidates.map((d) => ({ id: `dist:${d.id}`, title: U.truncar(d.nombre, 24), description: diasTexto(d.dias) })), { id: "dist:otro", title: "Ninguno de estos" }], { sectionTitle: "Distritos" });
    }
    const cfg = await store.getConfig();
    return say(ctx, `Por ahora *no tenemos cobertura en "${texto.trim()}"* o no reconocí el nombre. Revise la escritura o escriba *lista* para ver los distritos atendidos.\n\nSi su distrito no está, ${cfg.contacto_humano || "escríbanos para evaluar su caso"}.`);
  }
  async function setDistrito(ctx, d) {
    if (!d.dias || d.dias.length === 0) {
      const cfg = await store.getConfig();
      return say(ctx, `*${d.nombre}* no tiene ruta de recojo activa por ahora. ${cfg.contacto_humano || ""}`);
    }
    await go(ctx, "dia", { distrito: d.nombre, distrito_id: d.id, zona: d.zona || ctx.datos.zona || null, fecha: null, dia_semana: null });
    await say(ctx, `${zonaMeta(d.zona).emoji} *${d.nombre}*\n${diasTexto(d.dias)}.`);
    if (d.dias.length === 1) { await go(ctx, "fecha", { dia_semana: d.dias[0] }); return askFecha(ctx); }
    const dias = [...d.dias].sort();
    if (dias.length <= 3) await ask(ctx, `📅 Seleccione el día de la semana para su recolección en ${d.nombre}:`, dias.map((n) => ({ id: `dia:${n}`, title: capDia(n) })));
    else await pick(ctx, `📅 Seleccione el día de la semana para su recolección en ${d.nombre}:`, "Ver días", dias.map((n) => ({ id: `dia:${n}`, title: capDia(n) })), { sectionTitle: "Días" });
  }
  async function calcularFechas(ctx, excluir = null) {
    const [cfg, distritos] = await Promise.all([store.getConfig(), store.getDistritos()]);
    const distrito = distritos.find((d) => d.nombre === ctx.datos.distrito);
    if (!distrito) return { fechas: [], cfg };
    const hoy = U.limaParts(new Date()).iso;
    const hasta = U.addDays(hoy, Math.min(Number(cfg.horizonte_dias) || 30, 120));
    const [fechas, ocupacion] = await Promise.all([store.getFechasMap(hoy, hasta), store.getOcupacionMap(hoy, hasta)]);
    const excluirDias = ctx.datos.dia_semana ? [1, 2, 3, 4, 5, 6, 7].filter((n) => n !== Number(ctx.datos.dia_semana)) : [];
    return { fechas: fechasDisponibles({ now: new Date(), distrito, config: cfg, fechas, ocupacion, excluir, excluirDias }), cfg };
  }
  async function askFecha(ctx, { excluir = null, prefijo = "" } = {}) {
    const { fechas, cfg } = await calcularFechas(ctx, excluir);
    const diaTxt = ctx.datos.dia_semana ? capDia(ctx.datos.dia_semana) : null;
    if (fechas.length === 0) {
      await say(ctx, `${prefijo}Por ahora no hay fechas disponibles${diaTxt ? ` los días ${diaTxt}` : ""} en *${ctx.datos.distrito}* dentro de las próximas semanas. ${cfg.contacto_humano || ""}`);
      if (ctx.datos.flujo === "reprogramar") return showMenu(ctx);
      const distritos = await store.getDistritos();
      const d = distritos.find((x) => x.nombre === ctx.datos.distrito);
      return d && d.dias.length > 1 ? setDistrito(ctx, d) : showMenu(ctx);
    }
    await go(ctx, ctx.datos.flujo === "reprogramar" ? "reprog_fecha" : "fecha");
    const rows = fechas.map((f) => ({ id: `fecha:${f.iso}`, title: fechaTitulo(f.iso), description: `${capDia(U.parseIsoDate(f.iso).isoDow)}${f.libres <= 2 ? ` · ${f.libres} cupo${f.libres === 1 ? "" : "s"}` : ""}` }));
    await pick(ctx, `${prefijo}📍 *Seleccione su fecha de recolección en ${ctx.datos.distrito}:*\n${diaTxt ? `Las siguientes fechas corresponden a los días *${diaTxt}*.` : ""}\nFechas disponibles para su zona.`, "Ver fechas", rows, { sectionTitle: "Fechas disponibles" });
  }

  // ── Dirección / correo / acceso / comentario ──
  async function askDireccion(ctx) {
    if (ctx.datos.direccion && !ctx.datos.corrigiendo) { await go(ctx, "direccion_confirmar"); return siNo(ctx, `📍 Dirección registrada: *${ctx.datos.direccion}*\n¿Es correcta?`); }
    await go(ctx, "direccion", { direccion: null });
    await say(ctx, "Por favor, ingrese la dirección de *recojo*: 📦");
  }
  async function askCorreo(ctx) {
    if (ctx.datos.correo && !ctx.datos.corrigiendo) { await go(ctx, "correo_confirmar"); return siNo(ctx, `✉️ Correo ingresado: *${ctx.datos.correo}*\n¿Es correcto?`); }
    await go(ctx, "correo", { correo: null });
    await say(ctx, "✉️ Ingrese un correo electrónico para recibir la confirmación y los detalles de la reserva: 😊");
  }
  async function askAcceso(ctx) {
    const cfg = await store.getConfig();
    await go(ctx, "acceso");
    await ask(ctx, `🕘 ¿En qué días y horario pueden recibir a nuestro equipo? Nuestro horario de recojo es de *${cfg.horario_recojo || "9:00 a. m. a 5:30 p. m."}*, de lunes a viernes.\n\n_Escriba por ejemplo: "lunes a viernes de 9 a 1" o "solo sábados"._`, [{ id: BTN.sinRestriccion, title: "Sin restricción" }]);
  }
  async function askRequisitos(ctx) {
    await go(ctx, "requisitos");
    await ask(ctx, "🔐 ¿Existe algún *requisito de acceso* a sus instalaciones para nuestro personal? _(SCTR, documento de identidad, EPP, registro en recepción, etc.)_", [{ id: BTN.ninguno, title: "Ninguno" }]);
  }
  async function askComentarioPregunta(ctx) {
    await go(ctx, "comentario_pregunta");
    await siNo(ctx, "¿Desea añadir un comentario u observación sobre la donación? 📝", "Sí, añadir", "No, continuar");
  }

  // ── Resumen y creación ──
  function resumen(d) {
    const acceso = d.horario || d.requisitos ? `\n*Atención*: _${[d.horario, d.requisitos ? `acceso: ${d.requisitos}` : null].filter(Boolean).join(" · ")}_` : "";
    return `*Resumen de tu reserva:*\n\n*RUC*: _${d.documento}_\n*Empresa*: _${d.empresa}_\n*Distrito*: _${d.distrito}_\n*Dirección*: _${d.direccion}_\n*Residuos*: _${d.cantidad}_\n*Fotos*: _${d.fotos.length}_\n*Fecha*: _${U.fechaLarga(d.fecha)}_\n*Correo*: _${d.correo}_${acceso}${d.comentario ? `\n*Comentario*: _${d.comentario}_` : ""}`;
  }
  async function askConfirmar(ctx) {
    await go(ctx, "confirmar", { corrigiendo: false });
    await ask(ctx, `${resumen(ctx.datos)}\n\n*¿Confirmas tu reserva?*`, [
      { id: BTN.confirmar, title: "✅ Sí, confirmar" }, { id: BTN.corregir, title: "✏️ Corregir" }, { id: BTN.cancelarFlujo, title: "❌ No, cancelar" },
    ]);
  }
  async function crearReserva(ctx) {
    const d = ctx.datos;
    const payload = {
      user_id: ctx.from, tipo_donante: "empresa", nombre: ctx.name || d.empresa, empresa: d.empresa,
      documento_tipo: "RUC", documento: d.documento, correo: d.correo,
      distrito_id: d.distrito_id || null, distrito: d.distrito, direccion: d.direccion, referencia: null,
      materiales: d.materiales || detectarMateriales(d.cantidad || ""), cantidad: d.cantidad, comentario: d.comentario || null,
      fotos: d.fotos, fecha_recojo: d.fecha, actor: "donante",
      disponibilidad: d.disponibilidad || null, horario: d.horario || null, requisitos: d.requisitos || null, sunat: d.sunat || null,
    };
    let reserva;
    try {
      reserva = await store.reservar(payload);
    } catch (err) {
      if (err.code === "CUPO_LLENO" || err.code === "FECHA_BLOQUEADA") {
        // Solo falta la fecha: al elegir otra, se vuelve directo al resumen.
        await go(ctx, "fecha", { fecha: null, corrigiendo: true });
        return askFecha(ctx, { prefijo: "Uy, ese cupo acaba de ocuparse 😔. Tus datos siguen guardados. " });
      }
      throw err;
    }
    const cfg = await store.getConfig();
    const texto = String(cfg.mensaje_final || "✅ ¡Reserva registrada! Código: {codigo}").replace(/\{codigo\}/g, reserva.codigo).replace(/\{horario\}/g, cfg.horario_recojo || "9:00 a. m. a 5:30 p. m.");
    await say(ctx, texto);
    console.log(`📦 Reserva ${reserva.codigo} — ${reserva.distrito} ${reserva.fecha_recojo} (${ctx.from})`);
    correo("reserva", reserva);
    await go(ctx, "menu", { flujo: null, fotos: [], previa: null, corrigiendo: false });
  }

  // ── Mis reservas ──
  async function showMisRecojos(ctx) {
    const hoy = U.limaParts(new Date()).iso;
    const activas = await store.reservasActivasDeUsuario(ctx.from, hoy);
    if (activas.length === 0) { await say(ctx, "No tienes reservas programadas en este momento."); return showMenu(ctx); }
    await go(ctx, "recojos_lista", { flujo: "recojos" });
    await pick(ctx, "Estas son tus reservas programadas. Elige una para ver opciones:", "Ver reservas",
      activas.map((r) => ({ id: `res:${r.id}`, title: U.fechaCorta(r.fecha_recojo), description: U.truncar(`${r.codigo} · ${r.distrito} · ${r.cantidad || (r.materiales || []).join(", ")}`, 72) })), { sectionTitle: "Mis reservas" });
  }
  async function showReservaOpciones(ctx, r) {
    await go(ctx, "recojo_opciones", { reserva_id: r.id, distrito: r.distrito, fecha: r.fecha_recojo, dia_semana: null });
    await ask(ctx, `*${r.codigo}*\n📅 ${U.fechaLarga(r.fecha_recojo)}\n📍 ${r.direccion}, ${r.distrito}\n♻️ ${r.cantidad || (r.materiales || []).join(", ")}\n\n¿Qué deseas hacer?`,
      [{ id: BTN.reprogramar, title: "Cambiar fecha" }, { id: BTN.cancelarReserva, title: "Cancelar reserva" }, { id: BTN.volver, title: "Volver" }]);
  }

  // ── Constancias por WhatsApp ──
  async function askConstanciaRuc(ctx) {
    await go(ctx, "constancia_ruc", { flujo: "constancias" });
    await say(ctx, "📄 Para enviarte tu *constancia de donación*, ingresa el *RUC* de la empresa:");
  }
  async function enviarConstancias(ctx, ruc) {
    const cfg = await store.getConfig();
    const lista = await store.listarConstancias({ documento: ruc, limit: 3 });
    if (!lista.length) {
      await say(ctx, `Aún no hay constancias emitidas para el RUC *${ruc}*. La constancia se emite después de realizar el recojo y registrar el peso de los materiales. ${cfg.contacto_humano || ""}`);
      return showMenu(ctx);
    }
    if (!constancias?.generarPdf) { await say(ctx, `Tienes ${lista.length} constancia(s) emitida(s). ${cfg.contacto_humano || "Solicítala al equipo de reciclaje."}`); return showMenu(ctx); }
    const c = lista[0];
    try {
      const pdf = await constancias.generarPdf({ ...c, fecha: U.limaParts(new Date(c.created_at)).iso, firmante: cfg.firmante_nombre || "", cargo: cfg.firmante_cargo || "", organizacion: cfg.organizacion || undefined });
      const filename = `Constancia-${String(c.numero).padStart(5, "0")}-${String(c.razon_social).replace(/[^\w\-]+/g, "_").slice(0, 40)}.pdf`;
      const mediaId = await wa.uploadMedia(pdf, "application/pdf", filename);
      await wa.document(ctx.from, mediaId, filename, `Constancia N.° ${String(c.numero).padStart(5, "0")} · ${c.razon_social} · ${Number(c.total).toLocaleString("es-PE")} kg (${U.fechaDdMmYyyy(c.desde)} - ${U.fechaDdMmYyyy(c.hasta)})`);
      await store.logMensaje(ctx.from, "assistant", `[constancia ${c.numero} enviada por WhatsApp]`, { paso: ctx.paso });
      if (lista.length > 1) await say(ctx, `Te envié la más reciente. Tienes ${lista.length} constancias en total; si necesitas otra, ${cfg.contacto_humano || "escríbenos"}.`);
    } catch (err) {
      console.error("❌ Constancia por WhatsApp:", err.message);
      await say(ctx, `No pude enviarte el archivo por aquí 😕. ${c.enviada_a ? `Ya fue enviada al correo ${c.enviada_a}.` : cfg.contacto_humano || ""}`);
    }
    return showMenu(ctx);
  }

  // ── Imagen ──
  async function handleImage(ctx, image) {
    try {
      const { buffer, mimeType, size } = await wa.downloadMedia(image.id);
      if (size > 10 * 1024 * 1024) return say(ctx, "La foto es muy pesada. Envía una de menos de 10 MB, por favor.");
      const url = await store.uploadFoto(buffer, mimeType, ctx.from);
      const fotos = [...(ctx.datos.fotos || []), url];
      await store.logMensaje(ctx.from, "user", `[foto] ${url}`, { paso: ctx.paso });
      await go(ctx, "foto_mas", { fotos });
      return askFotoMas(ctx);
    } catch (err) {
      console.error("❌ Foto:", err.message);
      return say(ctx, "No pude recibir la foto 😕. ¿Puedes enviarla de nuevo?");
    }
  }

  // ── Punto de entrada ──
  async function handle({ from, name, msg }) {
    const [sesion, cfg] = await Promise.all([store.getSesion(from), store.getConfig()]);
    const ttl = sessionTtlMs(cfg);
    const inactivoMs = sesion ? Date.now() - new Date(sesion.updated_at).getTime() : Infinity;
    const expirada = !sesion || inactivoMs > ttl;
    const ctx = { from, name, paso: expirada ? "inicio" : sesion.paso, datos: expirada ? {} : (sesion?.datos || {}) };
    const texto = msg.text || "";
    const btn = msg.buttonId || null;
    if (texto) await store.logMensaje(from, "user", texto, { paso: ctx.paso });
    else if (btn) await store.logMensaje(from, "user", msg.buttonTitle || btn, { paso: ctx.paso, button: btn });

    // Sesión vencida a mitad de un proceso → se avisa y se reinicia desde la bienvenida.
    if (expirada && sesion && sesion.datos?.flujo && sesion.paso !== "menu") {
      const min = Math.round(ttl / 60000);
      if (btn && btn !== BTN.menu) { /* botón viejo: igual reiniciamos */ }
      return showMenu(ctx, { bienvenida: true, nota: `⏱️ Pasaron más de ${min} minutos sin actividad, así que reinicié la conversación. Empecemos de nuevo:` });
    }

    // Comandos globales
    if (texto && RE_SALUDO_GLOBAL.test(texto)) return showMenu(ctx, { bienvenida: true });
    if (texto && RE_RESERVAR_GLOBAL.test(texto)) return startReserva(ctx);
    // Reprogramar/cancelar por WhatsApp está DESACTIVADO para el donante (se hace desde el panel).
    // Se conserva el código de "Mis reservas" para activarlo más adelante: AUTOSERVICIO_RESERVAS=1.
    if (AUTOSERVICIO && texto && RE_MIS_RESERVAS_GLOBAL.test(texto)) return showMisRecojos(ctx);
    if (btn === BTN.menu || (texto && RE_MENU.test(texto))) return showMenu(ctx, { intro: ctx.datos.flujo ? "Listo, dejé el proceso anterior. ¿Qué deseas hacer?" : null });
    if (btn === BTN.reservar) return startReserva(ctx);
    if (AUTOSERVICIO && btn === BTN.misRecojos) return showMisRecojos(ctx);
    if (btn === BTN.constancias) return askConstanciaRuc(ctx);
    if (btn === BTN.info) return showInfo(ctx);
    // Foto fuera de lugar: se acepta si estamos en la reserva (la gente manda fotos cuando quiere)
    if (msg.image && ctx.datos.flujo === "reserva" && !["foto", "foto_mas"].includes(ctx.paso) && ctx.paso !== "confirmar") {
      // la guardamos y seguimos donde estábamos
      try { const { buffer, mimeType } = await wa.downloadMedia(msg.image.id); const url = await store.uploadFoto(buffer, mimeType, from); await go(ctx, ctx.paso, { fotos: [...(ctx.datos.fotos || []), url] }); await say(ctx, "📷 Foto guardada. Continuemos:"); } catch { /* ignorar */ }
    }

    switch (ctx.paso) {
      case "inicio":
        return showMenu(ctx, { bienvenida: true });

      case "menu":
        if (/mis (reservas|solicitudes|recojos)|reprogramar|cambiar (la )?fecha|cancelar|anular/i.test(texto)) {
          if (AUTOSERVICIO) return showMisRecojos(ctx);
          const c = await store.getConfig();
          await say(ctx, `Para cambiar la fecha o cancelar una solicitud, nuestro equipo te ayuda: ${c.contacto_humano || "escríbenos y te contactamos"}.`);
          return showMenu(ctx);
        }
        if (/reserva|reservar|recojo|donar|reciclar|programar|empezar|solicitud/i.test(texto)) return startReserva(ctx);
        if (/constancia|certificado/i.test(texto)) return askConstanciaRuc(ctx);
        if (/info|informaci[oó]n|c[oó]mo funciona|ayuda|distritos|cobertura|horario/i.test(texto)) return showInfo(ctx);
        if (RE_HOLA.test(texto)) return showMenu(ctx, { bienvenida: true });
        return showMenu(ctx, { intro: "No entendí tu mensaje. Elige una opción:" });

      // ── Reserva ──
      case "reutilizar": {
        const p = ctx.datos.previa || {};
        if (btn === BTN.usarDatos || RE_SI.test(texto)) {
          await go(ctx, "peso_minimo", { documento: p.documento, documento_tipo: "RUC", empresa: p.empresa, sunat: p.sunat, direccion: p.direccion, correo: p.correo, previa: null });
          return bienvenidaEmpresa(ctx);
        }
        if (btn === BTN.datosNuevos || RE_NO.test(texto)) { await go(ctx, "ruc", { previa: null, direccion: null, correo: null }); return askRuc(ctx); }
        return ask(ctx, "¿Uso tus datos anteriores?", [{ id: BTN.usarDatos, title: "Sí, usar mis datos" }, { id: BTN.datosNuevos, title: "Ingresar nuevos" }]);
      }
      case "ruc": {
        if (RE_HOLA.test(texto) && texto.length < 12) return askRuc(ctx);
        const doc = U.validarDocumento(texto);
        if (!doc || doc.tipo !== "RUC") {
          if (doc?.tipo === "DNI") return say(ctx, "El programa está dirigido a empresas e instituciones: necesitamos el *RUC* (11 dígitos). Si donas como persona natural con RUC 10, ingrésalo.");
          return say(ctx, "El RUC debe tener *11 dígitos* válidos (empieza en 10, 15, 16, 17 o 20). Escríbalo de nuevo, solo números.");
        }
        await go(ctx, "ruc_confirmar", { documento: doc.valor, documento_tipo: "RUC" });
        return siNo(ctx, `📌 RUC ingresado: *${doc.valor}*  ¿Es correcto?`, "Sí, continuar", "No, regresar");
      }
      case "ruc_confirmar": {
        if (btn === BTN.no || RE_NO.test(texto)) return askRuc(ctx);
        if (!(btn === BTN.si || RE_SI.test(texto))) return siNo(ctx, `📌 RUC ingresado: *${ctx.datos.documento}*  ¿Es correcto?`, "Sí, continuar", "No, regresar");
        const info = sunat ? await sunat.consultar(ctx.datos.documento) : null;
        if (info?.razon_social) {
          await go(ctx, "peso_minimo", { empresa: info.razon_social, sunat: info });
          if (ctx.datos.corrigiendo) return askConfirmar(ctx);
          return bienvenidaEmpresa(ctx);
        }
        await go(ctx, "razon_social", { sunat: null });
        return say(ctx, `${sunat?.enabled ? "No encontré ese RUC en SUNAT. " : ""}📌 Escriba la *razón social* de la empresa:`);
      }
      case "razon_social": {
        const v = U.validarNombre(texto);
        if (!v) return say(ctx, "Escriba la razón social de la empresa, por favor.");
        await go(ctx, "peso_minimo", { empresa: v });
        if (ctx.datos.corrigiendo) return askConfirmar(ctx);
        return bienvenidaEmpresa(ctx);
      }
      case "peso_minimo": {
        if (btn === BTN.si || RE_SI.test(texto)) return askMateriales(ctx);
        if (btn === BTN.no || RE_NO.test(texto)) {
          const cfg = await store.getConfig();
          await say(ctx, `Entendido. Cuando cuente con el mínimo de *${cfg.peso_minimo_kg || 250} kg*, escríbanos y programamos el recojo con gusto. ♻️\n\nSi tiene dudas, ${cfg.contacto_humano || "escríbanos"}.`);
          return showMenu(ctx);
        }
        return siNo(ctx, "📌 ¿Cuenta con el mínimo requerido para agendar el recojo?", "Sí", "No");
      }
      case "materiales": {
        if (!texto || texto.trim().length < 3) return askMateriales(ctx);
        await go(ctx, "foto", { cantidad: texto.trim().slice(0, 400), materiales: detectarMateriales(texto) });
        if (ctx.datos.corrigiendo) return askConfirmar(ctx);
        return ctx.datos.fotos?.length ? askFotoMas(ctx) : askFoto(ctx);
      }
      case "foto":
        if (msg.image) return handleImage(ctx, msg.image);
        if (msg.document && /image\//.test(msg.document.mimeType || "")) return handleImage(ctx, { id: msg.document.id });
        return say(ctx, "📤 Necesito al menos una *fotografía* de los residuos para continuar. Adjúntela desde el clip 📎 o la cámara de WhatsApp.");
      case "foto_mas":
        if (msg.image) return handleImage(ctx, msg.image);
        if (btn === BTN.fotoListo || RE_NO.test(texto) || /listo|continuar|seguir|ya/i.test(texto)) {
          if (ctx.datos.corrigiendo) return askConfirmar(ctx);
          return askZona(ctx);
        }
        if (btn === BTN.fotoMas || RE_SI.test(texto) || /otra|m[aá]s/i.test(texto)) { await go(ctx, "foto"); return say(ctx, "📷 Envíe la siguiente fotografía."); }
        return askFotoMas(ctx);

      case "zona": {
        if (btn && btn.startsWith("zona:")) return askDistritoZona(ctx, btn.slice(5));
        if (texto) return handleDistritoTexto(ctx, texto);
        return askZona(ctx);
      }
      case "distrito": {
        if (btn === "dist:otro" || btn === "dist:zona") return askZona(ctx);
        if (btn === "dist:escribir") return askDistritoTexto(ctx);
        if (btn && btn.startsWith("dist:")) {
          const d = (await store.getDistritos()).find((x) => x.id === btn.slice(5));
          if (d) return setDistrito(ctx, d);
        }
        if (btn && btn.startsWith("zona:")) return askDistritoZona(ctx, btn.slice(5));
        if (texto) return handleDistritoTexto(ctx, texto);
        return askZona(ctx);
      }
      case "dia": {
        const n = btn && btn.startsWith("dia:") ? Number(btn.slice(4)) : (() => { const i = U.DIAS.findIndex((x) => new RegExp(`^\\s*${x}`, "i").test(U.normalizar(texto))); return i > 0 ? i : i === 0 ? 7 : null; })();
        const d = (await store.getDistritos()).find((x) => x.nombre === ctx.datos.distrito);
        if (!n || !d || !d.dias.includes(n)) return d ? setDistrito(ctx, d) : askZona(ctx);
        await say(ctx, `✨ A continuación, le compartimos las fechas disponibles de los días *${capDia(n)}* en el distrito *${d.nombre}*.\n⏳ Un momento mientras se cargan las fechas 📅✨`);
        await go(ctx, "fecha", { dia_semana: n });
        return askFecha(ctx);
      }
      case "fecha": {
        if (btn && btn.startsWith("fecha:") && U.parseIsoDate(btn.slice(6))) {
          await go(ctx, "fecha_confirmar", { fecha: btn.slice(6) });
          return siNo(ctx, `📅 Fecha seleccionada: *${U.fechaLarga(btn.slice(6))}*\n¿Desea reservar esta fecha?`);
        }
        return askFecha(ctx, { prefijo: "Elija una fecha de la lista. " });
      }
      case "fecha_confirmar": {
        if (btn === BTN.no || RE_NO.test(texto)) { await go(ctx, "fecha", { fecha: null }); return askFecha(ctx); }
        if (!(btn === BTN.si || RE_SI.test(texto))) return siNo(ctx, `📅 Fecha seleccionada: *${U.fechaLarga(ctx.datos.fecha)}*\n¿Desea reservar esta fecha?`);
        if (ctx.datos.corrigiendo) return askConfirmar(ctx);
        return askDireccion(ctx);
      }
      case "direccion": {
        let dir = texto;
        if (msg.location) dir = [msg.location.name, msg.location.address].filter(Boolean).join(", ") || `${msg.location.lat},${msg.location.lng}`;
        if (!dir || dir.trim().length < 6) return say(ctx, "Escriba la dirección completa (calle, número y referencia), por favor.");
        await go(ctx, "direccion_confirmar", { direccion: dir.trim().slice(0, 250) });
        return siNo(ctx, `📍 Dirección registrada: *${ctx.datos.direccion}*\n¿Es correcta?`);
      }
      case "direccion_confirmar": {
        if (btn === BTN.no || RE_NO.test(texto)) { await go(ctx, "direccion", { direccion: null }); return say(ctx, "Por favor, ingrese la dirección de *recojo*: 📦"); }
        if (!(btn === BTN.si || RE_SI.test(texto))) return siNo(ctx, `📍 Dirección registrada: *${ctx.datos.direccion}*\n¿Es correcta?`);
        if (ctx.datos.corrigiendo) return askConfirmar(ctx);
        return askCorreo(ctx);
      }
      case "correo": {
        const v = U.validarCorreo(texto);
        if (!v) return say(ctx, "Ese correo no parece válido. Escríbalo así: nombre@dominio.com");
        await go(ctx, "correo_confirmar", { correo: v });
        return siNo(ctx, `✉️ Correo ingresado: *${v}*\n¿Es correcto?`);
      }
      case "correo_confirmar": {
        if (btn === BTN.no || RE_NO.test(texto)) { await go(ctx, "correo", { correo: null }); return say(ctx, "✉️ Ingrese el correo electrónico:"); }
        if (!(btn === BTN.si || RE_SI.test(texto))) return siNo(ctx, `✉️ Correo ingresado: *${ctx.datos.correo}*\n¿Es correcto?`);
        if (ctx.datos.corrigiendo) return askConfirmar(ctx);
        return askAcceso(ctx);
      }
      case "acceso": {
        const sin = btn === BTN.sinRestriccion || /^\s*(sin restricci[oó]n|ninguna|ninguno|no)\s*$/i.test(texto);
        const horario = sin ? "Sin restricción" : (texto || "").trim().slice(0, 160);
        if (!horario) return askAcceso(ctx);
        await go(ctx, "requisitos", { horario, disponibilidad: /s[aá]bado|domingo|fin de semana/i.test(horario) ? "incluye_sab" : "lun_vie" });
        return askRequisitos(ctx);
      }
      case "requisitos": {
        const ninguno = btn === BTN.ninguno || RE_NO.test(texto);
        await go(ctx, "comentario_pregunta", { requisitos: ninguno ? null : (texto || "").trim().slice(0, 300) || null });
        if (ctx.datos.corrigiendo) return askConfirmar(ctx);
        return askComentarioPregunta(ctx);
      }
      case "comentario_pregunta": {
        if (btn === BTN.si || RE_SI.test(texto)) { await go(ctx, "comentario"); return say(ctx, "Escriba su comentario u observación. ✍️💭"); }
        if (btn === BTN.no || RE_NO.test(texto)) { await go(ctx, "confirmar", { comentario: null }); return askConfirmar(ctx); }
        return askComentarioPregunta(ctx);
      }
      case "comentario": {
        if (!texto || texto.trim().length < 2) return say(ctx, "Escriba su comentario, por favor.");
        await go(ctx, "confirmar", { comentario: texto.trim().slice(0, 500) });
        return askConfirmar(ctx);
      }
      case "confirmar":
        if (btn === BTN.confirmar || RE_SI.test(texto)) return crearReserva(ctx);
        if (btn === BTN.cancelarFlujo || RE_NO.test(texto)) return showMenu(ctx, { intro: "Cancelé el registro. Cuando quieras retomarlo, elige *Empezar reserva*." });
        if (btn === BTN.corregir || /corregir|cambiar|editar|modificar/i.test(texto)) {
          await go(ctx, "corregir");
          return pick(ctx, "¿Qué dato quieres corregir?", "Elegir dato", CAMPOS_CORREGIBLES, { sectionTitle: "Datos" });
        }
        return askConfirmar(ctx);
      case "corregir": {
        if (!btn || !btn.startsWith("fix:")) return askConfirmar(ctx);
        const campo = btn.slice(4);
        await go(ctx, campo, { corrigiendo: true });
        switch (campo) {
          case "ruc": return askRuc(ctx);
          case "materiales": return askMateriales(ctx);
          case "foto": await go(ctx, "foto", { fotos: [] }); return askFoto(ctx);
          case "zona": return askZona(ctx);
          case "fecha": return askFecha(ctx);
          case "direccion": await go(ctx, "direccion", { direccion: null }); return say(ctx, "Por favor, ingrese la dirección de *recojo*: 📦");
          case "correo": await go(ctx, "correo", { correo: null }); return say(ctx, "✉️ Ingrese el correo electrónico:");
          case "acceso": return askAcceso(ctx);
          case "comentario": await go(ctx, "comentario"); return say(ctx, "Escriba su comentario u observación. ✍️💭");
          default: return askConfirmar(ctx);
        }
      }

      // ── Mis reservas ──
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
          await go(ctx, "reprog_fecha", { flujo: "reprogramar", distrito: r.distrito, fecha: r.fecha_recojo, dia_semana: null });
          return askFecha(ctx, { excluir: r.fecha_recojo, prefijo: `Tu reserva actual es el ${U.fechaLarga(r.fecha_recojo)}. ` });
        }
        if (btn === BTN.cancelarReserva || /cancelar/i.test(texto)) {
          await go(ctx, "recojo_cancelar");
          return ask(ctx, `¿Seguro que cancelas la reserva *${r.codigo}* del ${U.fechaLarga(r.fecha_recojo)}?`, [{ id: BTN.siCancelar, title: "Sí, cancelar" }, { id: BTN.noCancelar, title: "No, mantener" }]);
        }
        return showReservaOpciones(ctx, r);
      }
      case "reprog_fecha": {
        if (btn && btn.startsWith("fecha:")) {
          try {
            const r = await store.reprogramar(ctx.datos.reserva_id, btn.slice(6), "donante");
            await say(ctx, `✅ Listo. Tu reserva *${r.codigo}* quedó reprogramada para el *${U.fechaLarga(r.fecha_recojo)}*.\n📍 ${r.direccion}, ${r.distrito}`);
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
        if (btn === BTN.siCancelar || RE_SI.test(texto)) {
          try {
            const r = await store.cambiarEstado(ctx.datos.reserva_id, "cancelado", { nota: "Cancelado por el donante desde WhatsApp", actor: "donante" });
            await say(ctx, `Tu reserva *${r.codigo}* fue cancelada. Cuando quieras volver a donar, aquí estaré 💚`);
            correo("cancelacion", r, "Cancelado por el donante desde WhatsApp");
          } catch (err) { console.error("❌ cancelar:", err.message); await say(ctx, "No pude cancelar la reserva. Intenta de nuevo en unos minutos."); }
          return showMenu(ctx);
        }
        if (btn === BTN.noCancelar || RE_NO.test(texto)) { await say(ctx, "Perfecto, tu reserva sigue programada."); return showMenu(ctx); }
        return ask(ctx, "¿Cancelo la reserva?", [{ id: BTN.siCancelar, title: "Sí, cancelar" }, { id: BTN.noCancelar, title: "No, mantener" }]);
      }

      // ── Constancias ──
      case "constancia_ruc": {
        const doc = U.validarDocumento(texto);
        if (!doc || doc.tipo !== "RUC") return say(ctx, "Escribe el *RUC* de 11 dígitos de la empresa, por favor.");
        return enviarConstancias(ctx, doc.valor);
      }

      default:
        return showMenu(ctx);
    }
  }

  return { handle, BTN, detectarMateriales };
}

module.exports = { createFlow, BTN, SESSION_TTL_MS_DEFAULT, sessionTtlMs, detectarMateriales };
