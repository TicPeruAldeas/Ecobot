// Envío de cada reserva al webhook de Make, que la escribe en la hoja de Google
// "USUARIOS RUC". Las claves del JSON son los encabezados de la hoja para que el
// mapeo en Make sea directo. Se añaden campos extra (CODIGO, EVENTO, …) que Make
// puede ignorar o usar para enrutar (p. ej. no volver a insertar en una cancelación).
const { fechaDdMmYyyy, fechaHoraLima } = require("./util");

const ESTADO_HOJA = {
  programado: "FINALIZADO",   // así lo registraba Chatfuel: reserva completada en el bot
  atendido: "ATENDIDO",
  no_atendido: "NO ATENDIDO",
  cancelado: "CANCELADO",
  cerrado: "CERRADO",
};

function buildPayload(reserva, evento = "reserva") {
  const fotos = reserva.fotos || [];
  return {
    "FECHA DE SOLICITUD": fechaHoraLima(new Date(reserva.created_at || Date.now())),
    "CELULAR USUARIO": reserva.user_id,
    "CORREO USUARIO": reserva.correo || "",
    "RUC": reserva.documento || "",
    "EMPRESA": reserva.empresa || reserva.nombre || "",
    "DISTRITO": reserva.distrito,
    "DIRECCION DE RECOJO": [reserva.direccion, reserva.referencia].filter(Boolean).join(" — "),
    "DONACION TIPO": (reserva.materiales || []).join(","),
    "CANTIDAD DE DONACION": reserva.cantidad || "",
    "COMENTARIO": reserva.comentario || "",
    "FOTO": fotos[0] || "",
    "ESTADO RESERVA": ESTADO_HOJA[reserva.estado] || String(reserva.estado || "").toUpperCase(),
    "FECHA RESERVADA": fechaDdMmYyyy(reserva.fecha_recojo),
    "ENLACE GENERADO": "",
    // ── extras ──
    "CODIGO": reserva.codigo,
    "EVENTO": evento,                    // reserva | reprogramacion | cancelacion | estado
    "TIPO DONANTE": reserva.tipo_donante,
    "NOMBRE": reserva.nombre,
    "TIPO DOCUMENTO": reserva.documento_tipo || "",
    "REFERENCIA": reserva.referencia || "",
    "DISPONIBILIDAD": { lun_vie: "Lunes a viernes", incluye_sab: "Incluye sábados" }[reserva.disponibilidad] || "",
    "HORARIO DE ATENCION": reserva.horario || "",
    "REQUISITOS DE ACCESO": reserva.requisitos || "",
    "RAZON SOCIAL SUNAT": reserva.sunat?.razon_social || "",
    "ESTADO SUNAT": [reserva.sunat?.estado, reserva.sunat?.condicion].filter(Boolean).join(" / "),
    "FOTOS": fotos.join(" "),
    "FECHA ANTERIOR": reserva.fecha_anterior ? fechaDdMmYyyy(reserva.fecha_anterior) : "",
    "KILOS": reserva.kilos ?? "",
    "NOTA": reserva.nota || "",
    "ID": reserva.id,
  };
}

function createMake({ url, secret } = {}) {
  const enabled = Boolean(url);
  if (!enabled) console.warn("⚠️  MAKE_WEBHOOK_URL no definido — las reservas NO se enviarán a Google Sheets.");

  async function send(reserva, evento = "reserva") {
    if (!enabled) return { skipped: true };
    const payload = buildPayload(reserva, evento);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(secret ? { "x-make-apikey": secret } : {}) },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const body = await res.text().catch(() => "");
      if (!res.ok) throw new Error(`Make ${res.status}: ${body.slice(0, 200)}`);
      return { ok: true, status: res.status, body: body.slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { send, enabled, buildPayload };
}

module.exports = { createMake, buildPayload, ESTADO_HOJA };
