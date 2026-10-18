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

function stats() {
  let total = 0;
  for (const s of _rooms.values()) total += s.size;
  return { rooms: _rooms.size, connections: total };
}

module.exports = { join, leave, emit, emitWithParent, stats };
