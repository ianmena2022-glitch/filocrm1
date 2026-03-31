const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

const MP_BASE = 'https://api.mercadopago.com';
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;

async function mpFetch(method, path, body) {
  const res = await fetch(`${MP_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${MP_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': Date.now().toString()
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || 'Error Mercado Pago');
  return data;
}

// POST /api/payments/subscription — crear suscripción en MP y guardar en DB
router.post('/subscription', auth, async (req, res) => {
  const { membership_id, payer_email, plan_name, price_monthly } = req.body;
  if (!membership_id || !payer_email || !price_monthly) {
    return res.status(400).json({ error: 'membership_id, payer_email y price_monthly son requeridos' });
  }

  try {
    const appUrl = process.env.APP_URL || 'https://filocrm.com.ar';

    // Crear plan de suscripción en MP
    const plan = await mpFetch('POST', '/preapproval_plan', {
      reason: plan_name || 'Membresía FILO',
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: parseFloat(price_monthly),
        currency_id: 'ARS'
      },
      payment_methods_allowed: {
        payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }]
      },
      back_url: `${appUrl}/app`
    });

    // Crear suscripción para el pagador
    const subscription = await mpFetch('POST', '/preapproval', {
      preapproval_plan_id: plan.id,
      payer_email,
      reason: plan_name || 'Membresía FILO',
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: parseFloat(price_monthly),
        currency_id: 'ARS'
      },
      back_url: `${appUrl}/app`,
      notification_url: `${appUrl}/api/payments/webhook`
    });

    // Guardar en DB
    await pool.query(
      `UPDATE memberships SET
         mp_subscription_id = $1,
         mp_status = $2,
         payment_url = $3
       WHERE id = $4 AND shop_id = $5`,
      [subscription.id, subscription.status, subscription.init_point, membership_id, req.shopId]
    );

    // Enviar WhatsApp al cliente si tiene teléfono y el shop está conectado
    try {
      const membData = await pool.query(
        `SELECT c.phone, c.name, s.wpp_connected, s.name AS shop_name
         FROM memberships m
         JOIN clients c ON c.id = m.client_id
         JOIN shops s ON s.id = m.shop_id
         WHERE m.id = $1`,
        [membership_id]
      );
      const row = membData.rows[0];
      if (row?.phone && row?.wpp_connected) {
        const wpp = require('../services/whatsapp');
        const msg = `✂️ *${row.shop_name}* — Membresía

Hola ${row.name}! 👋

Tu membresía está lista. Para activarla hacé clic en el siguiente link y completá el pago:

🔗 ${subscription.init_point}

💳 Podés pagar con tarjeta de crédito o débito a través de Mercado Pago.

¡Gracias! 🙌`;
        await wpp.sendText(req.shopId, row.phone, msg);
        console.log(`[MP] WhatsApp enviado a ${row.phone}`);
      }
    } catch (wppErr) {
      console.error('[MP] Error enviando WhatsApp:', wppErr.message);
    }

    res.json({
      ok: true,
      subscription_id: subscription.id,
      payment_url: subscription.init_point,
      status: subscription.status
    });
  } catch (e) {
    console.error('MP subscription error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payments/webhook — MP notifica cambios de estado
router.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log(`[MP Webhook] type=${type} id=${data?.id}`);

    if (type === 'subscription_preapproval') {
      const subId = data?.id;
      if (!subId) return res.sendStatus(200);

      // Consultar estado actual en MP
      const subscription = await mpFetch('GET', `/preapproval/${subId}`);
      const status = subscription.status;

      console.log(`[MP Webhook] subscription ${subId} → status=${status}`);

      // Actualizar estado en DB
      const result = await pool.query(
        `UPDATE memberships SET mp_status = $1, active = $2
         WHERE mp_subscription_id = $3
         RETURNING id, shop_id, client_id, plan`,
        [status, status === 'authorized', subId]
      );

      if (result.rows.length) {
        const memb = result.rows[0];

        // Si se autorizó, renovar créditos del mes
        if (status === 'authorized') {
          const credits = memb.plan === 'basic' ? 2 : 999;
          const renews = new Date();
          renews.setMonth(renews.getMonth() + 1);

          await pool.query(
            `UPDATE memberships SET
               credits_used = 0,
               credits_total = $1,
               renews_at = $2
             WHERE id = $3`,
            [credits, renews.toISOString().split('T')[0], memb.id]
          );

          console.log(`[MP Webhook] membresía ${memb.id} renovada para cliente ${memb.client_id}`);
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('[MP Webhook] error:', e.message);
    res.sendStatus(200); // siempre 200 para que MP no reintente
  }
});

// GET /api/payments/subscription/:id — consultar estado de suscripción
router.get('/subscription/:id', auth, async (req, res) => {
  try {
    const memb = await pool.query(
      'SELECT mp_subscription_id, mp_status, payment_url FROM memberships WHERE id=$1 AND shop_id=$2',
      [req.params.id, req.shopId]
    );
    if (!memb.rows.length) return res.status(404).json({ error: 'No encontrado' });

    const m = memb.rows[0];
    if (!m.mp_subscription_id) return res.json({ has_subscription: false });

    // Consultar estado fresco en MP
    const subscription = await mpFetch('GET', `/preapproval/${m.mp_subscription_id}`);

    // Sincronizar si cambió
    if (subscription.status !== m.mp_status) {
      await pool.query(
        'UPDATE memberships SET mp_status=$1, active=$2 WHERE mp_subscription_id=$3',
        [subscription.status, subscription.status === 'authorized', m.mp_subscription_id]
      );
    }

    res.json({
      has_subscription: true,
      status: subscription.status,
      payment_url: m.payment_url,
      next_payment_date: subscription.auto_recurring?.end_date || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/payments/subscription/:id — cancelar suscripción en MP
router.delete('/subscription/:id', auth, async (req, res) => {
  try {
    const memb = await pool.query(
      'SELECT mp_subscription_id FROM memberships WHERE id=$1 AND shop_id=$2',
      [req.params.id, req.shopId]
    );
    if (!memb.rows.length || !memb.rows[0].mp_subscription_id) {
      return res.status(404).json({ error: 'Suscripción no encontrada' });
    }

    const subId = memb.rows[0].mp_subscription_id;

    // Cancelar en MP
    await mpFetch('PUT', `/preapproval/${subId}`, { status: 'cancelled' });

    // Actualizar en DB
    await pool.query(
      'UPDATE memberships SET mp_status=$1, active=FALSE, cancelled_at=NOW() WHERE id=$2 AND shop_id=$3',
      ['cancelled', req.params.id, req.shopId]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// ── SUSCRIPCIÓN DEL SHOP A FILO ────────────────────────────────────────────

const FILO_PLANS = {
  starter:    { price: 40000, name: 'FILO Starter' },
  staff:      { price: 80000, name: 'FILO Staff' },
  enterprise: { price: 130000, name: 'FILO Enterprise' },
};

// POST /api/payments/filo-subscription — el shop se suscribe a FILO
// Usa preapproval_plan para generar un link donde el usuario ingresa la tarjeta
router.post('/filo-subscription', auth, async (req, res) => {
  const { payer_email } = req.body;
  if (!payer_email) return res.status(400).json({ error: 'payer_email es requerido' });

  try {
    const shopData = await pool.query(
      'SELECT filo_plan, name FROM shops WHERE id=$1',
      [req.shopId]
    );
    if (!shopData.rows.length) return res.status(404).json({ error: 'Shop no encontrado' });

    const shop = shopData.rows[0];
    const planKey = shop.filo_plan || 'starter';
    const plan = FILO_PLANS[planKey] || FILO_PLANS.starter;
    const appUrl = process.env.APP_URL || 'https://filocrm.com.ar';

    // Crear plan de suscripción con trial de 7 días
    // El usuario ingresa la tarjeta en el checkout de MP, no se cobra hasta el día 8
    const mpPlan = await mpFetch('POST', '/preapproval_plan', {
      reason: plan.name,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: plan.price,
        currency_id: 'ARS',
        free_trial: {
          frequency: 7,
          frequency_type: 'days'
        }
      },
      payment_methods_allowed: {
        payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }]
      },
      back_url: appUrl + '/app',
      notification_url: appUrl + '/api/payments/webhook-filo'
    });

    // El init_point del plan es el link donde el usuario ingresa la tarjeta
    const paymentUrl = mpPlan.init_point;

    // Guardar plan_id y URL en DB
    await pool.query(
      `UPDATE shops SET
         mp_shop_subscription_id = $1,
         mp_shop_status = 'pending',
         mp_shop_payment_url = $2
       WHERE id = $3`,
      [mpPlan.id, paymentUrl, req.shopId]
    );

    console.log(`[FILO PAY] Shop ${req.shopId} → plan ${planKey} url: ${paymentUrl}`);

    res.json({
      ok: true,
      payment_url: paymentUrl,
      plan: planKey,
      price: plan.price
    });
  } catch (e) {
    console.error('[FILO PAY] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payments/webhook-filo — MP notifica pagos de suscripción FILO
router.post('/webhook-filo', async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log(`[FILO Webhook] type=${type} id=${data?.id}`);

    if (type === 'subscription_preapproval') {
      const subId = data?.id;
      if (!subId) return res.sendStatus(200);

      const subscription = await mpFetch('GET', `/preapproval/${subId}`);
      const status = subscription.status;

      await pool.query(
        `UPDATE shops SET
           mp_shop_status = $1,
           subscription_status = $2
         WHERE mp_shop_subscription_id = $3`,
        [status, status === 'authorized' ? 'active' : 'expired', subId]
      );

      console.log(`[FILO Webhook] Shop suscripción ${subId} → ${status}`);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('[FILO Webhook] error:', e.message);
    res.sendStatus(200);
  }
});

// POST /api/payments/filo-cancel — cancelar suscripción del shop a FILO
router.post('/filo-cancel', auth, async (req, res) => {
  try {
    const shopData = await pool.query(
      'SELECT mp_shop_subscription_id FROM shops WHERE id=$1',
      [req.shopId]
    );
    const subId = shopData.rows[0]?.mp_shop_subscription_id;

    if (subId) {
      await mpFetch('PUT', `/preapproval/${subId}`, { status: 'cancelled' });
    }

    await pool.query(
      "UPDATE shops SET subscription_status='cancelled', mp_shop_status='cancelled' WHERE id=$1",
      [req.shopId]
    );

    console.log(`[FILO] Shop ${req.shopId} canceló suscripción`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[FILO cancel]', e.message);
    res.status(500).json({ error: e.message });
  }
});
