// Baileys v7 — ESM-only, lazy dynamic import desde CJS
let _baileys = null;
async function getBaileys() {
  if (!_baileys) _baileys = await import('@whiskeysockets/baileys');
  return _baileys;
}

const { Boom } = require('@hapi/boom');
const pool = require('../db/pool');

// ─── Reglas anti-baneo de envío ──────────────────────────────────────────────
// WhatsApp banea números que se comportan como bot: mensajes a desconocidos, ritmo
// constante, ráfagas, volumen alto de golpe y destinatarios que reportan o bloquean.
// TODO envío (respuestas del bot, avisos, promociones) pasa por _deliver() y estas reglas.
//
// Tipos de envío (kind):
//   reply     → respuesta a un mensaje que el cliente nos escribió
//   notify    → aviso transaccional que el cliente espera (turno, seña, fila)
//   marketing → promociones / rescates
//   cold      → primer contacto a un número que no es cliente (prospección)
const wppGuard = (() => {
  const KINDS = ['reply', 'notify', 'marketing', 'cold'];
  const envInt = (name, def) => { const n = parseInt(process.env[name]); return Number.isFinite(n) && n >= 0 ? n : def; };
  const config = () => ({
    dailyCap:        envInt('WPP_DAILY_CAP', 300),         // todos los envíos del día por número
    firstContactCap: envInt('WPP_FIRST_CONTACT_CAP', 40),  // a números sin conversación previa
    marketingCap:    envInt('WPP_MARKETING_CAP', 60),
    coldCap:         envInt('WPP_COLD_CAP', 20),
    recipientHourly: envInt('WPP_RECIPIENT_HOURLY', 6),    // a un mismo destinatario por hora
    marketingCooldownDays: envInt('WPP_MARKETING_COOLDOWN_DAYS', 7),
    // pausa (ms) entre un envío y el siguiente, con jitter aleatorio dentro del rango
    gaps: {
      chat: [envInt('WPP_GAP_CHAT_MIN_MS', 2500),  envInt('WPP_GAP_CHAT_MAX_MS', 6000)],
      bulk: [envInt('WPP_GAP_BULK_MIN_MS', 20000), envInt('WPP_GAP_BULK_MAX_MS', 45000)],
    },
  });
  // El "día" de los topes se reinicia a medianoche, hora Argentina
  const dayKey = (now = Date.now()) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date(now));

  // Freno automático: tras varios envíos fallidos seguidos se pausa el número un rato
  // en vez de seguir insistiendo (insistir con la conexión rota es una señal de bot).
  const BREAKER_FAILS = 5, BREAKER_PAUSE_MS = 30 * 60 * 1000;
  const breaker = Object.create(null);     // shop → { fails, until }
  function failed(shopId, now = Date.now()) {
    const b = breaker[shopId] || (breaker[shopId] = { fails: 0, until: 0 });
    b.fails++;
    if (b.fails >= BREAKER_FAILS) {
      b.fails = 0;
      b.until = now + BREAKER_PAUSE_MS;
      console.warn(`[WPP] shop ${shopId}: ${BREAKER_FAILS} envíos fallidos seguidos — envíos en pausa ${BREAKER_PAUSE_MS / 60000} min`);
    }
  }
  const succeeded = (shopId) => { delete breaker[shopId]; };
  const pausedUntil = (shopId, now = Date.now()) => { const b = breaker[shopId]; return b && b.until > now ? b.until : 0; };

  const counters  = Object.create(null);   // `${shop}:${day}:${bucket}` → n
  const recipient = new Map();             // `${shop}:${phone}` → [timestamps]
  const nextFree  = Object.create(null);   // `${shop}:${lane}` → ms epoch
  const lastDigits = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);
  const guardError = (code, message) => { const e = new Error(message); e.code = code; return e; };

  // Lanza si el envío no corresponde. No modifica contadores (eso lo hace record()).
  function check(shopId, phone, kind, { firstContact = false, now = Date.now() } = {}) {
    if (!KINDS.includes(kind)) kind = 'notify';
    const paused = pausedUntil(shopId, now);
    if (paused)
      throw guardError('CIRCUIT_OPEN', `WhatsApp en pausa por envíos fallidos; se reintenta en ${Math.ceil((paused - now) / 60000)} min`);
    const c = config();
    const day = dayKey(now);
    const get = (b) => counters[`${shopId}:${day}:${b}`] || 0;
    if (get('total') >= c.dailyCap)
      throw guardError('DAILY_CAP', `WhatsApp: límite diario de ${c.dailyCap} mensajes alcanzado (se reinicia a medianoche)`);
    if (kind === 'marketing' && get('marketing') >= c.marketingCap)
      throw guardError('MARKETING_CAP', `WhatsApp: límite diario de ${c.marketingCap} mensajes promocionales alcanzado`);
    if (kind === 'cold' && get('cold') >= c.coldCap)
      throw guardError('COLD_CAP', `WhatsApp: límite diario de ${c.coldCap} primeros contactos alcanzado`);
    if (kind !== 'reply' && firstContact && get('first') >= c.firstContactCap)
      throw guardError('FIRST_CONTACT_CAP', `WhatsApp: límite diario de ${c.firstContactCap} mensajes a contactos nuevos alcanzado`);
    const list = (recipient.get(`${shopId}:${lastDigits(phone)}`) || []).filter(t => now - t < 3600000);
    if (list.length >= c.recipientHourly)
      throw guardError('RECIPIENT_RATE', 'WhatsApp: demasiados mensajes a este mismo número en la última hora');
  }

  function record(shopId, phone, kind, { firstContact = false, now = Date.now() } = {}) {
    if (!KINDS.includes(kind)) kind = 'notify';
    const day = dayKey(now);
    const inc = (b) => { const k = `${shopId}:${day}:${b}`; counters[k] = (counters[k] || 0) + 1; };
    inc('total');
    if (kind === 'marketing') inc('marketing');
    if (kind === 'cold') inc('cold');
    if (kind !== 'reply' && firstContact) inc('first');
    if (onRecord) { try { onRecord(shopId, day); } catch (_) {} }
    const key = `${shopId}:${lastDigits(phone)}`;
    const list = (recipient.get(key) || []).filter(t => now - t < 3600000);
    list.push(now);
    recipient.set(key, list);
    // Limpieza ocasional de días viejos y destinatarios inactivos
    if (Math.random() < 0.02) {
      for (const k of Object.keys(counters)) if (!k.includes(`:${day}:`)) delete counters[k];
      for (const [k, v] of recipient) if (!v.length || now - v[v.length - 1] > 3600000) recipient.delete(k);
    }
  }

  const countToday = (shopId, bucket = 'total', now = Date.now()) => counters[`${shopId}:${dayKey(now)}:${bucket}`] || 0;

  // Reserva el próximo "turno" de envío del número y devuelve cuántos ms hay que esperar.
  // Chat y promociones van por carriles separados: una tanda de promociones no demora la
  // respuesta a un cliente que acaba de escribir.
  function reserve(shopId, kind, { now = Date.now(), rand = Math.random } = {}) {
    const c = config();
    const lane = (kind === 'marketing' || kind === 'cold') ? 'bulk' : 'chat';
    const [min, max] = c.gaps[lane];
    const key = `${shopId}:${lane}`;
    const start = Math.max(now, nextFree[key] || 0);
    nextFree[key] = start + min + Math.floor(rand() * Math.max(0, max - min));
    return start - now;
  }

  // Pedidos de baja: solo frases inequívocas ("cancelar" suelto puede ser un turno)
  const normalizeText = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const OPT_OUT_WHOLE = /^(stop|baja|basta|parar|unsubscribe|desuscribir(me)?|darme de baja|dame de baja|dar de baja)[\s.!]*$/;
  const OPT_OUT_PHRASES = [
    /\bno (quiero|deseo|necesito) (recibir|mas mensajes|que me (escriban|manden|envien|molesten|contacten))/,
    /\b(dejen|deja|dejame|dejenme) de (escribir|escribirme|mandar|mandarme|enviar|enviarme|molestar|molestarme)/,
    /\bno me (escriban|escribas|manden|mandes|envien|envies|molesten|molestes|contacten|contactes)\b/,
    /\bsacame de (la|esta|su) (lista|base)/,
    /\bbaja de (los )?mensajes/,
    /\bno (quiero|deseo) (ser )?(contactado|contactada)/,
  ];
  function isOptOutIntent(text) {
    const t = normalizeText(text);
    if (!t || t.length > 200) return false;
    return OPT_OUT_WHOLE.test(t) || OPT_OUT_PHRASES.some(r => r.test(t));
  }

  // Persistencia (la conecta whatsapp.js): los topes del día sobreviven a un reinicio/deploy
  let onRecord = null;
  const setOnRecord = (fn) => { onRecord = fn; };
  const snapshot = (shopId, day) => {
    const out = {};
    for (const b of ['total', 'marketing', 'cold', 'first']) out[b] = counters[`${shopId}:${day}:${b}`] || 0;
    return out;
  };
  // Carga un contador guardado (nunca baja lo que ya se contó en memoria)
  const seed = (shopId, day, bucket, n) => {
    const k = `${shopId}:${day}:${bucket}`;
    counters[k] = Math.max(counters[k] || 0, parseInt(n) || 0);
  };

  function __reset() {
    for (const k of Object.keys(counters)) delete counters[k];
    for (const k of Object.keys(nextFree)) delete nextFree[k];
    for (const k of Object.keys(breaker)) delete breaker[k];
    recipient.clear();
  }
  return { KINDS, config, check, record, reserve, countToday, isOptOutIntent, lastDigits, dayKey, __reset,
           failed, succeeded, pausedUntil, setOnRecord, snapshot, seed };
})();
const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Directorio base para sesiones Baileys (override con BAILEYS_DIR)
const BAILEYS_BASE = process.env.BAILEYS_DIR || path.join(os.tmpdir(), 'filo_baileys');
try { fs.mkdirSync(BAILEYS_BASE, { recursive: true }); } catch(_){}
function baileysDir(shopId) { return path.join(BAILEYS_BASE, `shop_${shopId}`); }

// Mapa de sockets activos por shopId
const sockets  = {};
// Última actividad (ms epoch) por shopId para idle sweeper + LRU
const _lastActivity = Object.create(null);
function _touch(shopId) { _lastActivity[shopId] = Date.now(); }

// Config: idle TTL + hard cap (configurable por env, con defaults seguros).
// WPP_IDLE_TTL_MIN=0 (default) DESACTIVA el idle-sweep → sesiones hot para siempre
// mientras alcance el cap. Esto garantiza que el bot IA nunca se pierda mensajes.
// Pasá un valor >0 si querés que cierre sockets inactivos tras N minutos.
const WPP_IDLE_TTL_MS   = (parseInt(process.env.WPP_IDLE_TTL_MIN) || 0) * 60 * 1000;
const WPP_MAX_SESSIONS  = parseInt(process.env.WPP_MAX_SESSIONS) || 50;
const WPP_SWEEP_EVERY   = 5 * 60 * 1000;
const qrCodes  = {};
const statuses = {};
const decryptErrors = {};
const ciphertextLastWarning = {}; // debounce: última vez que se avisó por JID

// Backoff de QR — evita rate-limit de WhatsApp por demasiados intentos de vinculación
const qrAttempts     = {}; // shopId -> cantidad de QRs generados en la sesión actual
const qrCooldownUntil = {}; // shopId -> timestamp hasta el que no se puede generar QR
const MAX_QR_ATTEMPTS  = 5;               // máx QRs sin que nadie escanee
const QR_COOLDOWN_MS   = 30 * 60 * 1000; // 30 minutos de cooldown

// Registrar una única vez el handler de unhandledRejection para errores de conexión no fatales
if (!global.__filoWppUnhandledRejectionBound) {
  global.__filoWppUnhandledRejectionBound = true;
  process.on('unhandledRejection', (reason) => {
    if (reason?.message?.includes('Connection Closed') || reason?.output?.statusCode === 428) {
      console.log(`[WPP] Error de conexión capturado (no fatal): ${reason.message}`);
    }
  });
}

// Fix #15: limpiar entradas de ciphertextLastWarning con más de 10 minutos
const _ciphertextCleanupInterval = setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const jid of Object.keys(ciphertextLastWarning)) {
    if (ciphertextLastWarning[jid] < cutoff) delete ciphertextLastWarning[jid];
  }
}, 10 * 60 * 1000);
if (typeof _ciphertextCleanupInterval.unref === 'function') _ciphertextCleanupInterval.unref();

// Health check: cada 2 min verifica que el socket siga vivo con sendPresenceUpdate.
// Si falla 2 veces consecutivas, marcamos wpp_connected=FALSE y lanzamos reconexión.
// Esto detecta sockets zombies (WS muerto sin disparar connection.close) que normalmente
// hacían que sendText se cuelgue 30s.
const healthIntervals = {};
const healthFailures = {};
function startHealthCheck(shopId) {
  stopHealthCheck(shopId);
  healthFailures[shopId] = 0;
  const h = setInterval(async () => {
    const sock = sockets[shopId];
    if (!sock || statuses[shopId] !== 'connected') { stopHealthCheck(shopId); return; }
    try {
      // Timeout agresivo para detectar zombies
      await Promise.race([
        sock.sendPresenceUpdate('available'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('health_timeout')), 10000))
      ]);
      healthFailures[shopId] = 0;
    } catch (e) {
      healthFailures[shopId] = (healthFailures[shopId] || 0) + 1;
      console.warn(`[WPP health] shop ${shopId} fallo ${healthFailures[shopId]}/2: ${e.message}`);
      if (healthFailures[shopId] >= 2) {
        console.warn(`[WPP health] shop ${shopId} zombie detectado — forzando reconexión`);
        statuses[shopId] = 'disconnected';
        try { sock.end?.(new Error('zombie detected')); } catch(_){}
        delete sockets[shopId];
        stopHealthCheck(shopId);
        scheduleReconnect(shopId, 2000);
      }
    }
  }, 2 * 60 * 1000);
  if (typeof h.unref === 'function') h.unref();
  healthIntervals[shopId] = h;
}
function stopHealthCheck(shopId) {
  if (healthIntervals[shopId]) { clearInterval(healthIntervals[shopId]); delete healthIntervals[shopId]; }
  delete healthFailures[shopId];
}

// Dedup de mensajes entrantes por shopId:msgId
const processedMsgIds = new Set();

// Normaliza un teléfono AR al formato E.164 sin '+' (549 + area + número).
// Acepta variantes comunes y devuelve string con solo dígitos.
function normalizePhoneAR(phone) {
  if (phone == null) return '';
  let p = String(phone).replace(/\D/g, '');
  if (!p) return '';
  if (p.length === 10) p = '549' + p;                               // 1123456789 → 5491123456789
  else if (p.length === 11 && p.startsWith('15')) p = '54911' + p.slice(2);
  else if (p.length === 12 && p.startsWith('54')) p = '549' + p.slice(2); // 54XXXXXXXXXX → 549XXXXXXXXXX
  return p;
}

// Renderiza un template "Hola {nombre}, tu turno {fecha}" reemplazando case-insensitive
// y globalmente las claves. Toda {variable} que no haya sido pasada se elimina del texto
// para no mostrar "{clientname}" literal al cliente.
function renderTemplate(tpl, vars) {
  if (!tpl) return '';
  let out = String(tpl);
  for (const k of Object.keys(vars || {})) {
    const re = new RegExp('\\{' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\}', 'gi');
    out = out.replace(re, vars[k] == null ? '' : String(vars[k]));
  }
  // Limpiar variables sin resolver + espacios dobles / salto de línea triple
  out = out.replace(/\{[^{}]{1,40}\}/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

// Simula escritura humana antes de mandar: presence 'composing' + delay según largo del msg.
// Reduce señales que WhatsApp usa para detectar bots.
async function simulateTyping(sock, jid, messageLength = 100) {
  if (!sock || !jid) return;
  try {
    // Delay base: ~1.2s por 100 chars + jitter aleatorio (±500ms), capeado en 4s
    const base = Math.min(1200 + Math.round(messageLength * 12), 4000);
    const jitter = Math.round(Math.random() * 1000) - 500;
    const delayMs = Math.max(800, base + jitter);
    try { await sock.presenceSubscribe(jid); } catch(_) {}
    try { await sock.sendPresenceUpdate('composing', jid); } catch(_) {}
    await new Promise(r => setTimeout(r, delayMs));
    try { await sock.sendPresenceUpdate('paused', jid); } catch(_) {}
  } catch(e) {
    // No bloquear el envío si falla el presence update
    console.warn('[WPP] simulateTyping error (no-fatal):', e.message);
  }
}

// Topes diarios guardados en la base: si el servidor se reinicia (deploy), el conteo del día
// sigue donde estaba en vez de volver a cero.
let _wppCountersReady = null;
function _ensureWppCounters() {
  if (!_wppCountersReady) {
    _wppCountersReady = pool.query(`CREATE TABLE IF NOT EXISTS wpp_daily_counters (
        shop_id INTEGER NOT NULL, day DATE NOT NULL, bucket VARCHAR(20) NOT NULL, n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (shop_id, day, bucket))`)
      .then(async () => {
        const today = wppGuard.dayKey();
        const r = await pool.query('SELECT shop_id, bucket, n FROM wpp_daily_counters WHERE day=$1', [today]);
        r.rows.forEach(row => wppGuard.seed(row.shop_id, today, row.bucket, row.n));
        pool.query(`DELETE FROM wpp_daily_counters WHERE day < CURRENT_DATE - 7`).catch(() => {});
      })
      .catch(e => { _wppCountersReady = null; console.warn('[WPP] contadores diarios:', e.message); });
  }
  return _wppCountersReady;
}
const _wppFlushTimers = {};
wppGuard.setOnRecord((shopId, day) => {
  const key = `${shopId}:${day}`;
  if (_wppFlushTimers[key]) return;
  _wppFlushTimers[key] = setTimeout(async () => {
    delete _wppFlushTimers[key];
    try {
      await _ensureWppCounters();
      const snap = wppGuard.snapshot(shopId, day);
      for (const [bucket, n] of Object.entries(snap)) {
        if (!n) continue;
        await pool.query(
          `INSERT INTO wpp_daily_counters (shop_id, day, bucket, n) VALUES ($1,$2,$3,$4)
           ON CONFLICT (shop_id, day, bucket) DO UPDATE SET n = GREATEST(wpp_daily_counters.n, EXCLUDED.n)`,
          [parseInt(shopId), day, bucket, n]);
      }
    } catch (e) { console.warn('[WPP] no se pudo guardar el contador:', e.message); }
  }, 3000);
  if (typeof _wppFlushTimers[key].unref === 'function') _wppFlushTimers[key].unref();
});
if (process.env.NODE_ENV !== 'test') setTimeout(() => { _ensureWppCounters(); }, 5000).unref?.();

// Handles de setTimeout de reconexión por shop (para cancelar en clearSession)
const reconnectTimers = {};
function scheduleReconnect(shopId, delay) {
  if (reconnectTimers[shopId]) clearTimeout(reconnectTimers[shopId]);
  reconnectTimers[shopId] = setTimeout(() => {
    delete reconnectTimers[shopId];
    connect(shopId, null, null, null).catch(e => console.error(`[WPP] reconnect ${shopId}:`, e.message));
  }, delay);
  if (typeof reconnectTimers[shopId].unref === 'function') reconnectTimers[shopId].unref();
}
function cancelReconnect(shopId) {
  if (reconnectTimers[shopId]) {
    clearTimeout(reconnectTimers[shopId]);
    delete reconnectTimers[shopId];
  }
}

// Limpiar sesión completamente (tmp + DB)
async function clearSession(shopId) {
  try {
    cancelReconnect(shopId);
    stopHealthCheck(shopId);
    const dir = baileysDir(shopId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`Baileys: sesion limpiada en ${dir} para shop ${shopId}`);
    }
    await pool.query('UPDATE shops SET wpp_connected=FALSE, wpp_session=NULL WHERE id=$1', [shopId]);
    console.log(`Baileys: sesion limpiada en DB para shop ${shopId}`);
    delete sockets[shopId];
    delete statuses[shopId];
    delete decryptErrors[shopId];
    // Reset backoff al limpiar manualmente
    delete qrAttempts[shopId];
    delete qrCooldownUntil[shopId];
  } catch (e) {
    console.error('clearSession error:', e.message);
  }
}

// Limpiar sesión Signal de un JID específico (para resetear cifrado con ese contacto)
async function clearJidSession(shopId, jid, resolvedPhone) {
  try {
    const dir = authDir(shopId);
    const user = jid.split('@')[0];
    const phoneClean = (resolvedPhone || '').replace(/\D/g, '');
    // fs.promises evita bloquear el event loop en shops con muchos contactos
    const files = await fs.promises.readdir(dir);
    const sessionFiles = files.filter(f => f.startsWith('session-'));
    let removed = 0;
    const unlinks = [];
    for (const f of sessionFiles) {
      const base = f.replace(/^session-/, '').replace(/\.json$/, '');
      const fileUser = base.replace(/_\d+(\.\d+)*$/, '');
      if (fileUser === user || (phoneClean && fileUser === phoneClean)) {
        unlinks.push(fs.promises.unlink(path.join(dir, f)).then(() => removed++).catch(()=>{}));
      }
    }
    await Promise.all(unlinks);
    if (removed === 0) {
      console.log(`[WPP] clearJidSession: sin match para "${user}" / "${phoneClean}". Archivos: ${sessionFiles.slice(0,10).join(', ')}`);
    } else {
      console.log(`[WPP] clearJidSession: ${removed} sesión(es) eliminada(s) para ${jid}`);
      await saveSessionToDB(shopId);
    }
  } catch(e) {
    console.error('clearJidSession error:', e.message);
  }
}

// Limpiar solo las session keys de Signal (no las credenciales principales)
async function clearSignalKeys(shopId) {
  try {
    const dir = baileysDir(shopId);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      let removed = 0;
      for (const f of files) {
        if (f.startsWith('session-') || f.includes('pre-key') || f.includes('sender-key')) {
          fs.unlinkSync(path.join(dir, f));
          removed++;
        }
      }
      console.log(`[WPP] ${removed} keys Signal limpiadas para shop ${shopId}`);
    }
  } catch (e) {
    console.error('clearSignalKeys error:', e.message);
  }
}

function authDir(shopId) {
  const dir = baileysDir(shopId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Restaurar sesión desde PostgreSQL — todos los archivos de auth
async function restoreSessionFromDB(shopId) {
  try {
    const result = await pool.query(
      'SELECT wpp_session FROM shops WHERE id=$1',
      [shopId]
    );
    const sessionData = result.rows[0]?.wpp_session;
    if (!sessionData) return false;

    const dir = authDir(shopId);
    const parsed = JSON.parse(sessionData);

    for (const [filename, content] of Object.entries(parsed)) {
      fs.writeFileSync(path.join(dir, filename), JSON.stringify(content));
    }
    console.log(`Baileys: sesion restaurada para shop ${shopId} (${Object.keys(parsed).length} archivos)`);
    return true;
  } catch (e) {
    console.error('Error restaurando sesion:', e.message);
    return false;
  }
}

// Guardar sesión en PostgreSQL — todos los archivos de auth
async function saveSessionToDB(shopId) {
  try {
    const dir = authDir(shopId);
    if (!fs.existsSync(dir)) return;

    const credsPath = path.join(dir, 'creds.json');
    if (!fs.existsSync(credsPath)) return;

    const sessionData = {};
    const files = fs.readdirSync(dir);
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf8');
        sessionData[file] = JSON.parse(raw);
      } catch(e) {
        // ignorar archivos no JSON
      }
    }

    await pool.query(
      'UPDATE shops SET wpp_session=$1 WHERE id=$2',
      [JSON.stringify(sessionData), shopId]
    );
    console.log(`Baileys: sesion guardada en DB para shop ${shopId} (${Object.keys(sessionData).length} archivos)`);
  } catch (e) {
    console.error('Error guardando sesion:', e.message);
  }
}

// Descargar media usando API de Baileys v7
async function downloadMediaBuffer(mediaMessage, mediaType) {
  const { downloadContentFromMessage } = await getBaileys();
  const stream = await downloadContentFromMessage(mediaMessage, mediaType);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Extraer texto de cualquier tipo de mensaje de Baileys
function extractTextFromMessage(msgContent) {
  if (!msgContent) return null;

  if (msgContent.conversation) return msgContent.conversation;
  if (msgContent.extendedTextMessage?.text) return msgContent.extendedTextMessage.text;

  if (msgContent.ephemeralMessage?.message) {
    return extractTextFromMessage(msgContent.ephemeralMessage.message);
  }
  if (msgContent.viewOnceMessage?.message) {
    return extractTextFromMessage(msgContent.viewOnceMessage.message);
  }
  if (msgContent.viewOnceMessageV2?.message) {
    return extractTextFromMessage(msgContent.viewOnceMessageV2.message);
  }
  if (msgContent.documentWithCaptionMessage?.message) {
    return extractTextFromMessage(msgContent.documentWithCaptionMessage.message);
  }
  if (msgContent.editedMessage?.message) {
    return extractTextFromMessage(msgContent.editedMessage.message);
  }

  if (msgContent.imageMessage?.caption) return msgContent.imageMessage.caption;
  if (msgContent.videoMessage?.caption) return msgContent.videoMessage.caption;
  if (msgContent.documentMessage?.caption) return msgContent.documentMessage.caption;

  if (msgContent.buttonsResponseMessage?.selectedDisplayText) return msgContent.buttonsResponseMessage.selectedDisplayText;
  if (msgContent.listResponseMessage?.title) return msgContent.listResponseMessage.title;
  if (msgContent.templateButtonReplyMessage?.selectedDisplayText) return msgContent.templateButtonReplyMessage.selectedDisplayText;

  return null;
}

// Extraer imageMessage o documentMessage desenrollando wrappers de WPP (viewOnce, ephemeral, etc.)
// Devuelve { mediaType: 'image'|'pdf', mediaMsg: <imageMessage|documentMessage> } o null
function extractMediaFromMessage(msgContent) {
  if (!msgContent) return null;

  // Imagen directa
  if (msgContent.imageMessage) return { mediaType: 'image', mediaMsg: msgContent.imageMessage };

  // Documento (PDF u otro)
  if (msgContent.documentMessage) {
    const mime = msgContent.documentMessage.mimetype || '';
    const name = msgContent.documentMessage.fileName || '';
    if (mime.includes('pdf') || name.toLowerCase().endsWith('.pdf')) {
      return { mediaType: 'pdf', mediaMsg: msgContent.documentMessage };
    }
    return null;
  }

  // Desenrollar wrappers comunes
  const inner =
    msgContent.viewOnceMessage?.message ||
    msgContent.viewOnceMessageV2?.message ||
    msgContent.ephemeralMessage?.message ||
    msgContent.documentWithCaptionMessage?.message ||
    msgContent.editedMessage?.message ||
    null;

  if (inner) return extractMediaFromMessage(inner);

  return null;
}

// Buscar pago pendiente (seña o membresía) exactamente si es 1 solo cliente
// Retorna resultado solo si hay exactamente 1 pendiente — evita notificar a múltiples clientes
// Incluye sucursales del enterprise (shops con parent_enterprise_id = shopId)
async function findAnyPendingPayment(shopId) {
  try {
    const senaRes = await pool.query(
      `SELECT a.id, a.sena_amount, s.sena_cbu, c.phone AS client_phone
       FROM appointments a JOIN shops s ON s.id = a.shop_id JOIN clients c ON c.id = a.client_id
       WHERE (a.shop_id=$1 OR s.parent_enterprise_id=$1)
         AND a.status='waiting_sena' AND a.sena_comprobante_status IS NULL
         AND c.phone IS NOT NULL AND c.phone != ''
       LIMIT 1`,
      [shopId]
    );
    if (senaRes.rows.length) {
      const r = senaRes.rows[0];
      return { type: 'sena', id: r.id, amount: parseFloat(r.sena_amount), cbu: r.sena_cbu, clientPhone: r.client_phone };
    }

    const memRes = await pool.query(
      `SELECT m.id, m.price_monthly AS price, s.sena_cbu, c.phone AS client_phone
       FROM memberships m JOIN shops s ON s.id = m.shop_id JOIN clients c ON c.id = m.client_id
       WHERE (m.shop_id=$1 OR s.parent_enterprise_id=$1)
         AND m.payment_status IS DISTINCT FROM 'paid'
         AND (m.comprobante_status IS NULL OR m.comprobante_status = 'rejected')
         AND c.phone IS NOT NULL AND c.phone != ''
       ORDER BY m.created_at DESC LIMIT 1`,
      [shopId]
    );
    if (memRes.rows.length) {
      const r = memRes.rows[0];
      return { type: 'membership', id: r.id, amount: parseFloat(r.price), cbu: r.sena_cbu, clientPhone: r.client_phone };
    }

    return null;
  } catch (e) {
    console.error('[WPP] findAnyPendingPayment error:', e.message);
    return null;
  }
}

// Buscar pago pendiente para un teléfono específico (seña o membresía)
// Incluye sucursales del enterprise (shops con parent_enterprise_id = shopId)
async function findPendingPayment(shopId, phone) {
  try {
    const phoneDigits = phone.replace(/[^0-9]/g, '');
    // Usamos SIEMPRE los últimos 10 dígitos como match: para AR es área+número y
    // es estable sin importar si viene con 54, 549, @lid con sufijo, etc.
    // (El fix previo asumía que todo número de 14 que termina en 0 era @lid, lo
    // que corrompía matching de números reales que terminan en 0.)
    const phoneSuffix = phoneDigits.slice(-10);

    const senaRes = await pool.query(
      `SELECT a.id, a.sena_amount, s.sena_cbu
       FROM appointments a
       JOIN shops s ON s.id = a.shop_id
       WHERE (a.shop_id = $1 OR s.parent_enterprise_id = $1)
         AND a.status = 'waiting_sena'
         AND a.sena_comprobante_status IS NULL
         AND EXISTS (
           SELECT 1 FROM clients c
           WHERE c.id = a.client_id
             AND regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE $2
         )
       LIMIT 1`,
      [shopId, '%' + phoneSuffix]
    );
    if (senaRes.rows.length) {
      return { type: 'sena', id: senaRes.rows[0].id, amount: parseFloat(senaRes.rows[0].sena_amount), cbu: senaRes.rows[0].sena_cbu };
    }

    const memRes = await pool.query(
      `SELECT m.id, m.price_monthly AS price, s.sena_cbu
       FROM memberships m
       JOIN shops s ON s.id = m.shop_id
       JOIN clients c ON c.id = m.client_id
       WHERE (m.shop_id = $1 OR s.parent_enterprise_id = $1)
         AND m.payment_status IS DISTINCT FROM 'paid'
         AND (m.comprobante_status IS NULL OR m.comprobante_status = 'rejected')
         AND regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE $2
       ORDER BY m.created_at DESC
       LIMIT 1`,
      [shopId, '%' + phoneSuffix]
    );
    if (memRes.rows.length) {
      return { type: 'membership', id: memRes.rows[0].id, amount: parseFloat(memRes.rows[0].price), cbu: memRes.rows[0].sena_cbu };
    }

    return null;
  } catch (e) {
    console.error('[WPP] findPendingPayment error:', e.message);
    return null;
  }
}

// Verificar y procesar comprobante recibido (imagen o PDF)
// mediaMsg = el objeto imageMessage o documentMessage ya desenvuelto
async function handleComprobanteMedia(shopId, phone, remoteJid, sock, mediaType, mediaMsg) {
  try {
    let pending = await findPendingPayment(shopId, phone);
    console.log(`[WPP] findPendingPayment(${phone}): ${pending ? `${pending.type} #${pending.id}` : 'null'}`);
    // Solo usar fallback sin phone cuando no tenemos teléfono del cliente
    if (!pending && !phone) {
      pending = await findAnyPendingPayment(shopId);
      console.log(`[WPP] findAnyPendingPayment fallback: ${pending ? `${pending.type} #${pending.id} clientPhone=${pending.clientPhone}` : 'null'}`);
    }
    if (!pending) return false;

    console.log(`[WPP] Comprobante ${mediaType} de ${phone} para ${pending.type} #${pending.id}`);

    const { verifyComprobante, verifyComprobanteFromText } = require('./ai');
    let result = null;

    if (mediaType === 'image') {
      const buffer = await downloadMediaBuffer(mediaMsg, 'image');
      const base64 = buffer.toString('base64');
      const mime = mediaMsg?.mimetype || 'image/jpeg';
      result = await verifyComprobante(base64, mime, pending);
    } else if (mediaType === 'pdf') {
      const buffer = await downloadMediaBuffer(mediaMsg, 'document');
      try {
        const pdfParse = require('pdf-parse');
        // Timeout 8s para pdf-parse (bloquea event loop si es muy grande)
        const pdfData = await Promise.race([
          pdfParse(buffer),
          new Promise((_, rej) => setTimeout(() => rej(new Error('pdf_parse_timeout_8s')), 8000))
        ]);
        if (!pdfData.text?.trim()) {
          await _say(shopId, sock, remoteJid, phone, 'El PDF no tiene texto legible. Por favor mandá una foto del comprobante.');
          return true;
        }
        result = await verifyComprobanteFromText(pdfData.text, pending);
      } catch (pdfErr) {
        console.error('[WPP] pdf-parse error:', pdfErr.message);
        await _say(shopId, sock, remoteJid, phone, 'No pudimos leer el PDF. Por favor mandá una foto del comprobante.');
        return true;
      }
    }

    if (!result) {
      await _say(shopId, sock, remoteJid, phone, 'No pudimos verificar el comprobante. Intentá de nuevo o contactá al barbero.');
      return true;
    }

    // Fix #9: usar UTC para comparación de fechas — el servidor corre en UTC
    // Aceptar ayer, hoy y mañana para cubrir diferencias de timezone (AR = UTC-3)
    const AR_OFFSET_MS = 3 * 60 * 60 * 1000;
    const nowAR = new Date(Date.now() - AR_OFFSET_MS);
    const todayAR = new Date(nowAR.toISOString().split('T')[0] + 'T00:00:00.000Z');
    const yesterdayAR = new Date(todayAR.getTime() - 86400000);
    const tomorrowAR  = new Date(todayAR.getTime() + 86400000);
    const comprobanteDate = result.date ? new Date(result.date + 'T00:00:00.000Z') : null;

    const amountOk = result.amount && Math.abs(result.amount - pending.amount) / pending.amount <= 0.02;
    const dateOk = comprobanteDate && (
      comprobanteDate.getTime() === todayAR.getTime() ||
      comprobanteDate.getTime() === yesterdayAR.getTime() ||
      comprobanteDate.getTime() === tomorrowAR.getTime()
    );
    // Verificar CBU/CVU: comparar los últimos 10 dígitos para tolerar diferencias de formato
    const cbuOk = !pending.cbu || (() => {
      const expectedCbu = (pending.cbu || '').replace(/\D/g, '');
      const receivedCbu = (result.cbu_cvu || '').replace(/\D/g, '');
      if (!receivedCbu || !expectedCbu) return !expectedCbu; // si no hay CBU en el comprobante y tampoco está configurado, ok
      return expectedCbu.slice(-10) === receivedCbu.slice(-10);
    })();

    const verified = result.valid && amountOk && dateOk && cbuOk;
    const status = verified ? 'verified' : 'rejected';
    const dataJson = JSON.stringify(result);

    if (pending.type === 'sena') {
      await pool.query(
        `UPDATE appointments SET sena_comprobante_status=$1, sena_comprobante_data=$2 WHERE id=$3`,
        [status, dataJson, pending.id]
      );
      if (verified) {
        const senaUpd = await pool.query(`UPDATE appointments SET status='pending', sena_status='confirmed' WHERE id=$1 AND status='waiting_sena' RETURNING id`, [pending.id]);
        // Registrar seña en caja (igual que confirmación manual) — solo si recién se confirmó (evita duplicar)
        if (pending.amount > 0 && senaUpd.rows.length) {
          try {
            const apptRow = await pool.query('SELECT shop_id, client_name FROM appointments WHERE id=$1', [pending.id]);
            if (apptRow.rows.length) {
              const { getShopTz, shopDate } = require('../db/shopTz');
              const today = shopDate(await getShopTz(apptRow.rows[0].shop_id));
              const shopCfg = await pool.query('SELECT sena_payment_method FROM shops WHERE id=$1', [apptRow.rows[0].shop_id]);
              const senaPayMethod = shopCfg.rows[0]?.sena_payment_method || 'transfer';
              await pool.query(
                `INSERT INTO expenses (shop_id, amount, category, description, date, is_income, source_type, source_id, payment_method)
                 VALUES ($1, $2, 'otros', $3, $4, TRUE, 'sena', $5, $6)
                 ON CONFLICT DO NOTHING`,
                [apptRow.rows[0].shop_id, pending.amount,
                 `Seña - ${apptRow.rows[0].client_name || 'Sin nombre'}`,
                 today, pending.id, senaPayMethod]
              );
            }
          } catch (cajaErr) {
            console.error('[SENA] Error registrando en caja:', cajaErr.message);
          }
        }
        await _say(shopId, sock, remoteJid, phone, '✅ Comprobante verificado. Tu seña fue confirmada y el turno está reservado.');
      } else {
        const reasons = [];
        if (!amountOk) reasons.push(`monto incorrecto (esperado $${pending.amount})`);
        if (!dateOk) reasons.push('la fecha no corresponde a hoy o ayer');
        if (!cbuOk) reasons.push('el CBU/CVU del destinatario no coincide');
        await _say(shopId, sock, remoteJid, phone, `❌ No pudimos verificar el comprobante: ${reasons.join(', ')}. Por favor verificá y volvé a intentarlo.`);
      }
    } else if (pending.type === 'membership') {
      await pool.query(
        `UPDATE memberships SET comprobante_status=$1, comprobante_data=$2 WHERE id=$3`,
        [status, dataJson, pending.id]
      );
      if (verified) {
        await pool.query(`UPDATE memberships SET payment_status='paid', last_payment_at=NOW() WHERE id=$1`, [pending.id]);
        await _say(shopId, sock, remoteJid, phone, '✅ Pago de membresía verificado. ¡Ya tenés tus créditos activos!');
        try {
          const sse = require('./sse');
          sse.emit(pending.shop_id, 'membership.verified', { id: pending.id, client_name: pending.client_name || null });
        } catch(_) {}
        try {
          const notif = require('./notifications');
          await notif.create({
            shopId: pending.shop_id, recipientShopId: pending.shop_id,
            type: 'membership.verified',
            title: 'Membresía verificada',
            body:  `${pending.client_name || 'Cliente'} · $${pending.amount || ''}`,
            icon:  '✅', link: '/app#membresias',
          });
        } catch(_) {}
      } else {
        const reasons = [];
        if (!amountOk) reasons.push(`monto incorrecto (esperado $${pending.amount})`);
        if (!dateOk) reasons.push('la fecha no corresponde a hoy o ayer');
        if (!cbuOk) reasons.push('el CBU/CVU del destinatario no coincide');
        await _say(shopId, sock, remoteJid, phone, `❌ No pudimos verificar el comprobante: ${reasons.join(', ')}. Por favor verificá y volvé a intentarlo.`);
      }
    }

    return true;
  } catch (e) {
    console.error('[WPP] handleComprobanteMedia error:', e.message);
    return false;
  }
}

// Conectar o reconectar WhatsApp
async function connect(shopId, onQR, onConnected, onDisconnected) {
  // Cargar Baileys v7 (ESM)
  const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = await getBaileys();

  await restoreSessionFromDB(shopId);

  const dir = authDir(shopId);
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 15000,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    retryRequestDelayMs: 500,
    maxMsgRetryCount: 3,
    fireInitQueries: true,
    logger: { level: 'silent', log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ level: 'silent', log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
    getMessage: async (key) => {
      // Devolver el último texto del cliente desde ai.conversations si lo tenemos,
      // para que Baileys pueda re-descifrar en retries.
      try {
        const { getLastUserMessage } = require('./ai');
        if (typeof getLastUserMessage === 'function') {
          const jid = key?.remoteJid || '';
          const phone = jid.split('@')[0];
          const text = getLastUserMessage(shopId, phone);
          if (text) return { conversation: text };
        }
      } catch(_) {}
      return { conversation: '' };
    },
    shouldIgnoreJid: (jid) => {
      if (jid === 'status@broadcast') return true;
      if (jid.endsWith('@newsletter')) return true;
      if (jid.endsWith('@broadcast')) return true;
      return false;
    },
    cachedGroupMetadata: async () => null,
  });

  sockets[shopId]  = sock;
  _touch(shopId);
  statuses[shopId] = 'connecting';

  sock.ev.on('CB:receipt', () => {});

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    // Solo guardar en DB si ya está autenticado (evita guardar sesión incompleta del QR)
    if (statuses[shopId] === 'connected') {
      await saveSessionToDB(shopId);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Backoff: contar QRs generados sin escanear
      qrAttempts[shopId] = (qrAttempts[shopId] || 0) + 1;
      console.log(`Baileys QR generado para shop ${shopId} (intento ${qrAttempts[shopId]}/${MAX_QR_ATTEMPTS})`);

      if (qrAttempts[shopId] > MAX_QR_ATTEMPTS) {
        const cooldownMin = QR_COOLDOWN_MS / 60000;
        console.warn(`[WPP] Shop ${shopId}: límite de QRs (${MAX_QR_ATTEMPTS}) alcanzado. Cooldown ${cooldownMin} min para evitar rate-limit de WA.`);
        qrCooldownUntil[shopId] = Date.now() + QR_COOLDOWN_MS;
        statuses[shopId] = 'qr_limit';
        qrCodes[shopId]  = null;
        try { sock.end(); } catch(e) {}
        delete sockets[shopId];
        return;
      }

      qrCodes[shopId]  = qr;
      statuses[shopId] = 'qr';
      if (onQR) onQR(qr);
    }

    if (connection === 'open') {
      console.log(`Baileys conectado para shop ${shopId}`);
      statuses[shopId] = 'connected';
      qrCodes[shopId]  = null;
      delete qrAttempts[shopId];
      delete qrCooldownUntil[shopId];
      delete statuses[`${shopId}_reconnect`];
      await pool.query('UPDATE shops SET wpp_connected=TRUE WHERE id=$1', [shopId]);
      await saveSessionToDB(shopId);
      startHealthCheck(shopId);
      if (onConnected) onConnected();
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`Baileys desconectado para shop ${shopId}, código: ${code}`);
      statuses[shopId] = 'disconnected';

      // 401 = sesión inválida/revocada por WhatsApp → limpiar sesión y pedir nuevo QR
      if (code === DisconnectReason.loggedOut || code === 401) {
        console.log(`[WPP] Shop ${shopId}: sesión inválida (${code}), limpiando sesión guardada`);
        await pool.query('UPDATE shops SET wpp_connected=FALSE, wpp_session=NULL WHERE id=$1', [shopId]);
        delete sockets[shopId];
        delete statuses[`${shopId}_reconnect`];
        delete statuses[`${shopId}_440_count`];
        delete statuses[`${shopId}_440_firstAt`];
        if (onDisconnected) onDisconnected();
      } else if (code === 440 || code === DisconnectReason.connectionReplaced) {
        // 440 = "Session replaced" → otro dispositivo tomó la sesión.
        // Reconectar genera un loop infinito (ambos clientes se pisan).
        // Cortamos después de 3 ocurrencias en 2 minutos y pedimos acción manual.
        const now = Date.now();
        const firstAt = statuses[`${shopId}_440_firstAt`] || now;
        const windowMs = 2 * 60 * 1000;
        if (now - firstAt > windowMs) {
          statuses[`${shopId}_440_count`] = 1;
          statuses[`${shopId}_440_firstAt`] = now;
        } else {
          statuses[`${shopId}_440_count`] = (statuses[`${shopId}_440_count`] || 0) + 1;
          if (!statuses[`${shopId}_440_firstAt`]) statuses[`${shopId}_440_firstAt`] = now;
        }
        const count440 = statuses[`${shopId}_440_count`];
        if (count440 >= 3) {
          console.log(`[WPP] Shop ${shopId}: ⚠️ ${count440} desconexiones 440 (sesión reemplazada) en ventana corta. Deteniendo reconexión — hay otro dispositivo usando esta sesión de WhatsApp. El cliente debe cerrar WhatsApp Web en otros dispositivos (Celular → Dispositivos vinculados) y reconectar manualmente desde Configuración.`);
          await pool.query('UPDATE shops SET wpp_connected=FALSE WHERE id=$1', [shopId]);
          delete sockets[shopId];
          delete statuses[`${shopId}_reconnect`];
          delete statuses[`${shopId}_440_count`];
          delete statuses[`${shopId}_440_firstAt`];
          if (onDisconnected) onDisconnected();
        } else {
          const delay = 30 * 1000;
          console.log(`[WPP] Shop ${shopId}: desconexión 440 ${count440}/3 — reintentando en ${delay/1000}s (si sigue, el cliente tiene otro dispositivo con esta sesión)`);
          scheduleReconnect(shopId, delay);
        }
      } else {
        // Otros errores: reconectar con backoff exponencial
        const attempt = (statuses[`${shopId}_reconnect`] || 0) + 1;
        statuses[`${shopId}_reconnect`] = attempt;
        if (attempt <= 10) {
          const delay = Math.min(5000 * attempt, 60000);
          console.log(`[WPP] Shop ${shopId}: reconectando en ${delay/1000}s (intento ${attempt}/10)...`);
          scheduleReconnect(shopId, delay);
        } else {
          console.log(`[WPP] Shop ${shopId}: demasiados intentos de reconexión, abortando`);
          await pool.query('UPDATE shops SET wpp_connected=FALSE WHERE id=$1', [shopId]);
          delete sockets[shopId];
          delete statuses[`${shopId}_reconnect`];
        }
      }
    }
  });

  // Errores de descifrado — v7 los reporta acá
  // NOTA: el evento 'messages.decrypt-fail' existía en Baileys ≤ rc9 pero fue
  // removido en rc10+. En las versiones actuales los mensajes que no descifran
  // llegan como messages.upsert con message vacío o messageStubType=CIPHERTEXT,
  // que ya manejamos abajo con clearJidSession por-JID (más granular).

  // Escuchar mensajes entrantes
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    _touch(shopId); // mantiene viva la sesión mientras llegue tráfico
    const firstJid = messages[0]?.key?.remoteJid || 'unknown';
    const fromMe = messages[0]?.key?.fromMe;
    console.log(`[WPP] upsert type=${type} count=${messages.length} fromMe=${fromMe} jid=${firstJid}`);
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid || '';

        const isIndividual = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
        if (!isIndividual) continue;

        // Dedup: si vemos el mismo msg.key.id dos veces (common en Baileys), ignoramos
        const msgId = msg.key?.id;
        if (msgId) {
          const dedupKey = `${shopId}:${msgId}`;
          if (processedMsgIds.has(dedupKey)) {
            console.log(`[WPP] dedup: msg ${msgId} ya procesado`);
            continue;
          }
          processedMsgIds.add(dedupKey);
          // Limpiar set si pasa 500 entradas (evita memory bloat)
          if (processedMsgIds.size > 500) {
            const toDelete = Array.from(processedMsgIds).slice(0, 250);
            toDelete.forEach(k => processedMsgIds.delete(k));
          }
        }

        // Ignorar mensajes de status/broadcast
        if (jid === 'status@broadcast') continue;

        const phoneRaw = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
        if (!/^\d+$/.test(phoneRaw)) continue;

        // Ignorar reacciones, stickers, protocolMessages y eventos de sistema
        const stubType = msg.messageStubType;
        if (stubType && stubType !== 2) {
          console.log(`[WPP] Ignorando messageStubType=${stubType} de ${phoneRaw}`);
          continue;
        }
        const rawKeys = msg.message ? Object.keys(msg.message) : [];
        if (rawKeys.includes('reactionMessage') || rawKeys.includes('stickerMessage') || rawKeys.includes('protocolMessage')) {
          console.log(`[WPP] Ignorando ${rawKeys[0]} de ${phoneRaw}`);
          continue;
        }

        // Resolver phone desde @lid — v7 provee senderPn nativo
        let phone = phoneRaw;
        if (jid.endsWith('@lid')) {
          if (msg.senderPn) {
            // senderPn puede ser "5491135899641:0@s.whatsapp.net" — strip device suffix antes de digits
            phone = msg.senderPn.split(':')[0].split('@')[0].replace(/\D/g, '');
          } else {
            // Intentar via signalRepository de v7 (nativo)
            try {
              const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid);
              if (pn) phone = pn.replace('@s.whatsapp.net', '').replace(/\D/g, '');
            } catch(e) {}
          }
          console.log(`[WPP] @lid ${phoneRaw} → phone resuelto: ${phone}`);
        }

        // messageStubType 2 = CIPHERTEXT — descifrado fallido
        if (msg.messageStubType === 2) {
          console.log(`[WPP] CIPHERTEXT (stub=2) de ${phoneRaw} — reseteando sesión Signal`);
          // 1) Limpiar archivo de sesión
          await clearJidSession(shopId, jid, phone);
          // 2) assertSessions solo con el JID original (para no mezclar con phone JID que puede ser incorrecto)
          const phoneJid = phone && phone.length >= 10 ? `${phone}@s.whatsapp.net` : null;
          try {
            await sock.assertSessions([jid], true);
            console.log(`[WPP] CIPHERTEXT: assertSessions OK para ${jid}`);
          } catch(e) {
            console.log(`[WPP] CIPHERTEXT: assertSessions error: ${e.message}`);
          }
          // 3) Enviar aviso SOLO si el contacto tiene un pago pendiente (seña o membresía)
          // Si no tiene pago pendiente, no tiene sentido avisarle — era un mensaje normal que falló al descifrar
          const hasPending = phone ? await findPendingPayment(shopId, phone) : null;
          if (!hasPending) {
            console.log(`[WPP] CIPHERTEXT: sin pago pendiente para ${phoneRaw} — omitiendo aviso`);
            continue;
          }
          // Debounce: máx 1 aviso por JID cada 2 min
          const now = Date.now();
          const lastWarn = ciphertextLastWarning[jid] || 0;
          if (now - lastWarn < 2 * 60 * 1000) {
            console.log(`[WPP] CIPHERTEXT: aviso omitido (debounce) para ${phoneRaw}`);
            continue;
          }
          ciphertextLastWarning[jid] = now;
          const warning = '⚠️ Hubo un error al recibir tu mensaje. Por favor reenviálo nuevamente y lo veremos.';
          // Enviar usando el JID original (@lid o phone) — usa la sesión que acaba de establecer assertSessions
          const sendJid = jid.endsWith('@lid') ? jid : (phoneJid || null);
          if (sendJid) {
            try {
              await sock.sendMessage(sendJid, { text: warning });
              console.log(`[WPP] CIPHERTEXT: aviso enviado a ${sendJid}`);
            } catch(e) {
              console.error('[WPP] CIPHERTEXT sock.sendMessage error:', e.message);
              // Fallback a sendText si falla
              if (phoneJid) {
                try { await sendText(shopId, phone, warning); } catch(e2) {}
              }
            }
          } else {
            // NO hacer fallback a "primer pago pendiente del shop" porque podría
            // mandarle el aviso al cliente equivocado. Preferimos no avisar.
            console.log('[WPP] CIPHERTEXT: no se pudo resolver JID, no se envía aviso (anti-cross-user)');
          }
          continue;
        }

        let msgContent = msg.message;
        if ((!msgContent || Object.keys(msgContent).length === 0) && msg.message?.message) {
          msgContent = msg.message.message;
        }

        const msgKeys = msgContent ? Object.keys(msgContent) : [];
        console.log(`[WPP] Mensaje de ${phone} - keys: ${msgKeys.join(', ')}`);

        if (msgKeys.length === 0) {
          console.log(`[WPP] Mensaje vacío de ${phone} — ignorando`);
          continue;
        }

        // Interceptar imágenes y PDFs como posibles comprobantes (desenvuelve viewOnce, ephemeral, etc.)
        const extracted = extractMediaFromMessage(msgContent);
        if (extracted) {
          console.log(`[WPP] Media detectada tipo=${extracted.mediaType} de ${phone}`);
          const handled = await handleComprobanteMedia(shopId, phone, msg.key.remoteJid, sock, extracted.mediaType, extracted.mediaMsg);
          if (handled) continue;
        }

        const text = extractTextFromMessage(msgContent);

        if (!text || !text.trim()) {
          console.log(`[WPP] Mensaje sin texto de ${phone} (tipo no soportado o media sin caption)`);
          continue;
        }

        console.log(`[WPP] Texto extraído de ${phone}: "${text}"`);

        _markKnown(shopId, phone); // nos escribió: es un contacto con conversación

        // Pedido de baja: se registra y se confirma una sola vez. No pasa por la IA.
        if (wppGuard.isOptOutIntent(text)) {
          await addOptOut(shopId, phone);
          await _say(shopId, sock, msg.key.remoteJid, phone,
            'Listo, no te vamos a enviar más mensajes por este medio. Si necesitás algo, escribinos cuando quieras. 🙌');
          continue;
        }

        const { getAIResponse } = require('./ai');
        const reply = await getAIResponse(shopId, phone, text);

        if (reply) {
          console.log(`[WPP] Respondiendo a ${phone}: "${reply}"`);
          // Normalizar senderPn: puede venir como "5491135899641:0@s.whatsapp.net"
          // (con device suffix) → quedarnos con "5491135899641@s.whatsapp.net"
          let sendJid = msg.key.remoteJid;
          if (jid.endsWith('@lid') && msg.senderPn) {
            const cleanPn = String(msg.senderPn).split(':')[0];
            if (cleanPn.includes('@')) sendJid = cleanPn;
            else sendJid = cleanPn + '@s.whatsapp.net';
          }
          // Respuesta "humana": leído → escribiendo → mensaje, con pacing y topes (no instantánea)
          try {
            await _deliver(shopId, sock, sendJid, phone, reply, 'reply', { readKey: msg.key });
          } catch (e) {
            console.warn(`[WPP] respuesta del bot omitida (${e.code || 'error'}): ${e.message}`);
          }
        } else {
          console.log(`[WPP] AI no respondió (ignorado por clasificador o sin contexto)`);
        }
      } catch (e) {
        console.error('[WPP] Error procesando mensaje entrante:', e.message);
      }
    }
  });

  return sock;
}

// Iniciar sesión (devuelve QR como base64 o status connected)
async function startSession(shopId) {
  // Verificar cooldown por demasiados intentos fallidos
  const cooldownUntil = qrCooldownUntil[shopId];
  if (cooldownUntil && Date.now() < cooldownUntil) {
    const minutesLeft = Math.ceil((cooldownUntil - Date.now()) / 60000);
    throw new Error(`Demasiados intentos fallidos. Esperá ${minutesLeft} minuto${minutesLeft !== 1 ? 's' : ''} antes de volver a vincular WhatsApp.`);
  }

  // Reset contador al iniciar sesión nueva manualmente
  delete qrAttempts[shopId];

  await clearSession(shopId);
  if (sockets[shopId]) {
    try { sockets[shopId].end(); } catch(e) {}
    delete sockets[shopId];
  }

  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout esperando QR de WhatsApp'));
    }, 60000);

    try {
      await connect(
        shopId,
        (qr) => {
          clearTimeout(timeout);
          resolve({ qrcode: qr, type: 'raw' });
        },
        () => {
          clearTimeout(timeout);
          resolve({ status: 'CONNECTED' });
        },
        null
      );
    } catch (e) {
      clearTimeout(timeout);
      reject(e);
    }
  });
}

// Verificar estado
async function getStatus(shopId) {
  const status = statuses[shopId];
  const connected = status === 'connected';
  const cooldownUntil = qrCooldownUntil[shopId];
  const inCooldown = cooldownUntil && Date.now() < cooldownUntil;
  const paused = wppGuard.pausedUntil(shopId);
  return {
    connected,
    status: inCooldown ? 'qr_limit' : (status || 'disconnected'),
    cooldownMinutes: inCooldown ? Math.ceil((cooldownUntil - Date.now()) / 60000) : null,
    paused: !!paused,
    pausedMinutes: paused ? Math.ceil((paused - Date.now()) / 60000) : null
  };
}

// Fix #7: resolver shopId real para WPP — si la sucursal no tiene socket, usar enterprise owner
// Desde qué WhatsApp sale un mensaje de una sucursal:
//   1) el suyo, si está conectado;
//   2) el del dueño enterprise, si el dueño eligió "WhatsApp compartido" o si la sucursal no tiene
//      uno propio (y el del dueño está conectado o tiene sesión guardada);
//   3) si no, el suyo (se intenta restaurar su sesión guardada).
// Antes, cuando la sucursal no estaba conectada en ese instante, se mandaba siempre desde el del
// dueño, aunque el dueño no tuviera WhatsApp (pasa al pasar de Staff a Enterprise: la sede
// principal se queda con su WhatsApp y la cuenta nueva del dueño no tiene ninguno).
async function resolveWppShopId(shopId) {
  if (sockets[shopId] && statuses[shopId] === 'connected') return shopId;
  try {
    const r = await pool.query(
      `SELECT s.parent_enterprise_id, (s.wpp_session IS NOT NULL) AS own_session,
              p.enterprise_shared_wpp AS shared, (p.wpp_session IS NOT NULL) AS parent_session
         FROM shops s LEFT JOIN shops p ON p.id = s.parent_enterprise_id
        WHERE s.id=$1`, [shopId]);
    const x = r.rows[0];
    const parentId = x?.parent_enterprise_id;
    if (parentId) {
      const parentUsable = (sockets[parentId] && statuses[parentId] === 'connected') || x.parent_session;
      if (parentUsable && (x.shared || !x.own_session)) {
        console.log(`[WPP] resolveWppShopId: shop ${shopId} → usando el WhatsApp del enterprise ${parentId}`);
        return parentId;
      }
    }
  } catch(e) { /* fallback al shopId original */ }
  return shopId;
}

// ¿Este local tiene algún WhatsApp desde el que mandar (propio o el del enterprise)?
async function hasWhatsApp(shopId) {
  const id = await resolveWppShopId(shopId);
  if (sockets[id] && statuses[id] === 'connected') return true;
  try {
    const r = await pool.query('SELECT wpp_connected, (wpp_session IS NOT NULL) AS has_session FROM shops WHERE id=$1', [id]);
    return !!(r.rows[0]?.wpp_connected || r.rows[0]?.has_session);
  } catch (_) { return false; }
}

// ─── Bajas (opt-out) ─────────────────────────────────────────────────────────
// Un cliente que pide que no le escriban más NO recibe más mensajes proactivos.
// Es la principal defensa contra reportes ("spam") que terminan en baneo.
const _optOutSets = Object.create(null);   // shopId → Set(últimos 10 dígitos)
const _optOutLoaded = Object.create(null);
let _optOutTableReady = false;
async function _ensureOptOutTable() {
  if (_optOutTableReady) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS wpp_optouts (
      shop_id INT NOT NULL, phone VARCHAR(30) NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (shop_id, phone))`);
    _optOutTableReady = true;
  } catch (e) { console.warn('[WPP] no se pudo preparar wpp_optouts:', e.message); }
}
async function _loadOptOuts(shopId) {
  if (_optOutLoaded[shopId]) return _optOutSets[shopId];
  _optOutSets[shopId] = _optOutSets[shopId] || new Set();
  await _ensureOptOutTable();
  try {
    const r = await pool.query('SELECT phone FROM wpp_optouts WHERE shop_id=$1', [shopId]);
    for (const row of r.rows) _optOutSets[shopId].add(wppGuard.lastDigits(row.phone));
    _optOutLoaded[shopId] = true;
  } catch (e) { console.warn('[WPP] no se pudieron leer bajas:', e.message); }
  return _optOutSets[shopId];
}
async function isOptedOut(shopId, phone) {
  const set = await _loadOptOuts(shopId);
  return set.has(wppGuard.lastDigits(phone));
}
async function addOptOut(shopId, phone) {
  const set = await _loadOptOuts(shopId);
  const key = wppGuard.lastDigits(phone);
  set.add(key);
  try {
    await pool.query('INSERT INTO wpp_optouts (shop_id, phone) VALUES ($1,$2) ON CONFLICT DO NOTHING', [shopId, key]);
  } catch (e) { console.warn('[WPP] no se pudo guardar la baja:', e.message); }
  console.log(`[WPP] baja registrada: shop ${shopId} · ${key}`);
}

// ─── Contactos conocidos / número registrado en WhatsApp ─────────────────────
const _knownInbound = new Set();           // `${shopId}:${últimos10}` — nos escribieron
function _markKnown(shopId, phone) { _knownInbound.add(`${shopId}:${wppGuard.lastDigits(phone)}`); }
async function _isKnownContact(shopId, phone) {
  const key = `${shopId}:${wppGuard.lastDigits(phone)}`;
  if (_knownInbound.has(key)) return true;
  try {
    const r = await pool.query(
      `SELECT 1 FROM clients WHERE shop_id=$1 AND phone LIKE $2
         AND (last_visit IS NOT NULL OR COALESCE(total_visits,0) > 0) LIMIT 1`,
      [shopId, '%' + wppGuard.lastDigits(phone).slice(-8)]
    );
    if (r.rows.length) { _knownInbound.add(key); return true; }
  } catch (_) { /* sin dato: se trata como contacto nuevo (más estricto) */ }
  return false;
}

const _waExists = new Map();               // jid → { exists, at }
async function _ensureOnWhatsApp(sock, jid) {
  const hit = _waExists.get(jid);
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) {
    if (hit.exists === false) { const e = new Error('El número no tiene WhatsApp'); e.code = 'NOT_ON_WHATSAPP'; throw e; }
    return;
  }
  let exists;
  try {
    const r = await Promise.race([
      sock.onWhatsApp(jid),
      new Promise((_, rej) => setTimeout(() => rej(new Error('onWhatsApp_timeout')), 6000))
    ]);
    exists = Array.isArray(r) && r.length ? r[0]?.exists : undefined;
  } catch (_) { return; }                  // si no se puede verificar, no bloquear
  if (exists === undefined) return;
  _waExists.set(jid, { exists: !!exists, at: Date.now() });
  if (_waExists.size > 5000) _waExists.clear();
  if (!exists) { const e = new Error('El número no tiene WhatsApp'); e.code = 'NOT_ON_WHATSAPP'; throw e; }
}

const MARKETING_LOG_TYPES = ['sillon_libre', 'churn_rescue', 'rescate', 'rescate_auto', 'birthday', 'cumpleanos', 'promo'];
async function _marketingCooldownHit(shopId, phone) {
  const days = wppGuard.config().marketingCooldownDays;
  if (!days) return false;
  try {
    const r = await pool.query(
      `SELECT 1 FROM whatsapp_logs WHERE shop_id=$1 AND phone LIKE $2 AND type = ANY($3)
         AND sent_at > NOW() - ($4 || ' days')::interval LIMIT 1`,
      [shopId, '%' + wppGuard.lastDigits(phone).slice(-8), MARKETING_LOG_TYPES, String(days)]
    );
    return r.rows.length > 0;
  } catch (_) { return false; }
}

// Envío "humano": respeta límites, espacia los mensajes con jitter, marca como leído
// (si es respuesta), simula escritura y recién ahí manda. TODO envío pasa por acá.
async function _deliver(wppShopId, sock, jid, phone, text, kind, opts = {}) {
  const firstContact = !!opts.firstContact;
  wppGuard.check(wppShopId, phone, kind, { firstContact });
  const wait = wppGuard.reserve(wppShopId, kind);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  if (opts.readKey) { try { await sock.readMessages([opts.readKey]); } catch (_) {} }
  await simulateTyping(sock, jid, (text || '').length);

  // Timeout corto: si el socket es zombie, no colgamos el request HTTP del CRM 30s.
  // Marcamos el socket como caído y disparamos reconexión en background.
  const result = await Promise.race([
    sock.sendMessage(jid, { text }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('sendText_timeout_8s')), 12000))
  ]).catch(err => {
    if (err.message === 'sendText_timeout_8s') {
      console.warn(`[WPP] sendText timeout en shop ${wppShopId} — marcando zombie`);
      statuses[wppShopId] = 'disconnected';
      try { sock.end?.(new Error('sendText timeout')); } catch(_){}
      delete sockets[wppShopId];
      scheduleReconnect(wppShopId, 1000);
    }
    wppGuard.failed(wppShopId);
    throw err;
  });
  wppGuard.succeeded(wppShopId);
  wppGuard.record(wppShopId, phone, kind, { firstContact });
  return result;
}

// Responder dentro de una conversación (comprobantes, avisos al cliente que escribió)
async function _say(shopId, sock, jid, phone, text) {
  try {
    return await _deliver(shopId, sock, jid, phone, text, 'reply');
  } catch (e) {
    console.warn(`[WPP] respuesta omitida (${e.code || 'error'}): ${e.message}`);
  }
}

// Enviar mensaje de texto.  opts.kind: 'notify' (default) | 'marketing' | 'cold'
async function sendText(shopId, phone, message, opts = {}) {
  const kind = ['notify', 'marketing', 'cold', 'reply'].includes(opts.kind) ? opts.kind : 'notify';
  // Auto-resolver enterprise owner si la sucursal no tiene socket activo
  const wppShopId = await resolveWppShopId(shopId);
  let sock = sockets[wppShopId];

  if (!sock || statuses[wppShopId] !== 'connected') {
    console.log(`Baileys: no hay socket activo para shop ${wppShopId}, intentando restaurar...`);
    const restored = await restoreSessionFromDB(wppShopId);
    if (!restored) throw new Error('WhatsApp no está conectado. Conectalo desde Configuración.');

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout reconectando WhatsApp')), 30000);
      connect(
        wppShopId,
        null,
        () => { clearTimeout(timeout); resolve(); },
        null
      ).catch(e => { clearTimeout(timeout); reject(e); });
    });

    sock = sockets[wppShopId];
    if (!sock) throw new Error('No se pudo reconectar WhatsApp');
  }

  const phoneClean = normalizePhoneAR(phone);
  const jid = `${phoneClean}@s.whatsapp.net`;

  // Quien pidió la baja no recibe nada proactivo
  if (kind !== 'reply' && await isOptedOut(wppShopId, phoneClean)) {
    const e = new Error('El cliente pidió no recibir más mensajes'); e.code = 'OPTED_OUT'; throw e;
  }
  const firstContact = kind === 'reply' ? false : !(await _isKnownContact(wppShopId, phoneClean));
  if (kind === 'marketing' && await _marketingCooldownHit(wppShopId, phoneClean)) {
    const e = new Error('Ya se le envió una promoción hace poco'); e.code = 'MARKETING_COOLDOWN'; throw e;
  }
  // A un número que nunca nos escribió: antes de mandar, verificar que tenga WhatsApp
  if (firstContact) await _ensureOnWhatsApp(sock, jid);

  console.log(`Baileys sendText → ${jid} (shop ${wppShopId}, ${kind}${firstContact ? ', contacto nuevo' : ''})`);
  _touch(wppShopId);

  const result = await _deliver(wppShopId, sock, jid, phoneClean, message, kind, { firstContact });
  console.log(`Baileys sendText OK → ${result?.key?.id}`);
  return result;
}

// Cerrar sesión
async function closeSession(shopId) {
  try {
    const sock = sockets[shopId];
    if (sock) {
      await sock.logout();
      delete sockets[shopId];
    }
    await pool.query('UPDATE shops SET wpp_connected=FALSE, wpp_session=NULL WHERE id=$1', [shopId]);
    return true;
  } catch (e) {
    console.error('closeSession error:', e.message);
    return false;
  }
}

// Al iniciar el servidor, reconectar shops que tenían WhatsApp conectado.
// Limita concurrencia y stagger entre arranques para evitar rate-limit de WhatsApp.
async function reconnectAllShops() {
  const CONCURRENCY = 3;
  const STAGGER_MS  = 1500;
  try {
    // Cap al nivel del cap de sesiones. Si hay más shops conectados que cap,
    // priorizamos las últimas creadas (proxy de más activas). El resto arranca
    // cold y se reconecta on-demand en la próxima sendText.
    const result = await pool.query(
      `SELECT id FROM shops
         WHERE wpp_connected=TRUE AND wpp_session IS NOT NULL
         ORDER BY id DESC
         LIMIT $1`,
      [WPP_MAX_SESSIONS]
    );
    const queue = result.rows.map(r => r.id);
    console.log(`Baileys: reconectando ${queue.length} shop(s) con concurrencia=${CONCURRENCY} (cap=${WPP_MAX_SESSIONS})`);

    async function worker() {
      while (queue.length) {
        const shopId = queue.shift();
        // Si ya hay socket conectado para este shop (p.ej. restoreSessionFromDB
        // disparado por un sendText temprano), no abrimos otro para evitar 440.
        if (sockets[shopId] && statuses[shopId] === 'connected') {
          console.log(`Baileys: shop ${shopId} ya conectado, skip`);
          continue;
        }
        try {
          console.log(`Baileys: reconectando shop ${shopId}...`);
          await connect(shopId, null, null, null);
        } catch (e) {
          console.error(`Error reconectando shop ${shopId}:`, e.message);
        }
        await new Promise(r => setTimeout(r, STAGGER_MS));
      }
    }
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker);
    await Promise.all(workers);
  } catch (e) {
    console.error('reconnectAllShops error:', e.message);
  }
}

// ── Idle sweeper + LRU cap ──────────────────────────────────────────────────
// Pensado para escalar: una barbería que no envía/recibe hace ≥90min baja a cold.
// La próxima llamada a sendText la reconecta on-demand (ya existe esa lógica).
// Las entrantes se pierden mientras está cold — por eso TTL amplio (90m default).
async function _closeIdleSock(shopId, reason) {
  const sock = sockets[shopId];
  if (!sock) return;
  try {
    console.log(`[WPP sweep] shop ${shopId} cold-down (${reason})`);
    stopHealthCheck?.(shopId);
    cancelReconnect?.(shopId);
    try { sock.end?.(new Error(reason)); } catch(_) {}
    delete sockets[shopId];
    statuses[shopId] = 'disconnected';
    delete _lastActivity[shopId];
  } catch(e) { console.warn('[WPP sweep] close error:', e.message); }
}

async function sweepIdle() {
  try {
    const now = Date.now();
    const activeIds = Object.keys(sockets);

    // 1) Cerrar sesiones idle > TTL (solo si WPP_IDLE_TTL_MIN > 0).
    //    Con default 0 nunca se cold-ea por idle — el bot IA nunca pierde msgs.
    if (WPP_IDLE_TTL_MS > 0) {
      for (const id of activeIds) {
        const last = _lastActivity[id] || 0;
        if (now - last > WPP_IDLE_TTL_MS) {
          await _closeIdleSock(id, `idle>${Math.round(WPP_IDLE_TTL_MS/60000)}min`);
        }
      }
    }

    // 2) Hard cap LRU: si quedan más de MAX, cerrar las más viejas
    const remaining = Object.keys(sockets);
    if (remaining.length > WPP_MAX_SESSIONS) {
      const excess = remaining.length - WPP_MAX_SESSIONS;
      const sorted = remaining
        .map(id => ({ id, last: _lastActivity[id] || 0 }))
        .sort((a,b) => a.last - b.last);
      for (let i = 0; i < excess; i++) {
        await _closeIdleSock(sorted[i].id, `LRU cap ${WPP_MAX_SESSIONS}`);
      }
    }
  } catch(e) { console.error('[WPP sweep] error:', e.message); }
}

// Arrancar el sweeper una sola vez
if (!global.__wppSweeperStarted) {
  global.__wppSweeperStarted = true;
  const h = setInterval(sweepIdle, WPP_SWEEP_EVERY);
  if (typeof h.unref === 'function') h.unref();
  const ttlMsg = WPP_IDLE_TTL_MS > 0 ? `${WPP_IDLE_TTL_MS/60000}min` : 'OFF (always-hot)';
  console.log(`⏰ [WPP] sweeper iniciado — idle TTL=${ttlMsg}, cap=${WPP_MAX_SESSIONS}`);
}

// Stats para admin / debugging
function wppStats() {
  const now = Date.now();
  const today = new Date().toISOString().slice(0,10);
  const active = Object.keys(sockets).map(id => ({
    shopId: parseInt(id),
    status: statuses[id] || 'unknown',
    last_activity_min: _lastActivity[id] ? Math.round((now - _lastActivity[id]) / 60000) : null,
    sent_today: wppGuard.countToday(id)
  })).sort((a,b) => (a.last_activity_min||0) - (b.last_activity_min||0));
  return {
    active_sessions: active.length,
    max_sessions: WPP_MAX_SESSIONS,
    idle_ttl_min: Math.round(WPP_IDLE_TTL_MS/60000),
    min_gap_ms: wppGuard.config().gaps.chat[0],
    daily_cap: wppGuard.config().dailyCap,
    sessions: active
  };
}

module.exports = { __test: { sockets, statuses, guard: wppGuard }, resolveWppShopId, hasWhatsApp, startSession, getStatus, sendText, isOptedOut, addOptOut, closeSession, clearSession, reconnectAllShops, qrCodes, renderTemplate, normalizePhoneAR, wppStats, sweepIdle };
