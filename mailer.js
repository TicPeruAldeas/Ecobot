// Correo transaccional por SMTP (nodemailer). Funciona con Microsoft 365
// (smtp.office365.com:587), Google Workspace, Resend (smtp.resend.com) o cualquier SMTP.
// Si falta SMTP_HOST o SMTP_USER queda desactivado y todo envío devuelve { skipped: true }.
const nodemailer = require("nodemailer");
const dns = require("dns").promises;
const U = require("./util");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DISPONIBILIDAD = { lun_vie: "Lunes a viernes", incluye_sab: "Incluye sábados" };

function layout({ titulo, cuerpo, pie }) {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f3f6f3;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="600" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
      <tr><td style="background:#1b5e20;color:#fff;padding:18px 24px;font-size:18px;font-weight:600">♻️ ECO · Aldeas Infantiles SOS Perú</td></tr>
      <tr><td style="padding:24px"><h1 style="font-size:20px;margin:0 0 12px">${esc(titulo)}</h1>${cuerpo}</td></tr>
      <tr><td style="padding:14px 24px;background:#fafafa;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb">${pie || "Este correo se envió automáticamente desde ECO, el asistente de reciclaje de Aldeas Infantiles SOS Perú."}</td></tr>
    </table></td></tr></table></body></html>`;
}

function filas(pares) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="font-size:14px;margin:12px 0;border-collapse:collapse">${pares
    .filter(([, v]) => v != null && String(v).trim())
    .map(([k, v]) => `<tr><td style="padding:5px 12px 5px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:5px 0"><b>${esc(v)}</b></td></tr>`).join("")}</table>`;
}

function datosRecojo(r) {
  return filas([
    ["Código", r.codigo],
    ["Fecha de recojo", U.fechaLarga(r.fecha_recojo)],
    ["Dirección", `${r.direccion}${r.referencia ? ` (${r.referencia})` : ""}, ${r.distrito}`],
    ["Materiales", (r.materiales || []).join(", ")],
    ["Cantidad aproximada", r.cantidad],
    ["Atención", r.disponibilidad ? `${DISPONIBILIDAD[r.disponibilidad] || r.disponibilidad}${r.horario ? `, ${r.horario}` : ""}` : null],
  ]);
}

const saludo = (r) => `<p style="margin:0 0 8px">Hola ${esc(r.tipo_donante === "empresa" ? `${r.nombre} (${r.empresa})` : r.nombre)},</p>`;

const PLANTILLAS = {
  reserva: (r) => ({
    subject: `Recojo programado ${r.codigo} · ${U.fechaLarga(r.fecha_recojo)}`,
    html: layout({ titulo: "¡Tu recojo quedó programado!", cuerpo: `${saludo(r)}<p>Gracias por donar tus materiales reciclables. Estos son los datos de tu recojo:</p>${datosRecojo(r)}<p>Te recordaremos por WhatsApp antes de la fecha. Ten los materiales listos y accesibles. Si necesitas cambiar la fecha o cancelar, escribe <b>menú</b> en WhatsApp y elige <b>Mis recojos</b>.</p><p style="margin-top:16px">¡Gracias por reciclar con Aldeas Infantiles SOS! 💚</p>` }),
  }),
  reprogramacion: (r) => ({
    subject: `Recojo ${r.codigo} reprogramado para el ${U.fechaLarga(r.fecha_recojo)}`,
    html: layout({ titulo: "Tu recojo fue reprogramado", cuerpo: `${saludo(r)}<p>La nueva fecha de tu recojo es el <b>${esc(U.fechaLarga(r.fecha_recojo))}</b>${r.fecha_anterior ? ` (antes: ${esc(U.fechaLarga(r.fecha_anterior))})` : ""}.</p>${datosRecojo(r)}` }),
  }),
  recordatorio: (r) => ({
    subject: `Recordatorio: mañana pasamos por tu reciclaje · ${r.codigo}`,
    html: layout({ titulo: "Tu recojo es pronto", cuerpo: `${saludo(r)}<p>Te recordamos que tu recojo de materiales reciclables está programado para el <b>${esc(U.fechaLarga(r.fecha_recojo))}</b>.</p>${datosRecojo(r)}<p>Ten los materiales listos y accesibles${r.requisitos ? `, y coordina el acceso de nuestro personal (${esc(r.requisitos)})` : ""}. Si necesitas cambiar la fecha, escribe <b>menú</b> en WhatsApp y elige <b>Mis recojos</b>.</p>` }),
  }),
  cancelacion: (r, extra = {}) => ({
    subject: `Recojo ${r.codigo} cancelado`,
    html: layout({ titulo: "Tu recojo fue cancelado", cuerpo: `${saludo(r)}<p>El recojo <b>${esc(r.codigo)}</b> del ${esc(U.fechaLarga(r.fecha_recojo))} fue cancelado${extra.motivo ? `: ${esc(extra.motivo)}` : ""}.</p><p>Cuando quieras volver a donar, escríbenos por WhatsApp y programamos uno nuevo.</p>` }),
  }),
  constancia: (c) => ({
    subject: `Constancia de donación de reciclaje N.° ${String(c.numero).padStart(5, "0")} · ${c.razon_social}`,
    html: layout({ titulo: "Constancia de donación de reciclaje", cuerpo: `<p>Estimados ${esc(c.razon_social)},</p><p>Adjuntamos la constancia N.° <b>${String(c.numero).padStart(5, "0")}</b> por la donación de <b>${esc(Number(c.total).toLocaleString("es-PE"))} kg</b> de materiales reciclables entre el ${esc(U.fechaDdMmYyyy(c.desde))} y el ${esc(U.fechaDdMmYyyy(c.hasta))}.</p><p>Gracias por su compromiso con el medio ambiente y con las niñas, niños y adolescentes que acompañamos.</p>` }),
  }),
  avisoInterno: (r, extra = {}) => {
    const tipo = extra.tipo || "reserva";
    const titulos = { reserva: ["Nueva reserva", "Nueva reserva de recojo"], reprogramacion: ["Reprogramación", "Recojo reprogramado"], cancelacion: ["Cancelación", "Recojo cancelado"] };
    const [asunto, titulo] = titulos[tipo] || titulos.reserva;
    return {
    subject: `${asunto} ${r.codigo} · ${r.distrito} · ${U.fechaCorta(r.fecha_recojo)}`,
    html: layout({ titulo, cuerpo: `${tipo === "reprogramacion" && r.fecha_anterior ? `<p>Nueva fecha: <b>${esc(U.fechaLarga(r.fecha_recojo))}</b> (antes ${esc(U.fechaLarga(r.fecha_anterior))}).</p>` : ""}${tipo === "cancelacion" ? `<p>Cancelado${extra.motivo ? `: ${esc(extra.motivo)}` : ""}. El cupo quedó libre.</p>` : ""}${filas([
      ["Código", r.codigo], ["Fecha", U.fechaLarga(r.fecha_recojo)],
      ["Donante", r.tipo_donante === "empresa" ? `${r.empresa} (contacto: ${r.nombre})` : r.nombre],
      ["Documento", `${r.documento_tipo || ""} ${r.documento || ""}`], ["Celular", r.user_id], ["Correo", r.correo],
      ["Dirección", `${r.direccion}${r.referencia ? ` (${r.referencia})` : ""}, ${r.distrito}`],
      ["Atención", r.disponibilidad ? `${DISPONIBILIDAD[r.disponibilidad] || ""}${r.horario ? `, ${r.horario}` : ""}` : null],
      ["Requisitos de acceso", r.requisitos], ["Materiales", (r.materiales || []).join(", ")], ["Cantidad", r.cantidad], ["Comentario", r.comentario],
    ])}${(r.fotos || []).map((u) => `<a href="${esc(u)}"><img src="${esc(u)}" width="180" style="border-radius:8px;margin:4px"></a>`).join("")}`, pie: "Aviso interno para el equipo de logística." }),
    };
  },
};

// ── Proveedores ──
//  gmail : API de Gmail por HTTPS con OAuth2 (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET y un refresh
//          token obtenido desde el panel → Configuración → "Conectar Gmail", guardado en eco_config).
//          No usa puertos SMTP, así que funciona en Railway.
//  smtp  : SMTP_HOST/USER/PASS (M365, Google, Resend…). Requiere salida por 587/465.
function createMailer(env = process.env, { store = null } = {}) {
  const provider = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? "gmail" : env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS ? "smtp" : "none";
  const enabled = provider !== "none";
  const notifyTo = String(env.MAIL_NOTIFY_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
  const port = Number(env.SMTP_PORT) || 587;
  if (provider === "smtp") console.log(`📧 Correo: SMTP ${env.SMTP_HOST}:${port} como ${env.SMTP_USER}${notifyTo.length ? ` · avisos a ${notifyTo.join(", ")}` : ""}`);
  else if (provider === "gmail") console.log(`📧 Correo: API de Gmail (OAuth2)${notifyTo.length ? ` · avisos a ${notifyTo.join(", ")}` : ""}`);
  else console.warn("⚠️  Correo desactivado (define GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, o SMTP_HOST/USER/PASS).");

  // ── Gmail API (OAuth2) ──
  const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/userinfo.email"];
  let accessCache = { token: null, exp: 0 };
  async function gmailCreds() {
    const cfg = store ? await store.getConfig() : {};
    return { refreshToken: cfg.gmail_refresh_token || env.GMAIL_REFRESH_TOKEN || null, cuenta: cfg.gmail_cuenta || env.GMAIL_SENDER || null };
  }
  async function accessToken() {
    if (accessCache.token && Date.now() < accessCache.exp - 60000) return accessCache.token;
    const { refreshToken } = await gmailCreds();
    if (!refreshToken) { const e = new Error("Gmail no conectado: entra al panel → Configuración → Conectar Gmail"); e.code = "GMAIL_NO_TOKEN"; throw e; }
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(`Google token: ${j.error || res.status} ${j.error_description || ""}`.trim());
    accessCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return j.access_token;
  }
  async function fromAddress() {
    if (env.MAIL_FROM) return env.MAIL_FROM;
    if (provider === "gmail") { const { cuenta } = await gmailCreds(); return cuenta ? `ECO · Aldeas Infantiles SOS Perú <${cuenta}>` : "ECO · Aldeas Infantiles SOS Perú"; }
    return `ECO · Aldeas Infantiles SOS Perú <${env.SMTP_USER}>`;
  }
  async function sendGmail({ to, subject, html, attachments }) {
    const MailComposer = require("nodemailer/lib/mail-composer");
    const raw = await new MailComposer({ from: await fromAddress(), to, subject, html, attachments }).compile().build();
    const token = await accessToken();
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: raw.toString("base64url") }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { if (res.status === 401) accessCache = { token: null, exp: 0 }; throw new Error(`Gmail API ${res.status}: ${j.error?.message || JSON.stringify(j).slice(0, 200)}`); }
    return { ok: true, id: j.id };
  }
  // URL de consentimiento y canje del código (los usa el panel).
  function oauthUrl(redirectUri, state) {
    return "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
    });
  }
  async function exchangeCode(code, redirectUri) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.refresh_token) throw new Error(`Google no devolvió refresh_token (${j.error || res.status}: ${j.error_description || "revoca el acceso previo en myaccount.google.com/permissions y reintenta"})`);
    const who = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${j.access_token}` } }).then((r) => r.json()).catch(() => ({}));
    accessCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return { refreshToken: j.refresh_token, email: who.email || null };
  }
  async function estado() {
    if (provider !== "gmail") return { proveedor: provider, conectado: provider === "smtp", cuenta: provider === "smtp" ? env.SMTP_USER : null };
    const { refreshToken, cuenta } = await gmailCreds();
    return { proveedor: "gmail", conectado: Boolean(refreshToken), cuenta };
  }

  // Railway no tiene salida IPv6 y nodemailer resuelve el DNS por su cuenta (puede elegir la
  // IPv6 de smtp.gmail.com → ENETUNREACH). Se resuelve la IPv4 a mano y se conecta a ella,
  // manteniendo el nombre del host para TLS (servername) y para el saludo SMTP.
  let ipCache = { at: 0, ip: null };
  async function hostIPv4() {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(env.SMTP_HOST)) return env.SMTP_HOST;
    if (ipCache.ip && Date.now() - ipCache.at < 10 * 60 * 1000) return ipCache.ip;
    try {
      const ips = await dns.resolve4(env.SMTP_HOST);
      if (ips.length) { ipCache = { at: Date.now(), ip: ips[0] }; return ips[0]; }
    } catch (err) { console.warn(`⚠️  No se pudo resolver IPv4 de ${env.SMTP_HOST}: ${err.message}`); }
    return env.SMTP_HOST;
  }
  async function getTransport() {
    const ip = await hostIPv4();
    return nodemailer.createTransport({
      host: ip, port, secure: port === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      ...(port === 587 ? { requireTLS: true } : {}),
      tls: { servername: env.SMTP_HOST },
      connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 40000,
    });
  }

  async function send({ to, subject, html, attachments = [] }) {
    if (!enabled) return { skipped: true };
    if (!to) return { skipped: true, reason: "sin destinatario" };
    if (provider === "gmail") return sendGmail({ to, subject, html, attachments });
    const transport = await getTransport();
    try {
      const info = await transport.sendMail({ from: await fromAddress(), to, subject, html, attachments });
      return { ok: true, id: info.messageId };
    } catch (err) {
      ipCache.at = 0; // si falló la conexión, re-resolver la próxima vez
      throw err;
    } finally {
      transport.close();
    }
  }

  // Envíos "fire and forget": nunca rompen el flujo; el resultado se registra por callback.
  function enviar(tipo, destino, datos, extra, onDone) {
    if (!enabled || !destino) return Promise.resolve({ skipped: true });
    const tpl = PLANTILLAS[tipo](datos, extra);
    return send({ to: destino, ...tpl, attachments: extra?.attachments || [] })
      .then((r) => { console.log(`📧 ${tipo} → ${destino}`); onDone?.(null, r); return r; })
      .catch((err) => { console.error(`❌ correo ${tipo} → ${destino}: ${err.message}`); onDone?.(err); return { ok: false, error: err.message }; });
  }

  return {
    enabled, provider, notifyTo, send, enviar, oauthUrl, exchangeCode, estado,
    reserva: (r, cb) => enviar("reserva", r.correo, r, {}, cb),
    reprogramacion: (r, cb) => enviar("reprogramacion", r.correo, r, {}, cb),
    recordatorio: (r, cb) => enviar("recordatorio", r.correo, r, {}, cb),
    cancelacion: (r, motivo, cb) => enviar("cancelacion", r.correo, r, { motivo }, cb),
    constancia: (c, pdfBuffer, correo, cb) => enviar("constancia", correo || c.correo, c, { attachments: [{ filename: `Constancia-${String(c.numero).padStart(5, "0")}-${String(c.razon_social).replace(/[^\w\-]+/g, "_").slice(0, 40)}.pdf`, content: pdfBuffer, contentType: "application/pdf" }] }, cb),
    avisoInterno: (r, tipo = "reserva", motivo = null, cb) => notifyTo.length ? enviar("avisoInterno", notifyTo.join(", "), r, { tipo, motivo }, cb) : Promise.resolve({ skipped: true }),
    verify: async () => { if (!enabled) return false; if (provider === "gmail") { await accessToken(); return true; } const t = await getTransport(); try { return await t.verify(); } finally { t.close(); } },
  };
}

module.exports = { createMailer, PLANTILLAS, layout };
