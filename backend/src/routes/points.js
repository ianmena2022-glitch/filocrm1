const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// ── TIENDA ────────────────────────────────────────────

// GET /api/points/store — items de la tienda (auth requerida para dueño)
router.get('/store', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM points_store WHERE shop_id=$1 AND active=TRUE ORDER BY points_cost',
      [req.shopId]
    );
    // Si no hay items, crear defaults
    if (!result.rows.length) {
      const defaults = [
        { name: 'Lavado gratis', description: 'Un lavado de cabello sin costo en tu próxima visita', points_cost: 300 },
        { name: 'Descuento $1000', description: '$1000 de descuento en cualquier servicio', points_cost: 500 },
        { name: 'Corte gratis', description: 'Un corte de cabello completamente gratis', points_cost: 1000 },
        { name: 'Café o bebida', description: 'Una bebida de cortesía durante tu turno', points_cost: 150 },
      ];
      for (const d of defaults) {
        await pool.query(
          'INSERT INTO points_store (shop_id, name, description, points_cost) VALUES ($1,$2,$3,$4)',
          [req.shopId, d.name, d.description, d.points_cost]
        );
      }
      const fresh = await pool.query(
        'SELECT * FROM points_store WHERE shop_id=$1 AND active=TRUE ORDER BY points_cost',
        [req.shopId]
      );
      return res.json(fresh.rows);
    }
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/points/store/public/:slug — tienda pública para clientes
router.get('/store/public/:slug', async (req, res) => {
  try {
    const shop = await pool.query(
      'SELECT id, name, store_name, city FROM shops WHERE booking_slug=$1',
      [req.params.slug]
    );
    if (!shop.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    const shopData = shop.rows[0];

    const items = await pool.query(
      'SELECT * FROM points_store WHERE shop_id=$1 AND active=TRUE ORDER BY points_cost',
      [shopData.id]
    );
    res.json({ shop: shopData, items: items.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/points/store — crear item
router.post('/store', auth, async (req, res) => {
  const { name, description, points_cost, stock } = req.body;
  if (!name || !points_cost) return res.status(400).json({ error: 'Nombre y costo en puntos requeridos' });
  try {
    const stockVal = stock !== undefined && stock !== '' ? parseInt(stock) : null;
    const result = await pool.query(
      'INSERT INTO points_store (shop_id, name, description, points_cost, stock) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.shopId, name.trim(), description||null, parseInt(points_cost), stockVal]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/points/store/:id — editar item
router.put('/store/:id', auth, async (req, res) => {
  const { name, description, points_cost, stock } = req.body;
  try {
    const stockVal = stock !== undefined && stock !== '' ? parseInt(stock) : null;
    const result = await pool.query(
      `UPDATE points_store SET name=$1, description=$2, points_cost=$3, stock=$4
       WHERE id=$5 AND shop_id=$6 RETURNING *`,
      [name, description||null, parseInt(points_cost), stockVal, req.params.id, req.shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Item no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/points/store/:id — desactivar item
router.delete('/store/:id', auth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE points_store SET active=FALSE WHERE id=$1 AND shop_id=$2',
      [req.params.id, req.shopId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BALANCE DE CLIENTE ─────────────────────────────────

// GET /api/points/client/:clientId — balance y canjes de un cliente
router.get('/client/:clientId', auth, async (req, res) => {
  try {
    const client = await pool.query(
      'SELECT id, name, phone, points FROM clients WHERE id=$1 AND shop_id=$2',
      [req.params.clientId, req.shopId]
    );
    if (!client.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });

    const redemptions = await pool.query(
      `SELECT r.*, ps.name AS store_item_name
       FROM points_redemptions r
       LEFT JOIN points_store ps ON ps.id = r.item_id
       WHERE r.client_id=$1 AND r.shop_id=$2
       ORDER BY r.created_at DESC LIMIT 10`,
      [req.params.clientId, req.shopId]
    );

    res.json({ client: client.rows[0], redemptions: redemptions.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CANJES ─────────────────────────────────────────────

// POST /api/points/redeem — canjear puntos (el barbero lo hace por el cliente)
router.post('/redeem', auth, async (req, res) => {
  const { client_id, item_id } = req.body;
  if (!client_id || !item_id) return res.status(400).json({ error: 'Cliente e item requeridos' });

  try {
    const item = await pool.query(
      'SELECT * FROM points_store WHERE id=$1 AND shop_id=$2 AND active=TRUE',
      [item_id, req.shopId]
    );
    if (!item.rows.length) return res.status(404).json({ error: 'Item no encontrado' });

    const client = await pool.query(
      'SELECT id, name, points FROM clients WHERE id=$1 AND shop_id=$2',
      [client_id, req.shopId]
    );
    if (!client.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });

    const c = client.rows[0];
    const it = item.rows[0];

    if (c.points < it.points_cost) {
      return res.status(400).json({
        error: `Le faltan ${it.points_cost - c.points} puntos para canjear este premio`
      });
    }

    // Verificar stock disponible (NULL = ilimitado)
    if (it.stock !== null && it.stock !== undefined && it.stock <= 0) {
      return res.status(400).json({ error: 'Premio sin stock disponible' });
    }

    // Descontar puntos atómicamente (WHERE points >= cost evita puntos negativos por race condition)
    const deducted = await pool.query(
      'UPDATE clients SET points = points - $1 WHERE id=$2 AND shop_id=$3 AND points >= $1 RETURNING points',
      [it.points_cost, client_id, req.shopId]
    );
    if (!deducted.rows.length) {
      return res.status(400).json({ error: 'Puntos insuficientes (verificación concurrente fallida)' });
    }
    const newPoints = deducted.rows[0].points;

    // Decrementar stock si tiene límite (atómico, no llega a negativo)
    if (it.stock !== null && it.stock !== undefined) {
      await pool.query(
        'UPDATE points_store SET stock = stock - 1 WHERE id=$1 AND shop_id=$2 AND stock > 0',
        [it.id, req.shopId]
      );
    }

    // Registrar canje
    const redemption = await pool.query(
      `INSERT INTO points_redemptions (shop_id, client_id, item_id, item_name, points_used, status)
       VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *`,
      [req.shopId, client_id, item_id, it.name, it.points_cost]
    );

    res.json({
      ok: true,
      message: `✅ ${it.name} canjeado. Le quedan ${newPoints} puntos.`,
      new_points: newPoints,
      redemption: redemption.rows[0]
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/points/redeem/:id/use — marcar canje como usado
router.put('/redeem/:id/use', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE points_redemptions SET status='used' WHERE id=$1 AND shop_id=$2`,
      [req.params.id, req.shopId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CONFIG PUNTOS ──────────────────────────────────────

// PUT /api/points/config — configurar tienda y ratio
router.put('/config', auth, async (req, res) => {
  const { store_name, points_per_peso } = req.body;
  try {
    await pool.query(
      'UPDATE shops SET store_name=$1, points_per_peso=$2 WHERE id=$3',
      [store_name || 'Tienda FILO', parseFloat(points_per_peso) || 0.01, req.shopId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/points/config
router.get('/config', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT store_name, points_per_peso, booking_slug FROM shops WHERE id=$1',
      [req.shopId]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/points/client/phone/:slug/:phone — consulta pública por teléfono
router.get('/client/phone/:slug/:phone', async (req, res) => {
  try {
    const shop = await pool.query(
      'SELECT id FROM shops WHERE booking_slug=$1', [req.params.slug]
    );
    if (!shop.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });

    // Sanitizar teléfono: solo dígitos, últimos 8, con LIMIT para evitar enumeración
    const rawPhone = req.params.phone.replace(/\D/g, '').slice(-8);
    if (rawPhone.length < 6) return res.json({ client: null });

    const client = await pool.query(
      'SELECT id, name, points FROM clients WHERE shop_id=$1 AND phone LIKE $2 LIMIT 1',
      [shop.rows[0].id, '%' + rawPhone]
    );
    if (!client.rows.length) return res.json({ client: null });
    res.json({ client: client.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
