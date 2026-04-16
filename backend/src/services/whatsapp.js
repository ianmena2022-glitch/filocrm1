const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pool = require('../db/pool');
const fs   = require('fs');
const path = require('path');

// Mapa de sockets activos por shopId
const sockets  = {};
const qrCodes  = {};
const statuses = {};
const decryptErrors = {}; // contador de errores de descifrado por shopId

// Mapa LID → phone real (por shopId) — poblado desde contacts.set / contacts.update
const lidToPhone = {}; // lidToPhone[shopId][lidNumber] = phoneNumber

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

// Intentar resolver @lid → phone real consultando la API de WhatsApp
// Itera sobre clientes con pago pendiente, llama onWhatsApp para obtener su LID y hace match
async function resolveLidToPhone(shopId, lidNumber, sock) {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT c.phone
       FROM (
         SELECT client_id FROM appointments
         WHERE shop_id=$1 AND status='waiting_sena' AND sena_comprobante_status IS NULL
         UNION
         SELECT client_id FROM memberships
         WHERE shop_id=$1 AND (payment_status='pending' OR payment_status IS NULL)
           AND comprobante_status IS NULL AND active=TRUE
       ) pending
       JOIN clients c ON c.id = pending.client_id
       WHERE c.phone IS NOT NULL AND c.phone != ''`,
      [shopId]
    );

    for (const row of rows) {
      try {
        const phoneClean = row.phone.replace(/\D/g, '');
        const results = await sock.onWhatsApp(`${phoneClean}@s.whatsapp.net`);
        const info = Array.isArray(results) ? results[0] : results;
        if (!info) continue;
        const lid = (info.lid || '').replace(/@.*/, '');
        if (lid) {
          if (!lidToPhone[shopId]) lidToPhone[shopId] = {};
          lidToPhone[shopId][lid] = phoneClean;
          if (lid === lidNumber) {
            console.log(`[WPP] LID ${lidNumber} resuelto via onWhatsApp → ${phoneClean}`);
            return phoneClean;
          }
        }
      } catch(e) { /* este número no devolvió LID */ }
    }
  } catch(e) {
    console.error('[WPP] resolveLidToPhone error:', e.message);
  }
  return null;
}

// Buscar pago pendiente para un teléfono (seña o membresía)
async function findPendingPayment(shopId, phone) {
  try {
    const phoneSuffix = phone.replace(/[^0-9]/g, '').slice(-10);

    // Buscar seña pendiente
    const senaRes = await pool.query(
      `SELECT a.id, a.sena_amount, s.wpp_alias
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
      return { type: 'sena', id: senaRes.rows[0].id, amount: parseFloat(senaRes.rows[0].sena_amount), alias: senaRes.rows[0].wpp_alias };
    }

    // Buscar membresía con pago pendiente
    const memRes = await pool.query(
      `SELECT m.id, m.price, s.wpp_alias
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
      return { type: 'membership', id: memRes.rows[0].id, amount: parseFloat(memRes.rows[0].price), alias: memRes.rows[0].wpp_alias };
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
    const pending = await findPendingPayment(shopId, phone);
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

    // Validar monto (±2%), fecha (hoy o ayer), alias
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
      await pool.query(
        `UPDATE appointments SET sena_comprobante_status=$1, sena_comprobante_data=$2 WHERE id=$3`,
        [status, dataJson, pending.id]
      );
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
      await pool.query(
        `UPDATE memberships SET comprobante_status=$1, comprobante_data=$2 WHERE id=$3`,
        [status, dataJson, pending.id]
      );
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
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`Baileys desconectado para shop ${shopId}, código: ${code}, reconectar: ${shouldReconnect}`);
      statuses[shopId] = 'disconnected';

      if (code === DisconnectReason.loggedOut) {
        // Sesión cerrada   limpiar
        await pool.query('UPDATE shops SET wpp_connected=FALSE, wpp_session=NULL WHERE id=$1', [shopId]);
        delete sockets[shopId];
        if (onDisconnected) onDisconnected();
      } else if (shouldReconnect) {
        // Reconectar automáticamente
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

        // Si es @lid, resolver número real: senderPn > mapa de contactos > onWhatsApp API > phoneRaw
        let phone = (jid.endsWith('@lid') && msg.senderPn)
          ? msg.senderPn.replace('@s.whatsapp.net', '')
          : (jid.endsWith('@lid') && lidToPhone[shopId]?.[phoneRaw])
            ? lidToPhone[shopId][phoneRaw]
            : phoneRaw;
        // Último recurso: consultar la API de WA para resolver el LID
        if (jid.endsWith('@lid') && phone === phoneRaw) {
          const resolved = await resolveLidToPhone(shopId, phoneRaw, sock);
          if (resolved) phone = resolved;
        }
        if (jid.endsWith('@lid')) console.log(`[WPP] @lid ${phoneRaw} → phone resuelto: ${phone}`);

        // Detectar error de PreKey (mensaje no descifrable) — limpiar keys Signal
        if (msg.messageStubParameters?.includes('Invalid PreKey ID')) {
          console.log(`[WPP] Invalid PreKey ID para shop ${shopId} — limpiando keys Signal...`);
          await clearSignalKeys(shopId);
          continue;
        }

        // messageStubType 2 = CIPHERTEXT: Baileys no pudo descifrar — limpiar keys Signal
        if (msg.messageStubType === 2) {
          console.log(`[WPP] CIPHERTEXT (stub=2) de ${phone} — limpiando keys Signal para shop ${shopId}`);
          await clearSignalKeys(shopId);
          // No podemos enviar de vuelta al @lid ni buscar por LID no resuelto.
          // Notificamos a TODOS los clientes con pago pendiente via su phone conocido en DB.
          try {
            const { rows } = await pool.query(
              `SELECT DISTINCT c.phone
               FROM (
                 SELECT client_id FROM appointments
                 WHERE shop_id=$1 AND status='waiting_sena' AND sena_comprobante_status IS NULL
                 UNION
                 SELECT client_id FROM memberships
                 WHERE shop_id=$1 AND (payment_status='pending' OR payment_status IS NULL)
                   AND comprobante_status IS NULL AND active=TRUE
               ) pending
               JOIN clients c ON c.id = pending.client_id
               WHERE c.phone IS NOT NULL AND c.phone != ''`,
              [shopId]
            );
            for (const row of rows) {
              try {
                await sendText(shopId, row.phone, '⚠️ No pudimos leer tu último mensaje. Por favor reenviá el comprobante como imagen por este chat.');
                console.log(`[WPP] CIPHERTEXT: aviso enviado a ${row.phone}`);
              } catch(e) { console.error('[WPP] CIPHERTEXT notify error:', e.message); }
            }
          } catch(e) { console.error('[WPP] CIPHERTEXT query error:', e.message); }
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
            const pending = await findPendingPayment(shopId, phone);
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
          console.log(`[WPP] Respondiendo a ${phone}: "${reply}"`);
          const sendJid = (jid.endsWith('@lid') && msg.senderPn) ? msg.senderPn : msg.key.remoteJid;
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

module.exports = { startSession, getStatus, sendText, closeSession, clearSession, reconnectAllShops, qrCodes };
