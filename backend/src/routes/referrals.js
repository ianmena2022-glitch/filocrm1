const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// Crear columnas si no existen (primera vez)
async function ensureColumns() {
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS referred_by_shop_id INT REFERENCES shops(id) ON DELETE SET NULL`).catch(() => {});
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS ref_bonus_granted BOOLEAN DEFAULT FALSE`).catch(() => {});
}
ensureColumns();

// GET /api/referrals — stats + link del shop actual
router.get('/', auth, async (req, res) => {
  try {
    // Obtener booking_slug propio para armar el link
    const shopRes = await pool.query('SELECT booking_slug, name FROM shops WHERE id=$1', [req.shopId]);
    const shop = shopRes.rows[0];
    const refSlug = shop?.booking_slug || String(req.shopId);
    const refLink = `https://filocrm.com.ar/app?ref=${refSlug}`;

    // Stats — con fallback si la columna aún no existe
    let total = 0, active = 0, bonuses = 0, recent = [];
    try {
      const statsRes = await pool.query(
        `SELECT
           COUNT(*)                                                        AS total,
           COUNT(*) FILTER (WHERE subscription_status IN ('active','trial')) AS active,
           COUNT(*) FILTER (WHERE ref_bonus_granted = TRUE)               AS bonuses_granted
         FROM shops WHERE referred_by_shop_id = $1`,
        [req.shopId]
      );
      total   = parseInt(statsRes.rows[0].total)           || 0;
      active  = parseInt(statsRes.rows[0].active)          || 0;
      bonuses = parseInt(statsRes.rows[0].bonuses_granted) || 0;

      const recentRes = await pool.query(
        `SELECT name, subscription_status, created_at
         FROM shops WHERE referred_by_shop_id = $1
         ORDER BY created_at DESC LIMIT 10`,
        [req.shopId]
      );
      recent = recentRes.rows;
    } catch (statsErr) {
      console.warn('[referrals] stats query failed (column may not exist yet):', statsErr.message);
    }

    res.json({ ref_link: refLink, total, active, bonuses, recent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
