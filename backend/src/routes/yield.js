const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');
const wpp    = require('../services/whatsapp');

// GET /api/yield/vacant-slots
// Detecta huecos en la agenda de hoy
router.get('/vacant-slots', auth, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const shop = await pool.query('SELECT * FROM shops WHERE id=$1', [req.shopId]);
    const shopData = shop.rows[0];

    const appts = await pool.query(
      `SELECT time_start, time_end FROM appointments
       WHERE shop_id=$1 AND date=$2 AND status NOT IN ('cancelled','noshow')
       ORDER BY time_start`,
      [req.shopId, today]
    );

    // Horario de la barbería: 9:00 a 20:00 por defecto
    const workStart = 9 * 60;
    const workEnd   = 20 * 60;
    const slotLen   = 30; // minutos

    const occupied = appts.rows.map(a => {
      const [sh, sm] = String(a.time_start).split(':').map(Number);
      const [eh, em] = String(a.time_end || '00:00').split(':').map(Number);
      return { from: sh * 60 + sm, to: eh * 60 + em || sh * 60 + sm + 30 };
    });

    const vacant = [];
    for (let t = workStart; t < workEnd; t += slotLen) {
      const isOccupied = occupied.some(o => t < o.to && t + slotLen > o.from);
      if (!isOccupied) {
        const hh = String(Math.floor(t / 60)).padStart(2, '0');
        const mm = String(t % 60).padStart(2, '0');
        const eh = String(Math.floor((t + slotLen) / 60)).padStart(2, '0');
        const em = String((t + slotLen) % 60).padStart(2, '0');
        vacant.push({ from: `${hh}:${mm}`, to: `${eh}:${em}` });
      }
    }

    res.json({ vacant_slots: vacant, date: today });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/yield/target-clients
// Clientes que no vinieron en los últimos N días (para Sillón Libre)
router.get('/target-clients', auth, async (req, res) => {
  try {
    const shop = await pool.query('SELECT churn_days FROM shops WHERE id=$1', [req.shopId]);
    const churnDays = shop.rows[0]?.churn_days || 20;

    const result = await pool.query(
      `SELECT id, name, phone,
         COALESCE(EXTRACT(DAY FROM NOW() - last_visit::timestamptz), 999) AS days_since_last
       FROM clients
       WHERE shop_id=$1
         AND phone IS NOT NULL AND phone != ''
         AND (last_visit IS NULL OR last_visit < CURRENT_DATE - ($2 || ' days')::INTERVAL)
       ORDER BY last_visit ASC NULLS FIRST
       LIMIT 50`,
      [req.shopId, churnDays]
    );
    res.json({ clients: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/yield/send-flash-offer
// Envía WhatsApp masivo de Sillón Libre
router.post('/send-flash-offer', auth, async (req, res) => {
  const { slot, client_ids, incentivo } = req.body;
  if (!slot || !client_ids?.length) return res.status(400).json({ error: 'Slot y lista de clientes requeridos' });

  try {
    // Verificar que WPP esté conectado
    const shop = await pool.query('SELECT name, wpp_connected FROM shops WHERE id=$1', [req.shopId]);
    const shopData = shop.rows[0];
    if (!shopData.wpp_connected) return res.status(400).json({ error: 'WhatsApp no está conectado. Conectalo en Configuración.' });

    const clients = await pool.query(
      `SELECT id, name, phone FROM clients WHERE id = ANY($1) AND shop_id=$2`,
      [client_ids, req.shopId]
    );

    let sent = 0;
    const incentiveText = incentivo || '';

    for (const c of clients.rows) {
      if (!c.phone) continue;
      const msg = `¡Hola ${c.name}! 👋\n\nTenemos un sillón libre hoy a las *${slot}* en ${shopData.name}.\n\n${incentiveText}\n\n¿Te anotamos? ✂️`;

      try {
        await wpp.sendText(req.shopId, c.phone, msg);
        await pool.query(
          `INSERT INTO whatsapp_logs (shop_id, client_id, phone, message, type)
           VALUES ($1,$2,$3,$4,'sillon_libre')`,
          [req.shopId, c.id, c.phone, msg]
        );
        sent++;
        // Pequeño delay para no spamear
        await new Promise(r => setTimeout(r, 800));
      } catch (sendErr) {
        console.error(`Error enviando a ${c.name}:`, sendErr.message);
      }
    }

    res.json({ ok: true, sent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/yield/churn/at-risk
// Clientes en fuga (sin visitar hace más de churn_days)
router.get('/churn/at-risk', auth, async (req, res) => {
  try {
    const shop = await pool.query('SELECT churn_days FROM shops WHERE id=$1', [req.shopId]);
    const churnDays = shop.rows[0]?.churn_days || 20;

    const result = await pool.query(
      `SELECT id, name, phone,
         EXTRACT(DAY FROM NOW() - last_visit::timestamptz)::int AS days_since_last,
         CASE
           WHEN last_visit < CURRENT_DATE - ($2 * 2 || ' days')::INTERVAL THEN 'critico'
           ELSE 'en_fuga'
         END AS risk_level
       FROM clients
       WHERE shop_id=$1
         AND (last_visit IS NULL OR last_visit < CURRENT_DATE - ($2 || ' days')::INTERVAL)
         AND phone IS NOT NULL AND phone != ''
       ORDER BY last_visit ASC NULLS FIRST`,
      [req.shopId, churnDays]
    );

    res.json({ clients: result.rows, total: result.rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/yield/churn/rescue/:clientId
// Enviar mensaje de rescate a un cliente específico
router.post('/churn/rescue/:clientId', auth, async (req, res) => {
  const { clientId } = req.params;
  try {
    const shopQ = await pool.query('SELECT name, wpp_connected FROM shops WHERE id=$1', [req.shopId]);
    const shopData = shopQ.rows[0];
    if (!shopData.wpp_connected) return res.status(400).json({ error: 'WhatsApp no conectado' });

    const clientQ = await pool.query(
      'SELECT * FROM clients WHERE id=$1 AND shop_id=$2',
      [clientId, req.shopId]
    );
    if (!clientQ.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
    const client = clientQ.rows[0];
    if (!client.phone) return res.status(400).json({ error: 'El cliente no tiene teléfono registrado' });

    const msg = `¡Hola ${client.name}! 👋\n\nHace un tiempo que no te vemos por ${shopData.name} y te extrañamos. ✂️\n\n¿Cuándo querés pasar a renovar el corte? Te reservamos el turno ahora.`;

    await wpp.sendText(req.shopId, client.phone, msg);
    await pool.query(
      `INSERT INTO whatsapp_logs (shop_id, client_id, phone, message, type)
       VALUES ($1,$2,$3,$4,'churn_rescue')`,
      [req.shopId, client.id, client.phone, msg]
    );

    res.json({ ok: true, message: `Mensaje enviado a ${client.name}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
