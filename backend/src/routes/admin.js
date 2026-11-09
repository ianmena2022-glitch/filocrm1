const router = require('express').Router();
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');

const ADMIN_SECRET = process.env.ADMIN_PASSWORD;
if (!ADMIN_SECRET) {
  console.error('[ADMIN] FATAL: ADMIN_PASSWORD no está configurada. Login admin deshabilitado.');
}

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
// Cleanup periódico del Map (evita crecimiento ilimitado)
const _adminLoginCleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) if (now > v.resetAt) loginAttempts.delete(k);
}, 15 * 60 * 1000);
if (typeof _adminLoginCleanup.unref === 'function') _adminLoginCleanup.unref();

// Versión de las sesiones admin: al subirla ("cerrar sesión en todos los dispositivos")
// todos los tokens admin anteriores dejan de valer, sin tocar las sesiones de los clientes.
let _adminTokenVersion = null, _adminTokenVersionAt = 0;
async function getAdminTokenVersion() {
  if (_adminTokenVersion !== null && Date.now() - _adminTokenVersionAt < 60000) return _adminTokenVersion;
  try {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key='admin_token_version'`);
    _adminTokenVersion = parseInt(r.rows[0]?.value) || 0;
  } catch (_) { _adminTokenVersion = _adminTokenVersion || 0; }
  _adminTokenVersionAt = Date.now();
  return _adminTokenVersion;
}

// Middleware de autenticación admin
async function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch(e) {
    return res.status(401).json({ error: 'Token inválido' });
  }
  if (!payload.isAdmin) return res.status(401).json({ error: 'No autorizado' });
  if ((payload.v || 0) !== await getAdminTokenVersion()) return res.status(401).json({ error: 'Sesión cerrada. Volvé a ingresar.' });
  next();
}

// POST /api/admin/login
router.post('/login', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos.' });
  }
  if (!ADMIN_SECRET) {
    return res.status(503).json({ error: 'Login admin no configurado en el servidor' });
  }
  const { password, remember } = req.body;
  if (!password) return res.status(401).json({ error: 'Contraseña incorrecta' });
  // Comparación en tiempo constante para prevenir timing attacks
  const a = Buffer.from(password);
  const b = Buffer.from(ADMIN_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  // "Recordar este dispositivo": sesión de 90 días (el celular de confianza no vuelve a pedir la contraseña)
  const v = await getAdminTokenVersion();
  const token = jwt.sign({ isAdmin: true, v }, process.env.JWT_SECRET, { expiresIn: remember === true ? '90d' : '8h' });
  res.json({ token, remember: remember === true });
});

// POST /api/admin/accounts/:id/wpp-careful { days } — modo cuidado de WhatsApp (0 = apagar)
router.post('/accounts/:id/wpp-careful', adminAuth, async (req, res) => {
  try {
    const days = Math.max(0, Math.min(parseInt(req.body?.days) || 0, 90));
    await require('../services/whatsapp').setCareful(parseInt(req.params.id), days);
    res.json({ ok: true, days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/accounts/:id/wpp-lift-hold — deja reconectar antes de que pase la espera tras un
// bloqueo (usar solo si van a conectar un número distinto al bloqueado)
router.post('/accounts/:id/wpp-lift-hold', adminAuth, async (req, res) => {
  try { res.json({ ok: true, hold: await require('../services/whatsapp').liftBanHold(parseInt(req.params.id)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/logout-all — invalida todas las sesiones admin (p.ej. si perdiste el celular)
router.post('/logout-all', adminAuth, async (req, res) => {
  try {
    const next = (await getAdminTokenVersion()) + 1;
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('admin_token_version', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [String(next)]
    );
    _adminTokenVersion = next; _adminTokenVersionAt = Date.now();
    // Las suscripciones push de esos dispositivos también se dan de baja
    await pool.query('DELETE FROM admin_push_subscriptions').catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pagos recibidos sin asignar ──────────────────────────────────────────────
router.get('/unmatched-payments', adminAuth, async (req, res) => {
  try {
    const { ensureUnmatchedTable } = require('./payments')._internals;
    await ensureUnmatchedTable();
    const r = await pool.query(
      `SELECT u.*, s.name AS shop_name FROM unmatched_payments u
         LEFT JOIN shops s ON s.id = u.shop_id
        WHERE u.resolved = FALSE ORDER BY u.created_at DESC LIMIT 100`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/unmatched-payments/:id/assign { shop_id, plan } — acreditar el pago a una cuenta
router.post('/unmatched-payments/:id/assign', adminAuth, async (req, res) => {
  try {
    const { activateShopPlan, QR_PLANS } = require('./payments')._internals;
    const shopId = parseInt(req.body.shop_id);
    const plan = req.body.plan;
    if (!shopId || !QR_PLANS[plan]) return res.status(400).json({ error: 'Elegí la cuenta y el plan' });
    const u = await pool.query('SELECT * FROM unmatched_payments WHERE payment_id=$1 AND resolved=FALSE', [req.params.id]);
    if (!u.rows.length) return res.status(404).json({ error: 'Pago no encontrado o ya resuelto' });
    await activateShopPlan({ shopId, plan, paymentId: req.params.id, paidAmount: parseFloat(u.rows[0].amount) || 0, force: true });
    const done = await pool.query('SELECT 1 FROM mp_processed_payments WHERE payment_id=$1', [req.params.id]);
    if (!done.rows.length) return res.status(409).json({ error: 'No se pudo acreditar (¿el pago ya se usó en otra cuenta?)' });
    await pool.query('UPDATE unmatched_payments SET resolved=TRUE, resolved_at=NOW(), shop_id=$2, plan=$3 WHERE payment_id=$1', [req.params.id, shopId, plan]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/unmatched-payments/:id/dismiss — no corresponde a FILO / ya resuelto por fuera
router.post('/unmatched-payments/:id/dismiss', adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE unmatched_payments SET resolved=TRUE, resolved_at=NOW() WHERE payment_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/system — estado de las migraciones de la base
router.get('/system', adminAuth, async (req, res) => {
  try {
    const fs = require('fs'), path = require('path');
    const files = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter(f => f.endsWith('.sql')).sort();
    const applied = new Set((await pool.query('SELECT filename FROM _migrations')).rows.map(r => r.filename));
    res.json({
      pending_migrations: files.filter(f => !applied.has(f)),
      migration_error: global.__filoMigrationError || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// La columna exclude_from_kpis se crea sola si la migración 048 todavía no corrió (idempotente)
let _kpiColReady = null;
function ensureKpiColumn() {
  if (!_kpiColReady) {
    _kpiColReady = pool.query('ALTER TABLE shops ADD COLUMN IF NOT EXISTS exclude_from_kpis BOOLEAN NOT NULL DEFAULT FALSE')
      .then(() => pool.query('ALTER TABLE shops ADD COLUMN IF NOT EXISTS archived_manual BOOLEAN'))
      .catch(e => { _kpiColReady = null; console.warn('[admin] columnas de cuentas:', e.message); });
  }
  return _kpiColReady;
}

// GET /api/admin/accounts — listar todas las cuentas con jerarquía (sucursales y barberos)
router.get('/accounts', adminAuth, async (req, res) => {
  try {
    await ensureKpiColumn();
    await require('./push')._ensurePwaTable().catch(() => {});
    const result = await pool.query(`
      SELECT
        s.id, s.name, s.email, s.phone, s.city,
        s.filo_plan, s.plan, s.subscription_status,
        s.trial_ends_at, s.expired_at, s.created_at, s.first_payment_at, s.last_payment_at,
        s.wpp_connected,
        s.mp_shop_subscription_id, s.mp_shop_status,
        s.is_test,
        COALESCE(s.exclude_from_kpis, FALSE) AS exclude_from_kpis,
        s.archived_manual,
        s.is_barber, s.is_branch, s.is_enterprise_owner,
        s.parent_shop_id, s.parent_enterprise_id,
        s.barber_commission_pct,
        COALESCE(s.free_months, 0) AS free_months,
        -- App instalada (PWA) y notificaciones activadas
        (SELECT COUNT(*) FROM pwa_devices p WHERE p.shop_id = s.id)                    AS pwa_count,
        (SELECT MAX(p.last_seen) FROM pwa_devices p WHERE p.shop_id = s.id)            AS pwa_last_seen,
        (SELECT string_agg(DISTINCT p.platform, ',') FROM pwa_devices p WHERE p.shop_id = s.id) AS pwa_platforms,
        (SELECT COUNT(*) FROM push_subscriptions ps WHERE ps.shop_id = s.id)           AS push_count,
        -- WhatsApp: bloqueado por WhatsApp / modo cuidado (to_jsonb: sirve aunque la columna no exista)
        to_jsonb(s)->>'wpp_banned_at'     AS wpp_banned_at,
        to_jsonb(s)->>'wpp_careful_until' AS wpp_careful_until,
        GREATEST(COALESCE((to_jsonb(s)->>'wpp_ban_count')::int, 0),
                 (SELECT COUNT(*)::int FROM notifications nb WHERE nb.recipient_shop_id = s.id AND nb.type = 'wpp.banned')) AS wpp_ban_count,
        COUNT(b.id)  FILTER (WHERE b.is_barber = TRUE) AS barber_count,
        COUNT(br.id) FILTER (WHERE br.is_branch = TRUE) AS branch_count
      FROM shops s
      LEFT JOIN shops b  ON b.parent_shop_id       = s.id AND b.is_barber = TRUE
      LEFT JOIN shops br ON br.parent_enterprise_id = s.id AND br.is_branch = TRUE
      WHERE s.is_system IS DISTINCT FROM TRUE
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);
    await attachWppHealth(result.rows);
    res.json({ accounts: result.rows });
  } catch(e) {
    console.error('Admin GET accounts:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Salud del WhatsApp de cada cuenta (últimos 7 días): para ver venir un bloqueo.
// Aparte de la consulta principal: si alguna tabla todavía no existe, el panel igual carga.
async function attachWppHealth(rows) {
  try {
    const ids = rows.filter(a => a.wpp_connected || a.wpp_banned_at || parseInt(a.wpp_ban_count) > 0).map(a => a.id);
    if (!ids.length) return;
    const today = `(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`;
    const c = await pool.query(
      `SELECT shop_id,
              COALESCE(SUM(n) FILTER (WHERE bucket='total' AND day = ${today}), 0)::int AS today,
              COALESCE(SUM(n) FILTER (WHERE bucket='total'), 0)::int     AS total,
              COALESCE(SUM(n) FILTER (WHERE bucket='proactive'), 0)::int AS proactive,
              COALESCE(SUM(n) FILTER (WHERE bucket='first'), 0)::int     AS first,
              COALESCE(SUM(n) FILTER (WHERE bucket='marketing'), 0)::int AS marketing,
              COALESCE(SUM(n) FILTER (WHERE bucket='drops'), 0)::int     AS drops
         FROM wpp_daily_counters
        WHERE shop_id = ANY($1::int[]) AND day >= ${today} - 6
        GROUP BY shop_id`, [ids]).catch(() => ({ rows: [] }));
    const o = await pool.query(
      `SELECT shop_id, COUNT(*)::int AS optouts FROM wpp_optouts
        WHERE shop_id = ANY($1::int[]) AND created_at > NOW() - INTERVAL '7 days' GROUP BY shop_id`, [ids]).catch(() => ({ rows: [] }));
    const l = await pool.query(
      `SELECT id, to_jsonb(s)->>'wpp_linked_at' AS linked_at FROM shops s WHERE id = ANY($1::int[])`, [ids]).catch(() => ({ rows: [] }));
    const by = (list, k = 'shop_id') => Object.fromEntries(list.rows.map(r => [r[k], r]));
    const C = by(c), O = by(o), L = by(l, 'id');
    for (const a of rows) {
      if (!ids.includes(a.id)) continue;
      const x = C[a.id] || {};
      a.wpp_health = {
        today: x.today || 0, total: x.total || 0, proactive: x.proactive || 0, first: x.first || 0,
        marketing: x.marketing || 0, drops: x.drops || 0, optouts: O[a.id]?.optouts || 0,
        linked_at: L[a.id]?.linked_at || null,
      };
    }
  } catch (e) { console.warn('Admin salud WhatsApp:', e.message); }
}

// GET /api/admin/billing-forecast — cuánto cobra FILO a cada cuenta activa (con descuentos aplicados)
router.get('/billing-forecast', adminAuth, async (req, res) => {
  try {
    await ensureKpiColumn();
    const r = await pool.query(
      `SELECT id, filo_plan FROM shops
        WHERE is_system IS DISTINCT FROM TRUE
          AND (is_barber IS NULL OR is_barber = FALSE) AND (is_branch IS NULL OR is_branch = FALSE)
          AND subscription_status = 'active'`);
    const fc = await require('../services/promotions').forecastBilling(r.rows);
    res.json({ forecast: fc });
  } catch (e) {
    console.error('Admin billing-forecast:', e.message);
    res.status(500).json({ error: 'Error calculando el pronóstico de cobro' });
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

// ── ADMIN WHATSAPP SENDER (shop sistema oculto que envía mensajes admin) ─────

// Devuelve el shop sistema (lo crea si no existe). Es invisible para el admin
// y solo se usa como remitente de WhatsApp para mensajes automáticos.
async function getOrCreateAdminSenderShop() {
  const { rows } = await pool.query(
    `SELECT id, name, phone, wpp_connected, (wpp_session IS NOT NULL) AS had_session
     FROM shops WHERE is_system = TRUE LIMIT 1`
  );
  if (rows.length) return rows[0];

  const hash = await bcrypt.hash(require('crypto').randomBytes(32).toString('hex'), 12);
  const ins = await pool.query(
    `INSERT INTO shops (name, email, password, plan, filo_plan, subscription_status,
       trial_ends_at, is_system, is_test, email_verified)
     VALUES ('FILO Admin Sender', '_filo_system_sender_@filo.internal', $1,
       'test', 'starter', 'active', '2099-12-31', TRUE, TRUE, TRUE)
     RETURNING id, name, phone, wpp_connected, (wpp_session IS NOT NULL) AS had_session`,
    [hash]
  );
  return ins.rows[0];
}

// GET /api/admin/wpp/status — estado actual del sender
router.get('/wpp/status', adminAuth, async (req, res) => {
  try {
    const shop = await getOrCreateAdminSenderShop();
    res.json({ shop_id: shop.id, connected: !!shop.wpp_connected, had_session: !!shop.had_session, phone: shop.phone || null });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/wpp/connect — iniciar sesión, devuelve QR
router.post('/wpp/connect', adminAuth, async (req, res) => {
  try {
    const shop = await getOrCreateAdminSenderShop();
    const wpp  = require('../services/whatsapp');
    const data = await wpp.startSession(shop.id);

    if (data.status === 'CONNECTED') {
      await pool.query('UPDATE shops SET wpp_connected=TRUE WHERE id=$1', [shop.id]);
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('welcome_wpp_shop_id', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [String(shop.id)]
      );
      return res.json({ ok: true, connected: true, shop_id: shop.id });
    }

    if (data.qrcode) {
      let qrImage = data.qrcode;
      if (!qrImage.startsWith('data:image')) {
        try {
          const QRCode = require('qrcode');
          qrImage = await QRCode.toDataURL(data.qrcode, { width: 256, margin: 2, color: { dark:'#000', light:'#fff' } });
        } catch(_) {}
      }
      // Persistir el shop_id en settings para que verify-email lo use
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('welcome_wpp_shop_id', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [String(shop.id)]
      );
      return res.json({ ok: true, qr: qrImage, shop_id: shop.id });
    }

    res.json({ ok: false, error: 'No se pudo obtener el QR' });
  } catch(e) {
    console.error('Admin WPP connect:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/admin/wpp/send-welcome/:shopId — enviar mensaje de bienvenida custom a un shop
router.post('/wpp/send-welcome/:shopId', adminAuth, async (req, res) => {
  const targetShopId = parseInt(req.params.shopId);
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'message es requerido' });

  try {
    const target = await pool.query('SELECT phone FROM shops WHERE id=$1', [targetShopId]);
    if (!target.rows.length) return res.status(404).json({ error: 'Shop no encontrado' });
    const phone = target.rows[0].phone;
    if (!phone) return res.status(400).json({ error: 'El shop no tiene teléfono registrado' });

    const sender = await getOrCreateAdminSenderShop();
    if (!sender.wpp_connected) {
      return res.status(400).json({ error: 'El WhatsApp admin no está conectado. Conectalo desde el tab Config.' });
    }

    const wpp = require('../services/whatsapp');
    await wpp.sendText(sender.id, phone, message);
    res.json({ ok: true });
  } catch(e) {
    console.error('Admin send-welcome:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/wpp/reset — desconectar y limpiar sesión
router.post('/wpp/reset', adminAuth, async (req, res) => {
  try {
    const shop = await getOrCreateAdminSenderShop();
    const wpp  = require('../services/whatsapp');
    await wpp.clearSession(shop.id);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── APP SETTINGS (configuración global) ───────────────────────────────────────

// GET /api/admin/settings — leer todas las settings globales
router.get('/settings', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM app_settings');
    const settings = {};
    for (const row of result.rows) settings[row.key] = row.value;
    res.json({ settings });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/settings — actualizar settings (upsert por key)
router.put('/settings', adminAuth, async (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object')
    return res.status(400).json({ error: 'settings es requerido' });

  try {
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'admin_token_version') continue; // solo se cambia con /logout-all
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value == null ? '' : String(value)]
      );
    }
    res.json({ ok: true });
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
    trialEnds.setDate(trialEnds.getDate() + 15); // Trial de 15 días

    const result = await pool.query(
      `INSERT INTO shops (name, email, password, phone, plan, filo_plan, subscription_status, trial_ends_at)
       VALUES ($1, $2, $3, $4, 'starter', $5, $6, $7) RETURNING id, name, email, filo_plan, subscription_status`,
      [name.trim(), email.toLowerCase().trim(), hash, phone||null, plan, status, trialEnds.toISOString()]
    );

    // Servicios de ejemplo
    await pool.query(
      `INSERT INTO services (shop_id, name, price, cost, duration_minutes) VALUES
       ($1, 'Corte de cabello', 12000, 500, 30),
       ($1, 'Corte + barba', 16000, 700, 45),
       ($1, 'Barba', 8000, 400, 20)`,
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
  const { name, filo_plan, subscription_status, exclude_from_kpis, archived, active_until, new_password } = req.body;
  const validPlans   = ['starter','staff','enterprise'];
  const validStatus  = ['trial','active','expired','cancelled'];
  if (new_password !== undefined && new_password !== '' && String(new_password).length < 6) {
    return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 6 caracteres' });
  }

  try {
    const updates = [];
    const params  = [];
    let i = 1;

    // Contraseña nueva (por ejemplo, cuando el dueño se la olvidó): se guarda cifrada y las
    // sesiones abiertas con la anterior quedan registradas como previas al cambio.
    if (new_password) {
      updates.push(`password=$${i++}`); params.push(await bcrypt.hash(String(new_password), 12));
      updates.push('password_changed_at=NOW()');
    }

    if (typeof exclude_from_kpis === 'boolean') {
      await ensureKpiColumn();
      updates.push(`exclude_from_kpis=$${i++}`); params.push(exclude_from_kpis);
    }
    // Archivar / desarchivar a mano (null = volver a la regla automática)
    if (typeof archived === 'boolean' || archived === null) {
      await ensureKpiColumn();
      updates.push(`archived_manual=$${i++}`); params.push(archived);
    }
    if (name)                              { updates.push(`name=$${i++}`);                  params.push(name.trim()); }
    if (validPlans.includes(filo_plan))    {
      updates.push(`filo_plan=$${i++}`);               params.push(filo_plan);
      // Sincronizar flag is_enterprise_owner con el plan — sino el CRM sigue mostrando
      // el dashboard viejo. starter/staff ⇒ FALSE, enterprise ⇒ TRUE.
      updates.push(`is_enterprise_owner=$${i++}`);     params.push(filo_plan === 'enterprise');
      // Si pasa a enterprise, limpiar is_branch / parent_enterprise_id por si venía como sucursal
      if (filo_plan === 'enterprise') {
        updates.push(`is_branch=FALSE`);
        updates.push(`parent_enterprise_id=NULL`);
      }
    }
    if (validStatus.includes(subscription_status)) {
      updates.push(`subscription_status=$${i++}`);
      params.push(subscription_status);
      // Si se activa manualmente, marcar como activo y registrar primer pago si no existe
      if (subscription_status === 'active') {
        updates.push(`mp_shop_status=$${i++}`);
        params.push('authorized');
        updates.push(`first_payment_at=COALESCE(first_payment_at, NOW())`);
        // Una cuenta activa con la fecha de vencimiento ya pasada la vuelve a expirar el paywall
        // y el scheduler al instante: al activar a mano hay que dejar una fecha vigente.
        // active_until: 'forever' (sin vencimiento) o cantidad de meses (1-24).
        const cur = (await pool.query('SELECT subscription_status, trial_ends_at FROM shops WHERE id=$1', [req.params.id])).rows[0];
        const stale = !cur || cur.subscription_status !== 'active' || !cur.trial_ends_at || new Date(cur.trial_ends_at) < new Date();
        const monthsN = parseInt(active_until);
        if (Number.isFinite(monthsN) && monthsN >= 1 && monthsN <= 24) {
          updates.push(`trial_ends_at=NOW() + ($${i++}::int || ' months')::interval`);
          params.push(monthsN);
          updates.push('expired_at=NULL');
        } else if (active_until === 'forever' || (active_until === undefined && stale)) {
          updates.push(`trial_ends_at='2099-12-31'`);
          updates.push('expired_at=NULL');
        }
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

// GET /api/admin/wpp/stats — estado de sesiones Baileys activas
router.get('/wpp/stats', adminAuth, async (req, res) => {
  try {
    const wpp = require('../services/whatsapp');
    res.json(wpp.wppStats ? await wpp.wppStats() : { error: 'not available' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/wpp/sweep — forzar sweeper (útil para testing/liberar RAM)
router.post('/wpp/sweep', adminAuth, async (req, res) => {
  try {
    const wpp = require('../services/whatsapp');
    if (wpp.sweepIdle) await wpp.sweepIdle();
    res.json({ ok: true, stats: wpp.wppStats ? await wpp.wppStats() : null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Promociones (CRUD + usos) ────────────────────────────────────────────────

// GET /api/admin/promotions — listar todas
router.get('/promotions', adminAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.*,
              (SELECT COUNT(*)::int FROM promotion_uses WHERE promotion_id=p.id) AS uses_count
         FROM promotions p
         ORDER BY status ASC, created_at DESC`
    );
    res.json({ promotions: r.rows });
  } catch(e) {
    // Fallback si la tabla no existe aún (migración 043 pendiente)
    if (/promotions.*does not exist|relation "promotions"|relation "promotion_uses"/i.test(e.message)) {
      return res.json({ promotions: [], _warning: 'Migración 043 pendiente — correr el SQL en la DB para habilitar promociones' });
    }
    console.error('[admin promotions]', e.message);
    res.status(500).json({ error: 'Error cargando promociones' });
  }
});

// POST /api/admin/promotions — crear
router.post('/promotions', adminAuth, async (req, res) => {
  const {
    name, code, discount_type, discount_value,
    applies_to, shop_ids, plans, renewable,
    starts_at, ends_at, max_total_uses, max_uses_per_shop, status, notes, trial_days
  } = req.body || {};
  const trialDaysClean = trial_days ? parseInt(trial_days) : null;
  if (trialDaysClean !== null && (!(trialDaysClean >= 1 && trialDaysClean <= 365))) {
    return res.status(400).json({ error: 'Los días de trial deben estar entre 1 y 365' });
  }
  if (trialDaysClean && !(code || '').trim()) {
    return res.status(400).json({ error: 'Una promo de días de trial necesita un código (es lo que ingresa el cliente al registrarse)' });
  }
  if (!name || !discount_type || discount_value === undefined || discount_value === null) {
    return res.status(400).json({ error: 'name, discount_type y discount_value son requeridos' });
  }
  if (!['percent','fixed'].includes(discount_type)) return res.status(400).json({ error: 'discount_type inválido' });
  if (discount_type === 'percent' && (discount_value < 0 || discount_value > 100)) {
    return res.status(400).json({ error: 'percent debe estar entre 0 y 100' });
  }
  const appliesClean = applies_to === 'specific' ? 'specific' : 'all';
  const shopIdsClean = appliesClean === 'specific' && Array.isArray(shop_ids) ? shop_ids.map(Number).filter(Boolean) : null;
  const plansClean   = Array.isArray(plans) && plans.length ? plans.filter(p => ['starter','staff','enterprise'].includes(p)) : null;
  const statusClean  = ['active','paused','archived'].includes(status) ? status : 'active';
  try {
    await require('../services/promotions').ensureTrialSchema();
    const r = await pool.query(
      `INSERT INTO promotions
         (name, code, discount_type, discount_value, applies_to, shop_ids, plans,
          renewable, starts_at, ends_at, max_total_uses, max_uses_per_shop, status, notes, trial_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [name.trim(), (code||'').trim() || null, discount_type, parseFloat(discount_value),
       appliesClean, shopIdsClean, plansClean, renewable !== false,
       starts_at || null, ends_at || null,
       max_total_uses ? parseInt(max_total_uses) : null,
       max_uses_per_shop ? parseInt(max_uses_per_shop) : null,
       statusClean, (notes||'').trim() || null, trialDaysClean]
    );
    res.json(r.rows[0]);
  } catch(e) {
    if (/duplicate key.*code/i.test(e.message)) return res.status(409).json({ error: 'El código ya está en uso' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/promotions/:id — editar
router.put('/promotions/:id', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  const b = req.body || {};
  const fields = [];
  const vals   = [];
  let i = 1;
  function add(col, val) { fields.push(`${col}=$${i++}`); vals.push(val); }

  if (b.name !== undefined)              add('name', String(b.name).trim());
  if (b.code !== undefined)              add('code', (b.code||'').trim() || null);
  if (b.discount_type !== undefined && ['percent','fixed'].includes(b.discount_type)) add('discount_type', b.discount_type);
  if (b.discount_value !== undefined)    add('discount_value', parseFloat(b.discount_value));
  if (b.applies_to !== undefined)        add('applies_to', b.applies_to === 'specific' ? 'specific' : 'all');
  if (b.shop_ids !== undefined)          add('shop_ids', Array.isArray(b.shop_ids) ? b.shop_ids.map(Number).filter(Boolean) : null);
  if (b.plans !== undefined)             add('plans', Array.isArray(b.plans) && b.plans.length ? b.plans.filter(p => ['starter','staff','enterprise'].includes(p)) : null);
  if (b.renewable !== undefined)         add('renewable', !!b.renewable);
  if (b.starts_at !== undefined)         add('starts_at', b.starts_at || null);
  if (b.ends_at !== undefined)           add('ends_at', b.ends_at || null);
  if (b.max_total_uses !== undefined)    add('max_total_uses', b.max_total_uses ? parseInt(b.max_total_uses) : null);
  if (b.max_uses_per_shop !== undefined) add('max_uses_per_shop', b.max_uses_per_shop ? parseInt(b.max_uses_per_shop) : null);
  if (b.status !== undefined && ['active','paused','archived'].includes(b.status)) add('status', b.status);
  if (b.notes !== undefined)             add('notes', (b.notes||'').trim() || null);
  if (b.trial_days !== undefined) {
    const td = b.trial_days ? parseInt(b.trial_days) : null;
    if (td !== null && !(td >= 1 && td <= 365)) return res.status(400).json({ error: 'Los días de trial deben estar entre 1 y 365' });
    add('trial_days', td);
  }

  if (!fields.length) return res.status(400).json({ error: 'Nada que actualizar' });
  fields.push(`updated_at=NOW()`);
  vals.push(id);
  try {
    await require('../services/promotions').ensureTrialSchema();
    if (b.trial_days !== undefined || b.code !== undefined) {
      // una promo de trial necesita código: el que se está enviando o el que ya tenía
      const cur = await pool.query('SELECT code, trial_days FROM promotions WHERE id=$1', [id]);
      const finalCode = b.code !== undefined ? (b.code || '').trim() : (cur.rows[0]?.code || '');
      const finalTrial = b.trial_days !== undefined ? b.trial_days : cur.rows[0]?.trial_days;
      if (finalTrial && !finalCode) return res.status(400).json({ error: 'Una promo de días de trial necesita un código (es lo que ingresa el cliente al registrarse)' });
    }
    const r = await pool.query(
      `UPDATE promotions SET ${fields.join(',')} WHERE id=$${i} RETURNING *`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No existe' });
    res.json(r.rows[0]);
  } catch(e) {
    if (/duplicate key.*code/i.test(e.message)) return res.status(409).json({ error: 'El código ya está en uso' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/promotions/:id
router.delete('/promotions/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM promotions WHERE id=$1', [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/promotions/:id/uses — historial de usos
router.get('/promotions/:id/uses', adminAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.*, s.name AS shop_name, s.email AS shop_email
         FROM promotion_uses u
         LEFT JOIN shops s ON s.id = u.shop_id
         WHERE u.promotion_id=$1
         ORDER BY u.used_at DESC`,
      [parseInt(req.params.id)]
    );
    res.json({ uses: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/shops-search?q=... — buscador para armar shop_ids
router.get('/shops-search', adminAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ shops: [] });
  try {
    const r = await pool.query(
      `SELECT id, name, email, filo_plan FROM shops
         WHERE (name ILIKE $1 OR email ILIKE $1)
           AND (is_barber IS NULL OR is_barber = FALSE)
         ORDER BY name LIMIT 20`,
      ['%' + q + '%']
    );
    res.json({ shops: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Web Push admin ────────────────────────────────────────────────────────────

// GET /api/admin/push/public-key — devuelve la VAPID public key para el browser
router.get('/push/public-key', adminAuth, (req, res) => {
  const push = require('../services/push');
  const key = push.getPublicKey();
  if (!key) return res.status(503).json({ error: 'Push no configurado' });
  res.json({ key });
});

// POST /api/admin/push/subscribe — guarda una suscripción admin
router.post('/push/subscribe', adminAuth, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'subscription inválida' });
  }
  try {
    const ua = (req.headers['user-agent'] || '').slice(0, 300);
    await pool.query(
      `INSERT INTO admin_push_subscriptions (endpoint, p256dh, auth, user_agent)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE
         SET p256dh = EXCLUDED.p256dh,
             auth    = EXCLUDED.auth,
             user_agent = EXCLUDED.user_agent,
             last_used_at = NOW()`,
      [endpoint, keys.p256dh, keys.auth, ua]
    );
    console.log(`[admin push subscribe] ua="${ua.slice(0,80)}" endpoint=${endpoint.slice(0,60)}...`);
    res.json({ ok: true });
  } catch(e) {
    console.error('[admin push subscribe]', e.message);
    res.status(500).json({ error: 'Error al guardar suscripción' });
  }
});

// POST /api/admin/push/test — envía un push de prueba
router.post('/push/test', adminAuth, async (req, res) => {
  const push = require('../services/push');
  const r = await push.sendToAdmins({
    title: '🔔 Admin push OK',
    body:  'Las notificaciones admin están funcionando.',
    icon:  '/favicon.ico',
    data:  { url: '/admin' }
  });
  res.json(r);
});

// ── Filo Tycoon: PIN de 4 dígitos para abrir el juego ────────────────────────
// El PIN vive en la variable TYCOON_PIN de Railway (nunca en el código público).
const tycoonPinTries = new Map();
router.post('/tycoon/unlock', adminAuth, (req, res) => {
  const ip = req.ip || 'unknown', now = Date.now();
  const e = tycoonPinTries.get(ip) || { n: 0, until: now + 15 * 60 * 1000 };
  if (now > e.until) { e.n = 0; e.until = now + 15 * 60 * 1000; }
  if (e.n >= 5) return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos.' });
  const pin = String(process.env.TYCOON_PIN || '');
  if (!/^\d{4}$/.test(pin)) return res.status(503).json({ error: 'Falta configurar el PIN en el servidor' });
  const a = Buffer.from(String(req.body?.pin || '')), b = Buffer.from(pin);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    e.n++; tycoonPinTries.set(ip, e);
    return res.status(403).json({ error: 'PIN incorrecto', left: 5 - e.n });
  }
  tycoonPinTries.delete(ip);
  res.json({ ok: true });
});


// ── Filo Tycoon: todo guardado en el servidor ────────────────────────────────
// La partida y las conexiones a FiloCars / FILO Contenido viven en app_settings, así no se
// pierden al cambiar de dispositivo, borrar datos del navegador o abrir desde el ícono.
async function settingGet(key) {
  const r = await pool.query('SELECT value, updated_at FROM app_settings WHERE key=$1', [key]);
  return r.rows[0] || null;
}
async function settingSet(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, value]);
}
const jsonOr = (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } };

// GET /api/admin/tycoon/version → { build } — el juego se recarga solo si hay una versión nueva
let _tycoonBuild = null;
router.get('/tycoon/version', (req, res) => {
  try {
    if (!_tycoonBuild) {
      const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'tycoon.html'), 'utf8');
      _tycoonBuild = (html.match(/const BUILD = '([^']+)'/) || [])[1] || 'x';
    }
    res.set('Cache-Control', 'no-store').json({ build: _tycoonBuild });
  } catch (e) { res.json({ build: null }); }
});

// GET /api/admin/tycoon/state → { state }   ·   PUT { state }
router.get('/tycoon/state', adminAuth, async (req, res) => {
  try { const r = await settingGet('tycoon_state'); res.json({ state: r ? jsonOr(r.value, null) : null }); }
  catch (e) { res.status(500).json({ error: 'No se pudo leer la partida' }); }
});
router.put('/tycoon/state', adminAuth, async (req, res) => {
  try {
    const st = req.body?.state;
    if (!st || typeof st !== 'object') return res.status(400).json({ error: 'Partida inválida' });
    const txt = JSON.stringify(st);
    if (txt.length > 300000) return res.status(413).json({ error: 'Partida demasiado grande' });
    // Nunca pisar una partida más nueva con una vieja (dos dispositivos abiertos)
    const cur = await settingGet('tycoon_state');
    const curTick = cur ? (jsonOr(cur.value, {}).lastTick || 0) : 0;
    if ((st.lastTick || 0) < curTick) return res.json({ ok: true, kept: 'server', state: jsonOr(cur.value, null) });
    await settingSet('tycoon_state', txt);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'No se pudo guardar la partida' }); }
});

// ── FiloCars (el servidor guarda la sesión y la renueva sola) ────────────────
// Con la variable CARS_ADMIN_PASSWORD (referencia a la de FiloCars) nunca vuelve a pedir contraseña.
const CARS_URL = (process.env.CARS_URL || 'https://filocars-production.up.railway.app').replace(/\/$/, '');
async function carsLogin(password) {
  const r = await fetch(CARS_URL + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.token) { const e = new Error(data.error || 'No se pudo entrar a FiloCars'); e.status = r.status === 401 ? 401 : 502; throw e; }
  await settingSet('tycoon_cars_token', JSON.stringify({ token: data.token, at: Date.now() }));
  return data.token;
}
// opts: { method, body } para editar (PUT); sin opts es una lectura
async function carsFetch(path, opts = {}) {
  const saved = jsonOr((await settingGet('tycoon_cars_token'))?.value, null);
  let token = saved && Date.now() - saved.at < 11 * 3600 * 1000 ? saved.token : null;
  if (!token && process.env.CARS_ADMIN_PASSWORD) token = await carsLogin(process.env.CARS_ADMIN_PASSWORD);
  if (!token) { const e = new Error('Conectá FiloCars'); e.status = 412; throw e; }
  const call = (t) => fetch(CARS_URL + '/api/admin' + path, {
    method: opts.method || 'GET',
    headers: { Authorization: 'Bearer ' + t, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let r = await call(token);
  if (r.status === 401 && process.env.CARS_ADMIN_PASSWORD) {
    token = await carsLogin(process.env.CARS_ADMIN_PASSWORD);
    r = await call(token);
  }
  if (r.status === 401) { await settingSet('tycoon_cars_token', ''); const e = new Error('Conectá FiloCars'); e.status = 412; throw e; }
  const data = await r.json().catch(() => ({}));
  // Los errores de validación de FiloCars (400, 404) se pasan tal cual
  if (r.status === 400 || r.status === 404) { const e = new Error(data.error || 'FiloCars rechazó el cambio'); e.status = r.status; throw e; }
  if (!r.ok) { const e = new Error('FiloCars no respondió'); e.status = 502; throw e; }
  return data;
}

// Pestaña 🚗 Cars del admin: lee y edita agencias por el servidor, que guarda la sesión de FiloCars
// y se vuelve a conectar solo con CARS_ADMIN_PASSWORD (el admin nunca ve ni pide esa contraseña).
router.get('/cars/agencies', adminAuth, async (req, res) => {
  try { res.json(await carsFetch('/agencies')); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
router.put('/cars/agencies/:id', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Agencia inválida' });
  const b = req.body || {};
  const body = {};
  if (b.subscription_status) body.subscription_status = String(b.subscription_status);
  if (typeof b.is_test === 'boolean') body.is_test = b.is_test;
  if (b.add_days) body.add_days = parseInt(b.add_days);
  if (b.owner_password) body.owner_password = String(b.owner_password);
  if (b.sample_data === true) body.sample_data = true;
  try { res.json(await carsFetch(`/agencies/${id}`, { method: 'PUT', body })); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
router.post('/tycoon/cars/login', adminAuth, async (req, res) => {
  try { await carsLogin(String(req.body?.password || '')); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
router.get('/tycoon/cars/agencies', adminAuth, async (req, res) => {
  try { res.json(await carsFetch('/agencies')); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// ── Puente con FILO Contenido (el servidor guarda la sesión) ─────────────────
// Contenido usa una cookie de sesión propia (PIN). El servidor la guarda y la reenvía; si vence
// y está la variable CONTENIDO_PIN, vuelve a entrar solo. Solo para el admin logueado.
const CONTENIDO_URL = (process.env.CONTENIDO_URL || 'https://filo-contenido.up.railway.app').replace(/\/$/, '');
const CONTENIDO_ACTIONS = new Set(['approve', 'changes', 'published', 'unapprove', 'unpublish']);

async function contenidoLogin(pin) {
  const r = await fetch(CONTENIDO_URL + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: String(pin || '') }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'PIN incorrecto'); e.status = r.status === 401 ? 401 : 502; throw e; }
  const cookies = (typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')])
    .filter(Boolean).map(c => c.split(';')[0].trim());
  if (!cookies.length) { const e = new Error('Contenido no devolvió sesión'); e.status = 502; throw e; }
  const session = cookies.join('; ');
  await settingSet('tycoon_ct_session', session);
  return session;
}
async function contenidoSession(req) {
  const h = String(req.headers['x-contenido-session'] || '');
  const fromHeader = h.length < 4096 && !/[\r\n]/.test(h) ? h : '';
  const saved = (await settingGet('tycoon_ct_session'))?.value || '';
  if (!saved && fromHeader) await settingSet('tycoon_ct_session', fromHeader); // migra la sesión vieja del celu
  return saved || fromHeader;
}
// Hace el pedido a Contenido; si la sesión venció y hay CONTENIDO_PIN, entra de nuevo y reintenta
async function contenidoFetch(req, path, opts = {}) {
  let session = await contenidoSession(req);
  const go = (s) => fetch(CONTENIDO_URL + path, { ...opts, headers: { ...(opts.headers || {}), Cookie: s } });
  if (!session && process.env.CONTENIDO_PIN) session = await contenidoLogin(process.env.CONTENIDO_PIN);
  let r = await go(session);
  if (r.status === 401 && process.env.CONTENIDO_PIN) { session = await contenidoLogin(process.env.CONTENIDO_PIN); r = await go(session); }
  if (r.status === 401) await settingSet('tycoon_ct_session', '');
  return r;
}

// POST /api/admin/contenido/login { pin }
router.post('/contenido/login', adminAuth, async (req, res) => {
  // session va también en la respuesta: las versiones viejas del juego (guardadas en el celu) la esperan
  try { const session = await contenidoLogin(req.body?.pin); res.json({ ok: true, session }); }
  catch (e) { res.status(e.status || 502).json({ error: e.status ? e.message : 'FILO Contenido no responde' }); }
});

// GET /api/admin/contenido/pieces
router.get('/contenido/pieces', adminAuth, async (req, res) => {
  try {
    const r = await contenidoFetch(req, '/api/pieces');
    const data = await r.json().catch(() => ({}));
    res.status(r.status === 401 ? 401 : (r.ok ? 200 : 502)).json(r.ok ? data : { error: data.error || 'Sesión de Contenido vencida' });
  } catch (e) { res.status(e.status === 401 ? 401 : 502).json({ error: e.status ? e.message : 'FILO Contenido no responde' }); }
});

// POST /api/admin/contenido/pieces/:id/:action  (approve | changes {feedback} | published | unapprove | unpublish)
router.post('/contenido/pieces/:id/:action', adminAuth, async (req, res) => {
  if (!CONTENIDO_ACTIONS.has(req.params.action)) return res.status(400).json({ error: 'Acción inválida' });
  try {
    const r = await contenidoFetch(req, `/api/pieces/${encodeURIComponent(req.params.id)}/${req.params.action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.params.action === 'changes' ? { feedback: String(req.body?.feedback || '').slice(0, 2000) } : {}),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status === 401 ? 401 : (r.ok ? 200 : 502)).json(r.ok ? data : { error: data.error || 'No se pudo completar' });
  } catch (e) { res.status(e.status === 401 ? 401 : 502).json({ error: e.status ? e.message : 'FILO Contenido no responde' }); }
});

// GET /api/admin/contenido/media/:id — imagen o video del posteo (se transmite tal cual)
router.get('/contenido/media/:id', adminAuth, async (req, res) => {
  try {
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const r = await contenidoFetch(req, `/media/${encodeURIComponent(req.params.id)}`, { headers });
    if (!r.ok && r.status !== 206) return res.status(r.status === 401 ? 401 : 404).end();
    res.status(r.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { const v = r.headers.get(h); if (v) res.setHeader(h, v); }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const { Readable } = require('stream');
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) { if (!res.headersSent) res.status(502).end(); }
});

module.exports = router;