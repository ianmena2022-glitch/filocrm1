const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// Helper: mensaje paso a paso para pago de membresía
function buildPaymentMsg(clientName, price, alias, planName) {
  return `Hola ${clientName}! Para activar tu membresía${planName ? ` (${planName})` : ''} en FILO:\n\n1️⃣ Transferí $${price} al alias: *${alias}*\n2️⃣ Mandá el comprobante por este chat\n\nUna vez verificado el pago, tus créditos quedan activos. ¡Gracias!`;
}

// GET /api/memberships
router.get('/', auth, async (req, res) => {
  try {
    const isEnterprise = req.isEnterpriseOwner || false;
    const shopFilter = isEnterprise
      ? `(m.shop_id=$1 OR m.shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id=$1 AND is_branch=TRUE))`
      : `m.shop_id=$1`;
    const result = await pool.query(
      `SELECT m.*, c.name AS client_name, c.phone AS client_phone,
         m.credits_total - m.credits_used AS credits_remaining
       FROM memberships m
       JOIN clients c ON c.id = m.client_id
       WHERE ${shopFilter}
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
    const isEnterprise = req.isEnterpriseOwner || false;
    const shopFilter = isEnterprise
      ? `(shop_id=$1 OR shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id=$1 AND is_branch=TRUE))`
      : `shop_id=$1`;
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE active=TRUE)                   AS active_total,
         COUNT(*) FILTER (WHERE active=TRUE AND plan='basic')  AS basic_active,
         COUNT(*) FILTER (WHERE active=TRUE AND plan='premium') AS premium_active,
         COALESCE(SUM(price_monthly) FILTER (WHERE active=TRUE), 0) AS mrr
       FROM memberships WHERE ${shopFilter}`,
      [req.shopId]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/memberships
router.post('/', auth, async (req, res) => {
  const { client_id, plan, price_monthly, credits_total } = req.body;
  if (!client_id || !plan) return res.status(400).json({ error: 'Cliente y plan son requeridos' });

  try {
    // Cancelar membresía activa previa del mismo cliente
    await pool.query(
      `UPDATE memberships SET active=FALSE, cancelled_at=NOW()
       WHERE client_id=$1 AND shop_id=$2 AND active=TRUE`,
      [client_id, req.shopId]
    );

    // Usar créditos configurados por el dueño, o defaults si no se especifican
    let credits;
    if (credits_total !== undefined && credits_total !== null) {
      credits = parseInt(credits_total);
    } else {
      const shopData = await pool.query('SELECT membership_plans FROM shops WHERE id=$1', [req.shopId]);
      const plans = shopData.rows[0]?.membership_plans ? JSON.parse(shopData.rows[0].membership_plans) : {};
      const planConfig = plans[plan];
      credits = planConfig?.credits !== undefined ? parseInt(planConfig.credits) : (plan === 'basic' ? 2 : 999);
    }
    const renews = new Date();
    renews.setMonth(renews.getMonth() + 1);

    const result = await pool.query(
      `INSERT INTO memberships (shop_id, client_id, plan, price_monthly, credits_total, renews_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.shopId, client_id, plan, parseFloat(price_monthly||0), credits, renews.toISOString().split('T')[0]]
    );
    const membership = result.rows[0];

    await pool.query(`UPDATE clients SET notes = COALESCE(notes,'') WHERE id=$1`, [client_id]);

    // Enviar instrucciones de pago por WhatsApp
    try {
      const shopData = await pool.query(
        'SELECT name, sena_cbu, wpp_connected FROM shops WHERE id=$1',
        [req.shopId]
      );
      const shop = shopData.rows[0];
      const clientData = await pool.query('SELECT name, phone FROM clients WHERE id=$1', [client_id]);
      const client = clientData.rows[0];

      if (shop?.wpp_connected && shop?.sena_cbu && client?.phone) {
        const { generateMessage } = require('../services/ai');
        const { sendText } = require('../services/whatsapp');
        const price = parseFloat(price_monthly || 0);

        let msg = await generateMessage(req.shopId, 'membresia_bienvenida', {
          clientName: client.name,
          shopName: shop.name,
          planName: plan,
          credits,
          price,
          alias: shop.sena_cbu,
        });
        if (!msg) msg = buildPaymentMsg(client.name, price, shop.sena_cbu, plan);

        await sendText(req.shopId, client.phone, msg);
      }
    } catch (wppErr) {
      console.error('[memberships] Error enviando WPP bienvenida:', wppErr.message);
    }

    res.status(201).json(membership);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/memberships/:id/mark-paid — marcar pago manual recibido
router.put('/:id/mark-paid', auth, async (req, res) => {
  try {
    const renews = new Date();
    renews.setMonth(renews.getMonth() + 1);

    const memRes = await pool.query(
      `UPDATE memberships
       SET payment_status='paid', last_payment_at=NOW(),
           active=TRUE, credits_used=0, renews_at=$1,
           comprobante_status=COALESCE(comprobante_status, 'verified')
       WHERE id=$2 AND shop_id=$3
       RETURNING *, (SELECT name FROM clients WHERE id=memberships.client_id) AS client_name,
                    (SELECT phone FROM clients WHERE id=memberships.client_id) AS client_phone`,
      [renews.toISOString().split('T')[0], req.params.id, req.shopId]
    );
    if (!memRes.rows.length) return res.status(404).json({ error: 'Membresía no encontrada' });
    const m = memRes.rows[0];

    // Notificar al cliente
    try {
      const shopData = await pool.query('SELECT name, sena_cbu, wpp_connected FROM shops WHERE id=$1', [req.shopId]);
      const shop = shopData.rows[0];
      if (shop?.wpp_connected && m.client_phone) {
        const { generateMessage } = require('../services/ai');
        const { sendText } = require('../services/whatsapp');
        const fechaVencimiento = renews.toLocaleDateString('es-AR', { day: 'numeric', month: 'long' });
        let msg = await generateMessage(req.shopId, 'membresia_pago_confirmado', {
          clientName: m.client_name,
          shopName: shop.name,
          credits: m.credits_total,
          fechaVencimiento,
        });
        if (!msg) msg = `✅ Pago confirmado, ${m.client_name}. Tu membresía está activa con ${m.credits_total} créditos hasta el ${fechaVencimiento}.`;
        await sendText(req.shopId, m.client_phone, msg);
      }
    } catch (wppErr) {
      console.error('[memberships] Error enviando WPP pago confirmado:', wppErr.message);
    }

    res.json(m);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/memberships/:id/send-reminder — enviar recordatorio de pago
router.post('/:id/send-reminder', auth, async (req, res) => {
  try {
    const memRes = await pool.query(
      `SELECT m.*, c.name AS client_name, c.phone AS client_phone
       FROM memberships m JOIN clients c ON c.id = m.client_id
       WHERE m.id=$1 AND m.shop_id=$2`,
      [req.params.id, req.shopId]
    );
    if (!memRes.rows.length) return res.status(404).json({ error: 'Membresía no encontrada' });
    const m = memRes.rows[0];

    const shopData = await pool.query('SELECT name, sena_cbu, wpp_connected FROM shops WHERE id=$1', [req.shopId]);
    const shop = shopData.rows[0];
    if (!shop?.wpp_connected) return res.status(400).json({ error: 'WhatsApp no conectado' });
    if (!m.client_phone) return res.status(400).json({ error: 'El cliente no tiene teléfono' });

    const { generateMessage } = require('../services/ai');
    const { sendText } = require('../services/whatsapp');
    const fechaVencimiento = m.renews_at
      ? new Date(m.renews_at).toLocaleDateString('es-AR', { day: 'numeric', month: 'long' })
      : 'próximamente';

    let msg = await generateMessage(req.shopId, 'membresia_recordatorio', {
      clientName: m.client_name,
      shopName: shop.name,
      fechaVencimiento,
      price: parseFloat(m.price_monthly || 0),
      alias: shop.sena_cbu || '',
    });
    if (!msg) msg = buildPaymentMsg(m.client_name, parseFloat(m.price_monthly || 0), shop.sena_cbu || '', m.plan);

    await sendText(req.shopId, m.client_phone, msg);
    res.json({ ok: true });
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

    await pool.query('UPDATE memberships SET credits_used = credits_used + 1 WHERE id=$1', [req.params.id]);

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
