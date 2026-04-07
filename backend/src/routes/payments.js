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

    // Crear plan de suscripción en MP — el cliente completa el pago desde el init_point
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
      back_url: `${appUrl}/app`,
      notification_url: `${appUrl}/api/payments/webhook`
    });

    const paymentUrl = plan.init_point;

    // Guardar plan_id y URL en DB (el mp_subscription_id real llega por webhook cuando el cliente paga)
    await pool.query(
      `UPDATE memberships SET
         mp_subscription_id = $1,
         mp_status = 'pending',
         payment_url = $2
       WHERE id = $3 AND shop_id = $4`,
      [plan.id, paymentUrl, membership_id, req.shopId]
    );

    // Enviar WhatsApp al cliente con el link de pago
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
        const msg = `✂️ *${row.shop_name}* — Membresía\n\nHola ${row.name}! 👋\n\nTu membresía está lista. Para activarla hacé clic en el siguiente link y completá el pago:\n\n🔗 ${paymentUrl}\n\n💳 Podés pagar con tarjeta de crédito o débito a través de Mercado Pago.\n\n¡Gracias! 🙌`;
        await wpp.sendText(req.shopId, row.phone, msg);
        console.log(`[MP] WhatsApp enviado a ${row.phone}`);
      }
    } catch (wppErr) {
      console.error('[MP] Error enviando WhatsApp:', wppErr.message);
    }

    res.json({
      ok: true,
      payment_url: paymentUrl,
      status: 'pending'
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

// GET /api/payments/setup-plans — crear los 3 planes fijos en MP (ejecutar UNA sola vez)
// Protegido por ADMIN_SECRET — llamar desde consola o Postman
router.get('/setup-plans', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== (process.env.ADMIN_PASSWORD || 'filo-admin-2026')) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const appUrl = process.env.APP_URL || 'https://filocrm.com.ar';
  const results = {};
  for (const [key, plan] of Object.entries(FILO_PLANS)) {
    try {
      const mpPlan = await mpFetch('POST', '/preapproval_plan', {
        reason: plan.name,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: plan.price,
          currency_id: 'ARS',
          free_trial: { frequency: 7, frequency_type: 'days' }
        },
        payment_methods_allowed: {
          payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }]
        },
        back_url: appUrl + '/app',
        notification_url: appUrl + '/api/payments/webhook-filo'
      });
      results[key] = { id: mpPlan.id, init_point: mpPlan.init_point };
      console.log(`[SETUP] Plan ${key} creado: ${mpPlan.id}`);
    } catch(e) {
      results[key] = { error: e.message };
    }
  }
  res.json({
    message: 'Guardá estos IDs como variables de entorno en Railway:',
    env_vars: {
      MP_PLAN_STARTER:    results.starter?.id,
      MP_PLAN_STAFF:      results.staff?.id,
      MP_PLAN_ENTERPRISE: results.enterprise?.id,
    },
    full: results
  });
});

// POST /api/payments/filo-subscription — el shop se suscribe a FILO usando planes fijos
router.post('/filo-subscription', auth, async (req, res) => {
  const { payer_email } = req.body;
  if (!payer_email) return res.status(400).json({ error: 'payer_email es requerido' });

  try {
    const shopData = await pool.query('SELECT filo_plan, name FROM shops WHERE id=$1', [req.shopId]);
    if (!shopData.rows.length) return res.status(404).json({ error: 'Shop no encontrado' });

    const planKey = shopData.rows[0].filo_plan || 'starter';
    const planConfig = FILO_PLANS[planKey] || FILO_PLANS.starter;
    const appUrl = process.env.APP_URL || 'https://filocrm.com.ar';

    // Obtener ID del plan fijo desde env vars
    const planIds = {
      starter:    process.env.MP_PLAN_STARTER,
      staff:      process.env.MP_PLAN_STAFF,
      enterprise: process.env.MP_PLAN_ENTERPRISE,
    };
    const fixedPlanId = planIds[planKey];

    let paymentUrl;

    if (fixedPlanId) {
      // Usar el plan fijo — el init_point del plan ya tiene el trial incorporado
      const mpPlan = await mpFetch('GET', `/preapproval_plan/${fixedPlanId}`);
      paymentUrl = mpPlan.init_point;
      console.log(`[FILO PAY] Shop ${req.shopId} → plan fijo ${planKey} (${fixedPlanId})`);
    } else {
      // Fallback: crear plan nuevo si no hay plan fijo configurado
      console.warn(`[FILO PAY] Plan fijo no configurado para ${planKey}, creando uno nuevo...`);
      const mpPlan = await mpFetch('POST', '/preapproval_plan', {
        reason: planConfig.name,
        auto_recurring: {
          frequency: 1, frequency_type: 'months',
          transaction_amount: planConfig.price, currency_id: 'ARS',
          free_trial: { frequency: 7, frequency_type: 'days' }
        },
        payment_methods_allowed: { payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }] },
        back_url: appUrl + '/app',
        notification_url: appUrl + '/api/payments/webhook-filo'
      });
      paymentUrl = mpPlan.init_point;
    }

    await pool.query(
      `UPDATE shops SET mp_shop_status='pending', mp_shop_payment_url=$1 WHERE id=$2`,
      [paymentUrl, req.shopId]
    );

    res.json({ ok: true, payment_url: paymentUrl, plan: planKey, price: planConfig.price });
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
      const planId = subscription.preapproval_plan_id;
      console.log(`[FILO Webhook] suscripción ${subId} → ${status} · plan_id=${planId}`);

      // 1. Intentar actualizar shop existente (match por subscription_id o plan_id almacenado)
      const updated = await pool.query(
        `UPDATE shops SET mp_shop_status=$1, subscription_status=$2, mp_shop_subscription_id=$3
         WHERE mp_shop_subscription_id=$3 OR mp_shop_subscription_id=$4 RETURNING id`,
        [status, status === 'authorized' ? 'active' : 'expired', subId, planId]
      );

      // 2. Si no hay shop, buscar en pending_registrations y crear la cuenta
      if (!updated.rows.length && status === 'authorized') {
        const bcrypt = require('bcryptjs');
        const pending = await pool.query(
          'SELECT * FROM pending_registrations WHERE (mp_plan_id=$1 OR mp_plan_id=$2) AND expires_at > NOW()',
          [subId, planId]
        );
        if (pending.rows.length) {
          const p = pending.rows[0];
          // Verificar que no exista ya
          const exists = await pool.query('SELECT id FROM shops WHERE email=$1', [p.email]);
          if (!exists.rows.length) {
            const trialEnds = new Date();
            trialEnds.setDate(trialEnds.getDate() + 7);
            const shop = await pool.query(
              `INSERT INTO shops (name, email, password, phone, plan, filo_plan, trial_ends_at, subscription_status, mp_shop_subscription_id, mp_shop_status)
               VALUES ($1,$2,$3,$4,'starter',$5,$6,'active',$7,'authorized') RETURNING *`,
              [p.name, p.email, p.password, p.phone, p.filo_plan, trialEnds.toISOString(), subId]
            );
            await pool.query(
              `INSERT INTO services (shop_id, name, price, cost, duration_minutes) VALUES
               ($1,'Corte de cabello',3500,200,30),($1,'Corte + barba',5000,300,45),
               ($1,'Barba',2000,150,20),($1,'Corte + lavado',4500,250,40)`,
              [shop.rows[0].id]
            );
            await pool.query('DELETE FROM pending_registrations WHERE id=$1', [p.id]);
            console.log(`[FILO Webhook] Cuenta creada para ${p.email} via webhook`);
          }
        }
      }
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
