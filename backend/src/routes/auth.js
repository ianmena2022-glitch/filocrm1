const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');

function makeToken(shop) {
  return jwt.sign(
    { shopId: shop.id, email: shop.email, isBarber: shop.is_barber || false, parentShopId: shop.parent_shop_id || null },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function shopPayload(shop) {
  return {
    id:               shop.id,
    name:             shop.name,
    email:            shop.email,
    phone:            shop.phone,
    city:             shop.city,
    address:          shop.address,
    wpp_connected:    shop.wpp_connected,
    plan:             shop.plan || 'starter',
    is_test:          shop.is_test || shop.plan === 'test',
    is_barber:        shop.is_barber || false,
    parent_shop_id:   shop.parent_shop_id || null,
    commission_enabled: shop.commission_enabled || false,
    barber_commission_pct: shop.barber_commission_pct || 50,
    barber_color:     shop.barber_color || '#FFD100',
  };
}

// POST /api/auth/register — cuenta normal
router.post('/register', async (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  try {
    const exists = await pool.query('SELECT id FROM shops WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(400).json({ error: 'Ya existe una cuenta con ese email' });

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO shops (name, email, password, phone, plan) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name.trim(), email.toLowerCase().trim(), hash, phone || null, 'starter']
    );
    const shop = result.rows[0];

    await pool.query(
      `INSERT INTO services (shop_id, name, price, cost, duration_minutes) VALUES
       ($1, 'Corte de cabello', 3500, 200, 30),
       ($1, 'Corte + barba', 5000, 300, 45),
       ($1, 'Barba', 2000, 150, 20),
       ($1, 'Corte + lavado', 4500, 250, 40)`,
      [shop.id]
    );

    res.status(201).json({ token: makeToken(shop), shop: shopPayload(shop) });
  } catch (e) {
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Error al crear la cuenta' });
  }
});

// POST /api/auth/register-barber — barbero con código de invitación
router.post('/register-barber', async (req, res) => {
  const { name, email, password, invite_code } = req.body;
  if (!name || !email || !password || !invite_code) {
    return res.status(400).json({ error: 'Todos los campos son requeridos' });
  }

  try {
    // Verificar código de invitación
    const invite = await pool.query(
      'SELECT * FROM staff_invites WHERE code=$1 AND used=FALSE AND expires_at > NOW()',
      [invite_code.toUpperCase()]
    );
    if (!invite.rows.length) return res.status(400).json({ error: 'Código de invitación inválido o expirado' });
    const inv = invite.rows[0];

    const exists = await pool.query('SELECT id FROM shops WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(400).json({ error: 'Ya existe una cuenta con ese email' });

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO shops (name, email, password, plan, is_barber, parent_shop_id)
       VALUES ($1, $2, $3, 'staff', TRUE, $4) RETURNING *`,
      [name.trim(), email.toLowerCase().trim(), hash, inv.shop_id]
    );
    const shop = result.rows[0];

    // Marcar invitación como usada
    await pool.query(
      'UPDATE staff_invites SET used=TRUE, used_by=$1 WHERE id=$2',
      [shop.id, inv.id]
    );

    res.status(201).json({ token: makeToken(shop), shop: shopPayload(shop) });
  } catch (e) {
    console.error('Register barber error:', e.message);
    res.status(500).json({ error: 'Error al crear la cuenta' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

  try {
    const result = await pool.query('SELECT * FROM shops WHERE email = $1', [email.toLowerCase().trim()]);
    const shop = result.rows[0];
    if (!shop) return res.status(401).json({ error: 'Email o contraseña incorrectos' });

    const ok = await bcrypt.compare(password, shop.password);
    if (!ok) return res.status(401).json({ error: 'Email o contraseña incorrectos' });

    res.json({ token: makeToken(shop), shop: shopPayload(shop) });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// POST /api/auth/setup-test — crear cuentas test con password real (solo en dev o con secret)
router.post('/setup-test', async (req, res) => {
  const { secret, password } = req.body;
  if (secret !== process.env.JWT_SECRET) return res.status(403).json({ error: 'No autorizado' });

  try {
    const hash = await bcrypt.hash(password || 'filo2026test', 12);
    await pool.query(
      `UPDATE shops SET password=$1, plan='test', is_test=TRUE WHERE email IN ('ian@filocrm.com','socio@filocrm.com')`,
      [hash]
    );
    res.json({ ok: true, message: 'Cuentas test actualizadas' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
