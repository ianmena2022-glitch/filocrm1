const router    = require('express').Router();
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const pool      = require('../db/pool');
const rateLimit = require('express-rate-limit');

// Rate limit estricto para login: máx 10 intentos por 15 minutos por IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de login. Esperá 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function makeToken(shop) {
  return jwt.sign(
    {
      shopId:             shop.id,
      email:              shop.email,
      isBarber:           shop.is_barber            || false,
      parentShopId:       shop.parent_shop_id        || null,
      isEnterpriseOwner:  shop.is_enterprise_owner   || false,
      isBranch:           shop.is_branch             || false,
      parentEnterpriseId: shop.parent_enterprise_id  || null,
    },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function shopPayload(shop) {
  return {
    id:                   shop.id,
    name:                 shop.name,
    email:                shop.email,
    phone:                shop.phone,
    city:                 shop.city,
    address:              shop.address,
    wpp_connected:        shop.wpp_connected,
    wpp_had_session:      !!(shop.wpp_session), // true = tuvo WPP pero puede estar caído
    plan:                 shop.plan || 'starter',
    filo_plan:            shop.filo_plan || 'starter',
    is_test:              shop.is_test || shop.plan === 'test',
    is_barber:            shop.is_barber || false,
    parent_shop_id:       shop.parent_shop_id || null,
    commission_enabled:           shop.commission_enabled || false,
    barber_commission_pct:        shop.barber_commission_pct || 50,
    product_sale_commission_pct:  shop.product_sale_commission_pct != null ? parseFloat(shop.product_sale_commission_pct) : null,
    barber_color:         shop.barber_color || '#FFD100',
    subscription_status:  shop.subscription_status || 'trial',
    trial_ends_at:        shop.trial_ends_at || null,
    mp_shop_payment_url:     shop.mp_shop_payment_url || null,
    mp_shop_subscription_id: shop.mp_shop_subscription_id || null,
    mp_shop_status:          shop.mp_shop_status || null,
    is_enterprise_owner:  shop.is_enterprise_owner  || false,
    is_branch:            shop.is_branch            || false,
    parent_enterprise_id: shop.parent_enterprise_id || null,
    branch_label:         shop.branch_label         || null,
  };
}

// Calcular días restantes de trial
function trialDaysLeft(trial_ends_at) {
  if (!trial_ends_at) return 0;
  const diff = new Date(trial_ends_at) - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

// POST /api/auth/register — cuenta normal
router.post('/register', async (req, res) => {
  const { name, email, password, phone, filo_plan, referral_code, ref_slug, timezone } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  try {
    const exists = await pool.query('SELECT id FROM shops WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(400).json({ error: 'Ya existe una cuenta con ese email' });

    const hash = await bcrypt.hash(password, 12);

    // Trial de 7 días
    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + 7);

    // Plan elegido por el usuario
    const validFiloPlans = ['starter', 'staff', 'enterprise'];
    const filoPlan = validFiloPlans.includes(filo_plan) ? filo_plan : 'starter';

    const isEnterpriseOwner = filoPlan === 'enterprise';

    // Resolver vendor por código de referido (opcional)
    let vendorId = null;
    const codeNorm = referral_code ? referral_code.trim().toUpperCase() : null;
    if (codeNorm) {
      const vendorQ = await pool.query('SELECT id FROM vendors WHERE code=$1', [codeNorm]);
      if (vendorQ.rows.length) vendorId = vendorQ.rows[0].id;
    }

    // Resolver referido peer-to-peer (ref_slug = booking_slug del shop que refirió)
    let referredByShopId = null;
    if (ref_slug) {
      const refQ = await pool.query('SELECT id FROM shops WHERE booking_slug=$1', [ref_slug.trim()]);
      if (refQ.rows.length) referredByShopId = refQ.rows[0].id;
    }

    const tz = timezone || 'America/Argentina/Buenos_Aires';
    const result = await pool.query(
      `INSERT INTO shops (name, email, password, phone, plan, filo_plan, trial_ends_at, subscription_status, is_enterprise_owner, vendor_id, referral_code, referred_by_shop_id, timezone)
       VALUES ($1, $2, $3, $4, 'starter', $5, $6, 'trial', $7, $8, $9, $10, $11) RETURNING *`,
      [name.trim(), email.toLowerCase().trim(), hash, phone || null, filoPlan, trialEnds.toISOString(), isEnterpriseOwner, vendorId, codeNorm, referredByShopId, tz]
    );
    const shop = result.rows[0];

    // Las cuentas enterprise owner no necesitan servicios (no hacen reservas)
    if (!isEnterpriseOwner) {
      await pool.query(
        `INSERT INTO services (shop_id, name, price, cost, duration_minutes) VALUES
         ($1, 'Corte de cabello', 3500, 200, 30),
         ($1, 'Corte + barba', 5000, 300, 45),
         ($1, 'Barba', 2000, 150, 20),
         ($1, 'Corte + lavado', 4500, 250, 40)`,
        [shop.id]
      );
    }

    const refLog = vendorId ? ` · ref=${codeNorm} (vendor #${vendorId})` : '';
    console.log(`[REGISTRO] ${email} → plan ${filoPlan} · trial hasta ${trialEnds.toDateString()}${refLog}`);
    res.status(201).json({ token: makeToken(shop), shop: shopPayload(shop) });
  } catch (e) {
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Error al crear la cuenta' });
  }
});

// POST /api/auth/register-enterprise — cuenta madre enterprise (solo gestión)
router.post('/register-enterprise', async (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  try {
    const exists = await pool.query('SELECT id FROM shops WHERE email=$1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(400).json({ error: 'Ya existe una cuenta con ese email' });

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO shops
         (name, email, password, phone, plan, filo_plan,
          subscription_status, trial_ends_at, is_enterprise_owner)
       VALUES ($1,$2,$3,$4,'staff','enterprise','active','2099-12-31',TRUE)
       RETURNING *`,
      [name.trim(), email.toLowerCase().trim(), hash, phone || null]
    );
    const shop = result.rows[0];
    console.log(`[ENTERPRISE] Cuenta madre creada: ${email}`);
    res.status(201).json({ token: makeToken(shop), shop: shopPayload(shop) });
  } catch(e) {
    console.error('Register enterprise error:', e.message);
    res.status(500).json({ error: 'Error al crear la cuenta enterprise' });
  }
});

// POST /api/auth/register-barber — barbero con código de invitación
router.post('/register-barber', async (req, res) => {
  const { name, email, password, invite_code } = req.body;
  if (!name || !email || !password || !invite_code) {
    return res.status(400).json({ error: 'Todos los campos son requeridos' });
  }

  try {
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
router.post('/login', loginLimiter, async (req, res) => {
  try {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
    const result = await pool.query('SELECT * FROM shops WHERE email = $1', [email.toLowerCase().trim()]);
    const shop = result.rows[0];
    if (!shop) return res.status(401).json({ error: 'Email o contraseña incorrectos' });

    const ok = await bcrypt.compare(password, shop.password);
    if (!ok) return res.status(401).json({ error: 'Email o contraseña incorrectos' });

    // Verificar si el trial expiró y aún no tiene suscripción activa
    if (shop.subscription_status === 'trial' && shop.trial_ends_at && new Date(shop.trial_ends_at) < new Date()) {
      await pool.query(
        "UPDATE shops SET subscription_status='expired', expired_at=COALESCE(expired_at, NOW()) WHERE id=$1",
        [shop.id]
      );
      shop.subscription_status = 'expired';
    }

    const payload = shopPayload(shop);
    payload.trial_days_left = trialDaysLeft(shop.trial_ends_at);

    res.json({ token: makeToken(shop), shop: payload });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// GET /api/auth/status — verificar estado de suscripción
router.get('/status', async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query(
      'SELECT subscription_status, trial_ends_at, filo_plan, mp_shop_payment_url FROM shops WHERE id=$1',
      [payload.shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Shop no encontrado' });
    const shop = result.rows[0];

    // Auto-expirar trial si venció
    if (shop.subscription_status === 'trial' && shop.trial_ends_at && new Date(shop.trial_ends_at) < new Date()) {
      await pool.query("UPDATE shops SET subscription_status='expired', expired_at=COALESCE(expired_at, NOW()) WHERE id=$1", [payload.shopId]);
      shop.subscription_status = 'expired';
    }

    res.json({
      subscription_status: shop.subscription_status,
      trial_days_left: trialDaysLeft(shop.trial_ends_at),
      filo_plan: shop.filo_plan || 'starter',
      payment_url: shop.mp_shop_payment_url || null,
      has_access: shop.subscription_status === 'trial' || shop.subscription_status === 'active'
    });
  } catch (e) {
    res.status(401).json({ error: 'Token inválido' });
  }
});

// POST /api/auth/setup-test
router.post('/setup-test', async (req, res) => {
  const { secret, password } = req.body;
  if (secret !== process.env.JWT_SECRET) return res.status(403).json({ error: 'No autorizado' });

  try {
    const hash = await bcrypt.hash(password || 'filo2026test', 12);
    await pool.query(
      `UPDATE shops SET password=$1, plan='test', is_test=TRUE, subscription_status='active'
       WHERE email IN ('ian@filocrm.com','socio@filocrm.com')`,
      [hash]
    );
    res.json({ ok: true, message: 'Cuentas test actualizadas' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// DELETE /api/auth/delete-account — borrar cuenta permanentemente
router.delete('/delete-account', async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const shopId = payload.shopId;

    // Cancelar suscripción en MP si existe
    const shopData = await pool.query(
      'SELECT mp_shop_subscription_id FROM shops WHERE id=$1',
      [shopId]
    );
    const subId = shopData.rows[0]?.mp_shop_subscription_id;
    if (subId) {
      try {
        const mpToken = process.env.MP_ACCESS_TOKEN;
        await fetch(`https://api.mercadopago.com/preapproval/${subId}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${mpToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'cancelled' })
        });
      } catch(mpErr) {
        console.error('MP cancel error:', mpErr.message);
      }
    }

    // Borrar el shop (CASCADE borra todo lo relacionado)
    await pool.query('DELETE FROM shops WHERE id=$1', [shopId]);
    console.log(`[DELETE] Shop ${shopId} eliminado permanentemente`);
    res.json({ ok: true });
  } catch (e) {
    console.error('Delete account error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/me — devuelve el shop actualizado desde la DB
router.get('/me', async (req, res) => {
  const header = req.headers.authorization || '';
  const tkn = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!tkn) return res.status(401).json({ error: 'Token requerido' });
  try {
    const payload = jwt.verify(tkn, process.env.JWT_SECRET);
    const result = await pool.query('SELECT * FROM shops WHERE id=$1', [payload.shopId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Shop no encontrado' });
    const shop = result.rows[0];
    if (shop.subscription_status === 'trial' && shop.trial_ends_at && new Date(shop.trial_ends_at) < new Date()) {
      await pool.query("UPDATE shops SET subscription_status='expired', expired_at=COALESCE(expired_at, NOW()) WHERE id=$1", [payload.shopId]);
      shop.subscription_status = 'expired';
    }
    const shopData = shopPayload(shop);
    shopData.trial_days_left = trialDaysLeft(shop.trial_ends_at);
    res.json({ shop: shopData });
  } catch (e) {
    res.status(401).json({ error: 'Token inválido' });
  }
});

module.exports = router;
