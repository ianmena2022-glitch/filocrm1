// Webhook de WhatsApp Business Platform (API oficial de Meta).
// Meta llama acá con los mensajes que reciben las barberías y el estado de los que se envían.
// Es la vía oficial (aparte de la vinculación por QR de services/whatsapp.js). Por ahora se verifica
// la firma y se guarda cada evento; la bandeja y el envío por la API se arman sobre esto.
//
// Variables: WHATSAPP_VERIFY_TOKEN (la que se pone en Meta al configurar el webhook)
//            META_APP_SECRET       (Configuración de la app → Básica → Clave secreta)
const router = require('express').Router();
const crypto = require('crypto');
const pool   = require('../db/pool');

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const APP_SECRET   = process.env.META_APP_SECRET;

// GET /api/whatsapp/webhook — Meta verifica el webhook una vez, al configurarlo
router.get('/webhook', (req, res) => {
  const ok = VERIFY_TOKEN && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN;
  if (!ok) return res.sendStatus(403);
  res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
});

// Firma X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(cuerpo crudo, clave secreta de la app)
function validSignature(req) {
  if (!APP_SECRET) return process.env.NODE_ENV !== 'production';
  const header = String(req.headers['x-hub-signature-256'] || '');
  if (!header.startsWith('sha256=') || !req.rawBody) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex'), 'hex');
  const received = Buffer.from(header.slice(7), 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

// POST /api/whatsapp/webhook — mensajes y estados
router.post('/webhook', async (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200); // Meta reintenta si no contestamos rápido
  try {
    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        await pool.query(
          `INSERT INTO whatsapp_official_events (waba_id, phone_number_id, field, payload) VALUES ($1,$2,$3,$4)`,
          [String(entry.id || ''), change.value?.metadata?.phone_number_id || null, change.field || null, JSON.stringify(change.value || {})]);
      }
    }
  } catch (e) {
    console.error('[whatsapp-oficial:webhook]', e.message);
  }
});

module.exports = router;
