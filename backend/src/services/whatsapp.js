const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pool = require('../db/pool');
const fs   = require('fs');
const path = require('path');

// ── Estado por shop ───────────────────────────────────────────────────────────
const sockets        = {};   // socket activo
const qrCodes        = {};   // QR pendiente
const statuses       = {};   // 'connecting' | 'qr' | 'connected' | 'disconnected'
const decryptErrors  = {};   // contador errores descifrado
const reconnectAttempts  = {}; // [A] intentos de reconexión por shop
const reconnecting       = {}; // [A] mutex: true si ya hay reconexión en curso
const saveDebounceTimers = {}; // [C] timers de debounce para saveSessionToDB
const lastIncomingEvent  = {}; // [H] timestamp del último evento recibido de WA (cualquiera)

const SILENCE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 horas sin ningún evento = falla silenciosa

// ── [A] Backoff exponencial ───────────────────────────────────────────────────
const MAX_RECONNECT_ATTEMPTS = 10;
function getReconnectDelay(attempts) {
  // 5s → 10s → 20s → 40s → ... → 300s (máx)
  return Math.min(5000 * Math.pow(2, attempts), 300000);
}

// ── [B] Handler global de errores — registrado UNA SOLA VEZ ──────────────────
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || '';
  if (
    msg.includes('Connection Closed') ||
    msg.includes('Socket connection timeout') ||
    reason?.output?.statusCode === 428
  ) {
    console.log(`[WPP] Error de conexión capturado (no fatal): ${msg}`);
  }
});

// ── Helpers de sesión ─────────────────────────────────────────────────────────
async function clearSession(shopId) {
  try {
    const dir = path.join('/tmp', `baileys_${shopId}`);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`Baileys: sesion limpiada en /tmp para shop ${shopId}`);
    }
    await pool.query('UPDATE shops SET wpp_connected=FALSE, wpp_session=NULL WHERE id=$1', [shopId]);
    console.log(`Baileys: sesion limpiada en DB para shop ${shopId}`);
    delete sockets[shopId];
    delete statuses[shopId];
    delete decryptErrors[shopId];
    delete reconnectAttempts[shopId];
    delete reconnecting[shopId];
  } catch (e) {
    console.error('clearSession error:', e.message);
  }
}

async function clearSignalKeys(shopId) {
  try {
    const dir = path.join('/tmp', `baileys_${shopId}`);
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
  const dir = path.join('/tmp', `baileys_${shopId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function restoreSessionFromDB(shopId) {
  try {
    const result = await pool.query('SELECT wpp_session FROM shops WHERE id=$1', [shopId]);
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

// [C] Versión interna (real) del guardado
async function _doSaveSessionToDB(shopId) {
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
      } catch(e) { /* ignorar archivos no JSON */ }
    }
    await pool.query('UPDATE shops SET wpp_session=$1 WHERE id=$2', [JSON.stringify(sessionData), shopId]);
    console.log(`Baileys: sesion guardada en DB para shop ${shopId} (${Object.keys(sessionData).length} archivos)`);
  } catch (e) {
    console.error('Error guardando sesion:', e.message);
  }
}

// [C] Versión debounced — para creds.update (puede dispararse decenas de veces/min)
function saveSessionToDB(shopId) {
  if (saveDebounceTimers[shopId]) clearTimeout(saveDebounceTimers[shopId]);
  saveDebounceTimers[shopId] = setTimeout(async () => {
    delete saveDebounceTimers[shopId];
    await _doSaveSessionToDB(shopId);
  }, 4000);
}

// Versión inmediata — para on('open') y shutdown
async function saveSessionToDBNow(shopId) {
  if (saveDebounceTimers[shopId]) {
    clearTimeout(saveDebounceTimers[shopId]);
    delete saveDebounceTimers[shopId];
  }
  await _doSaveSessionToDB(shopId);
}

// ── Extracción de texto ───────────────────────────────────────────────────────
function extractTextFromMessage(msgContent) {
  if (!msgContent) return null;
  if (msgContent.conversation) return msgContent.conversation;
  if (msgContent.extendedTextMessage?.text) return msgContent.extendedTextMessage.text;
  if (msgContent.ephemeralMessage?.message)        return extractTextFromMessage(msgContent.ephemeralMessage.message);
  if (msgContent.viewOnceMessage?.message)         return extractTextFromMessage(msgContent.viewOnceMessage.message);
  if (msgContent.viewOnceMessageV2?.message)       return extractTextFromMessage(msgContent.viewOnceMessageV2.message);
  if (msgContent.documentWithCaptionMessage?.message) return extractTextFromMessage(msgContent.documentWithCaptionMessage.message);
  if (msgContent.editedMessage?.message)           return extractTextFromMessage(msgContent.editedMessage.message);
  if (msgContent.imageMessage?.caption)    return msgContent.imageMessage.caption;
  if (msgContent.videoMessage?.caption)    return msgContent.videoMessage.caption;
  if (msgContent.documentMessage?.caption) return msgContent.documentMessage.caption;
  if (msgContent.buttonsResponseMessage?.selectedDisplayText)     return msgContent.buttonsResponseMessage.selectedDisplayText;
  if (msgContent.listResponseMessage?.title)                      return msgContent.listResponseMessage.title;
  if (msgContent.templateButtonReplyMessage?.selectedDisplayText) return msgContent.templateButtonReplyMessage.selectedDisplayText;
  return null;
}

// ── Conectar / reconectar ─────────────────────────────────────────────────────
async function connect(shopId, onQR, onConnected, onDisconnected) {
  await restoreSessionFromDB(shopId);

  const dir = authDir(shopId);
  const { state, saveCreds } = await useMultiFileAuthState(dir);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (e) {
    console.warn(`[WPP] fetchLatestBaileysVersion falló, usando versión fallback: ${e.message}`);
    version = [2, 3000, 1015901307];
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['FILO CRM', 'Chrome', '1.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 15000,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    retryRequestDelayMs: 0,
    maxMsgRetryCount: 0,
    fireInitQueries: false,
    logger: {
      level: 'silent', log: () => {}, info: () => {}, warn: () => {},
      error: () => {}, debug: () => {}, trace: () => {},
      child: () => ({ level: 'silent', log: () => {}, info: () => {}, warn: () => {},
                      error: () => {}, debug: () => {}, trace: () => {} })
    },
    getMessage: async () => ({ conversation: '' }),
    shouldIgnoreJid: (jid) => {
      if (jid === 'status@broadcast') return true;
      if (jid.endsWith('@newsletter')) return true;
      if (jid.endsWith('@broadcast'))  return true;
      return false;
    },
    cachedGroupMetadata: async () => null,
  });

  sockets[shopId]  = sock;
  statuses[shopId] = 'connecting';

  // [H] Cualquier evento entrante de WA actualiza el timestamp de actividad
  sock.ev.on('CB:receipt', () => { lastIncomingEvent[shopId] = Date.now(); });

  // [C] Debounce en creds.update
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    saveSessionToDB(shopId); // debounced
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`Baileys QR generado para shop ${shopId}`);
      qrCodes[shopId]  = qr;
      statuses[shopId] = 'qr';
      if (onQR) onQR(qr);
    }

    if (connection === 'open') {
      console.log(`Baileys conectado para shop ${shopId}`);
      statuses[shopId] = 'connected';
      qrCodes[shopId]  = null;
      // [A] Reset intentos al conectar exitosamente
      reconnectAttempts[shopId] = 0;
      reconnecting[shopId]      = false;
      // [H] Inicializar timestamp de actividad al conectar
      lastIncomingEvent[shopId] = Date.now();
      await pool.query('UPDATE shops SET wpp_connected=TRUE WHERE id=$1', [shopId]);
      await saveSessionToDBNow(shopId); // inmediato al conectar
      if (onConnected) onConnected();
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`Baileys desconectado para shop ${shopId}, código: ${code}`);
      statuses[shopId] = 'disconnected';

      if (code === DisconnectReason.loggedOut || code === 403) {
        // Sesión cerrada explícitamente
        await pool.query('UPDATE shops SET wpp_connected=FALSE, wpp_session=NULL WHERE id=$1', [shopId]);
        delete sockets[shopId];
        reconnectAttempts[shopId] = 0;
        reconnecting[shopId]      = false;
        if (onDisconnected) onDisconnected();

      } else if (code === DisconnectReason.connectionReplaced || code === 440) {
        // Otro cliente tomó la sesión (deploy) — no pelear
        console.log(`[WPP] Shop ${shopId}: sesión tomada por otro cliente — no reconectar`);
        delete sockets[shopId];
        reconnecting[shopId] = false;

      } else {
        // [A] Reconexión con backoff + mutex
        if (reconnecting[shopId]) {
          console.log(`[WPP] Shop ${shopId}: ya hay reconexión en curso, ignorando duplicado`);
          return;
        }
        const attempts = reconnectAttempts[shopId] || 0;
        if (attempts >= MAX_RECONNECT_ATTEMPTS) {
          console.log(`[WPP] Shop ${shopId}: alcanzó el máximo de intentos (${MAX_RECONNECT_ATTEMPTS}) — abortando`);
          await pool.query('UPDATE shops SET wpp_connected=FALSE WHERE id=$1', [shopId]);
          delete sockets[shopId];
          reconnectAttempts[shopId] = 0;
          return;
        }
        const delay = getReconnectDelay(attempts);
        reconnectAttempts[shopId] = attempts + 1;
        reconnecting[shopId]      = true;
        console.log(`[WPP] Shop ${shopId}: reconectando en ${delay / 1000}s (intento ${attempts + 1}/${MAX_RECONNECT_ATTEMPTS})...`);
        setTimeout(async () => {
          reconnecting[shopId] = false;
          connect(shopId, null, null, null).catch(e =>
            console.error(`[WPP] Error en reconexión shop ${shopId}:`, e.message)
          );
        }, delay);
      }
    }
  });

  // Errores de descifrado Signal
  sock.ev.on('messages.decrypt-fail', async (failedMessages) => {
    lastIncomingEvent[shopId] = Date.now(); // [H] WA nos entregó algo, aunque no pudimos descifrarlo
    console.log(`[WPP] Error de descifrado para shop ${shopId} — ${failedMessages?.length || 0} mensajes fallidos`);
    decryptErrors[shopId] = (decryptErrors[shopId] || 0) + (failedMessages?.length || 1);
    if (decryptErrors[shopId] >= 3) {
      console.log(`[WPP] Demasiados errores de descifrado para shop ${shopId}, limpiando keys Signal...`);
      try {
        const dir = authDir(shopId);
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (f.startsWith('session-') || f.includes('pre-key') || f.includes('sender-key')) {
            fs.unlinkSync(path.join(dir, f));
          }
        }
        decryptErrors[shopId] = 0;
        console.log(`[WPP] Keys Signal limpiadas para shop ${shopId}`);
      } catch(e) {
        console.error('[WPP] Error limpiando keys Signal:', e.message);
      }
    }
  });

  // Mensajes entrantes
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    lastIncomingEvent[shopId] = Date.now(); // [H] WA nos está entregando mensajes
    const firstJid = messages[0]?.key?.remoteJid || 'unknown';
    const fromMe   = messages[0]?.key?.fromMe;
    console.log(`[WPP] upsert type=${type} count=${messages.length} fromMe=${fromMe} jid=${firstJid}`);
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid || '';
        const isIndividual = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
        if (!isIndividual) continue;

        const phoneRaw = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
        if (!/^\d+$/.test(phoneRaw)) continue;

        const phone = (jid.endsWith('@lid') && msg.senderPn)
          ? msg.senderPn.replace('@s.whatsapp.net', '')
          : phoneRaw;

        if (msg.messageStubParameters?.includes('Invalid PreKey ID')) {
          console.log(`[WPP] Invalid PreKey ID para shop ${shopId} — limpiando keys Signal...`);
          await clearSignalKeys(shopId);
          continue;
        }

        const msgContent = msg.message;
        const msgKeys = msgContent ? Object.keys(msgContent) : [];
        console.log(`[WPP] Mensaje de ${phone} - keys: ${msgKeys.join(', ')}`);

        const text = extractTextFromMessage(msgContent);
        if (!text || !text.trim()) {
          console.log(`[WPP] Mensaje sin texto de ${phone} (tipo no soportado o media sin caption)`);
          continue;
        }

        console.log(`[WPP] Texto extraído de ${phone}: "${text}"`);

        const { getAIResponse } = require('./ai');
        const reply = await getAIResponse(shopId, phone, text);

        if (reply) {
          const sendJid = (jid.endsWith('@lid') && msg.senderPn) ? msg.senderPn : msg.key.remoteJid;
          console.log(`[WPP] Respondiendo a ${phone} (jid=${sendJid}): "${reply}"`);
          await sock.sendMessage(sendJid, { text: reply });
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

// ── API pública ───────────────────────────────────────────────────────────────
async function startSession(shopId) {
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
        (qr) => { clearTimeout(timeout); resolve({ qrcode: qr, type: 'raw' }); },
        ()   => { clearTimeout(timeout); resolve({ status: 'CONNECTED' }); },
        null
      );
    } catch (e) {
      clearTimeout(timeout);
      reject(e);
    }
  });
}

async function getStatus(shopId) {
  const status = statuses[shopId];
  return { connected: status === 'connected', status: status || 'disconnected' };
}

async function sendText(shopId, phone, message) {
  let sock = sockets[shopId];

  if (!sock || statuses[shopId] !== 'connected') {
    // [A] Respetar mutex antes de reconectar
    if (reconnecting[shopId]) {
      throw new Error('WhatsApp está reconectando, intentá en unos segundos.');
    }
    console.log(`Baileys: no hay socket activo para shop ${shopId}, intentando restaurar...`);
    const restored = await restoreSessionFromDB(shopId);
    if (!restored) throw new Error('WhatsApp no está conectado. Conectalo desde Configuración.');

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout reconectando WhatsApp')), 30000);
      connect(
        shopId,
        null,
        () => { clearTimeout(timeout); resolve(); },
        null
      ).catch(e => { clearTimeout(timeout); reject(e); });
    });

    sock = sockets[shopId];
    if (!sock) throw new Error('No se pudo reconectar WhatsApp');
  }

  const phoneClean = phone.replace(/\D/g, '');
  const jid = `${phoneClean}@s.whatsapp.net`;
  console.log(`Baileys sendText → ${jid}`);
  const result = await sock.sendMessage(jid, { text: message });
  console.log(`Baileys sendText OK → ${result?.key?.id}`);
  return result;
}

async function closeSession(shopId) {
  try {
    const sock = sockets[shopId];
    if (sock) {
      await sock.logout();
      delete sockets[shopId];
    }
    await pool.query('UPDATE shops SET wpp_connected=FALSE, wpp_session=NULL WHERE id=$1', [shopId]);
    reconnectAttempts[shopId] = 0;
    reconnecting[shopId]      = false;
    return true;
  } catch (e) {
    console.error('closeSession error:', e.message);
    return false;
  }
}

// [F] Reconectar shops escalonados al arrancar (500ms entre cada uno)
async function reconnectAllShops() {
  try {
    const result = await pool.query(
      'SELECT id FROM shops WHERE wpp_connected=TRUE AND wpp_session IS NOT NULL'
    );
    result.rows.forEach((shop, i) => {
      setTimeout(() => {
        console.log(`Baileys: reconectando shop ${shop.id}...`);
        connect(shop.id, null, null, null).catch(e =>
          console.error(`Error reconectando shop ${shop.id}:`, e.message)
        );
      }, i * 500);
    });
  } catch (e) {
    console.error('reconnectAllShops error:', e.message);
  }
}

// [G] Watchdog — verifica cada 5 min que los sockets sigan vivos
function startWatchdog() {
  setInterval(async () => {
    const shopIds = Object.keys(sockets).filter(id => statuses[id] === 'connected');
    if (!shopIds.length) return;
    console.log(`[WPP Watchdog] Verificando ${shopIds.length} shop(s) conectado(s)...`);

    for (const shopId of shopIds) {
      try {
        const sock    = sockets[shopId];
        const wsState = sock?.ws?.readyState;
        // WebSocket readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
        const isAlive = wsState === undefined || wsState === 1;

        if (!isAlive) {
          // [G] Socket muerto — reconectar
          console.log(`[WPP Watchdog] Shop ${shopId} socket muerto (state=${wsState}) — reconectando...`);
          statuses[shopId] = 'disconnected';
          delete sockets[shopId];
          if (!reconnecting[shopId]) {
            reconnectAttempts[shopId] = 0;
            connect(shopId, null, null, null).catch(e =>
              console.error(`[WPP Watchdog] Error reconectando shop ${shopId}:`, e.message)
            );
          }
          continue;
        }

        // [H] Detectar falla silenciosa: socket vivo pero WA no entrega eventos hace 2h+
        const lastEvent   = lastIncomingEvent[shopId] || 0;
        const silenceMs   = Date.now() - lastEvent;
        const silenceMin  = Math.round(silenceMs / 60000);

        if (lastEvent > 0 && silenceMs > SILENCE_THRESHOLD_MS) {
          console.log(`[WPP Watchdog] Shop ${shopId} lleva ${silenceMin} min sin recibir ningún evento de WA — falla silenciosa, reconectando...`);
          statuses[shopId] = 'disconnected';
          delete sockets[shopId];
          delete lastIncomingEvent[shopId];
          // Marcar como desconectado en DB para que el banner aparezca en el frontend
          await pool.query('UPDATE shops SET wpp_connected=FALSE WHERE id=$1', [shopId])
            .catch(e => console.error(`[WPP Watchdog] Error actualizando DB shop ${shopId}:`, e.message));
          if (!reconnecting[shopId]) {
            reconnectAttempts[shopId] = 0;
            connect(shopId, null, null, null).catch(e =>
              console.error(`[WPP Watchdog] Error reconectando shop ${shopId}:`, e.message)
            );
          }
        } else {
          console.log(`[WPP Watchdog] Shop ${shopId} OK (último evento hace ${silenceMin} min)`);
        }

      } catch (e) {
        console.error(`[WPP Watchdog] Error verificando shop ${shopId}:`, e.message);
      }
    }
  }, 5 * 60 * 1000);
}

// Guardar sesiones activas antes de shutdown
async function saveAllSessionsOnShutdown() {
  const activeShops = Object.keys(sockets).filter(id => statuses[id] === 'connected');
  for (const shopId of activeShops) {
    try {
      await saveSessionToDBNow(shopId);
      console.log(`[WPP] Sesión guardada antes de shutdown: shop ${shopId}`);
    } catch (e) {
      console.error(`[WPP] Error guardando sesión en shutdown: ${e.message}`);
    }
  }
}

process.on('SIGTERM', async () => {
  console.log('[WPP] SIGTERM recibido — guardando sesiones activas...');
  await saveAllSessionsOnShutdown();
  process.exit(0);
});

// Iniciar watchdog al cargar el módulo
startWatchdog();

module.exports = { startSession, getStatus, sendText, closeSession, clearSession, reconnectAllShops, qrCodes };
