const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// GET /api/clients
router.get('/', auth, async (req, res) => {
  try {
    const effectiveShopId = req.parentShopId || req.shopId;
    const isEnterprise = req.isEnterpriseOwner || false;
    const shopFilter = isEnterprise
      ? `(c.shop_id = $1 OR c.shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id = $1 AND is_branch = TRUE))`
      : `c.shop_id = $1`;
    const result = await pool.query(
      `SELECT c.*,
         m.plan  AS membership_plan,
         m.active AS membership_active
       FROM clients c
       LEFT JOIN memberships m ON m.client_id = c.id AND m.active = TRUE
       WHERE ${shopFilter}
       ORDER BY c.name`,
      [effectiveShopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/clients/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const isEnterprise = req.isEnterpriseOwner || false;
    const ownerFilter = isEnterprise
      ? `(shop_id=$2 OR shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id=$2 AND is_branch=TRUE))`
      : `shop_id=$2`;
    const client = await pool.query(
      `SELECT * FROM clients WHERE id=$1 AND ${ownerFilter}`,
      [req.params.id, req.shopId]
    );
    if (!client.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });

    const history = await pool.query(
      `SELECT * FROM appointments WHERE client_id=$1 AND ${ownerFilter} ORDER BY date DESC, time_start DESC LIMIT 20`,
      [req.params.id, req.shopId]
    );
    res.json({ ...client.rows[0], history: history.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/clients
router.post('/', auth, async (req, res) => {
  const { name, phone, notes, address } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });

  try {
    const result = await pool.query(
      'INSERT INTO clients (shop_id, name, phone, notes, address) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.shopId, name.trim(), phone?.trim() || null, notes?.trim() || null, address?.trim() || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/clients/:id
router.put('/:id', auth, async (req, res) => {
  const { name, phone, notes, _add_points, _note } = req.body;
  try {
    // Modo referido: solo sumar puntos sin tocar otros campos (solo dueños, no barberos)
    if (_add_points !== undefined) {
      if (req.isBarber) return res.status(403).json({ error: 'No autorizado' });
      const pts = parseInt(_add_points) || 0;
      const result = await pool.query(
        `UPDATE clients SET points = points + $1 WHERE id=$2 AND shop_id=$3 RETURNING *`,
        [pts, req.params.id, req.shopId]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
      console.log(`[REFERIDO] +${pts} puntos a cliente ${req.params.id} — ${_note || ''}`);
      return res.json(result.rows[0]);
    }

    // Modo edición normal
    const { address } = req.body;
    const result = await pool.query(
      `UPDATE clients SET name=$1, phone=$2, notes=$3, address=$4 WHERE id=$5 AND shop_id=$6 RETURNING *`,
      [name, phone || null, notes || null, address || null, req.params.id, req.shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/clients/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM clients WHERE id=$1 AND shop_id=$2 RETURNING id',
      [req.params.id, req.shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
