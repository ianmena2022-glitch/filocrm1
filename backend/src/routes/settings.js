const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');
const wpp    = require('../services/whatsapp');

// GET /api/settings
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, phone, city, address, calendly_url,
              service_radius_km, churn_days, wpp_connected, logo_url, msg_templates, booking_slug, membership_plans, schedule
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
  const { name, phone, city, address, service_radius_km, churn_days, msg_templates, commission_enabled, membership_plans, filo_plan, schedule } = req.body;

  try {
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

    // Asegurar slug actualizado en el mismo UPDATE
    const result = await pool.query(
      `UPDATE shops SET
         name=COALESCE($1, name),
         phone=COALESCE($2, phone),
         city=COALESCE($3, city),
         address=COALESCE($4, address),
         service_radius_km=COALESCE($5, service_radius_km),
         churn_days=COALESCE($6, churn_days),
         msg_templates=COALESCE($7, msg_templates),
         booking_slug=COALESCE(booking_slug, $8),
         commission_enabled=COALESCE($9, commission_enabled),
         membership_plans=COALESCE($10, membership_plans),
         filo_plan=COALESCE($11, filo_plan),
         schedule=COALESCE($12, schedule)
       WHERE id=$13
       RETURNING id, name, email, phone, city, address,
                 service_radius_km, churn_days, wpp_connected, msg_templates, booking_slug, commission_enabled, membership_plans, schedule`,
      [name||null, phone||null, city||null, address||null,
       service_radius_km||null, churn_days||null, msg_templates||null,
       slug, commission_enabled !== undefined ? commission_enabled : null,
       membership_plans||null, filo_plan||null, schedule||null, req.shopId]
    );
    res.json({ ok: true, shop: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SERVICIOS ─────────────────────────────────────────

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

// PUT /api/settings/services/:id — editar servicio
router.put('/services/:id', auth, async (req, res) => {
  const { name, price, cost, duration_minutes } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Nombre y precio son requeridos' });
  try {
    const result = await pool.query(
      `UPDATE services SET name=$1, price=$2, cost=$3, duration_minutes=$4
       WHERE id=$5 AND shop_id=$6 RETURNING *`,
      [name.trim(), parseFloat(price), parseFloat(cost||0), parseInt(duration_minutes||30), req.params.id, req.shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// POST /api/settings/whatsapp/reset — reconexión limpia
router.post('/whatsapp/reset', auth, async (req, res) => {
  try {
    await wpp.clearSession(req.shopId);
    console.log(`[WPP] Reset limpio para shop ${req.shopId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('WPP reset error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/whatsapp/connect', auth, async (req, res) => {
  try {
    const data = await wpp.startSession(req.shopId);

    if (data.status === 'CONNECTED') {
      await pool.query('UPDATE shops SET wpp_connected=TRUE WHERE id=$1', [req.shopId]);
      return res.json({ ok: true, connected: true });
    }

    if (data.qrcode) {
      const qrRaw = data.qrcode;
      let qrImage;

      // Si ya es base64 de imagen, usarlo directo
      if (qrRaw.startsWith('data:image')) {
        qrImage = qrRaw;
      } else {
        // Convertir QR raw a PNG base64 usando librería qrcode
        try {
          const QRCode = require('qrcode');
          qrImage = await QRCode.toDataURL(qrRaw, {
            width: 256,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
          });
        } catch (qrErr) {
          console.error('QR conversion error:', qrErr.message);
          // Devolver el raw y que el frontend lo maneje
          qrImage = qrRaw;
        }
      }

      return res.json({ ok: true, qr: qrImage });
    }

    res.json({ ok: false, error: 'No se pudo obtener el QR de WhatsApp' });
  } catch (e) {
    console.error('WPP connect error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/settings/generate-slug — forzar generación de slug si no existe
router.post('/generate-slug', auth, async (req, res) => {
  try {
    const existing = await pool.query('SELECT booking_slug, name FROM shops WHERE id=$1', [req.shopId]);
    const shop = existing.rows[0];
    if (shop.booking_slug) return res.json({ slug: shop.booking_slug });
    
    const slug = (shop.name || 'barberia')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) + '-' + req.shopId;

    await pool.query('UPDATE shops SET booking_slug=$1 WHERE id=$2', [slug, req.shopId]);
    res.json({ slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/settings/plan — cambiar plan (solo cuentas test)
router.put('/plan', auth, async (req, res) => {
  const { plan } = req.body;
  const validPlans = ['starter', 'staff', 'enterprise', 'test'];
  if (!validPlans.includes(plan)) return res.status(400).json({ error: 'Plan inválido' });

  try {
    // Solo cuentas test pueden cambiar de plan (verificar is_test, no el plan actual)
    const shop = await pool.query('SELECT is_test FROM shops WHERE id=$1', [req.shopId]);
    if (!shop.rows[0]?.is_test) {
      return res.status(403).json({ error: 'Solo las cuentas de testing pueden cambiar de plan' });
    }
    await pool.query('UPDATE shops SET plan=$1, filo_plan=$1 WHERE id=$2', [plan, req.shopId]);
    res.json({ ok: true, plan });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/settings/whatsapp/pairing-code
router.post('/whatsapp/pairing-code', auth, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Número requerido' });
  try {
    const result = await wpp.requestPairingCode(req.shopId, phone);
    res.json(result);
  } catch (e) {
    console.error('Pairing code error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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
