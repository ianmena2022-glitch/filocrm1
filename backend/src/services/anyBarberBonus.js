// Bonus de puntos por elegir "cualquier profesional" (reserva online o fila virtual).
// El dueño lo activa desde Configuración y elige el %. Sirve para repartir el trabajo:
// el turno "cualquiera" siempre va al barbero libre con menos trabajo.
const pool = require('../db/pool');

let _ready = null;
function ensureBonusSchema() {
  if (!_ready) {
    _ready = (async () => {
      await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS any_barber_bonus_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
      await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS any_barber_bonus_pct INTEGER NOT NULL DEFAULT 20`);
      await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS any_barber BOOLEAN NOT NULL DEFAULT FALSE`);
      await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS bonus_points INTEGER NOT NULL DEFAULT 0`);
      await pool.query(`ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS any_barber BOOLEAN NOT NULL DEFAULT FALSE`);
    })().catch(e => { _ready = null; console.warn('[bonus] esquema:', e.message); });
  }
  return _ready;
}

// Config del local (una sucursal sin config propia usa la del dueño enterprise)
async function getBonusConfig(shopId) {
  await ensureBonusSchema();
  try {
    const r = await pool.query(
      `SELECT s.any_barber_bonus_enabled AS en, s.any_barber_bonus_pct AS pct,
              o.any_barber_bonus_enabled AS oen, o.any_barber_bonus_pct AS opct
         FROM shops s LEFT JOIN shops o ON o.id = s.parent_enterprise_id AND s.is_branch = TRUE
        WHERE s.id = $1`, [shopId]);
    const row = r.rows[0];
    if (!row) return { enabled: false, pct: 0 };
    if (row.en) return { enabled: true, pct: clampPct(row.pct) };
    if (row.oen) return { enabled: true, pct: clampPct(row.opct) };
    return { enabled: false, pct: clampPct(row.pct) };
  } catch (_) { return { enabled: false, pct: 0 }; }
}

function clampPct(v) { const n = parseInt(v); return Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : 20; }

// Puntos extra sobre los puntos que ya gana la visita
function bonusPoints(basePoints, cfg) {
  if (!cfg || !cfg.enabled || !(basePoints > 0)) return 0;
  return Math.round(basePoints * cfg.pct / 100);
}

module.exports = { ensureBonusSchema, getBonusConfig, bonusPoints, clampPct };
