const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');
const wpp    = require('../services/whatsapp');

// GET /api/yield/vacant-slots
router.get('/vacant-slots', auth, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const appts = await pool.query(
      `SELECT time_start, time_end FROM appointments
       WHERE shop_id=$1 AND date=$2 AND status NOT IN ('cancelled','noshow')
       ORDER BY time_start`,
      [req.shopId, today]
    );

    const workStart = 9 * 60;
    const workEnd   = 20 * 60;
    const slotLen   = 30;

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
    console.error('vacant-slots error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/yield/target-clients
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
    console.error('target-clients error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/yield/send-flash-offer
router.post('/send-flash-offer', auth, async (req, res) => {
  const { slot, client_ids, incentivo } = req.body;
  if (!slot || !client_ids?.length) return res.status(400).json({ error: 'Slot y lista de clientes requeridos' });

  try {
    const shop = await pool.query('SELECT name, wpp_connected, msg_templates FROM shops WHERE id=$1', [req.shopId]);
    const shopData = shop.rows[0];
    if (!shopData.wpp_connected) return res.status(400).json({ error: 'WhatsApp no está conectado. Conectalo en Configuración.' });

    const clients = await pool.query(
      `SELECT id, name, phone FROM clients WHERE id = ANY($1) AND shop_id=$2`,
      [client_ids, req.shopId]
    );

    let sent = 0;
    const { generateMessage } = require('../services/ai');

    for (const c of clients.rows) {
      if (!c.phone) continue;
      let msg = await generateMessage(req.shopId, 'sillon_libre', {
        clientName: c.name,
        slot,
        shopName: shopData.name,
        incentivo: incentivo || ''
      });
      // Fallback: usar template de la DB si la IA falla
      if (!msg) {
        const tpls = shopData.msg_templates ? JSON.parse(shopData.msg_templates) : {};
        msg = (tpls.sillon || '¡Hola {nombre}! 👋\n\nTenemos un sillón libre hoy a las *{hora}* en {barberia}.\n\n{incentivo}\n\n¿Te anotamos? ✂️')
          .replace('{nombre}', c.name)
          .replace('{hora}', slot)
          .replace('{barberia}', shopData.name)
          .replace('{incentivo}', incentivo || '');
      }

      try {
        await wpp.sendText(req.shopId, c.phone, msg);
        await pool.query(
          `INSERT INTO whatsapp_logs (shop_id, client_id, phone, message, type)
           VALUES ($1,$2,$3,$4,'sillon_libre')`,
          [req.shopId, c.id, c.phone, msg]
        );
        sent++;
        await new Promise(r => setTimeout(r, 800));
      } catch (sendErr) {
        console.error(`Error enviando a ${c.name}:`, sendErr.message);
      }
    }

    res.json({ ok: true, sent });
  } catch (e) {
    console.error('send-flash-offer error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/yield/churn/at-risk
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
    console.error('churn at-risk error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/yield/churn/rescue/:clientId
router.post('/churn/rescue/:clientId', auth, async (req, res) => {
  const { clientId } = req.params;
  try {
    const shopQ = await pool.query('SELECT name, wpp_connected, msg_templates FROM shops WHERE id=$1', [req.shopId]);
    const shopData = shopQ.rows[0];

    console.log(`Rescue → shopId: ${req.shopId}, wpp_connected: ${shopData.wpp_connected}`);

    if (!shopData.wpp_connected) {
      return res.status(400).json({ error: 'WhatsApp no conectado' });
    }

    const clientQ = await pool.query(
      'SELECT * FROM clients WHERE id=$1 AND shop_id=$2',
      [clientId, req.shopId]
    );
    if (!clientQ.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
    const client = clientQ.rows[0];

    console.log(`Rescue → cliente: ${client.name}, phone: ${client.phone}`);

    if (!client.phone) return res.status(400).json({ error: 'El cliente no tiene teléfono registrado' });

    const { generateMessage } = require('../services/ai');
    const daysSince = Math.round((Date.now() - new Date(client.last_visit).getTime()) / (1000*60*60*24)) || '?';
    let msg = await generateMessage(req.shopId, 'rescate', {
      clientName: client.name,
      shopName: shopData.name,
      daysSince
    });
    if (!msg) {
      const tpls = shopData.msg_templates ? JSON.parse(shopData.msg_templates) : {};
      msg = (tpls.rescate || '¡Hola {nombre}! 👋\n\nHace un tiempo que no te vemos por {barberia} y te extrañamos. ✂️\n\n¿Cuándo querés pasar a renovar el corte? Te reservamos el turno ahora.')
        .replace('{nombre}', client.name)
        .replace('{barberia}', shopData.name);
    }

    await wpp.sendText(req.shopId, client.phone, msg);

    await pool.query(
      `INSERT INTO whatsapp_logs (shop_id, client_id, phone, message, type)
       VALUES ($1,$2,$3,$4,'churn_rescue')`,
      [req.shopId, client.id, client.phone, msg]
    );

    res.json({ ok: true, message: `Mensaje enviado a ${client.name}` });
  } catch (e) {
    console.error('WPP rescue error completo:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
