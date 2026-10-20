// Promociones: resolver mejor descuento aplicable + registrar usos.
const pool = require('../db/pool');

const PLAN_PRICES = { starter: 50000, staff: 80000, enterprise: 130000 };
function planBasePrice(plan) { return PLAN_PRICES[plan] || 0; }

// Devuelve la MEJOR promo aplicable a (shopId, plan, code opcional) o null.
// 'Mejor' = la que da el mayor descuento sobre el precio base.
async function getBestPromoForShop({ shopId, plan, code = null }) {
  if (!shopId || !plan) return null;
  const basePrice = planBasePrice(plan);
  if (basePrice <= 0) return null;

  const now = new Date();
  const q = await pool.query(
    `SELECT * FROM promotions
       WHERE status = 'active'
         AND (starts_at IS NULL OR starts_at <= $1)
         AND (ends_at   IS NULL OR ends_at   >  $1)
         AND (applies_to = 'all' OR $2 = ANY(shop_ids))
         AND (plans IS NULL OR $3 = ANY(plans))
         AND (code IS NULL OR code = $4)`,
    [now, shopId, plan, code]
  );
  if (!q.rows.length) return null;

  // Filtrar por max_total_uses y max_uses_per_shop + renewable
  const eligible = [];
  for (const p of q.rows) {
    // Total uses
    if (p.max_total_uses) {
      const tot = await pool.query(
        'SELECT COUNT(*)::int AS n FROM promotion_uses WHERE promotion_id=$1',
        [p.id]
      );
      if (tot.rows[0].n >= p.max_total_uses) continue;
    }
    // Per-shop uses
    const perShop = await pool.query(
      'SELECT COUNT(*)::int AS n FROM promotion_uses WHERE promotion_id=$1 AND shop_id=$2',
      [p.id, shopId]
    );
    const used = perShop.rows[0].n;
    const cap  = p.renewable ? (p.max_uses_per_shop || 999999) : 1;
    if (used >= cap) continue;
    eligible.push(p);
  }
  if (!eligible.length) return null;

  // Calcular descuento efectivo para cada una y elegir la mejor
  let best = null;
  for (const p of eligible) {
    const d = computeDiscount(basePrice, p);
    if (!best || d.discount_amount > best._discount_amount) {
      best = { ...p, _discount_amount: d.discount_amount, _final_amount: d.final_amount, _base: basePrice };
    }
  }
  return best;
}

function computeDiscount(basePrice, promo) {
  let discount = 0;
  if (promo.discount_type === 'percent') {
    discount = Math.floor(basePrice * (parseFloat(promo.discount_value) / 100));
  } else {
    discount = Math.min(parseFloat(promo.discount_value), basePrice);
  }
  discount = Math.max(0, Math.min(discount, basePrice));
  return {
    discount_amount: discount,
    final_amount: basePrice - discount
  };
}

// Devuelve { base, final, discount, promo } para pricing a mostrar/cobrar.
async function priceForShop({ shopId, plan, code = null }) {
  const base = planBasePrice(plan);
  const promo = await getBestPromoForShop({ shopId, plan, code });
  if (!promo) return { base, final: base, discount: 0, promo: null };
  return {
    base,
    final: promo._final_amount,
    discount: promo._discount_amount,
    promo: {
      id: promo.id,
      name: promo.name,
      code: promo.code,
      discount_type: promo.discount_type,
      discount_value: parseFloat(promo.discount_value),
      renewable: promo.renewable
    }
  };
}

async function recordUse({ promotionId, shopId, paymentId, plan, originalAmount, finalAmount }) {
  if (!promotionId || !shopId) return;
  try {
    await pool.query(
      `INSERT INTO promotion_uses (promotion_id, shop_id, payment_id, plan, original_amount, discount_amount, final_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [promotionId, shopId, paymentId || null, plan || null, originalAmount, (originalAmount||0) - (finalAmount||0), finalAmount]
    );
  } catch(e) { console.error('[promo recordUse]', e.message); }
}

module.exports = { planBasePrice, getBestPromoForShop, priceForShop, recordUse, computeDiscount };
