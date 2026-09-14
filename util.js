// Utilidades puras: fechas en hora de Lima, normalización de texto y validaciones.
// Sin dependencias externas para que sean fáciles de probar.

const TZ = "America/Lima"; // UTC-5 fijo, Perú no tiene horario de verano.
const LIMA_OFFSET_MS = -5 * 60 * 60 * 1000;

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const DIAS_CORTO = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MESES_CORTO = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// Devuelve { y, m, d, h, min, dow, iso } de un instante visto desde Lima.
// dow: 0=domingo … 6=sábado. isoDow: 1=lunes … 7=domingo.
function limaParts(date = new Date()) {
  const shifted = new Date(date.getTime() + LIMA_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  const dow = shifted.getUTCDay();
  return {
    y, m, d, dow,
    isoDow: dow === 0 ? 7 : dow,
    h: shifted.getUTCHours(),
    min: shifted.getUTCMinutes(),
    iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  };
}

// "YYYY-MM-DD" (fecha civil de Lima) → partes.
function parseIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const dow = dt.getUTCDay();
  return { y, m: mo, d, dow, isoDow: dow === 0 ? 7 : dow, iso };
}

// Instante (UTC) en que empieza cierta hora "HH:MM" de un día civil de Lima.
function limaDateTime(iso, hhmm = "00:00") {
  const p = parseIsoDate(iso);
  if (!p) return null;
  const [h, mi] = String(hhmm).split(":").map((x) => Number(x) || 0);
  return new Date(Date.UTC(p.y, p.m - 1, p.d, h, mi) - LIMA_OFFSET_MS);
}

function addDays(iso, n) {
  const p = parseIsoDate(iso);
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// "lunes 15 de septiembre"
function fechaLarga(iso) {
  const p = parseIsoDate(iso);
  if (!p) return String(iso || "");
  return `${DIAS[p.dow]} ${p.d} de ${MESES[p.m - 1]}`;
}

// "Lun 15 sep" (cabe en el título de una fila de lista de WhatsApp, ≤24)
function fechaCorta(iso) {
  const p = parseIsoDate(iso);
  if (!p) return String(iso || "");
  const dia = DIAS_CORTO[p.dow];
  return `${dia.charAt(0).toUpperCase()}${dia.slice(1)} ${p.d} ${MESES_CORTO[p.m - 1]}`;
}

// "15/09/2026" — formato que usa la hoja de Google
function fechaDdMmYyyy(iso) {
  const p = parseIsoDate(iso);
  if (!p) return String(iso || "");
  return `${String(p.d).padStart(2, "0")}/${String(p.m).padStart(2, "0")}/${p.y}`;
}

// "15/09/2026 10:32" en hora de Lima
function fechaHoraLima(date = new Date()) {
  const p = limaParts(date);
  return `${String(p.d).padStart(2, "0")}/${String(p.m).padStart(2, "0")}/${p.y} ${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`;
}

function nombreDia(isoDow) {
  return DIAS[isoDow % 7];
}

// ── Texto ───────────────────────────────────────────────────
function normalizar(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function capitalizarNombre(s) {
  return String(s || "").trim().replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (w.length > 2 || w === w.toUpperCase() ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join(" ");
}

function truncar(s, n) {
  const t = String(s || "");
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + "…";
}

// ── Validaciones ────────────────────────────────────────────
const soloDigitos = (s) => String(s || "").replace(/\D+/g, "");

function validarDNI(s) {
  const d = soloDigitos(s);
  return d.length === 8 ? d : null;
}

function validarRUC(s) {
  const d = soloDigitos(s);
  if (d.length !== 11) return null;
  if (!/^(10|15|16|17|20)/.test(d)) return null;
  // Dígito verificador (módulo 11) — evita RUC inventados.
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) suma += Number(d[i]) * pesos[i];
  const resto = 11 - (suma % 11);
  const dv = resto === 10 ? 0 : resto === 11 ? 1 : resto;
  return dv === Number(d[10]) ? d : null;
}

// Acepta DNI (8) o RUC (11). Devuelve { tipo, valor } o null.
function validarDocumento(s) {
  const d = soloDigitos(s);
  if (d.length === 8) return { tipo: "DNI", valor: d };
  if (d.length === 11) { const r = validarRUC(d); return r ? { tipo: "RUC", valor: r } : null; }
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
function validarCorreo(s) {
  const v = String(s || "").trim().toLowerCase();
  return EMAIL_RE.test(v) && v.length <= 120 ? v : null;
}

function validarNombre(s) {
  const v = String(s || "").trim().replace(/\s+/g, " ");
  if (v.length < 3 || v.length > 80) return null;
  if (/\d{4,}/.test(v)) return null;
  if (!/[a-záéíóúñ]/i.test(v)) return null;
  return v;
}

// ── Distritos ───────────────────────────────────────────────
// Busca un distrito por nombre o alias. Devuelve { exact: d } | { candidates: [...] } | { none: true }.
function buscarDistrito(texto, distritos) {
  const q = normalizar(texto);
  if (!q) return { none: true };
  const activos = distritos.filter((d) => d.activo !== false);
  const formas = (d) => [d.nombre, ...(d.aliases || [])].map(normalizar);

  const exact = activos.find((d) => formas(d).includes(q));
  if (exact) return { exact };

  // Contiene / empieza por
  let cands = activos.filter((d) => formas(d).some((f) => f.startsWith(q) || f.includes(q) || q.includes(f)));
  if (cands.length === 1) return { exact: cands[0] };
  if (cands.length > 1) return { candidates: cands.slice(0, 9) };

  // Tolerancia a errores de tipeo: distancia de edición sobre el nombre completo
  const scored = activos
    .map((d) => ({ d, dist: Math.min(...formas(d).map((f) => levenshtein(f, q))) }))
    .filter((x) => x.dist <= Math.max(1, Math.floor(q.length / 4)))
    .sort((a, b) => a.dist - b.dist);
  if (scored.length === 1) return { exact: scored[0].d };
  if (scored.length > 1) return { candidates: scored.slice(0, 9).map((x) => x.d) };
  return { none: true };
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

module.exports = {
  TZ, DIAS, MESES,
  limaParts, parseIsoDate, limaDateTime, addDays,
  fechaLarga, fechaCorta, fechaDdMmYyyy, fechaHoraLima, nombreDia,
  normalizar, capitalizarNombre, truncar, soloDigitos,
  validarDNI, validarRUC, validarDocumento, validarCorreo, validarNombre,
  buscarDistrito, levenshtein,
};
