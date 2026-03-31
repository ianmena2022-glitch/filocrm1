const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// GET /api/clients
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*,
         m.plan  AS membership_plan,
         m.active AS membership_active
       FROM clients c
       LEFT JOIN memberships m ON m.client_id = c.id AND m.active = TRUE
       WHERE c.shop_id = $1
       ORDER BY c.name`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/clients/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const client = await pool.query(
      'SELECT * FROM clients WHERE id=$1 AND shop_id=$2',
      [req.params.id, req.shopId]
    );
    if (!client.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });

    const history = await pool.query(
      `SELECT * FROM appointments WHERE client_id=$1 AND shop_id=$2 ORDER BY date DESC, time_start DESC LIMIT 20`,
      [req.params.id, req.shopId]
    );
    res.json({ ...client.rows[0], history: history.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/clients
router.post('/', auth, async (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });

  try {
    const result = await pool.query(
      'INSERT INTO clients (shop_id, name, phone, notes) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.shopId, name.trim(), phone?.trim() || null, notes?.trim() || null]
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
    // Modo referido: solo sumar puntos sin tocar otros campos
    if (_add_points !== undefined) {
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
    const result = await pool.query(
      `UPDATE clients SET name=$1, phone=$2, notes=$3 WHERE id=$4 AND shop_id=$5 RETURNING *`,
      [name, phone || null, notes || null, req.params.id, req.shopId]
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
