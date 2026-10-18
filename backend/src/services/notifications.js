const pool = require('../db/pool');
const sse  = require('./sse');

// Crea una notificación persistente y la empuja por SSE al recipient.
// opts: { shopId, recipientShopId, type, title, body?, icon?, link? }
async function create(opts) {
  const { shopId, recipientShopId, type, title, body, icon, link } = opts;
  if (!shopId || !recipientShopId || !type || !title) return null;
  try {
    const r = await pool.query(
      `INSERT INTO notifications
         (shop_id, recipient_shop_id, type, title, body, icon, link)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, type, title, body, icon, link, created_at`,
      [shopId, recipientShopId, type, title, body || null, icon || null, link || null]
    );
    const row = r.rows[0];
    sse.emit(recipientShopId, 'notification.created', {
      id: row.id, type: row.type, title: row.title, body: row.body,
      icon: row.icon, link: row.link, created_at: row.created_at
    });

    // Capa 2: web push (fire & forget)
    try {
      const push = require('./push');
      if (push && push.sendToRecipient) {
        push.sendToRecipient(recipientShopId, {
          title: row.title,
          body:  row.body || '',
          icon:  '/favicon.ico',
          data:  { url: row.link || '/app', type: row.type, id: row.id }
        }).catch(() => {});
      }
    } catch(_) { /* push aún no disponible */ }

    return row;
  } catch(e) {
    console.error('[notifications] create error:', e.message);
    return null;
  }
}

// Crear una misma notificación a varios recipients (ej: dueño + barbero asignado)
async function createMany(recipients, baseOpts) {
  if (!Array.isArray(recipients) || !recipients.length) return [];
  const out = [];
  for (const rid of recipients) {
    if (!rid) continue;
    const row = await create({ ...baseOpts, recipientShopId: rid });
    if (row) out.push(row);
  }
  return out;
}

module.exports = { create, createMany };
