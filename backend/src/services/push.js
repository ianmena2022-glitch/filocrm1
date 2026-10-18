// Web Push: wrapper sobre web-push con lazy init de VAPID y manejo de errores
// (si el cliente desinstaló/revocó, su suscripción se borra de la DB).

const pool = require('../db/pool');

let _webpush = null;
let _vapidReady = false;

function init() {
  if (_webpush) return _webpush;
  try {
    _webpush = require('web-push');
    const pub  = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    const sub  = process.env.VAPID_SUBJECT || 'mailto:soporte@filocrm.com.ar';
    if (pub && priv) {
      _webpush.setVapidDetails(sub, pub, priv);
      _vapidReady = true;
    } else {
      console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY no configurados — web push deshabilitado');
    }
  } catch(e) {
    console.warn('[push] web-push no disponible:', e.message);
  }
  return _webpush;
}

function isReady() {
  if (!_webpush) init();
  return _vapidReady;
}

function getPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

async function sendToRecipient(shopId, payload) {
  if (!isReady()) {
    console.warn(`[push] send skip shop=${shopId}: VAPID no configurado`);
    return { sent: 0, failed: 0, reason: 'vapid_missing' };
  }
  const subs = await pool.query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE shop_id=$1`,
    [shopId]
  );
  if (!subs.rows.length) {
    console.log(`[push] send skip shop=${shopId}: sin suscripciones`);
    return { sent: 0, failed: 0, reason: 'no_subs' };
  }
  console.log(`[push] enviando a shop=${shopId} subs=${subs.rows.length} title="${(payload?.title||'').slice(0,40)}"`);

  let sent = 0, failed = 0;
  const data = JSON.stringify(payload || {});
  for (const row of subs.rows) {
    try {
      await _webpush.sendNotification({
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth }
      }, data);
      sent++;
      pool.query(`UPDATE push_subscriptions SET last_used_at=NOW() WHERE id=$1`, [row.id]).catch(()=>{});
    } catch(err) {
      failed++;
      // 404/410 → la suscripción está muerta, la borramos
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        pool.query(`DELETE FROM push_subscriptions WHERE id=$1`, [row.id]).catch(()=>{});
      } else {
        console.warn(`[push] send error (shop=${shopId} sub=${row.id}):`, err?.statusCode, err?.body?.slice?.(0,120) || err?.message);
      }
    }
  }
  return { sent, failed };
}

module.exports = { init, isReady, getPublicKey, sendToRecipient };
