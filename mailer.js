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

function createMailer(env = process.env) {
  const enabled = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
  const from = env.MAIL_FROM || (env.SMTP_USER ? `ECO · Aldeas Infantiles SOS Perú <${env.SMTP_USER}>` : "");
  const notifyTo = String(env.MAIL_NOTIFY_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
  const port = Number(env.SMTP_PORT) || 587;
  if (enabled) console.log(`📧 Correo: ${env.SMTP_HOST}:${port} como ${env.SMTP_USER}${notifyTo.length ? ` · avisos a ${notifyTo.join(", ")}` : ""}`);
  else console.warn("⚠️  Correo desactivado (faltan SMTP_HOST / SMTP_USER / SMTP_PASS).");

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
    const transport = await getTransport();
    try {
      const info = await transport.sendMail({ from, to, subject, html, attachments });
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
    enabled, from, notifyTo, send, enviar,
    reserva: (r, cb) => enviar("reserva", r.correo, r, {}, cb),
    reprogramacion: (r, cb) => enviar("reprogramacion", r.correo, r, {}, cb),
    recordatorio: (r, cb) => enviar("recordatorio", r.correo, r, {}, cb),
    cancelacion: (r, motivo, cb) => enviar("cancelacion", r.correo, r, { motivo }, cb),
    constancia: (c, pdfBuffer, correo, cb) => enviar("constancia", correo || c.correo, c, { attachments: [{ filename: `Constancia-${String(c.numero).padStart(5, "0")}-${String(c.razon_social).replace(/[^\w\-]+/g, "_").slice(0, 40)}.pdf`, content: pdfBuffer, contentType: "application/pdf" }] }, cb),
    avisoInterno: (r, tipo = "reserva", motivo = null, cb) => notifyTo.length ? enviar("avisoInterno", notifyTo.join(", "), r, { tipo, motivo }, cb) : Promise.resolve({ skipped: true }),
    verify: async () => { if (!enabled) return false; const t = await getTransport(); try { return await t.verify(); } finally { t.close(); } },
  };
}

module.exports = { createMailer, PLANTILLAS, layout };
