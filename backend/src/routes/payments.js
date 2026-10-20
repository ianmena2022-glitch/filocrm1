const router = require('express').Router();
const crypto = require('crypto');
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

const MP_BASE = 'https://api.mercadopago.com';
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_QR_TOKEN = process.env.MP_QR_ACCESS_TOKEN || process.env.MP_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;
const MP_QR_WEBHOOK_SECRET = process.env.MP_QR_WEBHOOK_SECRET;

if (process.env.NODE_ENV === 'production') {
  if (!MP_TOKEN)          console.error('[MP] FATAL: MP_ACCESS_TOKEN no configurado');
  if (!MP_WEBHOOK_SECRET) console.error('[MP] FATAL: MP_WEBHOOK_SECRET no configurado');
}

// Verifica la firma x-signature de Mercado Pago (HMAC-SHA256).
// Formato: "ts=<ts>,v1=<hash>" · manifest = `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
function verifyMpSignature(req) {
  const secrets = [MP_WEBHOOK_SECRET, MP_QR_WEBHOOK_SECRET].filter(Boolean);
  if (!secrets.length) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[MP] FATAL: ningún webhook secret configurado — rechazando webhook');
      return false;
    }
    console.warn('[MP] webhook secrets no configurados (dev) — aceptando sin verificar');
    return true;
  }
  try {
    const sigHeader = req.headers['x-signature'] || '';
    const requestId = req.headers['x-request-id'] || '';
    const dataId    = req.query['data.id'] || req.body?.data?.id || '';
    if (!sigHeader || !dataId) return false;

    const parts = {};
    sigHeader.split(',').forEach(p => {
      const [k, v] = p.split('=').map(s => s && s.trim());
      if (k && v) parts[k] = v;
    });
    const ts = parts.ts;
    const v1 = parts.v1;
    if (!ts || !v1) return false;

    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const received = Buffer.from(v1, 'hex');
    // Probar con cada secret (app vieja y app QR). Si matchea con cualquiera, válido.
    for (const secret of secrets) {
      const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
      const b = Buffer.from(expected, 'hex');
      if (received.length === b.length && crypto.timingSafeEqual(received, b)) return true;
    }
    return false;
  } catch (e) {
    console.error('[MP] Error verificando firma:', e.message);
    return false;
  }
}

async function mpFetch(method, path, body, tokenOverride) {
  const token = tokenOverride || MP_TOKEN;
  if (!token) throw new Error('MP_ACCESS_TOKEN no configurado');
  const res = await fetch(`${MP_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Idempotency-Key': crypto.randomUUID()
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`[MP ${method} ${path}] ${res.status} →`, JSON.stringify(data));
    throw new Error(data.message || data.error || `MP ${res.status}`);
  }
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

    // Enviar WhatsApp al cliente con el link de pago.
    // Fallback a enterprise owner si la sucursal no tiene wpp propio.
    try {
      const membData = await pool.query(
        `SELECT c.phone, c.name, s.wpp_connected, s.name AS shop_name, s.parent_enterprise_id
         FROM memberships m
         JOIN clients c ON c.id = m.client_id
         JOIN shops s ON s.id = m.shop_id
         WHERE m.id = $1`,
        [membership_id]
      );
      const row = membData.rows[0];
      if (row?.phone) {
        const wpp = require('../services/whatsapp');
        const wppShopId = row.parent_enterprise_id || req.shopId;
        const msg = `✂️ *${row.shop_name}* — Membresía\n\nHola ${row.name}! 👋\n\nTu membresía está lista. Para activarla hacé clic en el siguiente link y completá el pago:\n\n🔗 ${paymentUrl}\n\n💳 Podés pagar con tarjeta de crédito o débito a través de Mercado Pago.\n\n¡Gracias! 🙌`;
        await wpp.sendText(wppShopId, row.phone, msg);
        console.log(`[MP] WhatsApp enviado a ${row.phone} desde shop ${wppShopId}`);
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
  if (!verifyMpSignature(req)) {
    console.warn('[MP Webhook] firma inválida — rechazando');
    return res.sendStatus(401);
  }
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

const QR_PLANS = {
  starter:    { price: 40000,  label: 'FILO Starter'    },
  staff:      { price: 80000,  label: 'FILO Staff'       },
  enterprise: { price: 130000, label: 'FILO Enterprise'  },
};

// GET /api/payments/price/:plan?code=XXX — precio final (con promo aplicada si existe)
router.get('/price/:plan', auth, async (req, res) => {
  const plan = req.params.plan;
  if (!QR_PLANS[plan]) return res.status(400).json({ error: 'Plan inválido' });
  try {
    const promos = require('../services/promotions');
    const pricing = await promos.priceForShop({ shopId: req.shopId, plan, code: req.query.code || null });
    res.json({ plan, label: QR_PLANS[plan].label, ...pricing });
  } catch(e) {
    res.status(500).json({ error: 'Error calculando precio' });
  }
});

// POST /api/payments/qr-order — crear orden Checkout Pro (QR escaneable + link).
// El init_point abre Checkout Pro donde el cliente puede pagar con tarjeta, débito,
// transferencia desde cualquier banco (Transferencias 3.0), MP, Rapipago o Pago Fácil.
router.post('/qr-order', auth, async (req, res) => {
  const { plan, code } = req.body;
  if (!QR_PLANS[plan]) return res.status(400).json({ error: 'Plan inválido' });
  const planCfg = QR_PLANS[plan];
  const appUrl  = process.env.APP_URL || 'https://filocrm.com.ar';

  try {
    const promos  = require('../services/promotions');
    const pricing = await promos.priceForShop({ shopId: req.shopId, plan, code: code || null });
    const finalPrice = pricing.final;
    const promoId    = pricing.promo?.id || 0;
    // extRef incluye promo_id para registrar uso en el webhook/activate
    const extRef  = `filo:${req.shopId}:${plan}:${promoId}:${Date.now()}`;

    const pref = await mpFetch('POST', '/checkout/preferences', {
      items: [{ title: `${planCfg.label} — 30 días`, quantity: 1, unit_price: finalPrice, currency_id: 'ARS' }],
      external_reference: extRef,
      notification_url: `${appUrl}/api/payments/webhook-qr`,
      back_urls: { success: `${appUrl}/gracias`, failure: `${appUrl}/app` },
      auto_return: 'approved',
    });

    await pool.query("UPDATE shops SET mp_shop_status='pending_qr' WHERE id=$1", [req.shopId]);

    console.log(`[QR Order] Shop ${req.shopId} → plan ${plan} · $${finalPrice} (promo=${promoId||'-'}) · pref ${pref.id}`);
    res.json({
      ok: true,
      preference_id: pref.id,
      init_point: pref.init_point,
      amount: finalPrice,
      base_amount: pricing.base,
      discount: pricing.discount,
      promo: pricing.promo,
      plan
    });
  } catch(e) {
    console.error('[QR Order] Error:', e.message, e.stack);
    res.status(500).json({ error: 'Error generando QR: ' + e.message });
  }
});

// ── FLUJO TRANSFERENCIA BANCARIA CON AUTO-DETECCIÓN ────────────────────────
// Genera un monto único (base + centavos random) para distinguir pagos pendientes.
// MP notifica cuando ingresa plata a la cuenta; matcheamos por monto exacto.

// POST /api/payments/transfer-order — crear orden de pago por transferencia
router.post('/transfer-order', auth, async (req, res) => {
  const { plan, code } = req.body;
  if (!QR_PLANS[plan]) return res.status(400).json({ error: 'Plan inválido' });
  const planCfg = QR_PLANS[plan];
  const alias = process.env.MP_RECEIVER_ALIAS || '';
  const cbu   = process.env.MP_RECEIVER_CBU   || '';
  if (!alias && !cbu) {
    return res.status(503).json({ error: 'Transferencia no configurada (falta MP_RECEIVER_ALIAS/CBU)' });
  }

  try {
    // Expirar órdenes viejas no matcheadas (housekeeping)
    await pool.query(
      `UPDATE pending_transfers SET matched=TRUE, matched_at=NOW()
       WHERE matched=FALSE AND expires_at < NOW()`
    );

    // Aplicar promo si corresponde
    const promos  = require('../services/promotions');
    const pricing = await promos.priceForShop({ shopId: req.shopId, plan, code: code || null });
    const finalPrice = pricing.final;
    // Generar monto único: precio (con descuento) + 1..999 centavos que no colisionen con pendings activos.
    const baseCents = finalPrice * 100;
    let amountCents = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = baseCents + Math.floor(Math.random() * 999) + 1;
      const dupe = await pool.query(
        `SELECT 1 FROM pending_transfers
         WHERE amount_cents=$1 AND matched=FALSE AND expires_at > NOW()
         LIMIT 1`,
        [candidate]
      );
      if (!dupe.rows.length) { amountCents = candidate; break; }
    }
    if (!amountCents) return res.status(503).json({ error: 'No se pudo generar monto único, probá en unos segundos' });

    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h
    let ins;
    try {
      ins = await pool.query(
        `INSERT INTO pending_transfers (shop_id, plan, amount_cents, expires_at, promotion_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [req.shopId, plan, amountCents, expires.toISOString(), pricing.promo?.id || null]
      );
    } catch(e) {
      // Fallback si la columna promotion_id no existe aún (migración 043 pendiente)
      if (/promotion_id|column.*does not exist/i.test(e.message)) {
        ins = await pool.query(
          `INSERT INTO pending_transfers (shop_id, plan, amount_cents, expires_at)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [req.shopId, plan, amountCents, expires.toISOString()]
        );
      } else throw e;
    }
    const transferId = ins.rows[0].id;
    console.log(`[Transfer] Shop ${req.shopId} · plan ${plan} · $${(amountCents/100).toFixed(2)} · id=${transferId}`);

    res.json({
      ok: true,
      transfer_id: transferId,
      alias,
      cbu,
      amount: amountCents / 100,
      amount_cents: amountCents,
      amount_formatted: (amountCents / 100).toFixed(2),
      expires_at: expires.toISOString(),
      plan,
      receiver_name: process.env.MP_RECEIVER_NAME || 'FILO CRM',
    });
  } catch(e) {
    console.error('[Transfer] Error:', e.message);
    res.status(500).json({ error: 'Error al generar orden de transferencia' });
  }
});

// GET /api/payments/transfer-status/:id — polling para saber si se matcheó
router.get('/transfer-status/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const q = await pool.query(
      `SELECT matched, expires_at FROM pending_transfers
       WHERE id=$1 AND shop_id=$2`,
      [id, req.shopId]
    );
    if (!q.rows.length) return res.status(404).json({ error: 'no encontrada' });
    const row = q.rows[0];
    const expired = new Date(row.expires_at) < new Date() && !row.matched;
    res.json({
      status: row.matched ? 'matched' : (expired ? 'expired' : 'pending')
    });
  } catch(e) {
    res.status(500).json({ error: 'Error' });
  }
});

// Función helper: intenta matchear un payment entrante (money_in) con una orden pending.
// Devuelve { matched: true, shopId, plan } si matcheó, { matched: false } si no.
async function tryMatchIncomingTransfer(paymentId, amount) {
  const amountCents = Math.round(parseFloat(amount) * 100);
  if (!amountCents) return { matched: false };
  let q;
  try {
    q = await pool.query(
      `SELECT id, shop_id, plan, promotion_id FROM pending_transfers
       WHERE amount_cents=$1 AND matched=FALSE AND expires_at > NOW()
       ORDER BY created_at ASC LIMIT 1`,
      [amountCents]
    );
  } catch(e) {
    if (/promotion_id|column.*does not exist/i.test(e.message)) {
      q = await pool.query(
        `SELECT id, shop_id, plan FROM pending_transfers
         WHERE amount_cents=$1 AND matched=FALSE AND expires_at > NOW()
         ORDER BY created_at ASC LIMIT 1`,
        [amountCents]
      );
    } else throw e;
  }
  if (!q.rows.length) return { matched: false };
  const row = q.rows[0];
  await pool.query(
    `UPDATE pending_transfers SET matched=TRUE, matched_at=NOW(), mp_payment_id=$1
     WHERE id=$2`,
    [String(paymentId), row.id]
  );
  console.log(`[Transfer] ✓ MATCH payment ${paymentId} ($${amount}) → shop ${row.shop_id} · plan ${row.plan}`);
  try {
    const sse = require('../services/sse');
    sse.emit(row.shop_id, 'transfer.matched', { transfer_id: row.id, plan: row.plan });
  } catch(_) {}
  return { matched: true, shopId: row.shop_id, plan: row.plan, promotionId: row.promotion_id };
}

// Activa un plan mensual para una barbería. Centraliza la lógica (shops row,
// idempotencia, referrals, afiliados, WhatsApp de confirmación). No tira; loguea errores.
async function activateShopPlan({ shopId, plan, paymentId, paidAmount, promotionId = null }) {
  const basePrice = QR_PLANS[plan]?.price;
  // Si hay promo, el precio esperado puede ser menor. Recalcular con promo activa.
  let expectedPrice = basePrice;
  let resolvedPromoId = promotionId;
  try {
    const promos = require('../services/promotions');
    if (!resolvedPromoId) {
      const pricing = await promos.priceForShop({ shopId, plan });
      expectedPrice = pricing.final;
      resolvedPromoId = pricing.promo?.id || null;
    } else {
      // Si viene con promoId explícito (ej. desde transferencia), calcular con esa promo
      const promoRow = await pool.query('SELECT * FROM promotions WHERE id=$1', [resolvedPromoId]);
      if (promoRow.rows.length) {
        const d = promos.computeDiscount(basePrice, promoRow.rows[0]);
        expectedPrice = d.final_amount;
      }
    }
  } catch(e) { console.warn('[Activate] promo lookup error:', e.message); }

  if (expectedPrice && paidAmount < (expectedPrice - 1)) {
    console.warn(`[Activate] MONTO INSUFICIENTE — shop ${shopId} pagó $${paidAmount} para ${plan} (esperado $${expectedPrice}). Ignorando.`);
    return;
  }

  const shopRow = await pool.query('SELECT trial_ends_at FROM shops WHERE id=$1', [shopId]);
  if (!shopRow.rows.length) { console.warn(`[Activate] shop ${shopId} no existe`); return; }
  const currentExpiry = shopRow.rows[0].trial_ends_at;
  const accessUntil = (currentExpiry && new Date(currentExpiry) > new Date())
    ? new Date(currentExpiry)
    : new Date();
  accessUntil.setDate(accessUntil.getDate() + 30);

  const isEnterprise = plan === 'enterprise';
  const updated = await pool.query(
    `UPDATE shops
     SET subscription_status='active', mp_shop_status='authorized',
         filo_plan=$1, trial_ends_at=$2, expired_at=NULL,
         first_payment_at=COALESCE(first_payment_at, NOW()),
         last_payment_at=NOW(),
         is_enterprise_owner=$4,
         is_branch=CASE WHEN $4 THEN FALSE ELSE is_branch END,
         parent_enterprise_id=CASE WHEN $4 THEN NULL ELSE parent_enterprise_id END
     WHERE id=$3
     RETURNING name, phone, wpp_connected`,
    [plan, accessUntil.toISOString(), shopId, isEnterprise]
  );
  if (!updated.rows.length) return;

  await pool.query(
    `INSERT INTO mp_processed_payments (payment_id, shop_id, plan, amount)
     VALUES ($1,$2,$3,$4) ON CONFLICT (payment_id) DO NOTHING`,
    [String(paymentId), shopId, plan, paidAmount]
  );

  const shop = updated.rows[0];
  const planLabel = { starter:'Starter', staff:'Staff', enterprise:'Enterprise' }[plan] || plan;
  console.log(`[Activate] Shop ${shopId} activado — ${planLabel} hasta ${accessUntil.toDateString()}`);

  // SSE en vivo: el frontend del dueño cierra el modal + muestra success instantáneo
  try {
    const sse = require('../services/sse');
    sse.emit(shopId, 'plan.activated', { plan, plan_label: planLabel, until: accessUntil.toISOString() });
  } catch(_) {}

  // Notificar admin (fire & forget)
  try {
    const push = require('../services/push');
    push.sendToAdmins({
      title: '💰 Pago recibido',
      body:  `${shop.name || 'Shop'} activó plan ${planLabel} ($${(paidAmount||0).toLocaleString('es-AR')})`,
      icon:  '/favicon.ico',
      data:  { url: '/admin', type: 'plan.activated', shopId, plan }
    }).catch(()=>{});
  } catch(_) {}

  // Notificación persistente
  try {
    const notif = require('../services/notifications');
    const fechaVto = accessUntil.toLocaleDateString('es-AR', { day:'numeric', month:'long' });
    await notif.create({
      shopId, recipientShopId: shopId,
      type:  'plan.activated',
      title: `Plan ${planLabel} activado`,
      body:  `30 días de acceso, válido hasta el ${fechaVto}.`,
      icon:  '🎉',
    });
  } catch(_) {}

  try {
    const { grantFreeMonthToReferrer } = require('./referrals');
    await grantFreeMonthToReferrer(shopId);
  } catch(e) { console.error('[Activate] grantFreeMonth:', e.message); }

  try {
    const { creditAffiliateCommission } = require('./affiliates');
    await creditAffiliateCommission(shopId, plan);
  } catch(e) { console.error('[Activate] creditAffiliate:', e.message); }

  if (shop.wpp_connected && shop.phone) {
    try {
      const wpp = require('../services/whatsapp');
      const fechaVto = accessUntil.toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric' });
      const msg = `🎉 *¡Plan FILO activado!*\n\n✅ Tu plan *${planLabel}* está activo.\n📅 Válido 30 días hasta el ${fechaVto}.\n\n¡Gracias por usar FILO! ✂️`;
      await wpp.sendText(shopId, shop.phone, msg);
    } catch(e) { console.error('[Activate] WPP:', e.message); }
  }

  // Registrar uso de la promo si aplicó
  if (resolvedPromoId) {
    try {
      const promos = require('../services/promotions');
      await promos.recordUse({
        promotionId: resolvedPromoId,
        shopId,
        paymentId,
        plan,
        originalAmount: basePrice,
        finalAmount: expectedPrice
      });
    } catch(e) { console.error('[Activate] promo recordUse:', e.message); }
  }
}

// POST /api/payments/webhook-qr — MP notifica pago aprobado (QR / Checkout / Transferencia)
router.post('/webhook-qr', async (req, res) => {
  if (!verifyMpSignature(req)) {
    console.warn('[QR Webhook] firma inválida — rechazando');
    return res.sendStatus(401);
  }
  try {
    const { type, data, action } = req.body;
    console.log(`[QR Webhook] type=${type} action=${action} id=${data?.id}`);

    const isPaymentEvent = type === 'payment' || action === 'payment.created' || action === 'payment.updated';
    if (isPaymentEvent && data?.id) {
      const paymentId = String(data.id);

      // Idempotencia: si ya procesamos este payment_id, no volvemos a activar
      const already = await pool.query('SELECT 1 FROM mp_processed_payments WHERE payment_id=$1', [paymentId]);
      if (already.rows.length) {
        console.log(`[QR Webhook] pago ${paymentId} ya procesado, ignorando`);
        return res.sendStatus(200);
      }

      const payment = await mpFetch('GET', `/v1/payments/${paymentId}`);
      const { status, external_reference, transaction_amount } = payment;
      console.log(`[QR Webhook] pago ${paymentId} → ${status} · ref=${external_reference} · $${transaction_amount}`);

      if (status !== 'approved') return res.sendStatus(200);

      let shopId = null, plan = null, promotionId = null;
      if (external_reference?.startsWith('filo:')) {
        const parts = external_reference.split(':');
        shopId = parseInt(parts[1]);
        plan   = parts[2];
        // extRef: filo:shopId:plan:promoId:ts (promoId '0' = sin promo)
        if (parts.length >= 5) {
          const p = parseInt(parts[3]);
          if (p > 0) promotionId = p;
        }
      } else {
        // No tiene external_reference nuestro → intentar match con pending_transfers por monto exacto
        const match = await tryMatchIncomingTransfer(paymentId, transaction_amount);
        if (match.matched) { shopId = match.shopId; plan = match.plan; promotionId = match.promotionId; }
      }

      if (shopId && plan) {
        const paidAmount = parseFloat(transaction_amount) || 0;
        await activateShopPlan({ shopId, plan, paymentId, paidAmount, promotionId });
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

// Exportar helpers para que scheduler.js pueda hacer polling de transferencias.
router._internals = { tryMatchIncomingTransfer, activateShopPlan };
