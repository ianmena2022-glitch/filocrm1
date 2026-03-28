const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// GET /api/memberships
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, c.name AS client_name, c.phone AS client_phone,
         m.credits_total - m.credits_used AS credits_remaining
       FROM memberships m
       JOIN clients c ON c.id = m.client_id
       WHERE m.shop_id=$1
       ORDER BY m.active DESC, m.created_at DESC`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/memberships/stats
router.get('/stats', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE active=TRUE)                   AS active_total,
         COUNT(*) FILTER (WHERE active=TRUE AND plan='basic')  AS basic_active,
         COUNT(*) FILTER (WHERE active=TRUE AND plan='premium') AS premium_active,
         COALESCE(SUM(price_monthly) FILTER (WHERE active=TRUE), 0) AS mrr
       FROM memberships WHERE shop_id=$1`,
      [req.shopId]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/memberships
router.post('/', auth, async (req, res) => {
  const { client_id, plan, price_monthly } = req.body;
  if (!client_id || !plan) return res.status(400).json({ error: 'Cliente y plan son requeridos' });

  try {
    // Cancelar membresía activa previa del mismo cliente
    await pool.query(
      `UPDATE memberships SET active=FALSE, cancelled_at=NOW()
       WHERE client_id=$1 AND shop_id=$2 AND active=TRUE`,
      [client_id, req.shopId]
    );

    const credits = plan === 'basic' ? 2 : 999;
    const renews  = new Date();
    renews.setMonth(renews.getMonth() + 1);

    const result = await pool.query(
      `INSERT INTO memberships (shop_id, client_id, plan, price_monthly, credits_total, renews_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.shopId, client_id, plan, parseFloat(price_monthly||0), credits, renews.toISOString().split('T')[0]]
    );

    // Marcar cliente como miembro
    await pool.query(
      `UPDATE clients SET notes = COALESCE(notes,'') WHERE id=$1`,
      [client_id]
    );

    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/memberships/:id/checkin
router.post('/:id/checkin', auth, async (req, res) => {
  try {
    const memb = await pool.query(
      'SELECT * FROM memberships WHERE id=$1 AND shop_id=$2 AND active=TRUE',
      [req.params.id, req.shopId]
    );
    if (!memb.rows.length) return res.status(404).json({ error: 'Membresía no encontrada o inactiva' });
    const m = memb.rows[0];

    if (m.plan === 'basic' && m.credits_used >= m.credits_total) {
      return res.status(400).json({ error: 'Sin créditos disponibles este mes' });
    }

    await pool.query(
      'UPDATE memberships SET credits_used = credits_used + 1 WHERE id=$1',
      [req.params.id]
    );

    const remaining = m.plan === 'premium' ? '∞' : m.credits_total - m.credits_used - 1;
    res.json({ ok: true, message: `Check-in registrado. Créditos restantes: ${remaining}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/memberships/:id/cancel
router.put('/:id/cancel', auth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE memberships SET active=FALSE, cancelled_at=NOW() WHERE id=$1 AND shop_id=$2',
      [req.params.id, req.shopId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
