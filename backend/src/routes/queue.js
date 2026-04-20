const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth = require('../middleware/auth');

// ─── PUBLIC: join queue ──────────────────────────────────────────────────────
router.post('/:slug/join', async (req, res) => {
  try {
    const { slug } = req.params;
    const { name, phone } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'El nombre es obligatorio' });
    }

    // Find shop
    const shopRes = await pool.query(
      'SELECT id, name, booking_slug, queue_paused FROM shops WHERE booking_slug=$1',
      [slug]
    );
    if (!shopRes.rows.length) {
      return res.status(404).json({ error: 'Barbería no encontrada' });
    }
    const shop = shopRes.rows[0];

    // Check paused
    if (shop.queue_paused) {
      return res.status(423).json({ error: 'La fila está pausada', paused: true });
    }

    // Insert entry
    const insertRes = await pool.query(
      `INSERT INTO queue_entries (shop_id, client_name, client_phone, status)
       VALUES ($1, $2, $3, 'waiting') RETURNING id`,
      [shop.id, name.trim(), phone || null]
    );
    const entry_id = insertRes.rows[0].id;

    // Calculate position (number of waiting entries with lower id = people ahead)
    const posRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM queue_entries
       WHERE shop_id=$1 AND status='waiting' AND id < $2`,
      [shop.id, entry_id]
    );
    const position = posRes.rows[0].cnt;

    // Calculate avg wait
    const avgRes = await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (served_at - called_at))/60) AS avg_min
       FROM queue_entries
       WHERE shop_id=$1 AND status='served' AND served_at > NOW() - INTERVAL '4 hours'`,
      [shop.id]
    );
    const avg_wait_min = avgRes.rows[0].avg_min != null
      ? parseFloat(avgRes.rows[0].avg_min)
      : 15;

    const estimated_wait_min = Math.round(position * avg_wait_min);

    return res.json({
      entry_id,
      client_name: name.trim(),
      position,
      estimated_wait_min,
      shop_name: shop.name
    });
  } catch (e) {
    console.error('queue join error', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ─── PUBLIC: status ──────────────────────────────────────────────────────────
router.get('/:slug/status', async (req, res) => {
  try {
    const { slug } = req.params;
    const { entry_id } = req.query;

    // Find shop
    const shopRes = await pool.query(
      'SELECT id, name, booking_slug, queue_paused FROM shops WHERE booking_slug=$1',
      [slug]
    );
    if (!shopRes.rows.length) {
      return res.status(404).json({ error: 'Barbería no encontrada' });
    }
    const shop = shopRes.rows[0];

    if (!entry_id) {
      return res.json({ shop_name: shop.name, queue_paused: shop.queue_paused });
    }

    // Get entry
    const entryRes = await pool.query(
      `SELECT id, client_name, client_phone, status, created_at, called_at
       FROM queue_entries WHERE id=$1 AND shop_id=$2`,
      [entry_id, shop.id]
    );
    if (!entryRes.rows.length) {
      return res.status(404).json({ error: 'Entrada no encontrada' });
    }
    const entry = entryRes.rows[0];

    // Special status responses
    if (entry.status === 'called') {
      return res.json({
        status: 'called',
        message: '¡Es tu turno! Andá para la barbería 💈'
      });
    }
    if (entry.status === 'served') {
      return res.json({ status: 'served' });
    }
    if (entry.status === 'left') {
      return res.json({ status: 'left' });
    }

    // waiting — calculate position
    const posRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM queue_entries
       WHERE shop_id=$1 AND status='waiting' AND id < $2`,
      [shop.id, entry.id]
    );
    const position = posRes.rows[0].cnt;

    // avg wait
    const avgRes = await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (served_at - called_at))/60) AS avg_min
       FROM queue_entries
       WHERE shop_id=$1 AND status='served' AND served_at > NOW() - INTERVAL '4 hours'`,
      [shop.id]
    );
    const avg_wait_min = avgRes.rows[0].avg_min != null
      ? parseFloat(avgRes.rows[0].avg_min)
      : 15;

    const estimated_wait_min = Math.round(position * avg_wait_min);

    return res.json({
      entry_id: entry.id,
      status: entry.status,
      position,
      people_ahead: position,
      estimated_wait_min,
      client_name: entry.client_name,
      shop_name: shop.name,
      queue_paused: shop.queue_paused
    });
  } catch (e) {
    console.error('queue status error', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ─── PROTECTED: get queue ────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const shopId = req.shopId;

    // paused + slug
    const shopRes = await pool.query(
      'SELECT queue_paused, booking_slug FROM shops WHERE id=$1',
      [shopId]
    );
    const shop = shopRes.rows[0] || {};

    // entries (waiting + called)
    const entriesRes = await pool.query(
      `SELECT id, client_name, client_phone, status, created_at, called_at,
              EXTRACT(EPOCH FROM (NOW() - created_at))/60 AS minutes_waiting
       FROM queue_entries
       WHERE shop_id=$1 AND status IN ('waiting','called')
       ORDER BY created_at ASC`,
      [shopId]
    );

    // avg wait
    const avgRes = await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (served_at - called_at))/60) AS avg_min
       FROM queue_entries
       WHERE shop_id=$1 AND status='served' AND served_at > NOW() - INTERVAL '4 hours'`,
      [shopId]
    );
    const avg_wait_min = avgRes.rows[0].avg_min != null
      ? parseFloat(avgRes.rows[0].avg_min)
      : null;

    // served today
    const servedRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM queue_entries
       WHERE shop_id=$1 AND status='served' AND served_at > NOW()::date`,
      [shopId]
    );

    return res.json({
      paused: shop.queue_paused || false,
      shop_slug: shop.booking_slug || '',
      entries: entriesRes.rows,
      avg_wait_min,
      served_today: servedRes.rows[0].cnt
    });
  } catch (e) {
    console.error('queue GET error', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ─── PROTECTED: call next ────────────────────────────────────────────────────
router.post('/next', auth, async (req, res) => {
  try {
    const shopId = req.shopId;

    // Get shop name
    const shopRes = await pool.query('SELECT name FROM shops WHERE id=$1', [shopId]);
    const shopName = shopRes.rows[0]?.name || 'la barbería';

    // Get first waiting entry
    const entryRes = await pool.query(
      `SELECT id, client_name, client_phone FROM queue_entries
       WHERE shop_id=$1 AND status='waiting'
       ORDER BY created_at ASC LIMIT 1`,
      [shopId]
    );
    if (!entryRes.rows.length) {
      return res.json({ ok: false, message: 'No hay nadie en la fila' });
    }
    const entry = entryRes.rows[0];

    // Update to called
    await pool.query(
      `UPDATE queue_entries SET status='called', called_at=NOW() WHERE id=$1`,
      [entry.id]
    );

    // Count remaining waiting
    const remainRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM queue_entries
       WHERE shop_id=$1 AND status='waiting'`,
      [shopId]
    );
    const remaining = remainRes.rows[0].cnt;

    // avg wait for message
    const avgRes = await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (served_at - called_at))/60) AS avg_min
       FROM queue_entries
       WHERE shop_id=$1 AND status='served' AND served_at > NOW() - INTERVAL '4 hours'`,
      [shopId]
    );
    const avg = avgRes.rows[0].avg_min != null
      ? Math.round(parseFloat(avgRes.rows[0].avg_min))
      : 15;

    // Send WhatsApp non-blocking
    if (entry.client_phone) {
      let msg;
      if (remaining > 0) {
        msg = `¡Hola ${entry.client_name}! Tu turno en *${shopName}* se acerca 💈\nQuedan ${remaining} persona${remaining > 1 ? 's' : ''} antes que vos.\nEstimado: ${remaining * avg}min aprox. ¡No te vayas muy lejos! ✂️`;
      } else {
        msg = `¡Hola ${entry.client_name}! *Es tu turno* en ${shopName} 💈\n¡Vení ahora, te estamos esperando! ✂️`;
      }
      try {
        const wpp = require('../services/whatsapp');
        wpp.sendMessage(entry.client_phone, msg).catch(() => {});
      } catch (e) {
        // non-blocking, ignore
      }
    }

    return res.json({ ok: true, entry, remaining });
  } catch (e) {
    console.error('queue next error', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ─── PROTECTED: mark served ──────────────────────────────────────────────────
router.post('/serve/:id', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE queue_entries SET status='served', served_at=NOW()
       WHERE id=$1 AND shop_id=$2`,
      [req.params.id, req.shopId]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error('queue serve error', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ─── PROTECTED: remove from queue ───────────────────────────────────────────
router.post('/remove/:id', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE queue_entries SET status='left' WHERE id=$1 AND shop_id=$2`,
      [req.params.id, req.shopId]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error('queue remove error', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ─── PROTECTED: toggle pause ─────────────────────────────────────────────────
router.post('/pause', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE shops SET queue_paused = NOT queue_paused WHERE id=$1 RETURNING queue_paused`,
      [req.shopId]
    );
    return res.json({ paused: result.rows[0].queue_paused });
  } catch (e) {
    console.error('queue pause error', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ─── PROTECTED: clear queue ──────────────────────────────────────────────────
router.delete('/', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE queue_entries SET status='left'
       WHERE shop_id=$1 AND status IN ('waiting','called')`,
      [req.shopId]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error('queue clear error', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
