const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
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

// Mapa LID → phone real (por shopId) — poblado desde contacts.set / contacts.update
const lidToPhone = {}; // lidToPhone[shopId][lidNumber] = phoneNumber

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

// Buscar pago pendiente sin filtrar por phone (fallback para @lid no resuelto)
// Solo se usa cuando hay exactamente 1 pago pendiente en el shop
async function findAnyPendingPayment(shopId) {
  try {
    const senaRes = await pool.query(
      `SELECT a.id, a.sena_amount, s.sena_alias
       FROM appointments a JOIN shops s ON s.id = a.shop_id
       WHERE a.shop_id=$1 AND a.status='waiting_sena' AND a.sena_comprobante_status IS NULL
       LIMIT 2`,
      [shopId]
    );
    if (senaRes.rows.length === 1) {
      return { type: 'sena', id: senaRes.rows[0].id, amount: parseFloat(senaRes.rows[0].sena_amount), alias: senaRes.rows[0].sena_alias };
    }
    const memRes = await pool.query(
      `SELECT m.id, m.price_monthly AS price, s.sena_alias
       FROM memberships m JOIN shops s ON s.id = m.shop_id
       WHERE m.shop_id=$1 AND (m.payment_status='pending' OR m.payment_status IS NULL)
         AND m.comprobante_status IS NULL AND m.active=TRUE
       ORDER BY m.created_at DESC LIMIT 2`,
      [shopId]
    );
    if (memRes.rows.length === 1) {
      return { type: 'membership', id: memRes.rows[0].id, amount: parseFloat(memRes.rows[0].price), alias: memRes.rows[0].sena_alias };
    }
    return null;
  } catch(e) {
    console.error('[WPP] findAnyPendingPayment error:', e.message);
    return null;
  }
}

// Buscar pago pendiente para un teléfono (seña o membresía)
async function findPendingPayment(shopId, phone) {
  try {
    const phoneSuffix = phone.replace(/[^0-9]/g, '').slice(-10);

    const senaRes = await pool.query(
      `SELECT a.id, a.sena_amount, s.sena_alias
       FROM appointments a
       JOIN shops s ON s.id = a.shop_id
       WHERE a.shop_id = $1
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
      return { type: 'sena', id: senaRes.rows[0].id, amount: parseFloat(senaRes.rows[0].sena_amount), alias: senaRes.rows[0].sena_alias };
    }

    const memRes = await pool.query(
      `SELECT m.id, m.price_monthly AS price, s.sena_alias
       FROM memberships m
       JOIN shops s ON s.id = m.shop_id
       JOIN clients c ON c.id = m.client_id
       WHERE m.shop_id = $1
         AND m.comprobante_status IS NULL
         AND (m.payment_status = 'pending' OR m.payment_status IS NULL)
         AND regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE $2
       ORDER BY m.created_at DESC
       LIMIT 1`,
      [shopId, '%' + phoneSuffix]
    );
    if (memRes.rows.length) {
      return { type: 'membership', id: memRes.rows[0].id, amount: parseFloat(memRes.rows[0].price), alias: memRes.rows[0].sena_alias };
    }

    return null;
  } catch (e) {
    console.error('[WPP] findPendingPayment error:', e.message);
    return null;
  }
}

// Verificar y procesar comprobante recibido (imagen o PDF)
async function handleComprobanteMedia(shopId, phone, msg, sock, mediaType) {
  try {
    let pending = await findPendingPayment(shopId, phone);
    // Fallback para @lid no resuelto: si hay exactamente 1 pago pendiente en el shop, usarlo
    if (!pending && phone.length > 13) {
      pending = await findAnyPendingPayment(shopId);
      if (pending) console.log(`[WPP] @lid fallback: usando pago pendiente ${pending.type} #${pending.id}`);
    }
    if (!pending) return false;

    console.log(`[WPP] Comprobante ${mediaType} de ${phone} para ${pending.type} #${pending.id}`);

    const { verifyComprobante, verifyComprobanteFromText } = require('./ai');
    let result = null;

    if (mediaType === 'image') {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      const base64 = buffer.toString('base64');
      const mime = msg.message?.imageMessage?.mimetype || 'image/jpeg';
      result = await verifyComprobante(base64, mime, pending);
    } else if (mediaType === 'pdf') {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      try {
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(buffer);
        if (!pdfData.text?.trim()) {
          await sock.sendMessage(msg.key.remoteJid, { text: 'El PDF no tiene texto legible. Por favor mandá una foto del comprobante.' });
          return true;
        }
        result = await verifyComprobanteFromText(pdfData.text, pending);
      } catch (pdfErr) {
        console.error('[WPP] pdf-parse error:', pdfErr.message);
        await sock.sendMessage(msg.key.remoteJid, { text: 'No pudimos leer el PDF. Por favor mandá una foto del comprobante.' });
        return true;
      }
    }

    if (!result) {
      await sock.sendMessage(msg.key.remoteJid, { text: 'No pudimos verificar el comprobante. Intentá de nuevo o contactá al barbero.' });
      return true;
    }

    const today = new Date(); today.setHours(0,0,0,0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const comprobanteDate = result.date ? new Date(result.date) : null;
    comprobanteDate?.setHours(0,0,0,0);

    const amountOk = result.amount && Math.abs(result.amount - pending.amount) / pending.amount <= 0.02;
    const dateOk = comprobanteDate && (comprobanteDate.getTime() === today.getTime() || comprobanteDate.getTime() === yesterday.getTime());
    const aliasOk = !pending.alias || (result.alias && result.alias.replace(/\s/g,'').toLowerCase().includes(pending.alias.replace(/\s/g,'').toLowerCase().slice(0,6)));

    const verified = result.valid && amountOk && dateOk && aliasOk;
    const status = verified ? 'verified' : 'rejected';
    const dataJson = JSON.stringify(result);

    if (pending.type === 'sena') {
      await pool.query(`UPDATE appointments SET sena_comprobante_status=$1, sena_comprobante_data=$2 WHERE id=$3`, [status, dataJson, pending.id]);
      if (verified) {
        await pool.query(`UPDATE appointments SET status='confirmed' WHERE id=$1`, [pending.id]);
        await sock.sendMessage(msg.key.remoteJid, { text: '✅ Comprobante verificado. Tu seña fue confirmada y el turno está reservado.' });
      } else {
        const reasons = [];
        if (!amountOk) reasons.push(`monto incorrecto (esperado $${pending.amount})`);
        if (!dateOk) reasons.push('la fecha no corresponde a hoy o ayer');
        if (!aliasOk) reasons.push('el alias del destinatario no coincide');
        await sock.sendMessage(msg.key.remoteJid, { text: `❌ No pudimos verificar el comprobante: ${reasons.join(', ')}. Por favor verificá y volvé a intentarlo.` });
      }
    } else if (pending.type === 'membership') {
      await pool.query(`UPDATE memberships SET comprobante_status=$1, comprobante_data=$2 WHERE id=$3`, [status, dataJson, pending.id]);
      if (verified) {
        await pool.query(`UPDATE memberships SET payment_status='paid', last_payment_at=NOW() WHERE id=$1`, [pending.id]);
        await sock.sendMessage(msg.key.remoteJid, { text: '✅ Pago de membresía verificado. ¡Ya tenés tus créditos activos!' });
      } else {
        const reasons = [];
        if (!amountOk) reasons.push(`monto incorrecto (esperado $${pending.amount})`);
        if (!dateOk) reasons.push('la fecha no corresponde a hoy o ayer');
        if (!aliasOk) reasons.push('el alias del destinatario no coincide');
        await sock.sendMessage(msg.key.remoteJid, { text: `❌ No pudimos verificar el comprobante: ${reasons.join(', ')}. Por favor verificá y volvé a intentarlo.` });
      }
    }

    return true;
  } catch (e) {
    console.error('[WPP] handleComprobanteMedia error:', e.message);
    return false;
  }
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

  // Mapear LID → phone real desde la lista de contactos
  const storeLidMappings = (contacts) => {
    if (!lidToPhone[shopId]) lidToPhone[shopId] = {};
    for (const contact of contacts) {
      if (!contact.lid || !contact.id) continue;
      const lid   = contact.lid.replace(/@.*/, '');
      const phone = contact.id.replace(/@.*/, '');
      if (/^\d+$/.test(lid) && /^\d+$/.test(phone)) {
        lidToPhone[shopId][lid] = phone;
      }
    }
  };
  sock.ev.on('contacts.set',    ({ contacts }) => {
    storeLidMappings(contacts);
    console.log(`[WPP] Contacts sync: ${Object.keys(lidToPhone[shopId] || {}).length} LID mappings`);
  });
  sock.ev.on('contacts.update', (updates) => storeLidMappings(updates));

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

        // Si es @lid, resolver número real: senderPn > mapa de contactos > phoneRaw (LID)
        const phone = (jid.endsWith('@lid') && msg.senderPn)
          ? msg.senderPn.replace('@s.whatsapp.net', '')
          : (jid.endsWith('@lid') && lidToPhone[shopId]?.[phoneRaw])
            ? lidToPhone[shopId][phoneRaw]
            : phoneRaw;
        if (jid.endsWith('@lid')) console.log(`[WPP] @lid ${phoneRaw} → phone resuelto: ${phone}`);

        if (msg.messageStubParameters?.includes('Invalid PreKey ID')) {
          console.log(`[WPP] Invalid PreKey ID para shop ${shopId} — limpiando keys Signal...`);
          await clearSignalKeys(shopId);
          continue;
        }

        // messageStubType 2 = CIPHERTEXT: Baileys no pudo descifrar — limpiar keys Signal
        // No enviamos notificación a nadie (no sabemos quién es el @lid)
        if (msg.messageStubType === 2) {
          console.log(`[WPP] CIPHERTEXT (stub=2) de ${phone} — limpiando keys Signal para shop ${shopId}`);
          await clearSignalKeys(shopId);
          continue;
        }

        let msgContent = msg.message;
        // Algunos mensajes de @lid llegan con msg.message vacío; intentar ruta alternativa
        if ((!msgContent || Object.keys(msgContent).length === 0) && msg.message?.message) {
          msgContent = msg.message.message;
        }

        // Log de diagnostico
        const msgKeys = msgContent ? Object.keys(msgContent) : [];
        console.log(`[WPP] Mensaje de ${phone} - keys: ${msgKeys.join(', ')}`);

        // @lid con mensaje vacío: registrar estructura completa y manejar media
        if (msgKeys.length === 0 && jid.endsWith('@lid')) {
          try {
            const topKeys = Object.keys(msg).join(', ');
            console.log(`[WPP] @lid msg vacío — top-level keys: ${topKeys}`);
            if (msg.messageStubType != null) console.log(`[WPP] @lid messageStubType: ${msg.messageStubType}`);
          } catch(e) {}

          // Intentar descargar como imagen (best-effort)
          try {
            let pending = await findPendingPayment(shopId, phone);
            if (!pending) pending = await findAnyPendingPayment(shopId);
            if (pending) {
              let buffer;
              try { buffer = await downloadMediaMessage(msg, 'buffer', {}); } catch(dlErr) {
                console.log(`[WPP] @lid downloadMediaMessage falló: ${dlErr.message}`);
              }
              if (buffer && buffer.length > 100) {
                console.log(`[WPP] @lid media descargada (${buffer.length} bytes) — verificando como comprobante`);
                const { verifyComprobante } = require('./ai');
                const base64 = buffer.toString('base64');
                const result = await verifyComprobante(base64, 'image/jpeg', pending);
                if (!result) {
                  await sock.sendMessage(msg.key.remoteJid, { text: 'No pudimos verificar el comprobante. Intentá de nuevo o contactá al barbero.' });
                } else {
                  const today = new Date(); today.setHours(0,0,0,0);
                  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
                  const comprobanteDate = result.date ? new Date(result.date) : null;
                  comprobanteDate?.setHours(0,0,0,0);
                  const amountOk = result.amount && Math.abs(result.amount - pending.amount) / pending.amount <= 0.02;
                  const dateOk = comprobanteDate && (comprobanteDate.getTime() === today.getTime() || comprobanteDate.getTime() === yesterday.getTime());
                  const aliasOk = !pending.alias || (result.alias && result.alias.replace(/\s/g,'').toLowerCase().includes(pending.alias.replace(/\s/g,'').toLowerCase().slice(0,6)));
                  const verified = result.valid && amountOk && dateOk && aliasOk;
                  const status = verified ? 'verified' : 'rejected';
                  const dataJson = JSON.stringify(result);
                  if (pending.type === 'sena') {
                    await pool.query('UPDATE appointments SET sena_comprobante_status=$1, sena_comprobante_data=$2 WHERE id=$3', [status, dataJson, pending.id]);
                    if (verified) {
                      await pool.query("UPDATE appointments SET status='confirmed' WHERE id=$1", [pending.id]);
                      await sock.sendMessage(msg.key.remoteJid, { text: '✅ Comprobante verificado. Tu seña fue confirmada y el turno está reservado.' });
                    } else {
                      const reasons = [];
                      if (!amountOk) reasons.push(`monto incorrecto (esperado $${pending.amount})`);
                      if (!dateOk) reasons.push('la fecha no corresponde a hoy o ayer');
                      if (!aliasOk) reasons.push('el alias del destinatario no coincide');
                      await sock.sendMessage(msg.key.remoteJid, { text: `❌ No pudimos verificar el comprobante: ${reasons.join(', ')}. Por favor verificá y volvé a intentarlo.` });
                    }
                  } else if (pending.type === 'membership') {
                    await pool.query('UPDATE memberships SET comprobante_status=$1, comprobante_data=$2 WHERE id=$3', [status, dataJson, pending.id]);
                    if (verified) {
                      await pool.query("UPDATE memberships SET payment_status='paid', last_payment_at=NOW() WHERE id=$1", [pending.id]);
                      await sock.sendMessage(msg.key.remoteJid, { text: '✅ Pago de membresía verificado. ¡Ya tenés tus créditos activos!' });
                    } else {
                      const reasons = [];
                      if (!amountOk) reasons.push(`monto incorrecto (esperado $${pending.amount})`);
                      if (!dateOk) reasons.push('la fecha no corresponde a hoy o ayer');
                      if (!aliasOk) reasons.push('el alias del destinatario no coincide');
                      await sock.sendMessage(msg.key.remoteJid, { text: `❌ No pudimos verificar el comprobante: ${reasons.join(', ')}. Por favor verificá y volvé a intentarlo.` });
                    }
                  }
                }
                continue;
              } else {
                // No se pudo descargar la media — avisar al usuario
                await sock.sendMessage(msg.key.remoteJid, {
                  text: '⚠️ Recibimos tu archivo, pero no pudimos procesarlo. Por favor reenviá el comprobante como imagen directamente por este chat.'
                });
                continue;
              }
            }
          } catch(e) {
            console.error('[WPP] Error procesando @lid media:', e.message);
          }
          console.log(`[WPP] @lid mensaje vacío sin pago pendiente — ignorando`);
          continue;
        }

        // Interceptar imágenes como posibles comprobantes
        if (msgContent?.imageMessage) {
          const handled = await handleComprobanteMedia(shopId, phone, msg, sock, 'image');
          if (handled) continue;
        }

        // Interceptar PDFs como posibles comprobantes
        if (msgContent?.documentMessage) {
          const mime = msgContent.documentMessage.mimetype || '';
          if (mime === 'application/pdf' || mime.includes('pdf')) {
            const handled = await handleComprobanteMedia(shopId, phone, msg, sock, 'pdf');
            if (handled) continue;
          }
        }

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
