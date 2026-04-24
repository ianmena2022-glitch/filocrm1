const router = require('express').Router();
const auth   = require('../middleware/auth');
const wpp    = require('../services/whatsapp');
const pool   = require('../db/pool');

// POST /api/prospector/leads
// Workflow 1 (scraping semanal) — guarda leads en DB sin enviar nada
router.post('/leads', auth, async (req, res) => {
  try {
    const { leads } = req.body;
    if (!Array.isArray(leads) || !leads.length) return res.status(400).json({ error: 'leads debe ser un array' });
    let saved = 0;
    for (const lead of leads) {
      const phone = String(lead.phone || '').replace(/\D/g, '');
      if (!phone || phone.length < 12) continue;
      await pool.query(
        `INSERT INTO prospects (shop_id, phone, name, city, conversation)
         VALUES ($1, $2, $3, $4, '[]'::jsonb)
         ON CONFLICT (shop_id, phone) DO NOTHING`,
        [req.shopId, phone, lead.name || null, lead.city || null]
      );
      saved++;
    }
    res.json({ ok: true, saved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/prospector/leads/pending
// Workflow 2 (envío) — devuelve leads guardados que aún no fueron contactados
router.get('/leads/pending', auth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const result = await pool.query(
      `SELECT phone, name, city FROM prospects
       WHERE shop_id=$1 AND message_sent IS NULL
       ORDER BY id ASC LIMIT $2`,
      [req.shopId, limit]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/prospector/send
// n8n llama esto para enviar el mensaje y registrar el prospecto
router.post('/send', auth, async (req, res) => {
  try {
    const { phone, message, name, city } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone y message requeridos' });
    const cleanPhone = String(phone).replace(/\D/g, '');
    if (!cleanPhone) return res.status(400).json({ error: 'phone inválido' });

    await wpp.sendText(req.shopId, cleanPhone, message);

    // Guardar prospecto en DB (upsert — si ya existía, actualizar mensaje y fecha)
    await pool.query(
      `INSERT INTO prospects (shop_id, phone, name, city, message_sent, sent_at, conversation)
       VALUES ($1, $2, $3, $4, $5, NOW(), '[]'::jsonb)
       ON CONFLICT (shop_id, phone) DO UPDATE
         SET message_sent = EXCLUDED.message_sent,
             sent_at      = NOW(),
             name         = COALESCE(EXCLUDED.name, prospects.name),
             city         = COALESCE(EXCLUDED.city, prospects.city)`,
      [req.shopId, cleanPhone, name || null, city || null, message]
    );

    res.json({ ok: true, phone: cleanPhone });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/prospector/stats
// n8n lo llama para alimentar el prompt de Claude con info de qué mensajes funcionaron
router.get('/stats', auth, async (req, res) => {
  try {
    const total = await pool.query(
      'SELECT COUNT(*) FROM prospects WHERE shop_id=$1',
      [req.shopId]
    );
    const replied = await pool.query(
      'SELECT COUNT(*) FROM prospects WHERE shop_id=$1 AND reply_count > 0',
      [req.shopId]
    );
    const converted = await pool.query(
      'SELECT COUNT(*) FROM prospects WHERE shop_id=$1 AND converted=TRUE',
      [req.shopId]
    );
    // Ejemplos de mensajes que sí generaron respuesta
    const winners = await pool.query(
      `SELECT message_sent, reply_count FROM prospects
       WHERE shop_id=$1 AND reply_count > 0
       ORDER BY reply_count DESC LIMIT 3`,
      [req.shopId]
    );
    // Ejemplos de mensajes sin respuesta
    const losers = await pool.query(
      `SELECT message_sent FROM prospects
       WHERE shop_id=$1 AND reply_count = 0 AND sent_at < NOW() - INTERVAL '24 hours'
       ORDER BY sent_at DESC LIMIT 3`,
      [req.shopId]
    );

    const totalN    = parseInt(total.rows[0].count);
    const repliedN  = parseInt(replied.rows[0].count);
    const convN     = parseInt(converted.rows[0].count);

    res.json({
      total:          totalN,
      replied:        repliedN,
      converted:      convN,
      reply_rate:     totalN > 0 ? ((repliedN / totalN) * 100).toFixed(1) + '%' : '0%',
      messages_that_worked:    winners.rows.map(r => r.message_sent),
      messages_that_didnt:     losers.rows.map(r => r.message_sent),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/prospector/:phone/converted
// Marcar manualmente un prospecto como convertido
router.patch('/:phone/converted', auth, async (req, res) => {
  try {
    const cleanPhone = String(req.params.phone).replace(/\D/g, '');
    await pool.query(
      'UPDATE prospects SET converted=TRUE WHERE shop_id=$1 AND phone=$2',
      [req.shopId, cleanPhone]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
