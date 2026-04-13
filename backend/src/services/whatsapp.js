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


// Extraer texto de cualquier tipo de mensaje de Baileys
function extractTextFromMessage(msgContent) {
  if (!msgContent) return null;

  // Tipos directos
  if (msgContent.conversation) return msgContent.conversation;
  if (msgContent.extendedTextMessage?.text) return msgContent.extendedTextMessage.text;

  // Mensajes con contexto (viewOnce, ephemeral, etc.)
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

  // Mensajes con caption (imágenes, videos, docs con texto)
  if (msgContent.imageMessage?.caption) return msgContent.imageMessage.caption;
  if (msgContent.videoMessage?.caption) return msgContent.videoMessage.caption;
  if (msgContent.documentMessage?.caption) return msgContent.documentMessage.caption;

  // Botones y listas
  if (msgContent.buttonsResponseMessage?.selectedDisplayText) return msgContent.buttonsResponseMessage.selectedDisplayText;
  if (msgContent.listResponseMessage?.title) return msgContent.listResponseMessage.title;
  if (msgContent.templateButtonReplyMessage?.selectedDisplayText) return msgContent.templateButtonReplyMessage.selectedDisplayText;

  return null;
}

// Conectar o reconectar WhatsApp
async function connect(shopId, onQR, onConnected, onDisconnected) {
  // Restaurar sesión previa si existe
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
    retryRequestDelayMs: 0,      // No reintentar mensajes fallidos
    maxMsgRetryCount: 0,         // Sin reintentos   evita el sendRetryRequest que crashea
    fireInitQueries: false,      // No hacer queries iniciales innecesarias
    logger: { level: 'silent', log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ level: 'silent', log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
    getMessage: async (key) => {
      return { conversation: '' };
    },
    shouldIgnoreJid: (jid) => {
      // Ignorar status broadcast, newsletters y cualquier JID no individual
      if (jid === 'status@broadcast') return true;
      if (jid.endsWith('@newsletter')) return true;
      if (jid.endsWith('@broadcast')) return true;
      return false;
    },
    cachedGroupMetadata: async () => null,
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
      console.log(`Baileys desconectado para shop ${shopId}, código: ${code}`);
      statuses[shopId] = 'disconnected';

      if (code === DisconnectReason.loggedOut || code === 403) {
        // Sesión cerrada explícitamente — limpiar
        await pool.query('UPDATE shops SET wpp_connected=FALSE, wpp_session=NULL WHERE id=$1', [shopId]);
        delete sockets[shopId];
        if (onDisconnected) onDisconnected();
      } else if (code === DisconnectReason.connectionReplaced || code === 440) {
        // Otro cliente/contenedor tomó la sesión (deploy) — no pelear, ceder
        console.log(`[WPP] Shop ${shopId}: sesión tomada por otro cliente — no reconectar`);
        delete sockets[shopId];
      } else {
        // Reconectar automáticamente por pérdida de conexión normal
        console.log(`[WPP] Shop ${shopId}: reconectando en 5s...`);
        setTimeout(() => connect(shopId, null, null, null), 5000);
      }
    }
  });

  // Manejar fallos de descifrado   ocurre cuando la sesión Signal está desincronizada
  sock.ev.on('messages.decrypt-fail', async (failedMessages) => {
    console.log(`[WPP] Error de descifrado para shop ${shopId}   ${failedMessages?.length || 0} mensajes fallidos`);
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

  // Escuchar mensajes entrantes
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    const firstJid = messages[0]?.key?.remoteJid || 'unknown';
    const fromMe = messages[0]?.key?.fromMe;
    console.log(`[WPP] upsert type=${type} count=${messages.length} fromMe=${fromMe} jid=${firstJid}`);
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        // Ignorar mensajes propios
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid || '';

        // Solo responder a contactos individuales (@s.whatsapp.net o @lid)
        // Bloquear grupos (@g.us), newsletters, broadcasts, status, bots, y cualquier otro
        const isIndividual = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
        if (!isIndividual) continue;

        // Extraer el número/id del JID
        const phoneRaw = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
        if (!/^\d+$/.test(phoneRaw)) continue;

        // Si es @lid, usar senderPn como número real
        const phone = (jid.endsWith('@lid') && msg.senderPn)
          ? msg.senderPn.replace('@s.whatsapp.net', '')
          : phoneRaw;

        // Detectar error de PreKey (mensaje no descifrable) — limpiar keys Signal
        if (msg.messageStubParameters?.includes('Invalid PreKey ID')) {
          console.log(`[WPP] Invalid PreKey ID para shop ${shopId} — limpiando keys Signal...`);
          await clearSignalKeys(shopId);
          console.log(`[WPP] Keys limpiadas, proximos mensajes deberan descifrar correctamente`);
          continue;
        }

        const msgContent = msg.message;

        // Log de diagnostico
        const msgKeys = msgContent ? Object.keys(msgContent) : [];
        console.log(`[WPP] Mensaje de ${phone} - keys: ${msgKeys.join(', ')}`);

        // Extraer texto usando handler multi-tipo
        const text = extractTextFromMessage(msgContent);

        if (!text || !text.trim()) {
          console.log(`[WPP] Mensaje sin texto de ${phone} (tipo no soportado o media sin caption)`);
          continue;
        }

        console.log(`[WPP] Texto extraído de ${phone}: "${text}"`);

        // Obtener respuesta del AI
        const { getAIResponse } = require('./ai');
        const reply = await getAIResponse(shopId, phone, text);

        if (reply) {
          // Para @lid JIDs usar senderPn como destino — las sesiones Signal
          // están registradas bajo @s.whatsapp.net, no bajo @lid
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
          // QR generado   convertir a base64 image para el frontend
          clearTimeout(timeout);
          // qr es el string raw del QR   el frontend lo mostrará con qrcode lib
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

// Guardar sesiones activas antes de que el proceso muera (deploy / SIGTERM)
// Solo guarda las que siguen connected — no sobreescribe si otra instancia ya tomó la sesión
async function saveAllSessionsOnShutdown() {
  const activeShops = Object.keys(sockets).filter(id => statuses[id] === 'connected');
  for (const shopId of activeShops) {
    try {
      await saveSessionToDB(shopId);
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

module.exports = { startSession, getStatus, sendText, closeSession, clearSession, reconnectAllShops, qrCodes };
