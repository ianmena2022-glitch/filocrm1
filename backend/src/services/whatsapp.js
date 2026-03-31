const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pool = require('../db/pool');
const fs   = require('fs');
const path = require('path');

// Mapa de sockets activos por shopId
const sockets  = {};
const qrCodes  = {};
const statuses = {};
const decryptErrors = {}; // contador de errores de descifrado por shopId

// Limpiar sesión completamente (tmp + DB)
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
  } catch (e) {
    console.error('clearSession error:', e.message);
  }
}

// Limpiar solo las session keys de Signal (no las credenciales principales)
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

// Restaurar sesión desde PostgreSQL
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

    // Escribir archivos de credenciales
    for (const [filename, content] of Object.entries(parsed)) {
      fs.writeFileSync(path.join(dir, filename), JSON.stringify(content));
    }
    console.log(`Baileys: sesión restaurada para shop ${shopId}`);
    return true;
  } catch (e) {
    console.error('Error restaurando sesión:', e.message);
    return false;
  }
}

// Guardar sesión en PostgreSQL
async function saveSessionToDB(shopId) {
  try {
    const dir = authDir(shopId);
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir);
    const sessionData = {};
    for (const file of files) {
      try {
        sessionData[file] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch { }
    }

    await pool.query(
      'UPDATE shops SET wpp_session=$1 WHERE id=$2',
      [JSON.stringify(sessionData), shopId]
    );
    console.log(`Baileys: sesión guardada en DB para shop ${shopId}`);
  } catch (e) {
    console.error('Error guardando sesión:', e.message);
  }
}

// Conectar o reconectar WhatsApp
async function connect(shopId, onQR, onConnected, onDisconnected) {
  // Restaurar sesión previa si existe
  await restoreSessionFromDB(shopId);

  const dir = authDir(shopId);
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

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
    retryRequestDelayMs: 0,      // No reintentar mensajes fallidos
    maxMsgRetryCount: 0,         // Sin reintentos — evita el sendRetryRequest que crashea
    fireInitQueries: false,      // No hacer queries iniciales innecesarias
    logger: { level: 'silent', log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ level: 'silent', log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
    getMessage: async (key) => {
      return { conversation: '' };
    },
  });

  sockets[shopId]  = sock;
  statuses[shopId] = 'connecting';

  // Capturar errores no manejados del socket para evitar crash de Node
  sock.ev.on('CB:receipt', () => {}); // ignorar receipts
  process.on('unhandledRejection', (reason) => {
    if (reason?.message?.includes('Connection Closed') || reason?.output?.statusCode === 428) {
      console.log(`[WPP] Error de conexión capturado (no fatal): ${reason.message}`);
    }
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await saveSessionToDB(shopId);
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
      await pool.query('UPDATE shops SET wpp_connected=TRUE WHERE id=$1', [shopId]);
      await saveSessionToDB(shopId);
      if (onConnected) onConnected();
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`Baileys desconectado para shop ${shopId}, código: ${code}, reconectar: ${shouldReconnect}`);
      statuses[shopId] = 'disconnected';

      if (code === DisconnectReason.loggedOut) {
        // Sesión cerrada — limpiar
        await pool.query('UPDATE shops SET wpp_connected=FALSE, wpp_session=NULL WHERE id=$1', [shopId]);
        delete sockets[shopId];
        if (onDisconnected) onDisconnected();
      } else if (shouldReconnect) {
        // Código 440 = otra sesión activa, esperar más para no pisarse
        const delay = code === 440 ? 15000 : 5000;
        console.log(`[WPP] Reconectando en ${delay/1000}s...`);
        setTimeout(() => connect(shopId, null, null, null), delay);
      }
    }
  });

  // Manejar fallos de descifrado — ocurre cuando la sesión Signal está desincronizada
  sock.ev.on('messages.decrypt-fail', async (failedMessages) => {
    console.log(`[WPP] Error de descifrado para shop ${shopId} — ${failedMessages?.length || 0} mensajes fallidos`);
    decryptErrors[shopId] = (decryptErrors[shopId] || 0) + (failedMessages?.length || 1);

    // Si acumulamos 3+ errores de descifrado, limpiar keys Signal
    if (decryptErrors[shopId] >= 3) {
      console.log(`[WPP] Demasiados errores de descifrado para shop ${shopId}, limpiando keys Signal...`);
      try {
        // Limpiar solo los archivos de session keys (no las creds principales)
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

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[WPP] messages.upsert type=${type} count=${messages.length} shopId=${shopId}`);
    if (type !== 'notify') return;

    for (const msg of messages) {
      // DEBUG fuera del try para ver si el objeto existe
      console.log(`[WPP DEBUG] msg existe=${!!msg} key=${JSON.stringify(msg?.key)} hasMessage=${!!msg?.message}`);

      try {
        if (msg.key.fromMe) { console.log('[WPP DEBUG] skip fromMe'); continue; }

        const jid = msg.key.remoteJid || '';
        if (!jid.endsWith('@s.whatsapp.net')) { console.log(`[WPP DEBUG] skip jid=${jid}`); continue; }

        const phoneRaw = jid.replace('@s.whatsapp.net', '');
        if (!/^\d+$/.test(phoneRaw)) { console.log(`[WPP DEBUG] skip phoneRaw=${phoneRaw}`); continue; }

        const msgContent = msg.message;
        console.log(`[WPP DEBUG] msgContent keys=${JSON.stringify(Object.keys(msgContent || {}))}`);

        const text = msgContent?.conversation || msgContent?.extendedTextMessage?.text || null;
        console.log(`[WPP DEBUG] text="${text}"`);

        if (!text) { console.log('[WPP DEBUG] sin texto'); continue; }

        console.log(`[WPP] Mensaje de ${phoneRaw}: "${text}"`);

        const { getAIResponse } = require('./ai');
        const reply = await getAIResponse(shopId, phoneRaw, text);

        if (reply) {
          console.log(`[WPP] Respondiendo a ${phoneRaw}: "${reply}"`);
          await sock.sendMessage(jid, { text: reply });
        } else {
          console.log(`[WPP DEBUG] AI no respondió`);
        }
      } catch (e) {
        console.error('[WPP] Error:', e.message, e.stack?.split('\n')[1]);
      }
    }
  });

  return sock;
}

// Iniciar sesión (devuelve QR como base64 o status connected)
async function startSession(shopId) {
  // Limpiar sesión anterior para reconectar desde cero
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
          // QR generado — convertir a base64 image para el frontend
          clearTimeout(timeout);
          // qr es el string raw del QR — el frontend lo mostrará con qrcode lib
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
  return { connected, status: status || 'disconnected' };
}

// Enviar mensaje de texto
async function sendText(shopId, phone, message) {
  let sock = sockets[shopId];

  // Si no hay socket activo, intentar reconectar con sesión guardada
  if (!sock || statuses[shopId] !== 'connected') {
    console.log(`Baileys: no hay socket activo para shop ${shopId}, intentando restaurar...`);
    const restored = await restoreSessionFromDB(shopId);
    if (!restored) throw new Error('WhatsApp no está conectado. Conectalo desde Configuración.');

    // Reconectar con sesión restaurada
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

// Al iniciar el servidor, reconectar shops que tenían WhatsApp conectado
async function reconnectAllShops() {
  try {
    const result = await pool.query(
      'SELECT id FROM shops WHERE wpp_connected=TRUE AND wpp_session IS NOT NULL'
    );
    for (const shop of result.rows) {
      console.log(`Baileys: reconectando shop ${shop.id}...`);
      connect(shop.id, null, null, null).catch(e =>
        console.error(`Error reconectando shop ${shop.id}:`, e.message)
      );
    }
  } catch (e) {
    console.error('reconnectAllShops error:', e.message);
  }
}

module.exports = { startSession, getStatus, sendText, closeSession, reconnectAllShops, qrCodes };
