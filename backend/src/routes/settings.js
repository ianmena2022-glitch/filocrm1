const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');
const wpp    = require('../services/whatsapp');

function ownerOnly(req, res, next) {
  if (req.isBarber) return res.status(403).json({ error: 'Solo el dueño puede hacer esto' });
  next();
}

// GET /api/settings
router.get('/', auth, async (req, res) => {
  async function doSelect(includeNotifPrefs) {
    const cols = `id, name, email, phone, city, address, calendly_url,
              service_radius_km, churn_days, wpp_connected, logo_url, msg_templates, booking_slug, membership_plans, schedule, home_service, allow_barber_choice, closed_days,
              sena_enabled, sena_pct, sena_alias, sena_payment_method, timezone, slot_interval_minutes,
              revenue_pin_enabled, social_links${includeNotifPrefs ? ', notification_prefs' : ''}`;
    return pool.query(`SELECT ${cols} FROM shops WHERE id=$1`, [req.shopId]);
  }
  try {
    let result;
    try { result = await doSelect(true); }
    catch(e) {
      // Fallback si la columna notification_prefs no existe aún (migración 041 pendiente)
      if (/notification_prefs/i.test(e.message)) {
        console.warn('[settings] notification_prefs no existe aún — fallback. Correr migration 041.');
        result = await doSelect(false);
      } else throw e;
    }
    if (!result.rows.length) return res.status(404).json({ error: 'Shop no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/settings
router.put('/', auth, async (req, res) => {
  const { name, phone, city, address, service_radius_km, churn_days, msg_templates, commission_enabled, membership_plans, filo_plan, schedule, home_service, allow_barber_choice, closed_days, sena_enabled, sena_pct, sena_alias, sena_payment_method, timezone, slot_interval_minutes, booking_slug, social_links, notification_prefs } = req.body;

  // Sanitizar notification_prefs: solo claves bool conocidas
  let notifPrefsJson = null;
  if (notification_prefs && typeof notification_prefs === 'object') {
    const allowed = ['toasts','inapp','push','trial','wpp_alerts','sse_live'];
    const clean = {};
    for (const k of allowed) {
      if (typeof notification_prefs[k] === 'boolean') clean[k] = notification_prefs[k];
    }
    notifPrefsJson = JSON.stringify(clean);
  }

  // Sanitizar social_links: solo claves conocidas, values string trim
  let socialJson = null;
  if (social_links && typeof social_links === 'object') {
    const allowed = ['instagram','facebook','tiktok','website','youtube','whatsapp','x','maps'];
    const clean = {};
    for (const k of allowed) {
      const v = social_links[k];
      if (typeof v === 'string') {
        const t = v.trim().slice(0, 500);
        if (t) clean[k] = t;
      }
    }
    socialJson = JSON.stringify(clean);
  }

  try {
    // Resolver booking_slug: usar el que mande el cliente (sanitizado) o autogenerar si no hay
    const existingSlug = await pool.query('SELECT booking_slug FROM shops WHERE id=$1', [req.shopId]);
    let slug = existingSlug.rows[0]?.booking_slug;

    if (booking_slug !== undefined && booking_slug !== null && String(booking_slug).trim() !== '') {
      // Sanitizar: solo [a-z0-9-], 3..60 chars
      const clean = String(booking_slug).toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
      if (clean.length < 3) return res.status(400).json({ error: 'El slug debe tener al menos 3 caracteres v\u00e1lidos (a-z, 0-9, -)' });
      if (clean !== slug) {
        const dup = await pool.query('SELECT 1 FROM shops WHERE booking_slug=$1 AND id<>$2', [clean, req.shopId]);
        if (dup.rows.length) return res.status(409).json({ error: 'Ese link ya est\u00e1 en uso por otra barber\u00eda' });
        slug = clean;
      }
    } else if (!slug && name) {
      slug = name.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) + '-' + req.shopId;
    }

    // Asegurar slug actualizado en el mismo UPDATE
    const result = await pool.query(
      `UPDATE shops SET
         name=COALESCE($1, name),
         phone=COALESCE($2, phone),
         city=COALESCE($3, city),
         address=COALESCE($4, address),
         service_radius_km=COALESCE($5, service_radius_km),
         churn_days=COALESCE($6, churn_days),
         msg_templates=COALESCE($7, msg_templates),
         booking_slug=COALESCE($8, booking_slug),
         commission_enabled=COALESCE($9, commission_enabled),
         membership_plans=COALESCE($10, membership_plans),
         filo_plan=COALESCE($11, filo_plan),
         schedule=COALESCE($12, schedule),
         home_service=COALESCE($13, home_service),
         allow_barber_choice=COALESCE($14, allow_barber_choice),
         closed_days=COALESCE($15, closed_days),
         sena_enabled=COALESCE($17, sena_enabled),
         sena_pct=COALESCE($18, sena_pct),
         sena_alias=COALESCE($19, sena_alias),
         sena_payment_method=COALESCE($20, sena_payment_method),
         timezone=COALESCE($21, timezone),
         slot_interval_minutes=COALESCE($22, slot_interval_minutes),
         social_links=COALESCE($23::jsonb, social_links),
         notification_prefs=COALESCE($24::jsonb, notification_prefs)
       WHERE id=$16
       RETURNING id, name, email, phone, city, address,
                 service_radius_km, churn_days, wpp_connected, msg_templates, booking_slug, commission_enabled, membership_plans, schedule, home_service, allow_barber_choice, closed_days,
                 sena_enabled, sena_pct, sena_alias, sena_payment_method, timezone, slot_interval_minutes, social_links, notification_prefs`,
      [name||null, phone||null, city||null, address||null,
       service_radius_km||null, churn_days||null, msg_templates||null,
       slug, commission_enabled !== undefined ? commission_enabled : null,
       membership_plans||null, filo_plan||null, schedule||null,
       home_service !== undefined ? home_service : null,
       allow_barber_choice !== undefined ? allow_barber_choice : null,
       closed_days !== undefined ? closed_days : null, req.shopId,
       sena_enabled !== undefined ? sena_enabled : null,
       sena_pct !== undefined ? parseInt(sena_pct) : null,
       sena_alias !== undefined ? (sena_alias || null) : null,
       sena_payment_method !== undefined ? (sena_payment_method || null) : null,
       timezone || null,
       slot_interval_minutes !== undefined && slot_interval_minutes !== null ? Math.min(200, Math.max(5, parseInt(slot_interval_minutes) || 30)) : null,
       socialJson,
       notifPrefsJson]
    );
    // Sincronizar sena_cbu desde sena_alias (config de señas)
    if (sena_alias !== undefined && sena_alias) {
      await pool.query('UPDATE shops SET sena_cbu=$1 WHERE id=$2', [sena_alias, req.shopId]);
    }

    // Sincronizar sena_cbu desde mp_cbu del JSON de planes
    if (membership_plans) {
      try {
        const planes = JSON.parse(membership_plans);
        if (planes.mp_cbu) {
          await pool.query('UPDATE shops SET sena_cbu=$1 WHERE id=$2', [planes.mp_cbu, req.shopId]);
        }
      } catch(e) {}
    }

    res.json({ ok: true, shop: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SERVICIOS ─────────────────────────────────────────

router.get('/services', auth, async (req, res) => {
  try {
    // Barberos usan el shop padre directamente desde el token (sin query extra)
    const effectiveShopId = req.parentShopId || req.shopId;

    const result = await pool.query(
      'SELECT * FROM services WHERE shop_id=$1 AND active=TRUE ORDER BY name',
      [effectiveShopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Normaliza commission_pct: null si vacío/null/invalid, sino 0-100 clamped
function parseSvcCommission(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(raw);
  if (isNaN(n)) return null;
  return Math.min(100, Math.max(0, n));
}

router.post('/services', auth, ownerOnly, async (req, res) => {
  const { name, price, cost, duration_minutes, commission_pct } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Nombre y precio son requeridos' });
  try {
    const result = await pool.query(
      `INSERT INTO services (shop_id, name, price, cost, duration_minutes, commission_pct)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.shopId, name.trim(), parseFloat(price), parseFloat(cost||0), parseInt(duration_minutes||30), parseSvcCommission(commission_pct)]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/settings/services/:id — editar servicio
router.put('/services/:id', auth, ownerOnly, async (req, res) => {
  const { name, price, cost, duration_minutes, commission_pct } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Nombre y precio son requeridos' });
  try {
    const result = await pool.query(
      `UPDATE services SET name=$1, price=$2, cost=$3, duration_minutes=$4, commission_pct=$5
       WHERE id=$6 AND shop_id=$7 RETURNING *`,
      [name.trim(), parseFloat(price), parseFloat(cost||0), parseInt(duration_minutes||30), parseSvcCommission(commission_pct), req.params.id, req.shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/services/:id', auth, ownerOnly, async (req, res) => {
  try {
    await pool.query(
      'UPDATE services SET active=FALSE WHERE id=$1 AND shop_id=$2',
      [req.params.id, req.shopId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WHATSAPP ──────────────────────────────────────────

// POST /api/settings/whatsapp/reset — reconexión limpia
router.post('/whatsapp/reset', auth, async (req, res) => {
  try {
    await wpp.clearSession(req.shopId);
    console.log(`[WPP] Reset limpio para shop ${req.shopId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('WPP reset error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/whatsapp/connect', auth, async (req, res) => {
  try {
    const data = await wpp.startSession(req.shopId);

    if (data.status === 'CONNECTED') {
      await pool.query('UPDATE shops SET wpp_connected=TRUE WHERE id=$1', [req.shopId]);
      return res.json({ ok: true, connected: true });
    }

    if (data.qrcode) {
      const qrRaw = data.qrcode;
      let qrImage;

      // Si ya es base64 de imagen, usarlo directo
      if (qrRaw.startsWith('data:image')) {
        qrImage = qrRaw;
      } else {
        // Convertir QR raw a PNG base64 usando librería qrcode
        try {
          const QRCode = require('qrcode');
          qrImage = await QRCode.toDataURL(qrRaw, {
            width: 256,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
          });
        } catch (qrErr) {
          console.error('QR conversion error:', qrErr.message);
          // Devolver el raw y que el frontend lo maneje
          qrImage = qrRaw;
        }
      }

      return res.json({ ok: true, qr: qrImage });
    }

    res.json({ ok: false, error: 'No se pudo obtener el QR de WhatsApp' });
  } catch (e) {
    console.error('WPP connect error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/settings/generate-slug — forzar generación de slug si no existe
router.post('/generate-slug', auth, async (req, res) => {
  try {
    const existing = await pool.query('SELECT booking_slug, name FROM shops WHERE id=$1', [req.shopId]);
    const shop = existing.rows[0];
    if (shop.booking_slug) return res.json({ slug: shop.booking_slug });
    
    const slug = (shop.name || 'barberia')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) + '-' + req.shopId;

    await pool.query('UPDATE shops SET booking_slug=$1 WHERE id=$2', [slug, req.shopId]);
    res.json({ slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/settings/plan — cambiar plan (solo cuentas test)
router.put('/plan', auth, async (req, res) => {
  const { plan } = req.body;
  const validPlans = ['starter', 'staff', 'enterprise', 'test'];
  if (!validPlans.includes(plan)) return res.status(400).json({ error: 'Plan inválido' });

  try {
    // Solo cuentas test pueden cambiar de plan (verificar is_test, no el plan actual)
    const shop = await pool.query('SELECT is_test FROM shops WHERE id=$1', [req.shopId]);
    if (!shop.rows[0]?.is_test) {
      return res.status(403).json({ error: 'Solo las cuentas de testing pueden cambiar de plan' });
    }

    const isEnterpriseOwner = plan === 'enterprise';
    await pool.query(
      `UPDATE shops SET
         plan=$1, filo_plan=$1,
         is_enterprise_owner=$2,
         is_branch=FALSE,
         is_barber=FALSE,
         parent_shop_id=NULL,
         parent_enterprise_id=NULL
       WHERE id=$3`,
      [plan, isEnterpriseOwner, req.shopId]
    );

    const updated = await pool.query('SELECT * FROM shops WHERE id=$1', [req.shopId]);
    const updatedShop = updated.rows[0];

    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      {
        shopId:             updatedShop.id,
        email:              updatedShop.email,
        isBarber:           false,
        parentShopId:       null,
        isEnterpriseOwner:  isEnterpriseOwner,
        isBranch:           false,
        parentEnterpriseId: null,
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ ok: true, plan, token, shop: updatedShop });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/settings/whatsapp/pairing-code
router.post('/whatsapp/pairing-code', auth, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Número requerido' });
  try {
    const result = await wpp.requestPairingCode(req.shopId, phone);
    res.json(result);
  } catch (e) {
    console.error('Pairing code error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/whatsapp/status', auth, async (req, res) => {
  try {
    const status = await wpp.getStatus(req.shopId);
    if (status.connected) {
      await pool.query('UPDATE shops SET wpp_connected=TRUE WHERE id=$1', [req.shopId]);
    }
    res.json(status);
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// ── PIN para facturaciones mensuales ──────────────────────────
function isValidPin(p) {
  return typeof p === 'string' && /^\d{4}$/.test(p);
}

// Rate limit por shop para intentos de PIN: máx 10 intentos / 10 min
const pinAttempts = new Map(); // key = shopId → { count, resetAt }
function pinRateLimit(req, res, next) {
  const key = String(req.shopId);
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const MAX = 10;
  let e = pinAttempts.get(key);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + windowMs };
    pinAttempts.set(key, e);
  }
  e.count++;
  if (e.count > MAX) {
    const retry = Math.ceil((e.resetAt - now) / 1000);
    res.set('Retry-After', String(retry));
    return res.status(429).json({ error: `Demasiados intentos. Probá de nuevo en ${Math.ceil(retry/60)} min.` });
  }
  next();
}
// Limpiar entradas expiradas cada 15 min (unref para no bloquear shutdown)
const _pinCleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, e] of pinAttempts) if (now > e.resetAt) pinAttempts.delete(k);
}, 15 * 60 * 1000);
if (typeof _pinCleanup.unref === 'function') _pinCleanup.unref();

async function verifyAccountPassword(shopId, password) {
  if (!password) return false;
  const r = await pool.query('SELECT password FROM shops WHERE id=$1', [shopId]);
  if (!r.rows.length || !r.rows[0].password) return false;
  return bcrypt.compare(password, r.rows[0].password);
}

async function verifyStoredPin(shopId, pin) {
  if (!isValidPin(pin)) return false;
  const r = await pool.query('SELECT revenue_pin_hash, revenue_pin_enabled FROM shops WHERE id=$1', [shopId]);
  if (!r.rows.length || !r.rows[0].revenue_pin_enabled || !r.rows[0].revenue_pin_hash) return false;
  return bcrypt.compare(pin, r.rows[0].revenue_pin_hash);
}

// Activar PIN: requiere la contraseña de la cuenta + un pin nuevo (4 dígitos)
router.post('/revenue-pin/enable', auth, ownerOnly, async (req, res) => {
  const { password, pin } = req.body || {};
  if (!isValidPin(pin)) return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos' });
  if (!(await verifyAccountPassword(req.shopId, password))) {
    return res.status(401).json({ error: 'Contraseña de la cuenta incorrecta' });
  }
  try {
    const hash = await bcrypt.hash(pin, 10);
    await pool.query(
      'UPDATE shops SET revenue_pin_hash=$1, revenue_pin_enabled=TRUE WHERE id=$2',
      [hash, req.shopId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Desactivar: pide PIN actual (o contraseña como fallback)
router.post('/revenue-pin/disable', auth, ownerOnly, pinRateLimit, async (req, res) => {
  const { pin, password } = req.body || {};
  const okPin = await verifyStoredPin(req.shopId, pin);
  const okPwd = !okPin && password ? await verifyAccountPassword(req.shopId, password) : false;
  if (!okPin && !okPwd) return res.status(401).json({ error: 'PIN o contraseña incorrectos' });
  try {
    await pool.query('UPDATE shops SET revenue_pin_hash=NULL, revenue_pin_enabled=FALSE WHERE id=$1', [req.shopId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cambiar PIN sabiendo el anterior
router.post('/revenue-pin/change', auth, ownerOnly, pinRateLimit, async (req, res) => {
  const { old_pin, new_pin } = req.body || {};
  if (!isValidPin(new_pin)) return res.status(400).json({ error: 'El nuevo PIN debe ser de 4 dígitos' });
  if (!(await verifyStoredPin(req.shopId, old_pin))) return res.status(401).json({ error: 'PIN actual incorrecto' });
  try {
    const hash = await bcrypt.hash(new_pin, 10);
    await pool.query('UPDATE shops SET revenue_pin_hash=$1, revenue_pin_enabled=TRUE WHERE id=$2', [hash, req.shopId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resetear PIN con la contraseña de la cuenta (olvidó el PIN)
router.post('/revenue-pin/reset', auth, ownerOnly, async (req, res) => {
  const { password, new_pin } = req.body || {};
  if (!isValidPin(new_pin)) return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos' });
  if (!(await verifyAccountPassword(req.shopId, password))) {
    return res.status(401).json({ error: 'Contraseña de la cuenta incorrecta' });
  }
  try {
    const hash = await bcrypt.hash(new_pin, 10);
    await pool.query('UPDATE shops SET revenue_pin_hash=$1, revenue_pin_enabled=TRUE WHERE id=$2', [hash, req.shopId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Verificar PIN para destapar valores (frontend llama esto al clickear 👁️)
router.post('/revenue-pin/verify', auth, ownerOnly, pinRateLimit, async (req, res) => {
  const { pin } = req.body || {};
  const ok = await verifyStoredPin(req.shopId, pin);
  if (!ok) return res.status(401).json({ error: 'PIN incorrecto' });
  res.json({ ok: true });
});

module.exports = router;
