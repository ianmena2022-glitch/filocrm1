const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// Crear columnas si no existen (primera vez)
async function ensureColumns() {
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS referred_by_shop_id INT REFERENCES shops(id) ON DELETE SET NULL`).catch(() => {});
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS ref_bonus_granted BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS free_months INT DEFAULT 0`).catch(() => {});
}
ensureColumns();

// GET /api/referrals — stats + link + free_months disponibles
router.get('/', auth, async (req, res) => {
  try {
    const shopRes = await pool.query('SELECT booking_slug, name, free_months FROM shops WHERE id=$1', [req.shopId]);
    const shop    = shopRes.rows[0];
    const refSlug = shop?.booking_slug || String(req.shopId);
    const refLink = `https://filocrm.com.ar/app?ref=${refSlug}`;

    let total = 0, active = 0, bonuses = 0, recent = [];
    try {
      const statsRes = await pool.query(
        `SELECT
           COUNT(*)                                                           AS total,
           COUNT(*) FILTER (WHERE subscription_status IN ('active','trial')) AS active,
           COUNT(*) FILTER (WHERE ref_bonus_granted = TRUE)                  AS bonuses_granted
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
      console.warn('[referrals] stats query failed:', statsErr.message);
    }

    res.json({
      ref_link:    refLink,
      total,
      active,
      bonuses,
      recent,
      free_months: parseInt(shop?.free_months) || 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/referrals/redeem — canjear un mes gratis
router.post('/redeem', auth, async (req, res) => {
  try {
    // Verificar que tenga meses disponibles
    const shopRes = await pool.query(
      'SELECT id, free_months, subscription_status, trial_ends_at FROM shops WHERE id=$1',
      [req.shopId]
    );
    const shop = shopRes.rows[0];
    if (!shop) return res.status(404).json({ error: 'Shop no encontrado' });

    const freeMonths = parseInt(shop.free_months) || 0;
    if (freeMonths <= 0) return res.status(400).json({ error: 'No tenés meses gratis disponibles' });

    // Extender acceso 30 días desde hoy (o desde trial_ends_at si está en el futuro)
    const base = shop.trial_ends_at && new Date(shop.trial_ends_at) > new Date()
      ? new Date(shop.trial_ends_at)
      : new Date();
    base.setDate(base.getDate() + 30);

    // Actualizar: restar 1 mes gratis, extender trial, asegurar status = trial
    await pool.query(
      `UPDATE shops SET
         free_months       = free_months - 1,
         trial_ends_at     = $1,
         subscription_status = CASE
           WHEN subscription_status IN ('expired','cancelled') THEN 'trial'
           ELSE subscription_status
         END
       WHERE id = $2`,
      [base.toISOString(), req.shopId]
    );

    const updated = await pool.query(
      'SELECT id, name, subscription_status, trial_ends_at, free_months, filo_plan, plan, is_barber, is_branch, is_enterprise_owner, parent_shop_id, parent_enterprise_id FROM shops WHERE id=$1',
      [req.shopId]
    );

    console.log(`[REFERRALS] Shop ${req.shopId} canjeó 1 mes gratis. Quedan ${freeMonths - 1}. Acceso hasta ${base.toDateString()}`);
    res.json({ ok: true, shop: updated.rows[0], free_months_left: freeMonths - 1 });
  } catch (e) {
    console.error('[referrals/redeem]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Función exportable: otorgar mes gratis al referidor cuando su referido paga
async function grantFreeMonthToReferrer(paidShopId) {
  try {
    const refQ = await pool.query(
      'SELECT referred_by_shop_id, ref_bonus_granted FROM shops WHERE id=$1',
      [paidShopId]
    );
    const s = refQ.rows[0];
    if (!s?.referred_by_shop_id || s.ref_bonus_granted) return; // ya otorgado o sin referidor

    await pool.query(
      'UPDATE shops SET free_months = COALESCE(free_months,0) + 1 WHERE id=$1',
      [s.referred_by_shop_id]
    );
    await pool.query(
      'UPDATE shops SET ref_bonus_granted = TRUE WHERE id=$1',
      [paidShopId]
    );
    console.log(`[REFERRALS] +1 mes gratis otorgado a shop ${s.referred_by_shop_id} por referido ${paidShopId}`);
  } catch (e) {
    console.error('[referrals] grantFreeMonthToReferrer error:', e.message);
  }
}

module.exports = router;
module.exports.grantFreeMonthToReferrer = grantFreeMonthToReferrer;
