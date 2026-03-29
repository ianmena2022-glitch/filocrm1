const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');

// Almacén temporal de códigos de verificación (en memoria)
// { phone: { code, expires, shopId } }
const verifyCodes = {};

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendVerificationCode(shopId, phone, code) {
  try {
    const wpp = require('../services/whatsapp');
    const msg = `🔐 *Tu código de verificación FILO es:*

*${code}*

Válido por 10 minutos. No lo compartas con nadie.`;
    await wpp.sendText(shopId, phone, msg);
    return true;
  } catch(e) {
    console.error('Error enviando código WPP:', e.message);
    return false;
  }
}

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

    const token = makeToken(shop);
    const payload = shopPayload(shop);

    // Intentar enviar código de verificación por WhatsApp
    let verificationSent = false;
    if (phone) {
      const code = generateCode();
      verifyCodes[phone] = { code, expires: Date.now() + 10 * 60 * 1000, shopId: shop.id };
      // Usar shopId=1 (sistema) para enviar — si hay un shop con WPP conectado
      try {
        const sysShop = await pool.query('SELECT id FROM shops WHERE wpp_connected=TRUE LIMIT 1');
        if (sysShop.rows.length) {
          verificationSent = await sendVerificationCode(sysShop.rows[0].id, phone, code);
        }
      } catch(e) { console.error('WPP verify error:', e.message); }
    }

    res.status(201).json({ token, shop: payload, verification_sent: verificationSent });
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

// POST /api/auth/verify-code
router.post('/verify-code', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Teléfono y código requeridos' });

  const entry = verifyCodes[phone];
  if (!entry) return res.status(400).json({ error: 'Código no encontrado. Solicitá uno nuevo.' });
  if (Date.now() > entry.expires) {
    delete verifyCodes[phone];
    return res.status(400).json({ error: 'El código expiró. Solicitá uno nuevo.' });
  }
  if (entry.code !== String(code)) return res.status(400).json({ error: 'Código incorrecto' });

  // Marcar teléfono como verificado en la DB
  await pool.query('UPDATE shops SET phone=$1 WHERE id=$2', [phone, entry.shopId]);
  delete verifyCodes[phone];
  res.json({ ok: true });
});

// POST /api/auth/resend-code
router.post('/resend-code', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Teléfono requerido' });

  try {
    const shop = await pool.query('SELECT id FROM shops WHERE phone=$1', [phone]);
    if (!shop.rows.length) return res.status(404).json({ error: 'Cuenta no encontrada' });

    const code = generateCode();
    verifyCodes[phone] = { code, expires: Date.now() + 10 * 60 * 1000, shopId: shop.rows[0].id };

    const sysShop = await pool.query('SELECT id FROM shops WHERE wpp_connected=TRUE LIMIT 1');
    if (!sysShop.rows.length) return res.status(503).json({ error: 'WhatsApp no disponible para enviar código' });

    const sent = await sendVerificationCode(sysShop.rows[0].id, phone, code);
    if (!sent) return res.status(500).json({ error: 'No se pudo enviar el código' });

    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
