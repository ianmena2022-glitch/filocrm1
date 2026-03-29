const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');

function makeToken(shop) {
  return jwt.sign({ shopId: shop.id, email: shop.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

function shopPayload(shop) {
  return {
    id:            shop.id,
    name:          shop.name,
    email:         shop.email,
    phone:         shop.phone,
    city:          shop.city,
    address:       shop.address,
    calendly_url:  shop.calendly_url,
    wpp_connected: shop.wpp_connected,
  };
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  try {
    const exists = await pool.query('SELECT id FROM shops WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(400).json({ error: 'Ya existe una cuenta con ese email' });

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO shops (name, email, password, phone) VALUES ($1, $2, $3, $4) RETURNING *',
      [name.trim(), email.toLowerCase().trim(), hash, phone || null]
    );
    const shop = result.rows[0];

    // Servicios por defecto
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

module.exports = router;
