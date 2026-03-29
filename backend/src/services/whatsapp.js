const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pool = require('../db/pool');
const fs   = require('fs');
const path = require('path');

// Mapa de sockets activos por shopId
const sockets  = {};
const qrCodes  = {};
const statuses = {};

// Directorio para guardar credenciales de sesión
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
    logger: { level: 'silent', log: () => {}, info: () => {}, warn: console.warn, error: console.error, debug: () => {}, trace: () => {}, child: () => ({ level: 'silent', log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
  });

  sockets[shopId]  = sock;
  statuses[shopId] = 'connecting';

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
        // Reconectar automáticamente
        setTimeout(() => connect(shopId, null, null, null), 5000);
      }
    }
  });

  // Escuchar mensajes entrantes
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        // Ignorar mensajes propios o de grupos
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid?.endsWith('@g.us')) continue;

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          null;

        if (!text) continue;

        const phone = msg.key.remoteJid.replace('@s.whatsapp.net', '');
        console.log(`[WPP] Mensaje de ${phone}: "${text}"`);

        // Obtener respuesta del AI
        const { getAIResponse } = require('./ai');
        const reply = await getAIResponse(shopId, phone, text);

        if (reply) {
          console.log(`[WPP] Respondiendo a ${phone}: "${reply}"`);
          await sock.sendMessage(msg.key.remoteJid, { text: reply });
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

// Iniciar sesión con pairing code (sin QR)
async function requestPairingCode(shopId, phoneNumber) {
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout esperando pairing code'));
    }, 30000);

    try {
      // Limpiar sesión previa si existe
      const dir = authDir(shopId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(authDir(shopId));
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ['FILO CRM', 'Chrome', '1.0'],
        connectTimeoutMs: 60000,
        logger: { level: 'silent', log: () => {}, info: () => {}, warn: () => {}, error: console.error, debug: () => {}, trace: () => {}, child: () => ({ level: 'silent', log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
      });

      sockets[shopId] = sock;
      statuses[shopId] = 'connecting';

      sock.ev.on('creds.update', async () => {
        await saveCreds();
        await saveSessionToDB(shopId);
      });

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
          clearTimeout(timeout);
          statuses[shopId] = 'connected';
          await pool.query('UPDATE shops SET wpp_connected=TRUE WHERE id=$1', [shopId]);
          await saveSessionToDB(shopId);
          console.log(`Baileys pairing conectado para shop ${shopId}`);
        }
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          statuses[shopId] = 'disconnected';
          if (code !== DisconnectReason.loggedOut) {
            setTimeout(() => connect(shopId, null, null, null), 5000);
          }
        }
      });

      // Esperar a que el socket esté listo para solicitar pairing code
      await new Promise(r => setTimeout(r, 2000));

      const phone = phoneNumber.replace(/\D/g, '');
      const code = await sock.requestPairingCode(phone);
      clearTimeout(timeout);
      resolve({ code: code?.match(/.{1,4}/g)?.join('-') || code });
    } catch (e) {
      clearTimeout(timeout);
      reject(e);
    }
  });
}

module.exports = { startSession, requestPairingCode, getStatus, sendText, closeSession, reconnectAllShops, qrCodes };
