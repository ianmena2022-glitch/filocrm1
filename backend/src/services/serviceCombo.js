// Turnos con más de un servicio: junta los servicios elegidos en uno solo para el turno.
// - Nombre: "Corte + Barba"
// - Precio, costo y duración: la suma
// - Comisión: si algún servicio tiene comisión propia, se pondera por precio
//   (cada servicio usa la suya o, si no tiene, la del barbero)

const MAX_SERVICES = 10;

// Acepta service_ids (array o "1,2,3") y/o service_id. Devuelve ids únicos, en el orden elegido.
function parseServiceIds(body) {
  let raw = body?.service_ids;
  if (typeof raw === 'string') raw = raw.split(',');
  if (!Array.isArray(raw)) raw = [];
  if (!raw.length && body?.service_id) raw = [body.service_id];
  const out = [];
  for (const v of raw) {
    const n = parseInt(v);
    if (n > 0 && !out.includes(n)) out.push(n);
    if (out.length >= MAX_SERVICES) break;
  }
  return out;
}

function comboFromRows(ids, rows) {
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  const list = ids.map(id => byId.get(id)).filter(Boolean);
  if (!list.length) return null;
  const num = v => parseFloat(v) || 0;
  const price = list.reduce((s, r) => s + num(r.price), 0);
  const hasCustom = list.some(r => r.commission_pct !== null && r.commission_pct !== undefined);
  return {
    ids: list.map(r => Number(r.id)),
    firstId: Number(list[0].id),
    name: list.map(r => r.name).join(' + ').slice(0, 255),
    price,
    cost: list.reduce((s, r) => s + num(r.cost), 0),
    duration: list.reduce((s, r) => s + (parseInt(r.duration_minutes) || 30), 0),
    hasCustom,
    // % de comisión del turno para un barbero con `barberPct`
    commissionFor(barberPct) {
      const pctOf = r => (r.commission_pct !== null && r.commission_pct !== undefined) ? parseInt(r.commission_pct) : barberPct;
      if (list.length === 1) return pctOf(list[0]);
      if (price <= 0) return pctOf(list[0]);
      return Math.round(list.reduce((s, r) => s + num(r.price) * pctOf(r), 0) / price);
    },
  };
}

// Lee los servicios del local y devuelve el combo (o null si ninguno existe)
async function resolveServices(db, shopId, ids) {
  if (!ids || !ids.length) return null;
  const r = await db.query(
    'SELECT id, name, price, cost, duration_minutes, commission_pct FROM services WHERE shop_id=$1 AND id = ANY($2::int[])',
    [shopId, ids]
  );
  return comboFromRows(ids, r.rows);
}

// Comisión de un turno ya creado (para cuando se le asigna o cambia el barbero)
async function apptCommission(db, shopId, appt, barberPct) {
  const ids = (appt.service_ids && appt.service_ids.length) ? appt.service_ids.map(Number) : (appt.service_id ? [Number(appt.service_id)] : []);
  const combo = await resolveServices(db, shopId, ids);
  return combo && combo.hasCustom ? combo.commissionFor(barberPct) : barberPct;
}

module.exports = { parseServiceIds, resolveServices, apptCommission, MAX_SERVICES, __test: { comboFromRows } };
