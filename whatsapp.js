// Cliente mínimo de WhatsApp Cloud API (Meta Graph): texto, botones, listas,
// plantillas y descarga de medios. Un solo número (el de ECO).
const GRAPH = "https://graph.facebook.com/v21.0";

function createWhatsApp({ phoneNumberId, token }) {
  if (!phoneNumberId || !token) throw new Error("WhatsApp: faltan phoneNumberId/token");

  async function post(body) {
    const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  const text = (to, body) => post({ to, type: "text", text: { body: String(body).slice(0, 4096), preview_url: false } });

  // buttons: [{ id, title (≤20) }] máx. 3
  const buttons = (to, body, btns, { header, footer } = {}) => post({
    to, type: "interactive",
    interactive: {
      type: "button",
      ...(header ? { header: { type: "text", text: String(header).slice(0, 60) } } : {}),
      body: { text: String(body).slice(0, 1024) },
      ...(footer ? { footer: { text: String(footer).slice(0, 60) } } : {}),
      action: { buttons: btns.slice(0, 3).map((b) => ({ type: "reply", reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) } })) },
    },
  });

  // rows: [{ id, title (≤24), description (≤72) }] máx. 10 en total
  const list = (to, body, buttonText, rows, { header, footer, sectionTitle = "Opciones" } = {}) => post({
    to, type: "interactive",
    interactive: {
      type: "list",
      ...(header ? { header: { type: "text", text: String(header).slice(0, 60) } } : {}),
      body: { text: String(body).slice(0, 1024) },
      ...(footer ? { footer: { text: String(footer).slice(0, 60) } } : {}),
      action: {
        button: String(buttonText).slice(0, 20),
        sections: [{
          title: String(sectionTitle).slice(0, 24),
          rows: rows.slice(0, 10).map((r) => ({
            id: String(r.id).slice(0, 200),
            title: String(r.title).slice(0, 24),
            ...(r.description ? { description: String(r.description).slice(0, 72) } : {}),
          })),
        }],
      },
    },
  });

  // Plantilla aprobada (necesaria fuera de la ventana de 24 h). params: strings del cuerpo.
  const template = (to, name, params = [], lang = "es") => post({
    to, type: "template",
    template: {
      name, language: { code: lang },
      ...(params.length ? { components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: String(p) })) }] } : {}),
    },
  });

  const markRead = (messageId) => post({ status: "read", message_id: messageId }).catch(() => {});

  // Sube un archivo a Meta y devuelve el media id (para enviarlo como documento/imagen).
  async function uploadMedia(buffer, mimeType, filename) {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([buffer], { type: mimeType }), filename);
    const res = await fetch(`${GRAPH}/${phoneNumberId}/media`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) throw new Error(`WhatsApp media ${res.status}: ${JSON.stringify(data)}`);
    return data.id;
  }
  const document = (to, mediaId, filename, caption) => post({
    to, type: "document",
    document: { id: mediaId, filename: String(filename).slice(0, 240), ...(caption ? { caption: String(caption).slice(0, 1024) } : {}) },
  });

  // Descarga un medio recibido (foto). Devuelve { buffer, mimeType }.
  async function downloadMedia(mediaId) {
    const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });
    const info = await meta.json().catch(() => ({}));
    if (!meta.ok || !info.url) throw new Error(`Media ${meta.status}: ${JSON.stringify(info)}`);
    const bin = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!bin.ok) throw new Error(`Media download ${bin.status}`);
    const buffer = Buffer.from(await bin.arrayBuffer());
    return { buffer, mimeType: info.mime_type || "image/jpeg", size: info.file_size || buffer.length };
  }

  return { text, buttons, list, template, markRead, downloadMedia, uploadMedia, document, phoneNumberId };
}

// Extrae lo útil de un mensaje entrante del webhook.
function parseIncoming(message) {
  const type = message.type;
  const text = message.text?.body?.trim() || null;
  const buttonId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || message.button?.payload || null;
  const buttonTitle = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || message.button?.text || null;
  const image = message.image ? { id: message.image.id, mimeType: message.image.mime_type, caption: message.image.caption || null } : null;
  const document = message.document ? { id: message.document.id, mimeType: message.document.mime_type, filename: message.document.filename } : null;
  const location = message.location ? { lat: message.location.latitude, lng: message.location.longitude, name: message.location.name, address: message.location.address } : null;
  return { type, text, buttonId, buttonTitle, image, document, location };
}

module.exports = { createWhatsApp, parseIncoming };
