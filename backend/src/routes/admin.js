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
        s.trial_ends_at, s.created_at,
        s.wpp_connected,
        s.mp_shop_subscription_id, s.mp_shop_status,
        s.is_test,
        s.is_barber, s.is_branch, s.is_enterprise_owner,
        s.parent_shop_id, s.parent_enterprise_id,
        s.barber_commission_pct,
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
  const { name, email, code, commission_pct } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Nombre y código son requeridos' });
  const codeNorm = code.trim().toUpperCase().replace(/\s+/g, '');
  try {
    const exists = await pool.query('SELECT id FROM vendors WHERE code=$1', [codeNorm]);
    if (exists.rows.length) return res.status(400).json({ error: 'Ya existe un vendedor con ese código' });
    const result = await pool.query(
      'INSERT INTO vendors (name, email, code, commission_pct) VALUES ($1,$2,$3,$4) RETURNING *',
      [name.trim(), email?.trim() || null, codeNorm, commission_pct || 20]
    );
    res.json({ vendor: result.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/vendors/:id
router.put('/vendors/:id', adminAuth, async (req, res) => {
  const { name, email, code, commission_pct } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Nombre y código son requeridos' });
  const codeNorm = code.trim().toUpperCase().replace(/\s+/g, '');
  try {
    const conflict = await pool.query('SELECT id FROM vendors WHERE code=$1 AND id<>$2', [codeNorm, req.params.id]);
    if (conflict.rows.length) return res.status(400).json({ error: 'Ese código ya está en uso por otro vendedor' });
    const result = await pool.query(
      'UPDATE vendors SET name=$1, email=$2, code=$3, commission_pct=$4 WHERE id=$5 RETURNING *',
      [name.trim(), email?.trim() || null, codeNorm, commission_pct || 20, req.params.id]
    );
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

module.exports = router;
