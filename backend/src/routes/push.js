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
    res.json({ ok: true });
  } catch(e) {
    console.error('[push subscribe]', e.message);
    res.status(500).json({ error: 'Error al guardar suscripción' });
  }
});

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
