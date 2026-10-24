const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');
const push   = require('../services/push');

// GET /api/push/public-key — para que el frontend construya la subscription
router.get('/public-key', (req, res) => {
  const key = push.getPublicKey();
  if (!key) return res.status(503).json({ error: 'Push no configurado' });
  res.json({ key });
});

// POST /api/push/subscribe — guarda la suscripción del browser
router.post('/subscribe', auth, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'subscription inválida' });
  }
  try {
    const ua = (req.headers['user-agent'] || '').slice(0, 300);
    await pool.query(
      `INSERT INTO push_subscriptions (shop_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE
         SET shop_id = EXCLUDED.shop_id,
             p256dh  = EXCLUDED.p256dh,
             auth    = EXCLUDED.auth,
             user_agent = EXCLUDED.user_agent,
             last_used_at = NOW()`,
      [req.shopId, endpoint, keys.p256dh, keys.auth, ua]
    );
    console.log(`[push subscribe] shop=${req.shopId} ua="${ua.slice(0,80)}" endpoint=${endpoint.slice(0,60)}...`);
    res.json({ ok: true });
  } catch(e) {
    console.error('[push subscribe]', e.message);
    res.status(500).json({ error: 'Error al guardar suscripción' });
  }
});

// ── App instalada (PWA) ──────────────────────────────────────────────────────
// El navegador no avisa cuando alguien instala la app, pero sí se puede saber cuándo la abren
// como app instalada: cada dispositivo se registra (sin datos personales, solo un id al azar).
let _pwaTable = null;
function ensurePwaTable() {
  if (!_pwaTable) {
    _pwaTable = pool.query(`CREATE TABLE IF NOT EXISTS pwa_devices (
        shop_id    INTEGER NOT NULL,
        device_id  VARCHAR(64) NOT NULL,
        platform   VARCHAR(20),
        first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (shop_id, device_id))`)
      .catch(e => { _pwaTable = null; throw e; });
  }
  return _pwaTable;
}

// POST /api/push/device { device_id, platform } — solo lo llama la app instalada
router.post('/device', auth, async (req, res) => {
  const deviceId = String(req.body?.device_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const platform = ['ios', 'android', 'windows', 'mac', 'linux', 'otro'].includes(req.body?.platform) ? req.body.platform : 'otro';
  if (!deviceId) return res.status(400).json({ error: 'device_id requerido' });
  try {
    await ensurePwaTable();
    await pool.query(
      `INSERT INTO pwa_devices (shop_id, device_id, platform) VALUES ($1,$2,$3)
       ON CONFLICT (shop_id, device_id) DO UPDATE SET last_seen = NOW(), platform = EXCLUDED.platform`,
      [req.shopId, deviceId, platform]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});
router._ensurePwaTable = ensurePwaTable;

// POST /api/push/unsubscribe — borra una suscripción (al revocar permisos)
router.post('/unsubscribe', auth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });
  try {
    await pool.query(
      `DELETE FROM push_subscriptions WHERE endpoint=$1 AND shop_id=$2`,
      [endpoint, req.shopId]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Error' });
  }
});

// POST /api/push/test — enviar un push de prueba
router.post('/test', auth, async (req, res) => {
  const r = await push.sendToRecipient(req.shopId, {
    title: '🔔 Push funcionando',
    body:  'Vas a recibir notificaciones aunque la app esté cerrada.',
    icon:  '/favicon.ico',
    data:  { url: '/app' }
  });
  res.json(r);
});

module.exports = router;
