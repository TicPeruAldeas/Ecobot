// Cálculo de fechas disponibles. Función pura: recibe el "ahora", el distrito,
// la configuración, los bloqueos/cupos especiales y la ocupación, y devuelve
// las fechas que realmente se pueden ofrecer.
const { limaParts, addDays, parseIsoDate, limaDateTime } = require("./util");

/**
 * @param {object} p
 * @param {Date}   p.now                 instante actual
 * @param {object} p.distrito            { nombre, dias:[1..7] }
 * @param {object} p.config              { anticipacion_horas, hora_inicio_recojo, horizonte_dias, max_fechas, cupos_por_fecha }
 * @param {object} p.fechas              mapa iso → { bloqueada, cupo_maximo }
 * @param {object} p.ocupacion           mapa iso → ocupados
 * @param {string} [p.excluir]           iso a excluir (p. ej. la fecha actual al reprogramar)
 * @returns {Array<{iso, libres, cupo}>}
 */
function fechasDisponibles({ now = new Date(), distrito, config = {}, fechas = {}, ocupacion = {}, excluir = null }) {
  const dias = new Set((distrito?.dias || []).map(Number));
  if (dias.size === 0) return [];

  const anticipacionMs = (Number(config.anticipacion_horas) || 24) * 60 * 60 * 1000;
  const horaInicio = /^\d{1,2}:\d{2}$/.test(String(config.hora_inicio_recojo || "")) ? config.hora_inicio_recojo : "09:00";
  const horizonte = Math.min(Math.max(Number(config.horizonte_dias) || 30, 1), 120);
  const maxFechas = Math.min(Math.max(Number(config.max_fechas) || 6, 1), 10);
  const cupoDefault = Math.max(Number(config.cupos_por_fecha) || 5, 0);

  const hoy = limaParts(now).iso;
  const minimo = now.getTime() + anticipacionMs;
  const out = [];

  for (let i = 0; i <= horizonte && out.length < maxFechas; i++) {
    const iso = addDays(hoy, i);
    if (excluir && iso === excluir) continue;
    const p = parseIsoDate(iso);
    if (!dias.has(p.isoDow)) continue;
    const f = fechas[iso] || {};
    if (f.bloqueada) continue;
    const inicio = limaDateTime(iso, horaInicio).getTime();
    if (inicio < minimo) continue;
    const cupo = f.cupo_maximo != null ? Number(f.cupo_maximo) : cupoDefault;
    const ocupados = Number(ocupacion[iso] || 0);
    const libres = cupo - ocupados;
    if (libres <= 0) continue;
    out.push({ iso, libres, cupo });
  }
  return out;
}

// Reduce la config de la tabla (array de {key,value}) a un objeto.
function configToObject(rows = []) {
  const o = {};
  for (const r of rows) o[r.key] = r.value;
  return o;
}

module.exports = { fechasDisponibles, configToObject };
