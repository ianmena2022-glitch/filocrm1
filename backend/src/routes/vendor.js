const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const pool   = require('../db/pool');

function planPrice(p) {
  if (p === 'enterprise') return 130000;
  if (p === 'staff')      return 80000;
  return 40000;
}

// Middleware de autenticación para vendedores
function vendorAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload.isVendor) return res.status(401).json({ error: 'No autorizado' });
    req.vendorId = payload.vendorId;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// POST /api/vendor/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  try {
    const result = await pool.query(
      'SELECT * FROM vendors WHERE LOWER(email)=LOWER($1)',
      [email.trim()]
    );
    const v = result.rows[0];
    if (!v || !v.password) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    const ok = await bcrypt.compare(password, v.password);
    if (!ok) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const token = jwt.sign(
      { isVendor: true, vendorId: v.id },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vendor/me
router.get('/me', vendorAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, code, commission_pct, created_at FROM vendors WHERE id=$1',
      [req.vendorId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Vendedor no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vendor/stats
router.get('/stats', vendorAuth, async (req, res) => {
  try {
    const vResult = await pool.query(
      'SELECT id, name, email, code, commission_pct FROM vendors WHERE id=$1',
      [req.vendorId]
    );
    if (!vResult.rows.length) return res.status(404).json({ error: 'Vendedor no encontrado' });
    const vendor = vResult.rows[0];
    const pct = vendor.commission_pct || 20;

    // Cuentas referidas (excluye barberos y sucursales)
    const accountsResult = await pool.query(
      `SELECT id, name, email, filo_plan, subscription_status, first_payment_at, created_at
       FROM shops
       WHERE vendor_id=$1
         AND COALESCE(is_barber,FALSE)=FALSE
         AND COALESCE(is_branch,FALSE)=FALSE
       ORDER BY subscription_status='active' DESC, created_at DESC`,
      [req.vendorId]
    );

    const accounts = accountsResult.rows.map(s => {
      const is_paying = s.subscription_status === 'active';
      const monthly_price = planPrice(s.filo_plan);
      const commission_earned = is_paying ? Math.round(monthly_price * pct / 100) : 0;
      return { ...s, monthly_price, is_paying, commission_earned };
    });

    // referred_count
    const referred_count = accounts.length;

    // paying_count
    const paying_count = accounts.filter(a => a.subscription_status === 'active').length;

    // commission_total: cuentas que alguna vez pagaron
    const totalQ = await pool.query(
      `SELECT filo_plan FROM shops
       WHERE vendor_id=$1
         AND (first_payment_at IS NOT NULL OR subscription_status='active')
         AND COALESCE(is_barber,FALSE)=FALSE
         AND COALESCE(is_branch,FALSE)=FALSE`,
      [req.vendorId]
    );
    const commission_total = totalQ.rows.reduce(
      (sum, s) => sum + Math.round(planPrice(s.filo_plan) * pct / 100), 0
    );

    // commission_month + new_this_month: primer pago este mes
    const monthQ = await pool.query(
      `SELECT filo_plan FROM shops
       WHERE vendor_id=$1
         AND first_payment_at >= date_trunc('month', NOW())
         AND COALESCE(is_barber,FALSE)=FALSE
         AND COALESCE(is_branch,FALSE)=FALSE`,
      [req.vendorId]
    );
    const commission_month = monthQ.rows.reduce(
      (sum, s) => sum + Math.round(planPrice(s.filo_plan) * pct / 100), 0
    );
    const new_this_month = monthQ.rows.length;

    res.json({
      vendor,
      referred_count,
      paying_count,
      commission_total,
      commission_month,
      new_this_month,
      accounts
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
