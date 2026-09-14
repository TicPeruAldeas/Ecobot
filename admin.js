// Panel de administración de ECO. Se monta en /admin.
// Roles: admin (todo), logistica (operar reservas, calendario, rutas, config), lectura (solo ver).
// Usuarios: variable ADMIN_USERS ("user:clave:rol,…") y/o tabla eco_admin_users (scrypt).
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const XLSX = require("xlsx");
const U = require("./util");
const { fechasDisponibles } = require("./scheduling");

const ROLES = ["admin", "logistica", "lectura"];
const ESTADOS = ["programado", "atendido", "no_atendido", "cancelado", "cerrado"];
const SESSION_TTL_MS = (Number(process.env.ADMIN_SESSION_HOURS) || 10) * 60 * 60 * 1000;
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || process.env.INGEST_SECRET || "";

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || "")), bb = Buffer.from(String(b || ""));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function hashPassword(pass) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt$${salt}$${crypto.scryptSync(String(pass), salt, 64).toString("hex")}`;
}
function verifyPassword(pass, stored) {
  const [alg, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  return safeEqual(crypto.scryptSync(String(pass), salt, 64).toString("hex"), hash);
}
function loadEnvUsers() {
  const users = new Map();
  for (const entry of (process.env.ADMIN_USERS || "").split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length < 2) continue;
    const name = parts[0].trim();
    const last = parts[parts.length - 1].trim().toLowerCase();
    const hasRol = parts.length >= 3 && ROLES.includes(last);
    const pass = (hasRol ? parts.slice(1, -1) : parts.slice(1)).join(":").trim();
    if (name && pass) users.set(name.toLowerCase(), { name, pass, rol: hasRol ? last : "admin" });
  }
  return users;
}
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifySession(token) {
  if (!token || !SESSION_SECRET) return null;
  const [body, sig] = String(token).split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!p.exp || Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const clientIp = (req) => (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim();
const puede = { admin: 3, logistica: 2, lectura: 1 };

module.exports = function createAdminRouter({ store, make, whatsappHelpers }) {
  const router = express.Router();
  const envUsers = loadEnvUsers();
  if (!SESSION_SECRET) console.warn("⚠️  ADMIN_SESSION_SECRET no definido — el panel /admin no permitirá iniciar sesión.");
  if (envUsers.size === 0) console.warn("⚠️  ADMIN_USERS vacío — solo entrarán usuarios de la tabla eco_admin_users.");

  async function checkCredentials(user, pass) {
    const u = String(user || "").trim().toLowerCase();
    try {
      const rows = await store.getAdminUsers();
      const row = rows.find((r) => r.username.toLowerCase() === u && r.active);
      if (row && verifyPassword(pass, row.password_hash)) return { name: row.username, rol: row.rol };
    } catch (err) { console.error("⚠️  eco_admin_users:", err.message); }
    const e = envUsers.get(u);
    if (e && safeEqual(pass, e.pass)) return { name: e.name, rol: e.rol };
    return null;
  }

  function auth(minRol = "lectura") {
    return (req, res, next) => {
      const s = verifySession(parseCookies(req).eco_admin);
      if (!s) return req.path.startsWith("/api") ? res.status(401).json({ error: "Sesión expirada" }) : res.redirect("/admin/login");
      if ((puede[s.rol] || 0) < puede[minRol]) return res.status(403).json({ error: "Sin permiso" });
      req.admin = s;
      next();
    };
  }
  const actor = (req) => `admin:${req.admin.name}`;

  // ── Login ──
  router.get("/login", (_req, res) => res.sendFile(path.join(__dirname, "admin-login.html")));
  router.post("/login", async (req, res) => {
    const id = await checkCredentials(req.body.user, req.body.password);
    if (!id || !SESSION_SECRET) { await store.audit({ user: req.body.user, action: "login_failed", ip: clientIp(req) }); return res.redirect("/admin/login?error=1"); }
    const token = signSession({ name: id.name, rol: id.rol, exp: Date.now() + SESSION_TTL_MS });
    res.setHeader("Set-Cookie", `eco_admin=${encodeURIComponent(token)}; HttpOnly; Path=/admin; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${req.secure ? "; Secure" : ""}`);
    await store.audit({ user: id.name, action: "login", ip: clientIp(req) });
    res.redirect("/admin");
  });
  router.get("/logout", (req, res) => {
    res.setHeader("Set-Cookie", "eco_admin=; HttpOnly; Path=/admin; Max-Age=0");
    res.redirect("/admin/login");
  });

  router.get("/", auth(), (_req, res) => res.sendFile(path.join(__dirname, "admin.html")));
  router.get("/api/me", auth(), (req, res) => res.json({ name: req.admin.name, rol: req.admin.rol, make: make.enabled }));

  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => { console.error("❌ admin:", err.message); res.status(500).json({ error: err.code || err.message }); });

  // ── Resumen ──
  router.get("/api/resumen", auth(), wrap(async (req, res) => {
    const hoy = U.limaParts().iso;
    const desde = req.query.desde || U.addDays(hoy, -30), hasta = req.query.hasta || U.addDays(hoy, 60);
    const rows = await store.resumen(desde, hasta);
    const by = (key) => rows.reduce((m, r) => { const k = r[key] || "-"; m[k] = (m[k] || 0) + 1; return m; }, {});
    const materiales = {};
    for (const r of rows) for (const m of r.materiales || []) materiales[m] = (materiales[m] || 0) + 1;
    const kilos = rows.reduce((s, r) => s + (Number(r.kilos) || 0), 0);
    const proximos = rows.filter((r) => r.estado === "programado" && r.fecha_recojo >= hoy).length;
    res.json({ desde, hasta, total: rows.length, proximos, por_estado: by("estado"), por_distrito: by("distrito"), por_tipo: by("tipo_donante"), materiales, kilos });
  }));

  // ── Reservas ──
  router.get("/api/reservas", auth(), wrap(async (req, res) => {
    const { estado, desde, hasta, distrito, q } = req.query;
    res.json(await store.listarReservas({ estado, desde, hasta, distrito, q }));
  }));
  router.get("/api/reservas/:id", auth(), wrap(async (req, res) => {
    const r = await store.getReserva(req.params.id);
    if (!r) return res.status(404).json({ error: "No existe" });
    res.json({ ...r, eventos: await store.getEventos(r.id) });
  }));
  router.post("/api/reservas/:id/estado", auth("logistica"), wrap(async (req, res) => {
    const { estado, nota, kilos } = req.body || {};
    if (!ESTADOS.includes(estado)) return res.status(400).json({ error: "Estado inválido" });
    const r = await store.cambiarEstado(req.params.id, estado, { nota: nota || null, actor: actor(req), kilos: kilos === "" || kilos == null ? null : Number(kilos) });
    await store.audit({ user: req.admin.name, action: "estado", target: r.codigo, ip: clientIp(req), details: { estado, nota, kilos } });
    let aviso = null;
    if (estado === "cancelado" && req.body.avisar) {
      aviso = await whatsappHelpers.notificar(r.user_id, `Hola ${r.empresa || r.nombre}. Tu recojo *${r.codigo}* del ${U.fechaLarga(r.fecha_recojo)} fue cancelado${nota ? `: ${nota}` : ""}. Si deseas reprogramar, escribe *menú* y elige *Donar reciclables*.`, [r.empresa || r.nombre, r.codigo, `cancelado${nota ? ` (${nota})` : ""}`]);
    }
    make.send(r, estado === "cancelado" ? "cancelacion" : "estado").catch((e) => console.warn("Make estado:", e.message));
    res.json({ ...r, aviso });
  }));
  router.post("/api/reservas/:id/reprogramar", auth("logistica"), wrap(async (req, res) => {
    const { fecha, avisar } = req.body || {};
    if (!U.parseIsoDate(fecha)) return res.status(400).json({ error: "Fecha inválida" });
    const r = await store.reprogramar(req.params.id, fecha, actor(req));
    await store.audit({ user: req.admin.name, action: "reprogramar", target: r.codigo, ip: clientIp(req), details: { de: r.fecha_anterior, a: fecha } });
    let aviso = null;
    if (avisar) aviso = await whatsappHelpers.notificar(r.user_id, `Hola ${r.empresa || r.nombre}. Tu recojo *${r.codigo}* fue reprogramado para el *${U.fechaLarga(r.fecha_recojo)}* en ${r.direccion}, ${r.distrito}. Si no te acomoda, escribe *menú* → *Mis recojos*.`, [r.empresa || r.nombre, r.codigo, `reprogramado para el ${U.fechaLarga(r.fecha_recojo)}`]);
    make.send(r, "reprogramacion").catch((e) => console.warn("Make reprog:", e.message));
    res.json({ ...r, aviso });
  }));
  router.post("/api/reservas/:id/reenviar-make", auth("logistica"), wrap(async (req, res) => {
    const r = await store.getReserva(req.params.id);
    if (!r) return res.status(404).json({ error: "No existe" });
    try { await make.send(r, "reserva"); await store.marcarMake(r.id, true); res.json({ ok: true }); }
    catch (err) { await store.marcarMake(r.id, false, err.message); res.status(502).json({ error: err.message }); }
  }));
  // Fechas disponibles para reprogramar desde el panel (mismas reglas que el bot, sin la anticipación mínima).
  router.get("/api/reservas/:id/fechas", auth("logistica"), wrap(async (req, res) => {
    const r = await store.getReserva(req.params.id);
    if (!r) return res.status(404).json({ error: "No existe" });
    const [cfg, distritos] = await Promise.all([store.getConfig(), store.getDistritos()]);
    const d = distritos.find((x) => x.nombre === r.distrito) || { dias: [1, 2, 3, 4, 5] };
    const hoy = U.limaParts().iso, hasta = U.addDays(hoy, 60);
    const [fechas, ocupacion] = await Promise.all([store.getFechasMap(hoy, hasta), store.getOcupacionMap(hoy, hasta)]);
    res.json(fechasDisponibles({ distrito: d, config: { ...cfg, anticipacion_horas: 0, horizonte_dias: 60, max_fechas: 10 }, fechas, ocupacion, excluir: r.fecha_recojo }));
  }));

  // ── Calendario ──
  router.get("/api/calendario", auth(), wrap(async (req, res) => {
    const hoy = U.limaParts().iso;
    const desde = req.query.desde || hoy, hasta = req.query.hasta || U.addDays(hoy, 30);
    const [cfg, distritos, fechas, reservas] = await Promise.all([
      store.getConfig(), store.getDistritos(), store.getFechasMap(desde, hasta), store.listarReservas({ desde, hasta, limit: 2000 }),
    ]);
    const cupoDefault = Number(cfg.cupos_por_fecha) || 5;
    const dias = [];
    for (let iso = desde; iso <= hasta; iso = U.addDays(iso, 1)) {
      const p = U.parseIsoDate(iso); if (!p) break;
      const f = fechas[iso] || {};
      const delDia = reservas.filter((r) => r.fecha_recojo === iso);
      dias.push({
        fecha: iso, dia: U.nombreDia(p.isoDow), isoDow: p.isoDow,
        distritos: distritos.filter((d) => (d.dias || []).includes(p.isoDow)).map((d) => d.nombre),
        bloqueada: Boolean(f.bloqueada), motivo: f.motivo || null,
        cupo: f.cupo_maximo != null ? Number(f.cupo_maximo) : cupoDefault, cupo_especial: f.cupo_maximo != null,
        ocupados: delDia.filter((r) => r.estado === "programado").length,
        reservas: delDia.map((r) => ({ id: r.id, codigo: r.codigo, nombre: r.empresa || r.nombre, distrito: r.distrito, estado: r.estado, materiales: r.materiales })),
      });
    }
    res.json(dias);
  }));
  router.post("/api/fechas", auth("logistica"), wrap(async (req, res) => {
    const { fecha, bloqueada, motivo, cupo_maximo } = req.body || {};
    if (!U.parseIsoDate(fecha)) return res.status(400).json({ error: "Fecha inválida" });
    const f = await store.upsertFecha({ fecha, bloqueada, motivo, cupo_maximo });
    await store.audit({ user: req.admin.name, action: "fecha", target: fecha, ip: clientIp(req), details: f });
    res.json(f);
  }));

  // ── Distritos ──
  router.get("/api/distritos", auth(), wrap(async (_req, res) => res.json(await store.getDistritos({ incluirInactivos: true, fresh: true }))));
  router.post("/api/distritos", auth("logistica"), wrap(async (req, res) => {
    const d = await store.upsertDistrito(req.body || {});
    await store.audit({ user: req.admin.name, action: "distrito", target: d.nombre, ip: clientIp(req), details: { dias: d.dias, activo: d.activo, aliases: d.aliases } });
    res.json(d);
  }));

  // ── Config ──
  router.get("/api/config", auth(), wrap(async (_req, res) => res.json(await store.getConfig(true))));
  router.post("/api/config", auth("logistica"), wrap(async (req, res) => {
    const cambios = req.body || {};
    for (const [k, v] of Object.entries(cambios)) {
      if (!/^[a-z_]{3,40}$/.test(k)) continue;
      await store.setConfig(k, String(v ?? ""));
    }
    await store.audit({ user: req.admin.name, action: "config", ip: clientIp(req), details: cambios });
    res.json(await store.getConfig(true));
  }));

  // ── Conversaciones ──
  router.get("/api/conversaciones", auth(), wrap(async (_req, res) => res.json(await store.listarConversaciones(150))));
  router.get("/api/conversacion", auth(), wrap(async (req, res) => {
    if (!req.query.user_id) return res.status(400).json({ error: "Falta user_id" });
    res.json(await store.getMensajes(String(req.query.user_id), 300));
  }));

  // ── Export Excel ──
  router.get("/api/export.xlsx", auth(), wrap(async (req, res) => {
    const { estado, desde, hasta, distrito, q } = req.query;
    const rows = await store.listarReservas({ estado, desde, hasta, distrito, q, limit: 5000 });
    const data = rows.map((r) => ({
      "CODIGO": r.codigo, "FECHA DE SOLICITUD": U.fechaHoraLima(new Date(r.created_at)), "FECHA RESERVADA": U.fechaDdMmYyyy(r.fecha_recojo),
      "ESTADO": r.estado, "TIPO DONANTE": r.tipo_donante, "NOMBRE / CONTACTO": r.nombre, "EMPRESA": r.empresa || "",
      "TIPO DOC": r.documento_tipo || "", "DOCUMENTO": r.documento || "", "CELULAR": r.user_id, "CORREO": r.correo || "",
      "DISTRITO": r.distrito, "DIRECCION": r.direccion, "REFERENCIA": r.referencia || "",
      "DISPONIBILIDAD": { lun_vie: "Lunes a viernes", incluye_sab: "Incluye sábados" }[r.disponibilidad] || "", "HORARIO": r.horario || "", "REQUISITOS DE ACCESO": r.requisitos || "",
      "RAZON SOCIAL SUNAT": r.sunat?.razon_social || "", "ESTADO SUNAT": [r.sunat?.estado, r.sunat?.condicion].filter(Boolean).join(" / "),
      "MATERIALES": (r.materiales || []).join(", "), "CANTIDAD": r.cantidad || "", "COMENTARIO": r.comentario || "",
      "FOTOS": (r.fotos || []).join(" "), "KILOS": r.kilos ?? "", "NOTA": r.nota || "", "REPROGRAMACIONES": r.reprogramaciones,
      "FECHA ANTERIOR": r.fecha_anterior ? U.fechaDdMmYyyy(r.fecha_anterior) : "", "ENVIADO A SHEETS": r.make_enviado_at ? "sí" : (r.make_error ? "error" : "no"),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "Reservas");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    await store.audit({ user: req.admin.name, action: "export", ip: clientIp(req), details: { filas: data.length } });
    res.setHeader("Content-Disposition", `attachment; filename="eco-reservas-${U.limaParts().iso}.xlsx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buf);
  }));

  // ── Usuarios del panel (solo admin) ──
  router.get("/api/admin-users", auth("admin"), wrap(async (_req, res) => {
    const rows = await store.getAdminUsers();
    res.json([
      ...[...envUsers.values()].map((u) => ({ username: u.name, rol: u.rol, origen: "env", active: true })),
      ...rows.map((r) => ({ id: r.id, username: r.username, rol: r.rol, active: r.active, origen: "tabla", created_at: r.created_at })),
    ]);
  }));
  router.post("/api/admin-users", auth("admin"), wrap(async (req, res) => {
    const { id, username, password, rol, active } = req.body || {};
    if (!ROLES.includes(rol)) return res.status(400).json({ error: "Rol inválido" });
    if (!id && (!username || !password)) return res.status(400).json({ error: "Usuario y contraseña obligatorios" });
    const row = { ...(id ? { id } : {}), username: String(username).trim(), rol, active: active !== false };
    if (password) row.password_hash = hashPassword(password);
    if (!id && !row.password_hash) return res.status(400).json({ error: "Contraseña obligatoria" });
    const saved = await store.upsertAdminUser(row);
    await store.audit({ user: req.admin.name, action: "admin_user", target: saved.username, ip: clientIp(req), details: { rol, active: row.active, password: Boolean(password) } });
    res.json({ id: saved.id, username: saved.username, rol: saved.rol, active: saved.active });
  }));
  router.get("/api/audit", auth("admin"), wrap(async (_req, res) => res.json(await store.getAudit(300))));

  return router;
};

module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
