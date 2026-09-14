// Consulta de RUC en SUNAT a través de un proveedor de API (configurable).
// Devuelve { ruc, razon_social, estado, condicion, direccion, distrito, provincia, departamento } o null.
// Nunca bloquea el flujo: ante error o timeout se devuelve null y el bot pide la razón social a mano.
//
// Proveedores soportados (RUC_API_PROVIDER):
//   apisnet   → https://apis.net.pe  (default). Con RUC_API_TOKEN usa v2; sin token usa v1 (gratis, con límite).
//   apiperu   → https://apiperu.dev   (requiere RUC_API_TOKEN)
//   decolecta → https://decolecta.com (requiere RUC_API_TOKEN)
//   custom    → RUC_API_URL con {ruc}, opcional RUC_API_TOKEN como Bearer

const CACHE_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

const PROVIDERS = {
  apisnet: {
    url: (ruc, token) => token ? `https://api.apis.net.pe/v2/sunat/ruc?numero=${ruc}` : `https://api.apis.net.pe/v1/ruc?numero=${ruc}`,
  },
  apiperu: { url: (ruc) => `https://apiperu.dev/api/ruc/${ruc}`, unwrap: (d) => d?.data || d },
  decolecta: { url: (ruc) => `https://api.decolecta.com/v1/sunat/ruc?numero=${ruc}` },
  custom: { url: (ruc) => String(process.env.RUC_API_URL || "").replace("{ruc}", ruc) },
};

const pickFirst = (obj, keys) => { for (const k of keys) { const v = obj?.[k]; if (v != null && String(v).trim()) return String(v).trim(); } return null; };

// Normaliza las distintas formas de respuesta de los proveedores.
function normalizar(ruc, raw) {
  if (!raw || typeof raw !== "object") return null;
  const razon = pickFirst(raw, ["razonSocial", "razon_social", "nombre_o_razon_social", "nombre", "name"]);
  if (!razon) return null;
  return {
    ruc,
    razon_social: razon,
    nombre_comercial: pickFirst(raw, ["nombreComercial", "nombre_comercial"]),
    estado: (pickFirst(raw, ["estado", "estado_del_contribuyente", "status"]) || "").toUpperCase() || null,
    condicion: (pickFirst(raw, ["condicion", "condicion_de_domicilio", "condition"]) || "").toUpperCase() || null,
    direccion: pickFirst(raw, ["direccion", "direccion_completa", "address"]),
    distrito: pickFirst(raw, ["distrito", "district"]),
    provincia: pickFirst(raw, ["provincia", "province"]),
    departamento: pickFirst(raw, ["departamento", "department"]),
    tipo: pickFirst(raw, ["tipo", "tipo_contribuyente", "type"]),
  };
}

function createSunat({ provider = process.env.RUC_API_PROVIDER || "apisnet", token = process.env.RUC_API_TOKEN, timeoutMs = 7000, fetchImpl = fetch } = {}) {
  const p = PROVIDERS[provider];
  const enabled = Boolean(p) && (provider !== "custom" || Boolean(process.env.RUC_API_URL));
  if (!enabled) console.warn(`⚠️  Consulta SUNAT desactivada (RUC_API_PROVIDER=${provider}). Se pedirá la razón social a mano.`);
  else console.log(`🏛️  Consulta SUNAT: ${provider}${token ? " (con token)" : " (sin token)"}`);

  async function consultar(ruc) {
    if (!enabled || !/^\d{11}$/.test(String(ruc))) return null;
    const hit = cache.get(ruc);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(p.url(ruc, token), {
        headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: ctrl.signal,
      });
      if (res.status === 404 || res.status === 422) { cache.set(ruc, { at: Date.now(), value: null }); return null; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const value = normalizar(ruc, p.unwrap ? p.unwrap(raw) : raw);
      cache.set(ruc, { at: Date.now(), value });
      return value;
    } catch (err) {
      console.warn(`⚠️  SUNAT ${ruc}: ${err.name === "AbortError" ? "timeout" : err.message}`);
      return null; // no se cachea: puede ser un error transitorio
    } finally {
      clearTimeout(timer);
    }
  }

  return { consultar, enabled, provider };
}

module.exports = { createSunat, normalizar };
