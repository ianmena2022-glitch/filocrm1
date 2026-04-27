const router  = require('express').Router();
const pool    = require('../db/pool');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

// Comisión one-time por plan (primer pago del shop referido)
const COMMISSIONS = {
  starter:    24000,
  staff:      48000,
  enterprise: 78000,
};

// ── Crear tablas si no existen ────────────────────────────────────────────────
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS affiliates (
      id           SERIAL PRIMARY KEY,
      name         VARCHAR(255) NOT NULL,
      email        VARCHAR(255) UNIQUE NOT NULL,
      password     VARCHAR(255) NOT NULL,
      phone        VARCHAR(50),
      code         VARCHAR(30) UNIQUE NOT NULL,
      promo_method TEXT,
      bank_info    TEXT,
      status       VARCHAR(20) DEFAULT 'active',
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      total_earned NUMERIC(10,2) DEFAULT 0,
      total_paid   NUMERIC(10,2) DEFAULT 0
    )
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS affiliate_commissions (
      id           SERIAL PRIMARY KEY,
      affiliate_id INT REFERENCES affiliates(id) ON DELETE CASCADE,
      shop_id      INT REFERENCES shops(id) ON DELETE SET NULL,
      shop_name    VARCHAR(255),
      plan         VARCHAR(20),
      amount       NUMERIC(10,2),
      status       VARCHAR(20) DEFAULT 'pending',
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      paid_at      TIMESTAMPTZ
    )
  `).catch(() => {});

  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS affiliate_id INT REFERENCES affiliates(id) ON DELETE SET NULL`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_shops_affiliate ON shops(affiliate_id)`).catch(() => {});
}
ensureTables();

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeToken(aff) {
  return jwt.sign({ affId: aff.id, email: aff.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

function payload(aff) {
  return {
    id:           aff.id,
    name:         aff.name,
    email:        aff.email,
    phone:        aff.phone        || null,
    code:         aff.code,
    bank_info:    aff.bank_info    || null,
    promo_method: aff.promo_method || null,
    status:       aff.status,
    total_earned: parseFloat(aff.total_earned) || 0,
    total_paid:   parseFloat(aff.total_paid)   || 0,
    created_at:   aff.created_at,
  };
}

function genCode(name) {
  const base = name.trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8)
    .toUpperCase();
  const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${base}${suffix}`;
}

function affAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    if (!p.affId) return res.status(401).json({ error: 'Token inválido' });
    req.affId = p.affId;
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
}

// ── POST /api/affiliates/register ─────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { name, email, password, phone, promo_method, bank_info } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
  if (password.length < 6)          return res.status(400).json({ error: 'Contraseña mínimo 6 caracteres' });
  if (!bank_info?.trim())           return res.status(400).json({ error: 'CBU/Alias para cobros es requerido' });

  try {
    const exists = await pool.query('SELECT id FROM affiliates WHERE email=$1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(400).json({ error: 'Ya existe una cuenta con ese email' });

    const hash = await bcrypt.hash(password, 12);
    let code = genCode(name);
    const ck = await pool.query('SELECT id FROM affiliates WHERE code=$1', [code]);
    if (ck.rows.length) code += Math.random().toString(36).slice(2, 4).toUpperCase();

    const r = await pool.query(
      `INSERT INTO affiliates (name, email, password, phone, code, promo_method, bank_info)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name.trim(), email.toLowerCase().trim(), hash, phone || null, code, promo_method || null, bank_info.trim()]
    );
    const aff = r.rows[0];
    console.log(`[AFFILIATE] Nuevo afiliado: ${email} → código ${code}`);
    res.status(201).json({ token: makeToken(aff), affiliate: payload(aff) });
  } catch (e) {
    console.error('Affiliate register:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/affiliates/login ────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  try {
    const r = await pool.query('SELECT * FROM affiliates WHERE email=$1', [email.toLowerCase().trim()]);
    const aff = r.rows[0];
    if (!aff) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    const ok = await bcrypt.compare(password, aff.password);
    if (!ok)  return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    res.json({ token: makeToken(aff), affiliate: payload(aff) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/affiliates/me ────────────────────────────────────────────────────
router.get('/me', affAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM affiliates WHERE id=$1', [req.affId]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado' });

    const stats = await pool.query(
      `SELECT
         COUNT(*)                                              AS total_referrals,
         COUNT(*) FILTER (WHERE status='pending')             AS pending_count,
         COUNT(*) FILTER (WHERE status='paid')                AS paid_count,
         COALESCE(SUM(amount) FILTER (WHERE status='pending'), 0) AS pending_amount,
         COALESCE(SUM(amount) FILTER (WHERE status='paid'),    0) AS paid_amount
       FROM affiliate_commissions WHERE affiliate_id=$1`,
      [req.affId]
    );

    const comms = await pool.query(
      `SELECT id, shop_name, plan, amount, status, created_at, paid_at
       FROM affiliate_commissions WHERE affiliate_id=$1
       ORDER BY created_at DESC LIMIT 30`,
      [req.affId]
    );

    const s = stats.rows[0];
    res.json({
      affiliate: payload(r.rows[0]),
      stats: {
        total_referrals:  parseInt(s.total_referrals)  || 0,
        pending_count:    parseInt(s.pending_count)    || 0,
        paid_count:       parseInt(s.paid_count)       || 0,
        pending_amount:   parseFloat(s.pending_amount) || 0,
        paid_amount:      parseFloat(s.paid_amount)    || 0,
      },
      commissions: comms.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Función exportable: acreditar comisión cuando shop referido paga ──────────
async function creditAffiliateCommission(shopId, plan) {
  try {
    const shopRes = await pool.query('SELECT affiliate_id, name FROM shops WHERE id=$1', [shopId]);
    const shop = shopRes.rows[0];
    if (!shop?.affiliate_id) return;

    // Solo una comisión por shop (primer pago)
    const existing = await pool.query(
      'SELECT id FROM affiliate_commissions WHERE shop_id=$1', [shopId]
    );
    if (existing.rows.length) return;

    const amount = COMMISSIONS[plan] || 0;
    if (!amount) return;

    await pool.query(
      `INSERT INTO affiliate_commissions (affiliate_id, shop_id, shop_name, plan, amount)
       VALUES ($1,$2,$3,$4,$5)`,
      [shop.affiliate_id, shopId, shop.name, plan, amount]
    );
    await pool.query(
      'UPDATE affiliates SET total_earned = total_earned + $1 WHERE id=$2',
      [amount, shop.affiliate_id]
    );
    console.log(`[AFFILIATE] +$${amount} a afiliado ${shop.affiliate_id} por shop ${shopId} plan ${plan}`);
  } catch (e) {
    console.error('[AFFILIATE] creditCommission error:', e.message);
  }
}

module.exports = router;
module.exports.creditAffiliateCommission = creditAffiliateCommission;
module.exports.COMMISSIONS = COMMISSIONS;
