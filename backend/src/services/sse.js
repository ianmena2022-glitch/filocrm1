// Hub simple de Server-Sent Events por shopId.
// Cada conexión se registra en el "room" de su shopId. emit() escribe un
// evento a todas las conexiones de ese room.

const _rooms = new Map(); // shopId → Set<res>

function join(shopId, res) {
  const sid = Number(shopId);
  if (!sid) return () => {};
  let set = _rooms.get(sid);
  if (!set) { set = new Set(); _rooms.set(sid, set); }
  set.add(res);
  return () => leave(sid, res);
}

function leave(shopId, res) {
  const sid = Number(shopId);
  const set = _rooms.get(sid);
  if (!set) return;
  set.delete(res);
  if (!set.size) _rooms.delete(sid);
}

function emit(shopId, event, payload) {
  // En el servicio de WhatsApp no hay navegadores conectados: el evento se reenvía a la app
  // principal, que es la que tiene abiertas las conexiones en vivo del CRM.
  if (process.env.WPP_IS_WORKER === '1') {
    const main = process.env.MAIN_APP_URL;
    if (main) {
      fetch(String(main).replace(/\/+$/, '') + '/api/internal/sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wpp-secret': process.env.WPP_WORKER_SECRET || '' },
        body: JSON.stringify({ shopId, event, payload }),
      }).catch(() => {});
    }
    return;
  }
  const sid = Number(shopId);
  const set = _rooms.get(sid);
  if (!set || !set.size) return;
  const chunk = `event: ${event}\ndata: ${JSON.stringify(payload || {})}\n\n`;
  for (const res of [...set]) {
    try {
      res.write(chunk);
    } catch(_) {
      set.delete(res);
    }
  }
}

// Para eventos que también le importan al enterprise owner (dashboard global
// de todas las sucursales).
function emitWithParent(shopId, parentId, event, payload) {
  emit(shopId, event, payload);
  if (parentId && Number(parentId) !== Number(shopId)) emit(parentId, event, payload);
}

// Igual que emitWithParent, pero busca solo la cuenta Enterprise del local (si es sucursal).
// Así la agenda abierta del dueño Enterprise se actualiza cuando cobra o cambia un turno la sucursal
// o un barbero. El padre se guarda 10 min en memoria para no consultar la base en cada evento.
const _parentCache = new Map(); // shopId → { parent, at }
async function emitShop(shopId, event, payload) {
  emit(shopId, event, payload);
  const sid = Number(shopId);
  if (!sid) return;
  let c = _parentCache.get(sid);
  if (!c || Date.now() - c.at > 10 * 60 * 1000) {
    try {
      const r = await require('../db/pool').query('SELECT parent_enterprise_id FROM shops WHERE id=$1', [sid]);
      c = { parent: r.rows[0]?.parent_enterprise_id || null, at: Date.now() };
      _parentCache.set(sid, c);
    } catch (_) { return; }
  }
  if (c.parent && Number(c.parent) !== sid) emit(c.parent, event, payload);
}

function stats() {
  let total = 0;
  for (const s of _rooms.values()) total += s.size;
  return { rooms: _rooms.size, connections: total };
}

module.exports = { join, leave, emit, emitWithParent, emitShop, stats };
