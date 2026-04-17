// Baileys v7 — ESM-only, lazy dynamic import desde CJS
let _baileys = null;
async function getBaileys() {
  if (!_baileys) _baileys = await import('@whiskeysockets/baileys');
  return _baileys;
}

const { Boom } = require('@hapi/boom');
const pool = require('../db/pool');
const fs   = require('fs');
const path = require('path');

// Mapa de sockets activos por shopId
const sockets  = {};
const qrCodes  = {};
const statuses = {};
const decryptErrors = {};
const ciphertextLastWarning = {}; // debounce: última vez que se avisó por JID

// Fix #15: limpiar entradas de ciphertextLastWarning con más de 10 minutos
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const jid of Object.keys(ciphertextLastWarning)) {
    if (ciphertextLastWarning[jid] < cutoff) delete ciphertextLastWarning[jid];
  }
}, 10 * 60 * 1000);

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

// Limpiar sesión Signal de un JID específico (para resetear cifrado con ese contacto)
async function clearJidSession(shopId, jid, resolvedPhone) {
  try {
    const dir = authDir(shopId);
    const user = jid.split('@')[0];
    const phoneClean = (resolvedPhone || '').replace(/\D/g, '');
    const files = fs.readdirSync(dir);
    const sessionFiles = files.filter(f => f.startsWith('session-'));
    let removed = 0;
    for (const f of sessionFiles) {
      // useMultiFileAuthState: session-{user}.{device}.json o session-{user}-{device}.json (fixFileName convierte ':' a '-')
      const base = f.replace(/^session-/, '').replace(/\.json$/, '');
      const fileUser = base.replace(/_\d+(\.\d+)*$/, ''); // strip _1.0, _1.89, etc (formato Baileys v7)
      if (fileUser === user || (phoneClean && fileUser === phoneClean)) {
        fs.unlinkSync(path.join(dir, f));
        removed++;
      }
    }
    if (removed === 0) {
      // Log arquivos para diagnóstico
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
    const phoneSuffix = phone.replace(/[^0-9]/g, '').slice(-10);

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
async function handleComprobanteMedia(shopId, phone, msg, sock, mediaType) {
  try {
    let pending = await findPendingPayment(shopId, phone);
    console.log(`[WPP] findPendingPayment(${phone}): ${pending ? `${pending.type} #${pending.id}` : 'null'}`);
    // Fix #4 + #12: solo usar fallback sin phone cuando no tenemos teléfono del cliente
    // Si tenemos el teléfono y no se encontró pago, no aplicar fallback (evita verificar cliente incorrecto)
    if (!pending && !phone) {
      pending = await findAnyPendingPayment(shopId);
      console.log(`[WPP] findAnyPendingPayment fallback: ${pending ? `${pending.type} #${pending.id} clientPhone=${pending.clientPhone}` : 'null'}`);
    }
    if (!pending) return false;

    console.log(`[WPP] Comprobante ${mediaType} de ${phone} para ${pending.type} #${pending.id}`);

    const { verifyComprobante, verifyComprobanteFromText } = require('./ai');
    let result = null;

    if (mediaType === 'image') {
      const buffer = await downloadMediaBuffer(msg.message.imageMessage, 'image');
      const base64 = buffer.toString('base64');
      const mime = msg.message?.imageMessage?.mimetype || 'image/jpeg';
      result = await verifyComprobante(base64, mime, pending);
    } else if (mediaType === 'pdf') {
      const buffer = await downloadMediaBuffer(msg.message.documentMessage, 'document');
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
        await pool.query(`UPDATE appointments SET status='pending', sena_status='confirmed' WHERE id=$1`, [pending.id]);
        // Registrar seña en caja (igual que confirmación manual)
        if (pending.amount > 0) {
          try {
            const today = new Date().toISOString().split('T')[0];
            const apptRow = await pool.query('SELECT shop_id, client_name FROM appointments WHERE id=$1', [pending.id]);
            if (apptRow.rows.length) {
              await pool.query(
                `INSERT INTO expenses (shop_id, amount, category, description, date, is_income, source_type, source_id, payment_method)
                 VALUES ($1, $2, 'otros', $3, $4, TRUE, 'sena', $5, 'transfer')
                 ON CONFLICT DO NOTHING`,
                [apptRow.rows[0].shop_id, pending.amount,
                 `Seña - ${apptRow.rows[0].client_name || 'Sin nombre'}`,
                 today, pending.id]
              );
            }
          } catch (cajaErr) {
            console.error('[SENA] Error registrando en caja:', cajaErr.message);
          }
        }
        await sock.sendMessage(msg.key.remoteJid, { text: '✅ Comprobante verificado. Tu seña fue confirmada y el turno está reservado.' });
      } else {
        const reasons = [];
        if (!amountOk) reasons.push(`monto incorrecto (esperado $${pending.amount})`);
        if (!dateOk) reasons.push('la fecha no corresponde a hoy o ayer');
        if (!cbuOk) reasons.push('el CBU/CVU del destinatario no coincide');
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
        if (!cbuOk) reasons.push('el CBU/CVU del destinatario no coincide');
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
  // Cargar Baileys v7 (ESM)
  const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = await getBaileys();

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
    retryRequestDelayMs: 0,
    maxMsgRetryCount: 0,
    fireInitQueries: false,
    logger: { level: 'silent', log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ level: 'silent', log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
    getMessage: async (key) => {
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
  statuses[shopId] = 'connecting';

  sock.ev.on('CB:receipt', () => {});
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
      console.log(`Baileys desconectado para shop ${shopId}, código: ${code}`);
      statuses[shopId] = 'disconnected';

      if (code === DisconnectReason.loggedOut) {
        await pool.query('UPDATE shops SET wpp_connected=FALSE, wpp_session=NULL WHERE id=$1', [shopId]);
        delete sockets[shopId];
        if (onDisconnected) onDisconnected();
      } else if (shouldReconnect) {
        const attempt = (statuses[`${shopId}_reconnect`] || 0) + 1;
        statuses[`${shopId}_reconnect`] = attempt;
        if (attempt <= 10) {
          console.log(`[WPP] Shop ${shopId}: reconectando en 5s (intento ${attempt}/10)...`);
          setTimeout(() => connect(shopId, null, null, null), 5000);
        } else {
          console.log(`[WPP] Shop ${shopId}: demasiados intentos de reconexión, abortando`);
          await pool.query('UPDATE shops SET wpp_connected=FALSE WHERE id=$1', [shopId]);
          delete sockets[shopId];
        }
      }
    }
  });

  // Errores de descifrado — v7 los reporta acá
  sock.ev.on('messages.decrypt-fail', async (failedMessages) => {
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

  // Escuchar mensajes entrantes
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
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

        const phoneRaw = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
        if (!/^\d+$/.test(phoneRaw)) continue;

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
          // 3) Enviar aviso (debounce: máx 1 por JID cada 2 min)
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
            // Fallback: buscar cliente pendiente en DB
            try {
              const pending = await findAnyPendingPayment(shopId);
              if (pending?.clientPhone) {
                await sendText(shopId, pending.clientPhone, warning);
              }
            } catch(e) { console.error('[WPP] CIPHERTEXT fallback error:', e.message); }
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

        // Interceptar imágenes como posibles comprobantes
        if (msgContent?.imageMessage) {
          const handled = await handleComprobanteMedia(shopId, phone, msg, sock, 'image');
          if (handled) continue;
        }

        // Interceptar PDFs como posibles comprobantes
        if (msgContent?.documentMessage) {
          const mime = msgContent.documentMessage.mimetype || '';
          console.log(`[WPP] documentMessage mime="${mime}" fileName="${msgContent.documentMessage.fileName || ''}"`);
          if (mime === 'application/pdf' || mime.includes('pdf') || (msgContent.documentMessage.fileName || '').toLowerCase().endsWith('.pdf')) {
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
  return { connected, status: status || 'disconnected' };
}

// Fix #7: resolver shopId real para WPP — si la sucursal no tiene socket, usar enterprise owner
async function resolveWppShopId(shopId) {
  if (sockets[shopId] && statuses[shopId] === 'connected') return shopId;
  try {
    const r = await pool.query('SELECT parent_enterprise_id FROM shops WHERE id=$1', [shopId]);
    const parentId = r.rows[0]?.parent_enterprise_id;
    if (parentId) {
      console.log(`[WPP] resolveWppShopId: shop ${shopId} → usando enterprise owner ${parentId}`);
      return parentId;
    }
  } catch(e) { /* fallback al shopId original */ }
  return shopId;
}

// Enviar mensaje de texto
async function sendText(shopId, phone, message) {
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

  const phoneClean = phone.replace(/\D/g, '');
  const jid = `${phoneClean}@s.whatsapp.net`;

  console.log(`Baileys sendText → ${jid} (shop ${wppShopId})`);

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
