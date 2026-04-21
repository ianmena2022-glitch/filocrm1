const router = require('express').Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

// Default methods seeded for new shops
const DEFAULT_METHODS = [
  { key: 'cash',     label: 'Efectivo',      icon: '💵', is_debt: false, sort_order: 0 },
  { key: 'debit',    label: 'Débito',         icon: '💳', is_debt: false, sort_order: 1 },
  { key: 'credit',   label: 'Crédito',        icon: '💳', is_debt: false, sort_order: 2 },
  { key: 'transfer', label: 'Transferencia',  icon: '📲', is_debt: false, sort_order: 3 },
  { key: 'debt',     label: 'Fiado',          icon: '📋', is_debt: true,  sort_order: 4 },
];

// Seed defaults if shop has no methods
async function seedDefaults(shopId) {
  const existing = await pool.query('SELECT id FROM payment_methods WHERE shop_id=$1', [shopId]);
  if (existing.rows.length === 0) {
    for (const m of DEFAULT_METHODS) {
      await pool.query(
        'INSERT INTO payment_methods (shop_id, key, label, icon, is_debt, sort_order) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [shopId, m.key, m.label, m.icon, m.is_debt, m.sort_order]
      );
    }
  }
}

// GET /api/payment-methods — list all methods for this shop
// Los barberos usan los métodos del shop padre (dueño)
router.get('/', auth, async (req, res) => {
  const shopId = (req.isBarber && req.parentShopId) ? req.parentShopId : req.shopId;
  try {
    await seedDefaults(shopId);
    const result = await pool.query(
      'SELECT * FROM payment_methods WHERE shop_id=$1 AND active=TRUE ORDER BY sort_order, id',
      [shopId]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/payment-methods — create new method
router.post('/', auth, async (req, res) => {
  try {
    const { label, icon, is_debt } = req.body;
    if (!label?.trim()) return res.status(400).json({ error: 'label es requerido' });
    // Generate key from label
    const key = label.trim().toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').slice(0, 50);
    const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order),0) as m FROM payment_methods WHERE shop_id=$1', [req.shopId]);
    const sortOrder = (parseInt(maxOrder.rows[0]?.m) || 0) + 1;
    const result = await pool.query(
      'INSERT INTO payment_methods (shop_id, key, label, icon, is_debt, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.shopId, key, label.trim(), icon || '💳', is_debt || false, sortOrder]
    );
    res.status(201).json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/payment-methods/:id — update label/icon/is_debt
router.put('/:id', auth, async (req, res) => {
  try {
    const { label, icon, is_debt } = req.body;
    if (!label?.trim()) return res.status(400).json({ error: 'label es requerido' });
    const result = await pool.query(
      'UPDATE payment_methods SET label=$1, icon=$2, is_debt=$3 WHERE id=$4 AND shop_id=$5 RETURNING *',
      [label.trim(), icon || '💳', is_debt || false, req.params.id, req.shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/payment-methods/:id — soft delete if used, hard delete otherwise
router.delete('/:id', auth, async (req, res) => {
  try {
    const usage = await pool.query(
      `SELECT COUNT(*) FROM appointments WHERE shop_id=$1 AND payment_method=(SELECT key FROM payment_methods WHERE id=$2 AND shop_id=$1)`,
      [req.shopId, req.params.id]
    );
    if (parseInt(usage.rows[0].count) > 0) {
      // Soft delete — just deactivate
      await pool.query('UPDATE payment_methods SET active=FALSE WHERE id=$1 AND shop_id=$2', [req.params.id, req.shopId]);
    } else {
      await pool.query('DELETE FROM payment_methods WHERE id=$1 AND shop_id=$2', [req.params.id, req.shopId]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
