const router = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');

const ADMIN_SECRET = process.env.ADMIN_PASSWORD || 'filo-admin-2026';

// Rate limiting simple para login admin (máx 10 intentos por IP cada 15 min)
const loginAttempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 10;
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count > maxAttempts;
}

// Middleware de autenticación admin
function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload.isAdmin) return res.status(401).json({ error: 'No autorizado' });
    next();
  } catch(e) {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// POST /api/admin/login
router.post('/login', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos.' });
  }
  const { password } = req.body;
  if (!password || password !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const token = jwt.sign({ isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

// GET /api/admin/accounts — listar todas las cuentas con jerarquía (sucursales y barberos)
router.get('/accounts', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        s.id, s.name, s.email, s.phone, s.city,
        s.filo_plan, s.plan, s.subscription_status,
        s.trial_ends_at, s.expired_at, s.created_at,
        s.wpp_connected,
        s.mp_shop_subscription_id, s.mp_shop_status,
        s.is_test,
        s.is_barber, s.is_branch, s.is_enterprise_owner,
        s.parent_shop_id, s.parent_enterprise_id,
        s.barber_commission_pct,
        COALESCE(s.free_months, 0) AS free_months,
        COUNT(b.id)  FILTER (WHERE b.is_barber = TRUE) AS barber_count,
        COUNT(br.id) FILTER (WHERE br.is_branch = TRUE) AS branch_count
      FROM shops s
      LEFT JOIN shops b  ON b.parent_shop_id       = s.id AND b.is_barber = TRUE
      LEFT JOIN shops br ON br.parent_enterprise_id = s.id AND br.is_branch = TRUE
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);
    res.json({ accounts: result.rows });
  } catch(e) {
    console.error('Admin GET accounts:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/peer-referrals — ranking de referidos peer-to-peer
router.get('/peer-referrals', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        r.id, r.name, r.email, r.booking_slug,
        COUNT(s.id)::int                                                                    AS total_referred,
        COUNT(s.id) FILTER (WHERE s.subscription_status = 'active')::int                   AS active_referred,
        COUNT(s.id) FILTER (WHERE s.subscription_status = 'trial')::int                    AS trial_referred,
        COUNT(s.id) FILTER (WHERE s.ref_bonus_granted = TRUE)::int                         AS bonuses_granted,
        MAX(s.created_at)                                                                   AS last_referral_at
      FROM shops r
      LEFT JOIN shops s ON s.referred_by_shop_id = r.id
      WHERE r.is_barber = FALSE AND r.is_branch = FALSE
      GROUP BY r.id
      HAVING COUNT(s.id) > 0
      ORDER BY COUNT(s.id) DESC
      LIMIT 100
    `);
    res.json({ referrers: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── VENDEDORES / REFERIDOS ────────────────────────────────────────────────────

// Precio del primer mes por plan
function planPrice(filo_plan) {
  if (filo_plan === 'enterprise') return 130000;
  if (filo_plan === 'staff')      return 80000;
  return 40000; // starter
}

// GET /api/admin/vendors
router.get('/vendors', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.id, v.name, v.email, v.code, v.commission_pct, v.created_at,
             COUNT(s.id) FILTER (WHERE s.id IS NOT NULL AND COALESCE(s.is_barber,FALSE)=FALSE AND COALESCE(s.is_branch,FALSE)=FALSE)::int AS referred_count,
             COUNT(s.id) FILTER (WHERE COALESCE(s.is_barber,FALSE)=FALSE AND COALESCE(s.is_branch,FALSE)=FALSE AND s.subscription_status='active')::int AS paying_count
      FROM vendors v
      LEFT JOIN shops s ON s.vendor_id = v.id
      GROUP BY v.id
      ORDER BY v.created_at DESC
    `);
    // Comisión one-time: se cobra una sola vez por el primer pago de cada cuenta referida
    const vendors = await Promise.all(result.rows.map(async v => {
      const pct = v.commission_pct || 20;

      // Todas las cuentas que alguna vez pagaron (first_payment_at o ya active antes de la migración)
      const totalQ = await pool.query(
        `SELECT filo_plan FROM shops
         WHERE vendor_id=$1
           AND (first_payment_at IS NOT NULL OR subscription_status='active')
           AND COALESCE(is_barber,FALSE)=FALSE AND COALESCE(is_branch,FALSE)=FALSE`,
        [v.id]
      );
      const commission_total = totalQ.rows.reduce((sum, s) =>
        sum + Math.round(planPrice(s.filo_plan) * pct / 100), 0);

      // Solo las que pagaron por primera vez este mes
      const monthQ = await pool.query(
        `SELECT filo_plan FROM shops
         WHERE vendor_id=$1 AND first_payment_at >= date_trunc('month', NOW())
           AND COALESCE(is_barber,FALSE)=FALSE AND COALESCE(is_branch,FALSE)=FALSE`,
        [v.id]
      );
      const commission_month = monthQ.rows.reduce((sum, s) =>
        sum + Math.round(planPrice(s.filo_plan) * pct / 100), 0);
      const new_this_month = monthQ.rows.length;

      return { ...v, commission_total, commission_month, new_this_month };
    }));
    res.json({ vendors });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/vendors/:id/accounts — cuentas referidas por un vendedor
router.get('/vendors/:id/accounts', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, filo_plan, subscription_status, trial_ends_at, created_at
       FROM shops
       WHERE vendor_id=$1 AND COALESCE(is_barber,FALSE)=FALSE AND COALESCE(is_branch,FALSE)=FALSE
       ORDER BY subscription_status='active' DESC, created_at DESC`,
      [req.params.id]
    );
    const accounts = result.rows.map(s => ({
      ...s,
      monthly_price: planPrice(s.filo_plan),
      is_paying: s.subscription_status === 'active'
    }));
    res.json({ accounts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/vendors
router.post('/vendors', adminAuth, async (req, res) => {
  const { name, email, code, commission_pct, password } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Nombre y código son requeridos' });
  const codeNorm = code.trim().toUpperCase().replace(/\s+/g, '');
  try {
    const exists = await pool.query('SELECT id FROM vendors WHERE code=$1', [codeNorm]);
    if (exists.rows.length) return res.status(400).json({ error: 'Ya existe un vendedor con ese código' });
    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    const result = await pool.query(
      'INSERT INTO vendors (name, email, code, commission_pct, password) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name.trim(), email?.trim() || null, codeNorm, commission_pct || 20, passwordHash]
    );
    res.json({ vendor: result.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/vendors/:id
router.put('/vendors/:id', adminAuth, async (req, res) => {
  const { name, email, code, commission_pct, password } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Nombre y código son requeridos' });
  const codeNorm = code.trim().toUpperCase().replace(/\s+/g, '');
  try {
    const conflict = await pool.query('SELECT id FROM vendors WHERE code=$1 AND id<>$2', [codeNorm, req.params.id]);
    if (conflict.rows.length) return res.status(400).json({ error: 'Ese código ya está en uso por otro vendedor' });
    const params = [name.trim(), email?.trim() || null, codeNorm, commission_pct || 20];
    let query;
    if (password) {
      const passwordHash = await bcrypt.hash(password, 12);
      params.push(passwordHash);
      params.push(req.params.id);
      query = 'UPDATE vendors SET name=$1, email=$2, code=$3, commission_pct=$4, password=$5 WHERE id=$6 RETURNING *';
    } else {
      params.push(req.params.id);
      query = 'UPDATE vendors SET name=$1, email=$2, code=$3, commission_pct=$4 WHERE id=$5 RETURNING *';
    }
    const result = await pool.query(query, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Vendedor no encontrado' });
    res.json({ vendor: result.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/vendors/:id
router.delete('/vendors/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE shops SET vendor_id=NULL WHERE vendor_id=$1', [req.params.id]);
    await pool.query('DELETE FROM vendors WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/accounts — crear cuenta nueva
router.post('/accounts', adminAuth, async (req, res) => {
  const { name, email, phone, password, filo_plan, subscription_status } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }

  try {
    const exists = await pool.query('SELECT id FROM shops WHERE email=$1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(400).json({ error: 'Ya existe una cuenta con ese email' });

    const hash = await bcrypt.hash(password, 12);
    const validPlans = ['starter','staff','enterprise'];
    const plan = validPlans.includes(filo_plan) ? filo_plan : 'starter';
    const status = ['trial','active'].includes(subscription_status) ? subscription_status : 'trial';

    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + 7);

    const result = await pool.query(
      `INSERT INTO shops (name, email, password, phone, plan, filo_plan, subscription_status, trial_ends_at)
       VALUES ($1, $2, $3, $4, 'starter', $5, $6, $7) RETURNING id, name, email, filo_plan, subscription_status`,
      [name.trim(), email.toLowerCase().trim(), hash, phone||null, plan, status, trialEnds.toISOString()]
    );

    // Servicios de ejemplo
    await pool.query(
      `INSERT INTO services (shop_id, name, price, cost, duration_minutes) VALUES
       ($1, 'Corte de cabello', 3500, 200, 30),
       ($1, 'Corte + barba', 5000, 300, 45),
       ($1, 'Barba', 2000, 150, 20)`,
      [result.rows[0].id]
    );

    console.log(`[ADMIN] Cuenta creada: ${email} → ${plan}`);
    res.status(201).json({ ok: true, account: result.rows[0] });
  } catch(e) {
    console.error('Admin POST accounts:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/accounts/:id — editar plan/estado
router.put('/accounts/:id', adminAuth, async (req, res) => {
  const { name, filo_plan, subscription_status } = req.body;
  const validPlans   = ['starter','staff','enterprise'];
  const validStatus  = ['trial','active','expired','cancelled'];

  try {
    const updates = [];
    const params  = [];
    let i = 1;

    if (name)                              { updates.push(`name=$${i++}`);                  params.push(name.trim()); }
    if (validPlans.includes(filo_plan))    { updates.push(`filo_plan=$${i++}`);             params.push(filo_plan); }
    if (validStatus.includes(subscription_status)) {
      updates.push(`subscription_status=$${i++}`);
      params.push(subscription_status);
      // Si se activa manualmente, marcar como activo y registrar primer pago si no existe
      if (subscription_status === 'active') {
        updates.push(`mp_shop_status=$${i++}`);
        params.push('authorized');
        updates.push(`first_payment_at=COALESCE(first_payment_at, NOW())`);
      }
    }

    if (!updates.length) return res.status(400).json({ error: 'Nada que actualizar' });

    params.push(req.params.id);
    await pool.query(
      `UPDATE shops SET ${updates.join(',')} WHERE id=$${i} AND (is_barber=FALSE OR is_barber IS NULL)`,
      params
    );

    console.log(`[ADMIN] Cuenta ${req.params.id} actualizada`);
    res.json({ ok: true });
  } catch(e) {
    console.error('Admin PUT accounts:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/accounts/:id — borrar cuenta
router.delete('/accounts/:id', adminAuth, async (req, res) => {
  try {
    // No permitir borrar cuentas test
    const shop = await pool.query('SELECT is_test FROM shops WHERE id=$1', [req.params.id]);
    if (!shop.rows.length) return res.status(404).json({ error: 'Cuenta no encontrada' });
    if (shop.rows[0].is_test) return res.status(403).json({ error: 'No se pueden borrar cuentas de test' });

    await pool.query('DELETE FROM shops WHERE id=$1', [req.params.id]);
    console.log(`[ADMIN] Cuenta ${req.params.id} eliminada`);
    res.json({ ok: true });
  } catch(e) {
    console.error('Admin DELETE accounts:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/grant-free-months — sumar meses gratis a un usuario
router.post('/grant-free-months', adminAuth, async (req, res) => {
  const { shop_id, months } = req.body;
  if (!shop_id || !months || months < 1 || months > 12) {
    return res.status(400).json({ error: 'shop_id y months (1-12) son requeridos' });
  }
  try {
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS free_months INT DEFAULT 0`).catch(() => {});
    const result = await pool.query(
      `UPDATE shops SET free_months = COALESCE(free_months, 0) + $1 WHERE id = $2
       RETURNING id, name, free_months`,
      [parseInt(months), parseInt(shop_id)]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Shop no encontrado' });
    const shop = result.rows[0];
    console.log(`[ADMIN] +${months} mes${months > 1 ? 'es' : ''} gratis a shop ${shop_id} (${shop.name}). Total: ${shop.free_months}`);
    res.json({ ok: true, free_months: shop.free_months, name: shop.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AFILIADOS ─────────────────────────────────────────────────────────────────

// GET /api/admin/affiliates — lista de afiliados con stats
router.get('/affiliates', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        a.id, a.name, a.email, a.code, a.bank_info, a.status,
        a.total_earned, a.total_paid, a.created_at,
        COUNT(ac.id)                                              AS total_referrals,
        COALESCE(SUM(ac.amount) FILTER (WHERE ac.status='pending'), 0) AS pending_amount,
        COALESCE(SUM(ac.amount) FILTER (WHERE ac.status='paid'),    0) AS paid_amount
      FROM affiliates a
      LEFT JOIN affiliate_commissions ac ON ac.affiliate_id = a.id
      GROUP BY a.id
      ORDER BY a.created_at DESC
    `);
    res.json({ affiliates: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/affiliates/:id/commissions
router.get('/affiliates/:id/commissions', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, shop_name, plan, amount, status, created_at, paid_at
       FROM affiliate_commissions WHERE affiliate_id=$1
       ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ commissions: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/affiliates/commissions/:id/pay — marcar una comisión como pagada
router.post('/affiliates/commissions/:id/pay', adminAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE affiliate_commissions SET status='paid', paid_at=NOW()
       WHERE id=$1 AND status='pending'
       RETURNING affiliate_id, amount`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Comisión no encontrada o ya pagada' });
    // Actualizar total_paid del afiliado
    await pool.query(
      'UPDATE affiliates SET total_paid = total_paid + $1 WHERE id=$2',
      [r.rows[0].amount, r.rows[0].affiliate_id]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/affiliates/:id/pay-all — marcar todas las pendientes como pagadas
router.post('/affiliates/:id/pay-all', adminAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE affiliate_commissions SET status='paid', paid_at=NOW()
       WHERE affiliate_id=$1 AND status='pending'
       RETURNING amount`,
      [req.params.id]
    );
    const total = r.rows.reduce((s, row) => s + parseFloat(row.amount), 0);
    await pool.query(
      'UPDATE affiliates SET total_paid = total_paid + $1 WHERE id=$2',
      [total, req.params.id]
    );
    res.json({ ok: true, count: r.rows.length, total });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/accounts/:id/wpp-reset — limpiar sesión WhatsApp de un shop
router.post('/accounts/:id/wpp-reset', adminAuth, async (req, res) => {
  try {
    const wpp = require('../services/whatsapp');
    await wpp.clearSession(parseInt(req.params.id));
    res.json({ ok: true, message: `Sesión WhatsApp limpiada para shop #${req.params.id}` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
