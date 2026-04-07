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
    id:                   shop.id,
    name:                 shop.name,
    email:                shop.email,
    phone:                shop.phone,
    city:                 shop.city,
    address:              shop.address,
    wpp_connected:        shop.wpp_connected,
    plan:                 shop.plan || 'starter',
    filo_plan:            shop.filo_plan || 'starter',
    is_test:              shop.is_test || shop.plan === 'test',
    is_barber:            shop.is_barber || false,
    parent_shop_id:       shop.parent_shop_id || null,
    commission_enabled:   shop.commission_enabled || false,
    barber_commission_pct: shop.barber_commission_pct || 50,
    barber_color:         shop.barber_color || '#FFD100',
    subscription_status:  shop.subscription_status || 'trial',
    trial_ends_at:        shop.trial_ends_at || null,
    mp_shop_payment_url:     shop.mp_shop_payment_url || null,
    mp_shop_subscription_id: shop.mp_shop_subscription_id || null,
    mp_shop_status:          shop.mp_shop_status || null,
  };
}

// Calcular días restantes de trial
function trialDaysLeft(trial_ends_at) {
  if (!trial_ends_at) return 0;
  const diff = new Date(trial_ends_at) - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

// POST /api/auth/pre-register — guarda datos temporales, devuelve link MP
// La cuenta real se crea cuando MP confirma el pago vía webhook
router.post('/pre-register', async (req, res) => {
  const { name, email, password, phone, filo_plan } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  try {
    // Verificar que no exista cuenta real con ese email
    const exists = await pool.query('SELECT id FROM shops WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(400).json({ error: 'Ya existe una cuenta con ese email' });

    // Eliminar pre-registros anteriores del mismo email
    await pool.query('DELETE FROM pending_registrations WHERE email = $1', [email.toLowerCase()]);

    const hash = await bcrypt.hash(password, 12);
    const validFiloPlans = ['starter', 'staff', 'enterprise'];
    const filoPlan = validFiloPlans.includes(filo_plan) ? filo_plan : 'starter';

    // Guardar en pending_registrations
    const pending = await pool.query(
      `INSERT INTO pending_registrations (name, email, password, phone, filo_plan)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name.trim(), email.toLowerCase().trim(), hash, phone || null, filoPlan]
    );
    const pendingId = pending.rows[0].id;

    // Obtener link del plan fijo de MP según el plan elegido
    const FILO_PLANS = {
      starter:    { price: 40000, name: 'FILO Starter' },
      staff:      { price: 80000, name: 'FILO Staff' },
      enterprise: { price: 130000, name: 'FILO Enterprise' },
    };
    const planConfig = FILO_PLANS[filoPlan] || FILO_PLANS.starter;
    const appUrl = process.env.APP_URL || 'https://filocrm.com.ar';
    const MP_TOKEN = process.env.MP_ACCESS_TOKEN;

    // Usar plan fijo si está configurado como env var
    const planIds = {
      starter:    process.env.MP_PLAN_STARTER,
      staff:      process.env.MP_PLAN_STAFF,
      enterprise: process.env.MP_PLAN_ENTERPRISE,
    };
    const fixedPlanId = planIds[filoPlan];

    let paymentUrl;
    let mpPlanId;

    if (fixedPlanId) {
      // Usar el init_point del plan fijo directamente.
      // MP maneja la tarjeta del usuario — NO crear preapproval server-side
      // (requiere card_token_id que solo el browser puede generar).
      const mpRes = await fetch(`https://api.mercadopago.com/preapproval_plan/${fixedPlanId}`, {
        headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
      });
      const mpData = await mpRes.json();
      if (!mpRes.ok) throw new Error(mpData.message || 'Error al obtener plan MP');

      // Agregar pending_id como query param en el back_url para identificar al usuario
      // cuando MP nos redirige de vuelta
      const baseInitPoint = mpData.init_point;
      paymentUrl = baseInitPoint + (baseInitPoint.includes('?') ? '&' : '?') + `external_reference=pending:${pendingId}`;
      mpPlanId = fixedPlanId;
    } else {
      // Fallback: crear plan nuevo
      console.warn(`[PRE-REG] Plan fijo no configurado para ${filoPlan}, creando uno nuevo...`);
      const mpRes = await fetch('https://api.mercadopago.com/preapproval_plan', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MP_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': `pre-reg-${pendingId}-${Date.now()}`
        },
        body: JSON.stringify({
          reason: planConfig.name,
          auto_recurring: {
            frequency: 1, frequency_type: 'months',
            transaction_amount: planConfig.price, currency_id: 'ARS',
            free_trial: { frequency: 7, frequency_type: 'days' }
          },
          payment_methods_allowed: { payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }] },
          back_url: `${appUrl}/app?pending=${pendingId}`,
          notification_url: `${appUrl}/api/payments/webhook-filo`
        })
      });
      const mpData = await mpRes.json();
      if (!mpRes.ok) throw new Error(mpData.message || 'Error MP');
      paymentUrl = mpData.init_point;
      mpPlanId = mpData.id;
    }

    // Guardar mp_plan_id en el pending
    await pool.query(
      'UPDATE pending_registrations SET mp_plan_id=$1 WHERE id=$2',
      [mpPlanId, pendingId]
    );

    console.log(`[PRE-REG] ${email} → plan ${filoPlan} · pending_id=${pendingId}`);
    res.json({ ok: true, payment_url: paymentUrl, pending_id: pendingId });
  } catch (e) {
    console.error('Pre-register error:', e.message);
    res.status(500).json({ error: 'Error al iniciar el registro: ' + e.message });
  }
});

// POST /api/auth/complete-registration — completa el registro desde pending (llamado por back_url)
router.post('/complete-registration', async (req, res) => {
  const { pending_id } = req.body;
  if (!pending_id) return res.status(400).json({ error: 'pending_id requerido' });

  try {
    const pending = await pool.query(
      'SELECT * FROM pending_registrations WHERE id=$1 AND expires_at > NOW()',
      [pending_id]
    );
    if (!pending.rows.length) return res.status(404).json({ error: 'Registro expirado o no encontrado' });
    const p = pending.rows[0];

    // Verificar que no exista cuenta ya creada
    const exists = await pool.query('SELECT id FROM shops WHERE email=$1', [p.email]);
    if (exists.rows.length) {
      // Ya existe — hacer login directo
      const shop = exists.rows[0];
      return res.json({ token: makeToken(shop), shop: shopPayload(shop), already_exists: true });
    }

    // Crear la cuenta real
    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + 7);

    const result = await pool.query(
      `INSERT INTO shops (name, email, password, phone, plan, filo_plan, trial_ends_at, subscription_status)
       VALUES ($1, $2, $3, $4, 'starter', $5, $6, 'trial') RETURNING *`,
      [p.name, p.email, p.password, p.phone, p.filo_plan, trialEnds.toISOString()]
    );
    const shop = result.rows[0];

    // Servicios de ejemplo
    await pool.query(
      `INSERT INTO services (shop_id, name, price, cost, duration_minutes) VALUES
       ($1, 'Corte de cabello', 3500, 200, 30),
       ($1, 'Corte + barba', 5000, 300, 45),
       ($1, 'Barba', 2000, 150, 20),
       ($1, 'Corte + lavado', 4500, 250, 40)`,
      [shop.id]
    );

    // Asociar el mp_plan_id al shop
    if (p.mp_plan_id) {
      await pool.query(
        "UPDATE shops SET mp_shop_subscription_id=$1, mp_shop_status='pending' WHERE id=$2",
        [p.mp_plan_id, shop.id]
      );
    }

    // Eliminar el pending
    await pool.query('DELETE FROM pending_registrations WHERE id=$1', [pending_id]);

    // Re-fetch para incluir mp_shop_status='pending' actualizado
    const freshShop = (await pool.query('SELECT * FROM shops WHERE id=$1', [shop.id])).rows[0];

    console.log(`[REGISTRO] ${p.email} → cuenta creada · plan ${p.filo_plan}`);
    res.status(201).json({ token: makeToken(freshShop), shop: shopPayload(freshShop) });
  } catch (e) {
    console.error('Complete registration error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/register — cuenta normal
router.post('/register', async (req, res) => {
  const { name, email, password, phone, filo_plan } = req.body;
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

    const result = await pool.query(
      `INSERT INTO shops (name, email, password, phone, plan, filo_plan, trial_ends_at, subscription_status)
       VALUES ($1, $2, $3, $4, 'starter', $5, $6, 'trial') RETURNING *`,
      [name.trim(), email.toLowerCase().trim(), hash, phone || null, filoPlan, trialEnds.toISOString()]
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

    console.log(`[REGISTRO] ${email} → plan ${filoPlan} · trial hasta ${trialEnds.toDateString()}`);
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
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

  try {
    const result = await pool.query('SELECT * FROM shops WHERE email = $1', [email.toLowerCase().trim()]);
    const shop = result.rows[0];
    if (!shop) return res.status(401).json({ error: 'Email o contraseña incorrectos' });

    const ok = await bcrypt.compare(password, shop.password);
    if (!ok) return res.status(401).json({ error: 'Email o contraseña incorrectos' });

    // Verificar si el trial expiró y aún no tiene suscripción activa
    if (shop.subscription_status === 'trial' && shop.trial_ends_at && new Date(shop.trial_ends_at) < new Date()) {
      await pool.query(
        "UPDATE shops SET subscription_status='expired' WHERE id=$1",
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
      await pool.query("UPDATE shops SET subscription_status='expired' WHERE id=$1", [payload.shopId]);
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
      await pool.query("UPDATE shops SET subscription_status='expired' WHERE id=$1", [payload.shopId]);
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
