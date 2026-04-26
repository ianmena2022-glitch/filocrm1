const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// GET /api/referrals — stats + link del shop actual
router.get('/', auth, async (req, res) => {
  try {
    // Obtener booking_slug propio para armar el link
    const shopRes = await pool.query('SELECT booking_slug, name FROM shops WHERE id=$1', [req.shopId]);
    const shop = shopRes.rows[0];
    const refSlug = shop?.booking_slug || String(req.shopId);

    // Contar referidos
    const statsRes = await pool.query(
      `SELECT
         COUNT(*)                                                        AS total,
         COUNT(*) FILTER (WHERE subscription_status IN ('active','trial')) AS active,
         COUNT(*) FILTER (WHERE ref_bonus_granted = TRUE)               AS bonuses_granted
       FROM shops WHERE referred_by_shop_id = $1`,
      [req.shopId]
    );
    const stats = statsRes.rows[0];

    // Referidos recientes
    const recentRes = await pool.query(
      `SELECT name, subscription_status, created_at
       FROM shops WHERE referred_by_shop_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [req.shopId]
    );

    res.json({
      ref_link: `https://filocrm.com.ar/app?ref=${refSlug}`,
      total:    parseInt(stats.total),
      active:   parseInt(stats.active),
      bonuses:  parseInt(stats.bonuses_granted),
      recent:   recentRes.rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
