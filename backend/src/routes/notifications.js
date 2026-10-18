const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// GET /api/notifications — últimas 50 del usuario actual + unread_count
router.get('/', auth, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT id, type, title, body, icon, link, read, created_at
       FROM notifications
       WHERE recipient_shop_id=$1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.shopId]
    );
    const unread = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notifications
       WHERE recipient_shop_id=$1 AND read=FALSE`,
      [req.shopId]
    );
    res.json({ items: rows.rows, unread_count: unread.rows[0]?.n || 0 });
  } catch(e) {
    console.error('[notif list]', e.message);
    res.status(500).json({ error: 'Error' });
  }
});

// GET /api/notifications/unread-count — solo el contador (poll liviano o SSE fallback)
router.get('/unread-count', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notifications
       WHERE recipient_shop_id=$1 AND read=FALSE`,
      [req.shopId]
    );
    res.json({ unread_count: r.rows[0]?.n || 0 });
  } catch(e) {
    res.status(500).json({ error: 'Error' });
  }
});

// POST /api/notifications/read/:id — marcar una como leída
router.post('/read/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    await pool.query(
      `UPDATE notifications SET read=TRUE, read_at=NOW()
       WHERE id=$1 AND recipient_shop_id=$2 AND read=FALSE`,
      [id, req.shopId]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Error' });
  }
});

// POST /api/notifications/read-all
router.post('/read-all', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET read=TRUE, read_at=NOW()
       WHERE recipient_shop_id=$1 AND read=FALSE`,
      [req.shopId]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Error' });
  }
});

module.exports = router;
