require("dotenv").config({ quiet: true });

const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_TOKEN"];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Variables de entorno faltantes: ${missing.join(", ")}`);
  process.exit(1);
}

// Railway no tiene salida IPv6: si un host (p. ej. smtp.gmail.com) resuelve primero a IPv6,
// la conexión falla con ENETUNREACH. Preferir IPv4 en todas las resoluciones DNS.
require("dns").setDefaultResultOrder("ipv4first");

const crypto = require("crypto");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { createStore } = require("./store");
const { createWhatsApp, parseIncoming } = require("./whatsapp");
const { createFlow } = require("./flow");
const { createSunat } = require("./sunat");
const { createMailer } = require("./mailer");
const U = require("./util");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const store = createStore(supabase, { bucket: process.env.STORAGE_BUCKET || "eco-fotos" });
const wa = createWhatsApp({ phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID, token: process.env.WHATSAPP_TOKEN });
const sunat = createSunat();
const mailer = createMailer();
const flow = createFlow({ store, wa, sunat, mailer });

// ── App Secret(s) de Meta: META_APP_SECRET, META_APP_SECRET_2, … ──
const META_APP_SECRETS = Object.entries(process.env)
  .filter(([k, v]) => /^META_APP_SECRET(_[A-Z0-9]+)?$/.test(k) && String(v || "").trim())
  .map(([, v]) => v.trim());
if (META_APP_SECRETS.length === 0) console.warn("⚠️  Sin META_APP_SECRET — el webhook NO verificará la firma de Meta.");
else console.log(`🔐 App Secrets configurados: ${META_APP_SECRETS.length}`);

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

function verifyMetaSignature(req) {
  if (META_APP_SECRETS.length === 0) return true;
  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !req.rawBody) return false;
  const sigBuf = Buffer.from(signature);
  return META_APP_SECRETS.some((secret) => {
    const expBuf = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex"));
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  });
}

// ── Dedup de reintentos de Meta ──
const seenMessageIds = new Map();
const DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_AGE_MS = (Number(process.env.MAX_INBOUND_MESSAGE_AGE_SECONDS) || 180) * 1000;

// ── Modo prueba: lista blanca de números ──
// TEST_ALLOWED_NUMBERS="51999000111,51988777666" → el bot SOLO atiende (y solo escribe a) esos
// números; al resto los ignora en silencio. Vacío = atiende a todos. Útil mientras el número
// sigue conectado a Chatfuel.
const TEST_ALLOWED = new Set(String(process.env.TEST_ALLOWED_NUMBERS || "").split(",").map((s) => s.replace(/\D+/g, "")).filter(Boolean));
const permitido = (numero) => TEST_ALLOWED.size === 0 || TEST_ALLOWED.has(String(numero).replace(/\D+/g, ""));
if (TEST_ALLOWED.size > 0) console.warn(`🧪 MODO PRUEBA: solo se atiende a ${[...TEST_ALLOWED].join(", ")}. Quita TEST_ALLOWED_NUMBERS para producción.`);
function alreadyProcessed(id) {
  if (!id) return false;
  const now = Date.now();
  if (seenMessageIds.size > 2000) for (const [k, ts] of seenMessageIds) if (now - ts > DEDUP_TTL_MS) seenMessageIds.delete(k);
  if (seenMessageIds.has(id) && now - seenMessageIds.get(id) < DEDUP_TTL_MS) return true;
  seenMessageIds.set(id, now);
  return false;
}

// ── Cola por usuario ──
const userQueues = new Map();
function runSerialized(key, task) {
  const prev = userQueues.get(key) || Promise.resolve();
  const current = prev.then(task).catch((err) => console.error(`❌ [${key}]`, err.message));
  userQueues.set(key, current);
  current.finally(() => { if (userQueues.get(key) === current) userQueues.delete(key); });
  return current;
}

// ── Panel ──
app.use("/admin", require("./admin")({ store, wa, mailer, whatsappHelpers: { notificar } }));

app.get("/health", (_req, res) => res.json({ ok: true, bot: "eco", correo: mailer.enabled, sunat: sunat.enabled, uptime_s: Math.round(process.uptime()), version: String(process.env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 7) || null, ts: new Date().toISOString() }));

// ── Webhook Meta ──
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(req.query["hub.challenge"]);
  }
  return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  if (!verifyMetaSignature(req)) { console.warn("🔏 Firma de Meta inválida — rechazado"); return res.sendStatus(403); }
  res.sendStatus(200);

  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  if (!message) return; // statuses (entregado/leído) u otros eventos

  const incomingId = value?.metadata?.phone_number_id;
  if (incomingId && incomingId !== wa.phoneNumberId) { console.log(`⏭️  Ignorando número ajeno: ${incomingId}`); return; }

  const ageMs = Date.now() - Number(message.timestamp) * 1000;
  if (Number.isFinite(ageMs) && ageMs > MAX_AGE_MS) { console.log(`⏭️  Mensaje viejo (${Math.round(ageMs / 1000)}s): ${message.id}`); return; }
  if (alreadyProcessed(message.id)) { console.log(`⏭️  Duplicado: ${message.id}`); return; }

  const from = message.from;
  if (!permitido(from)) { console.log(`🧪 Ignorado (fuera de la lista de prueba): ${from}`); return; }
  const name = value?.contacts?.[0]?.profile?.name || null;
  const msg = parseIncoming(message);
  if (!msg.text && !msg.buttonId && !msg.image && !msg.document && !msg.location) {
    console.log(`⏭️  Tipo no soportado (${msg.type}) de ${from}`);
    runSerialized(from, () => wa.text(from, "Por ahora solo puedo leer texto, botones y fotos 🙂"));
    return;
  }
  console.log(`📩 ${from}${name ? ` (${name})` : ""}: ${msg.text || msg.buttonId || msg.type}`);
  wa.markRead(message.id);

  runSerialized(from, async () => {
    try {
      await flow.handle({ from, name, msg });
    } catch (err) {
      console.error(`❌ Error en flujo [${from}]:`, err.message, err.original || "");
      await wa.text(from, "Disculpa, tuve un problema técnico. Escribe *menú* para continuar.").catch(() => {});
    }
  });
});

// ── Notificar a un donante desde el panel (reprogramación/cancelación) ──
// Fuera de la ventana de 24 h Meta exige plantilla; si hay una configurada se usa.
async function notificar(userId, texto, templateParams = null) {
  if (!permitido(userId)) return { ok: false, error: "Número fuera de la lista de prueba (TEST_ALLOWED_NUMBERS)" };
  const tpl = process.env.WA_TEMPLATE_CAMBIO;
  try {
    if (tpl && templateParams) await wa.template(userId, tpl, templateParams, process.env.WA_TEMPLATE_LANG || "es");
    else await wa.text(userId, texto);
    await store.logMensaje(userId, "assistant", texto, { origen: "panel" });
    return { ok: true };
  } catch (err) {
    console.warn(`⚠️  No se pudo avisar a ${userId}: ${err.message.slice(0, 160)}`);
    return { ok: false, error: err.message.slice(0, 200) };
  }
}

// ── Recordatorios ──
const SWEEP_MS = Math.max(Number(process.env.REMINDER_SWEEP_MINUTES) || 10, 1) * 60 * 1000;
async function sweepRecordatorios() {
  try {
    const cfg = await store.getConfig();
    const horas = Number(cfg.recordatorio_horas) || 24;
    const now = new Date();
    const hoy = U.limaParts(now).iso;
    const hasta = U.addDays(hoy, Math.ceil(horas / 24) + 1);
    const pendientes = await store.reservasParaRecordatorio(hoy, hasta);
    for (const r of pendientes) {
      if (!permitido(r.user_id)) continue;
      const inicio = U.limaDateTime(r.fecha_recojo, cfg.hora_inicio_recojo || "09:00").getTime();
      const faltan = inicio - now.getTime();
      if (faltan <= 0 || faltan > horas * 3600000) continue;
      const nombre = r.empresa || r.nombre;
      const texto = `Hola ${nombre} 👋 Te recordamos tu recojo de reciclaje *${r.codigo}* programado para el *${U.fechaLarga(r.fecha_recojo)}* en ${r.direccion}, ${r.distrito}. Ten los materiales listos. Si necesitas cambiar la fecha, escribe *menú* → *Mis recojos*.`;
      const tpl = process.env.WA_TEMPLATE_RECORDATORIO;
      const resultado = { whatsapp: null, correo: null };
      // 1) WhatsApp (plantilla si existe; si no, texto libre que solo llega dentro de la ventana de 24 h)
      try {
        if (tpl) {
          const campos = (process.env.WA_TEMPLATE_RECORDATORIO_PARAMS || "nombre,fecha,direccion,codigo").split(",").map((s) => s.trim());
          const valores = { nombre, fecha: U.fechaLarga(r.fecha_recojo), direccion: `${r.direccion}, ${r.distrito}`, codigo: r.codigo, distrito: r.distrito };
          await wa.template(r.user_id, tpl, campos.map((c) => valores[c] ?? ""), process.env.WA_TEMPLATE_LANG || "es");
        } else {
          await wa.text(r.user_id, texto);
        }
        await store.logMensaje(r.user_id, "assistant", texto, { origen: "recordatorio", reserva: r.codigo });
        resultado.whatsapp = { ok: true, via: tpl ? "template" : "text" };
      } catch (err) {
        console.warn(`⚠️  Recordatorio WhatsApp ${r.codigo} falló: ${err.message.slice(0, 160)}`);
        resultado.whatsapp = { ok: false, error: err.message.slice(0, 200) };
      }
      // 2) Correo (no depende de la ventana de 24 h)
      if (mailer.enabled && r.correo) {
        const m = await mailer.recordatorio(r);
        resultado.correo = m.ok ? { ok: true, a: r.correo } : { ok: false, error: m.error || "no enviado" };
      }
      // Se marca aunque falle, para no reintentar en cada barrido (el detalle queda en el historial de la reserva).
      await store.marcarRecordatorio(r.id, resultado);
      console.log(`⏰ Recordatorio ${r.codigo} → WhatsApp ${resultado.whatsapp?.ok ? "✅" : "❌"}${resultado.correo ? ` · correo ${resultado.correo.ok ? "✅" : "❌"}` : ""}`);
    }
  } catch (err) {
    console.error("❌ sweepRecordatorios:", err.message);
  }
}

// ── Simulador (pruebas sin WhatsApp): POST /simulate { user_id, text | button | image } ──
// Devuelve lo que el bot habría enviado. Requiere Authorization: Bearer <INGEST_SECRET|ADMIN_SESSION_SECRET>.
const SIM_SECRET = process.env.INGEST_SECRET || process.env.ADMIN_SESSION_SECRET;
app.post("/simulate", async (req, res) => {
  if (!SIM_SECRET || req.headers.authorization !== `Bearer ${SIM_SECRET}`) return res.status(401).json({ error: "No autorizado" });
  const { user_id, text, button, image_url, name } = req.body || {};
  if (!user_id) return res.status(400).json({ error: "Falta user_id" });
  const out = [];
  const fakeWa = {
    phoneNumberId: "sim",
    text: async (_to, body) => out.push({ type: "text", body }),
    buttons: async (_to, body, btns) => out.push({ type: "buttons", body, buttons: btns }),
    list: async (_to, body, buttonText, rows) => out.push({ type: "list", body, buttonText, rows }),
    template: async () => out.push({ type: "template" }),
    markRead: async () => {},
    downloadMedia: async () => ({ buffer: Buffer.from("fake"), mimeType: "image/jpeg", size: 4 }),
  };
  const simStore = { ...store, uploadFoto: async () => image_url || "https://example.com/foto-simulada.jpg" };
  const simFlow = createFlow({ store: simStore, wa: fakeWa, sunat, mailer });
  const msg = { text: text || null, buttonId: button || null, buttonTitle: button || null, image: image_url ? { id: "sim" } : null, document: null, location: null, type: image_url ? "image" : text ? "text" : "interactive" };
  try {
    await runSerialized(`sim:${user_id}`, () => simFlow.handle({ from: String(user_id), name: name || "Prueba", msg }));
    res.json({ respuestas: out });
  } catch (err) {
    res.status(500).json({ error: err.message, respuestas: out });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ECO en puerto ${PORT} — número ${wa.phoneNumberId}`);
  console.log(`📄 Plantilla recordatorio: ${process.env.WA_TEMPLATE_RECORDATORIO || "(ninguna: se intentará texto libre)"}`);
  setInterval(sweepRecordatorios, SWEEP_MS);
  setTimeout(sweepRecordatorios, 15000);
});
