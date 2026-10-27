// Web Push: wrapper sobre web-push con lazy init de VAPID y manejo de errores
// (si el cliente desinstaló/revocó, su suscripción se borra de la DB).

const pool = require('../db/pool');

let _webpush = null;
let _vapidReady = false;

// urgency 'high': Android/iOS la entregan al instante aunque el teléfono esté en ahorro de energía
// (con 'normal', el valor por defecto, la pueden demorar minutos). TTL: si el celular está apagado,
// el aviso se descarta a las 6 h en vez de llegar días después.
const PUSH_OPTS = { urgency: 'high', TTL: 6 * 3600 };

function init() {
  if (_webpush) return _webpush;
  try {
    _webpush = require('web-push');
    const pub  = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    const sub  = process.env.VAPID_SUBJECT || 'mailto:serviciosfilocrm@gmail.com';
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

  const data = JSON.stringify(payload || {});
  const results = await Promise.allSettled(subs.rows.map(row =>
    _webpush.sendNotification({
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth }
    }, data, PUSH_OPTS).then(() => {
      pool.query(`UPDATE push_subscriptions SET last_used_at=NOW() WHERE id=$1`, [row.id]).catch(()=>{});
      return { ok: true, row };
    }, err => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        pool.query(`DELETE FROM push_subscriptions WHERE id=$1`, [row.id]).catch(()=>{});
      } else {
        console.warn(`[push] send error (shop=${shopId} sub=${row.id}):`, err?.statusCode, err?.body?.slice?.(0,120) || err?.message);
      }
      return { ok: false, row };
    })
  ));
  let sent = 0, failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.ok) sent++;
    else failed++;
  }
  return { sent, failed };
}

// Envía un push a todas las suscripciones admin (panel /admin)
async function sendToAdmins(payload) {
  if (!isReady()) {
    console.warn('[push admin] skip: VAPID no configurado');
    return { sent: 0, failed: 0, reason: 'vapid_missing' };
  }
  let subs;
  try {
    subs = await pool.query(`SELECT id, endpoint, p256dh, auth FROM admin_push_subscriptions`);
  } catch(e) {
    console.warn('[push admin] skip: tabla no existe aún —', e.message);
    return { sent: 0, failed: 0, reason: 'table_missing' };
  }
  if (!subs.rows.length) return { sent: 0, failed: 0, reason: 'no_subs' };
  console.log(`[push admin] enviando a ${subs.rows.length} sub(s) title="${(payload?.title||'').slice(0,40)}"`);
  const data = JSON.stringify(payload || {});
  const results = await Promise.allSettled(subs.rows.map(row =>
    _webpush.sendNotification({
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth }
    }, data, PUSH_OPTS).then(() => {
      pool.query(`UPDATE admin_push_subscriptions SET last_used_at=NOW() WHERE id=$1`, [row.id]).catch(()=>{});
      return true;
    }, err => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        pool.query(`DELETE FROM admin_push_subscriptions WHERE id=$1`, [row.id]).catch(()=>{});
      } else {
        console.warn(`[push admin] send error sub=${row.id}:`, err?.statusCode, err?.body?.slice?.(0,120) || err?.message);
      }
      return false;
    })
  ));
  let sent = 0, failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) sent++; else failed++;
  }
  return { sent, failed };
}

module.exports = { init, isReady, getPublicKey, sendToRecipient, sendToAdmins };
