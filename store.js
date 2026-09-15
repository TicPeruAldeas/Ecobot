// Acceso a datos (Supabase). Toda la lógica de negocio con cupos vive en las
// funciones SQL eco_reservar / eco_reprogramar / eco_cambiar_estado.
const crypto = require("crypto");
const { configToObject } = require("./scheduling");

const CACHE_MS = 60 * 1000;

// Traduce el mensaje de error de una función SQL a un código conocido.
function rpcError(error) {
  const msg = String(error?.message || error || "");
  const code = ["CUPO_LLENO", "FECHA_BLOQUEADA", "NO_EXISTE", "ESTADO_INVALIDO", "MISMA_FECHA"].find((c) => msg.includes(c));
  const err = new Error(code || msg);
  err.code = code || "RPC_ERROR";
  err.original = msg;
  return err;
}

function createStore(supabase, { bucket = "eco-fotos" } = {}) {
  let configCache = { at: 0, value: null };
  let distritosCache = { at: 0, value: null };

  // ── Config ──
  async function getConfig(fresh = false) {
    if (!fresh && configCache.value && Date.now() - configCache.at < CACHE_MS) return configCache.value;
    const { data, error } = await supabase.from("eco_config").select("key, value");
    if (error) throw error;
    configCache = { at: Date.now(), value: configToObject(data) };
    return configCache.value;
  }
  async function setConfig(key, value) {
    const { error } = await supabase.from("eco_config").upsert({ key, value: String(value), updated_at: new Date().toISOString() });
    if (error) throw error;
    configCache.at = 0;
  }

  // ── Distritos ──
  async function getDistritos({ incluirInactivos = false, fresh = false } = {}) {
    if (!fresh && distritosCache.value && Date.now() - distritosCache.at < CACHE_MS) {
      return incluirInactivos ? distritosCache.value : distritosCache.value.filter((d) => d.activo);
    }
    const { data, error } = await supabase.from("eco_distritos").select("*").order("nombre");
    if (error) throw error;
    distritosCache = { at: Date.now(), value: data || [] };
    return incluirInactivos ? distritosCache.value : distritosCache.value.filter((d) => d.activo);
  }
  async function upsertDistrito(d) {
    const row = {
      ...(d.id ? { id: d.id } : {}),
      nombre: String(d.nombre || "").trim(),
      aliases: Array.isArray(d.aliases) ? d.aliases.map((a) => String(a).trim()).filter(Boolean) : [],
      dias: Array.isArray(d.dias) ? [...new Set(d.dias.map(Number).filter((n) => n >= 1 && n <= 7))].sort() : [],
      activo: d.activo !== false,
      updated_at: new Date().toISOString(),
    };
    if (!row.nombre) throw new Error("Nombre de distrito vacío");
    const { data, error } = await supabase.from("eco_distritos").upsert(row).select().single();
    if (error) throw error;
    distritosCache.at = 0;
    return data;
  }

  // ── Sesiones ──
  async function getSesion(userId) {
    const { data, error } = await supabase.from("eco_sesiones").select("*").eq("user_id", userId).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function saveSesion(userId, paso, datos, nombreWa) {
    const { error } = await supabase.from("eco_sesiones").upsert({
      user_id: userId, paso, datos: datos || {}, nombre_wa: nombreWa || null, updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  // ── Fechas / ocupación ──
  async function getFechasMap(desde, hasta) {
    const { data, error } = await supabase.from("eco_fechas").select("*").gte("fecha", desde).lte("fecha", hasta);
    if (error) throw error;
    const m = {};
    for (const f of data || []) m[f.fecha] = f;
    return m;
  }
  async function upsertFecha(f) {
    const row = {
      fecha: f.fecha, bloqueada: Boolean(f.bloqueada), motivo: f.motivo || null,
      cupo_maximo: f.cupo_maximo === "" || f.cupo_maximo == null ? null : Number(f.cupo_maximo),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from("eco_fechas").upsert(row).select().single();
    if (error) throw error;
    return data;
  }
  async function getOcupacionMap(desde, hasta) {
    const { data, error } = await supabase.rpc("eco_ocupacion", { p_desde: desde, p_hasta: hasta });
    if (error) throw error;
    const m = {};
    for (const r of data || []) m[r.fecha] = Number(r.ocupados);
    return m;
  }

  // ── Reservas ──
  async function reservar(payload) {
    const { data, error } = await supabase.rpc("eco_reservar", { p: payload });
    if (error) throw rpcError(error);
    return data;
  }
  async function reprogramar(id, fecha, actor = "donante") {
    const { data, error } = await supabase.rpc("eco_reprogramar", { p_id: id, p_fecha: fecha, p_actor: actor });
    if (error) throw rpcError(error);
    return data;
  }
  async function cambiarEstado(id, estado, { nota = null, actor = "sistema", kilos = null, kilosDetalle = null } = {}) {
    const { data, error } = await supabase.rpc("eco_cambiar_estado", { p_id: id, p_estado: estado, p_nota: nota, p_actor: actor, p_kilos: kilos, p_kilos_detalle: kilosDetalle });
    if (error) throw rpcError(error);
    return data;
  }

  // ── Constancias de donación ──
  // Reservas atendidas/cerradas de un donante (por documento) con kilos registrados en el período.
  async function reservasAtendidasDeDonante(documento, desde, hasta) {
    const { data, error } = await supabase.from("eco_reservas").select("*")
      .eq("documento", documento).in("estado", ["atendido", "cerrado"])
      .gte("fecha_recojo", desde).lte("fecha_recojo", hasta).order("fecha_recojo");
    if (error) throw error;
    return data || [];
  }
  async function crearConstancia(row) {
    const { data, error } = await supabase.from("eco_constancias").insert(row).select().single();
    if (error) throw error;
    return data;
  }
  async function getConstancia(id) {
    const { data, error } = await supabase.from("eco_constancias").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function listarConstancias({ documento, limit = 100 } = {}) {
    let q = supabase.from("eco_constancias").select("*").order("created_at", { ascending: false }).limit(limit);
    if (documento) q = q.eq("documento", documento);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }
  async function marcarConstanciaEnviada(id, correo) {
    const { error } = await supabase.from("eco_constancias").update({ enviada_a: correo, enviada_at: new Date().toISOString() }).eq("id", id);
    if (error) console.error("⚠️  marcarConstanciaEnviada:", error.message);
  }
  async function getReserva(id) {
    const { data, error } = await supabase.from("eco_reservas").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function getReservaPorCodigo(codigo) {
    const { data, error } = await supabase.from("eco_reservas").select("*").eq("codigo", String(codigo).toUpperCase().trim()).maybeSingle();
    if (error) throw error;
    return data;
  }
  // Reservas vivas y futuras (o de hoy) del donante.
  async function reservasActivasDeUsuario(userId, hoyIso) {
    const { data, error } = await supabase.from("eco_reservas").select("*")
      .eq("user_id", userId).eq("estado", "programado").gte("fecha_recojo", hoyIso)
      .order("fecha_recojo").limit(10);
    if (error) throw error;
    return data || [];
  }
  async function ultimaReservaDeUsuario(userId) {
    const { data, error } = await supabase.from("eco_reservas").select("*")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function addEvento(reservaId, evento, detalle = {}, actor = "sistema") {
    const { error } = await supabase.from("eco_reserva_eventos").insert({ reserva_id: reservaId, evento, detalle, actor });
    if (error) console.error("⚠️  evento:", error.message);
  }
  async function getEventos(reservaId) {
    const { data, error } = await supabase.from("eco_reserva_eventos").select("*").eq("reserva_id", reservaId).order("created_at");
    if (error) throw error;
    return data || [];
  }

  // Reservas programadas cuyo recojo empieza dentro de la ventana del recordatorio y aún no fueron avisadas.
  async function reservasParaRecordatorio(desdeIso, hastaIso) {
    const { data, error } = await supabase.from("eco_reservas").select("*")
      .eq("estado", "programado").is("recordatorio_enviado_at", null)
      .gte("fecha_recojo", desdeIso).lte("fecha_recojo", hastaIso).limit(200);
    if (error) throw error;
    return data || [];
  }
  async function marcarRecordatorio(id, detalle = {}) {
    const { error } = await supabase.from("eco_reservas").update({ recordatorio_enviado_at: new Date().toISOString() }).eq("id", id);
    if (error) console.error("⚠️  marcarRecordatorio:", error.message);
    await addEvento(id, "recordatorio", detalle, "sistema");
  }

  // ── Listados para el panel ──
  async function listarReservas({ estado, desde, hasta, distrito, q, limit = 300 } = {}) {
    let query = supabase.from("eco_reservas").select("*").order("fecha_recojo", { ascending: false }).order("created_at", { ascending: false }).limit(limit);
    if (estado) query = query.eq("estado", estado);
    if (desde) query = query.gte("fecha_recojo", desde);
    if (hasta) query = query.lte("fecha_recojo", hasta);
    if (distrito) query = query.eq("distrito", distrito);
    if (q) {
      const s = String(q).replace(/[%,()]/g, " ").trim();
      query = query.or(`codigo.ilike.%${s}%,nombre.ilike.%${s}%,empresa.ilike.%${s}%,documento.ilike.%${s}%,user_id.ilike.%${s}%,correo.ilike.%${s}%`);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  // ── Mensajes ──
  async function logMensaje(userId, role, message, metadata = {}) {
    const { error } = await supabase.from("eco_mensajes").insert({ user_id: userId, role, message: String(message || "").slice(0, 4000), metadata });
    if (error) console.error("⚠️  logMensaje:", error.message);
  }
  async function getMensajes(userId, limit = 200) {
    const { data, error } = await supabase.from("eco_mensajes").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data || []).reverse();
  }
  async function listarConversaciones(limit = 100) {
    const { data, error } = await supabase.from("eco_mensajes").select("user_id, message, role, created_at").order("created_at", { ascending: false }).limit(2000);
    if (error) throw error;
    const seen = new Map();
    for (const r of data || []) if (!seen.has(r.user_id)) seen.set(r.user_id, r);
    return [...seen.values()].slice(0, limit);
  }

  // ── Fotos (Supabase Storage) ──
  async function uploadFoto(buffer, mimeType, userId) {
    const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
    const path = `${new Date().toISOString().slice(0, 10)}/${userId}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
    const { error } = await supabase.storage.from(bucket).upload(path, buffer, { contentType: mimeType, upsert: false });
    if (error) throw error;
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  }

  // ── Panel: usuarios y auditoría ──
  async function getAdminUsers() {
    const { data, error } = await supabase.from("eco_admin_users").select("id, username, password_hash, rol, active, created_at").order("username");
    if (error) throw error;
    return data || [];
  }
  async function upsertAdminUser(row) {
    const { data, error } = await supabase.from("eco_admin_users").upsert({ ...row, updated_at: new Date().toISOString() }).select().single();
    if (error) throw error;
    return data;
  }
  async function audit({ user, action, target = null, ip = null, details = {} }) {
    const { error } = await supabase.from("eco_admin_audit").insert({ admin_user: user, action, target, ip, details });
    if (error) console.error("⚠️  audit:", error.message);
  }
  async function getAudit(limit = 200) {
    const { data, error } = await supabase.from("eco_admin_audit").select("*").order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  }

  // Resumen para el panel
  async function resumen(desde, hasta) {
    const { data, error } = await supabase.from("eco_reservas").select("estado, distrito, fecha_recojo, materiales, tipo_donante, kilos")
      .gte("fecha_recojo", desde).lte("fecha_recojo", hasta).limit(5000);
    if (error) throw error;
    return data || [];
  }

  return {
    getConfig, setConfig,
    getDistritos, upsertDistrito,
    getSesion, saveSesion,
    getFechasMap, upsertFecha, getOcupacionMap,
    reservar, reprogramar, cambiarEstado, getReserva, getReservaPorCodigo,
    reservasActivasDeUsuario, ultimaReservaDeUsuario, addEvento, getEventos,
    reservasParaRecordatorio, marcarRecordatorio,
    reservasAtendidasDeDonante, crearConstancia, getConstancia, listarConstancias, marcarConstanciaEnviada,
    listarReservas, logMensaje, getMensajes, listarConversaciones,
    uploadFoto,
    getAdminUsers, upsertAdminUser, audit, getAudit, resumen,
  };
}

module.exports = { createStore, rpcError };
