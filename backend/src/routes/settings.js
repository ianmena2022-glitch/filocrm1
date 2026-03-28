const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');
const wpp    = require('../services/whatsapp');

// GET /api/settings
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, phone, city, address, calendly_url,
              service_radius_km, churn_days, wpp_connected, logo_url, msg_templates, booking_slug
       FROM shops WHERE id=$1`,
      [req.shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Shop no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/settings
router.put('/', auth, async (req, res) => {
  const { name, phone, city, address, calendly_url, service_radius_km, churn_days, msg_templates } = req.body;

    // Auto-generar booking_slug si no existe
    const existingSlug = await pool.query('SELECT booking_slug FROM shops WHERE id=$1', [req.shopId]);
    let slug = existingSlug.rows[0]?.booking_slug;
    if (!slug && name) {
      slug = name.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) + '-' + req.shopId;
      await pool.query('UPDATE shops SET booking_slug=$1 WHERE id=$2', [slug, req.shopId]);
    }
  try {
    const result = await pool.query(
      `UPDATE shops SET
         name=$1, phone=$2, city=$3, address=$4,
         calendly_url=$5, service_radius_km=$6, churn_days=$7, msg_templates=$8
       WHERE id=$9
       RETURNING id, name, email, phone, city, address, calendly_url,
                 service_radius_km, churn_days, wpp_connected, msg_templates`,
      [name, phone||null, city||null, address||null,
       calendly_url||null, service_radius_km||3, churn_days||20, msg_templates||null, req.shopId]
    );
    res.json({ ok: true, shop: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SERVICIOS ─────────────────────────────────────────

// GET /api/settings/services
router.get('/services', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM services WHERE shop_id=$1 AND active=TRUE ORDER BY name',
      [req.shopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/settings/services
router.post('/services', auth, async (req, res) => {
  const { name, price, cost, duration_minutes } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Nombre y precio son requeridos' });
  try {
    const result = await pool.query(
      `INSERT INTO services (shop_id, name, price, cost, duration_minutes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.shopId, name.trim(), parseFloat(price), parseFloat(cost||0), parseInt(duration_minutes||30)]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/settings/services/:id
router.delete('/services/:id', auth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE services SET active=FALSE WHERE id=$1 AND shop_id=$2',
      [req.params.id, req.shopId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WHATSAPP ──────────────────────────────────────────

// POST /api/settings/whatsapp/connect
router.post('/whatsapp/connect', auth, async (req, res) => {
  try {
    const data = await wpp.startSession(req.shopId);

    // WPPConnect devuelve el QR como base64 o como URL
    if (data.qrcode) {
      // Puede venir como "data:image/png;base64,..." o solo el base64
      const qr = data.qrcode.startsWith('data:')
        ? data.qrcode
        : `data:image/png;base64,${data.qrcode}`;
      return res.json({ ok: true, qr });
    }

    if (data.status === 'CONNECTED') {
      await pool.query('UPDATE shops SET wpp_connected=TRUE WHERE id=$1', [req.shopId]);
      return res.json({ ok: true, connected: true });
    }

    res.json({ ok: false, error: 'No se pudo iniciar sesión de WhatsApp', raw: data });
  } catch (e) {
    console.error('WPP connect error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/settings/whatsapp/status
router.get('/whatsapp/status', auth, async (req, res) => {
  try {
    const status = await wpp.getStatus(req.shopId);
    if (status.connected) {
      await pool.query('UPDATE shops SET wpp_connected=TRUE WHERE id=$1', [req.shopId]);
    }
    res.json(status);
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

module.exports = router;
