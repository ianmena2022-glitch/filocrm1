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

// ── SISTEMA QR DINÁMICO ────────────────────────────────────────────────────

// POST /api/payments/qr-order — crear orden de pago único (30 días de acceso)
router.post('/qr-order', auth, async (req, res) => {
  const { plan } = req.body;
  const validPlans = ['starter', 'staff', 'enterprise'];
  if (!validPlans.includes(plan)) return res.status(400).json({ error: 'Plan inválido' });

  const QR_PLANS = {
    starter:    { price: 40000,  label: 'FILO Starter'    },
    staff:      { price: 80000,  label: 'FILO Staff'       },
    enterprise: { price: 130000, label: 'FILO Enterprise'  },
  };
  const planCfg = QR_PLANS[plan];
  const appUrl  = process.env.APP_URL || 'https://filocrm.com.ar';
  const extRef  = `filo:${req.shopId}:${plan}:${Date.now()}`;

  try {
    const pref = await mpFetch('POST', '/checkout/preferences', {
      items: [{ title: `${planCfg.label} — 30 días`, quantity: 1, unit_price: planCfg.price, currency_id: 'ARS' }],
      external_reference: extRef,
      notification_url: `${appUrl}/api/payments/webhook-qr`,
      back_urls: { success: `${appUrl}/app?qr_paid=1`, failure: `${appUrl}/app` },
      auto_return: 'approved',
    });

    await pool.query("UPDATE shops SET mp_shop_status='pending_qr' WHERE id=$1", [req.shopId]);

    console.log(`[QR Order] Shop ${req.shopId} → plan ${plan} · pref ${pref.id}`);
    res.json({ ok: true, preference_id: pref.id, init_point: pref.init_point, amount: planCfg.price, plan });
  } catch(e) {
    console.error('[QR Order] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payments/webhook-qr — MP notifica pago aprobado (QR / Checkout)
router.post('/webhook-qr', async (req, res) => {
  try {
    const { type, data, action } = req.body;
    console.log(`[QR Webhook] type=${type} action=${action} id=${data?.id}`);

    const isPaymentEvent = type === 'payment' || action === 'payment.created' || action === 'payment.updated';
    if (isPaymentEvent && data?.id) {
      const payment = await mpFetch('GET', `/v1/payments/${data.id}`);
      const { status, external_reference, transaction_amount } = payment;
      console.log(`[QR Webhook] pago ${data.id} → ${status} · ref=${external_reference}`);

      if (status === 'approved' && external_reference?.startsWith('filo:')) {
        const parts   = external_reference.split(':');
        const shopId  = parseInt(parts[1]);
        const plan    = parts[2];
        if (!shopId || isNaN(shopId)) return res.sendStatus(200);

        // Validar que el monto pagado corresponde al plan (tolerancia de $1 por redondeos)
        const QR_PLANS = {
          starter:    { price: 40000  },
          staff:      { price: 80000  },
          enterprise: { price: 130000 },
        };
        const expectedPrice = QR_PLANS[plan]?.price;
        const paidAmount    = parseFloat(transaction_amount) || 0;
        if (expectedPrice && paidAmount < expectedPrice - 1) {
          console.warn(`[QR Webhook] MONTO INSUFICIENTE — shop ${shopId} pagó $${paidAmount} para plan ${plan} (esperado $${expectedPrice}). Ignorando.`);
          return res.sendStatus(200);
        }

        const accessUntil = new Date();
        accessUntil.setDate(accessUntil.getDate() + 30);

        const isEnterprise = plan === 'enterprise';
        const updated = await pool.query(
          `UPDATE shops
           SET subscription_status='active', mp_shop_status='authorized',
               filo_plan=$1, trial_ends_at=$2, expired_at=NULL,
               first_payment_at=COALESCE(first_payment_at, NOW()),
               is_enterprise_owner=$4,
               is_branch=CASE WHEN $4 THEN FALSE ELSE is_branch END,
               parent_enterprise_id=CASE WHEN $4 THEN NULL ELSE parent_enterprise_id END
           WHERE id=$3
           RETURNING name, phone, wpp_connected`,
          [plan, accessUntil.toISOString(), shopId, isEnterprise]
        );

        if (updated.rows.length) {
          const shop = updated.rows[0];
          const planLabel = { starter:'Starter', staff:'Staff', enterprise:'Enterprise' }[plan] || plan;
          console.log(`[QR Webhook] Shop ${shopId} activado — ${planLabel} hasta ${accessUntil.toDateString()}`);

          // Otorgar mes gratis al referidor peer-to-peer (si aplica)
          try {
            const { grantFreeMonthToReferrer } = require('./referrals');
            await grantFreeMonthToReferrer(shopId);
          } catch(refErr) {
            console.error('[QR Webhook] grantFreeMonth error:', refErr.message);
          }

          // Acreditar comisión al afiliado (si aplica)
          try {
            const { creditAffiliateCommission } = require('./affiliates');
            await creditAffiliateCommission(shopId, plan);
          } catch(affErr) {
            console.error('[QR Webhook] creditAffiliate error:', affErr.message);
          }

          if (shop.wpp_connected && shop.phone) {
            try {
              const wpp = require('../services/whatsapp');
              const fechaVto = accessUntil.toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric' });
              const msg = `🎉 *¡Plan FILO activado!*\n\n✅ Tu plan *${planLabel}* está activo.\n📅 Válido 30 días hasta el ${fechaVto}.\n\n¡Gracias por usar FILO! ✂️`;
              await wpp.sendText(shopId, shop.phone, msg);
            } catch(wppErr) {
              console.error('[QR Webhook] Error WPP:', wppErr.message);
            }
          }
        }
      }
    }
    res.sendStatus(200);
  } catch(e) {
    console.error('[QR Webhook] error:', e.message);
    res.sendStatus(200);
  }
});

// POST /api/payments/filo-cancel — cancelar suscripción del shop a FILO
router.post('/filo-cancel', auth, async (req, res) => {
  try {
    const shopData = await pool.query(
      'SELECT mp_shop_subscription_id, mp_payer_email, email FROM shops WHERE id=$1',
      [req.shopId]
    );
    const shop = shopData.rows[0];
    const storedId = shop?.mp_shop_subscription_id;

    if (storedId) {
      try {
        // Intentar cancelar con el ID almacenado (puede ser subscription_id o plan_id)
        await mpFetch('PUT', `/preapproval/${storedId}`, { status: 'cancelled' });
        console.log(`[FILO cancel] Suscripción ${storedId} cancelada en MP`);
      } catch (mpErr) {
        // Si falló, probablemente tenemos el plan_id — buscar la suscripción real del usuario.
        // Usar mp_payer_email (email real de MP) si está disponible; si no, el email de FILO.
        const searchEmail = shop.mp_payer_email || shop.email;
        console.warn(`[FILO cancel] PUT directo falló (${mpErr.message}), buscando por plan_id + email=${searchEmail}...`);
        try {
          const search = await mpFetch('GET', `/preapproval/search?preapproval_plan_id=${storedId}&payer_email=${encodeURIComponent(searchEmail)}`);
          const realSub = search?.results?.[0];
          if (realSub?.id) {
            await mpFetch('PUT', `/preapproval/${realSub.id}`, { status: 'cancelled' });
            // Guardar el ID real para futuras operaciones
            await pool.query('UPDATE shops SET mp_shop_subscription_id=$1 WHERE id=$2', [realSub.id, req.shopId]);
            console.log(`[FILO cancel] Suscripción ${realSub.id} cancelada via búsqueda por plan_id`);
          }
        } catch (searchErr) {
          // Logear pero no fallar — el acceso se revoca igual al vencer el período
          console.error(`[FILO cancel] Búsqueda en MP falló:`, searchErr.message);
        }
      }
    }

    // Solo marcar mp_shop_status como 'cancelled' — NO tocar subscription_status.
    // El acceso se mantiene hasta que venza el período (trial_ends_at o ciclo de facturación).
    // El cron job / webhook revocarán el acceso cuando MP confirme el vencimiento.
    await pool.query(
      "UPDATE shops SET mp_shop_status='cancelled' WHERE id=$1",
      [req.shopId]
    );

    console.log(`[FILO] Shop ${req.shopId} canceló suscripción`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[FILO cancel]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payments/test-change-plan — solo para cuentas test, cambia plan sin pago
router.post('/test-change-plan', auth, async (req, res) => {
  try {
    const { plan } = req.body;
    const validPlans = ['starter', 'staff', 'enterprise'];
    if (!validPlans.includes(plan)) return res.status(400).json({ error: 'Plan inválido' });

    const shopRes = await pool.query('SELECT is_test FROM shops WHERE id=$1', [req.shopId]);
    if (!shopRes.rows.length || !shopRes.rows[0].is_test) {
      return res.status(403).json({ error: 'Solo disponible para cuentas test' });
    }

    const isEnterprise = plan === 'enterprise';
    await pool.query(
      `UPDATE shops SET filo_plan=$1, is_enterprise_owner=$2,
         is_branch=CASE WHEN $2 THEN FALSE ELSE is_branch END,
         parent_enterprise_id=CASE WHEN $2 THEN NULL ELSE parent_enterprise_id END
       WHERE id=$3`,
      [plan, isEnterprise, req.shopId]
    );

    res.json({ ok: true, plan });
  } catch (e) {
    console.error('[test-change-plan]', e.message);
    res.status(500).json({ error: e.message });
  }
});
