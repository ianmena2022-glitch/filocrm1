const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// GET /api/appointments?date=YYYY-MM-DD
router.get('/', auth, async (req, res) => {
  const { date } = req.query;
  const d = date || new Date().toISOString().split('T')[0];
  try {
    const result = await pool.query(
      `SELECT a.*, c.name AS client_name, c.phone AS client_phone
       FROM appointments a
       LEFT JOIN clients c ON c.id = a.client_id
       WHERE a.shop_id = $1 AND a.date = $2
       ORDER BY a.time_start`,
      [req.shopId, d]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/appointments
router.post('/', auth, async (req, res) => {
  const {
    client_id, client_name, service_id, service_name,
    price, cost, date, time_start, barber_name, commission_pct, notes,
    redeem_item_id, redeem_item_name, redeem_points_cost
  } = req.body;

  if (!time_start || !date) return res.status(400).json({ error: 'Fecha y hora son requeridas' });

  try {
    // Resolver nombre e info del servicio si viene service_id
    let svcName = service_name || null;
    let svcCost = cost || 0;
    if (service_id) {
      const svc = await pool.query('SELECT * FROM services WHERE id=$1 AND shop_id=$2', [service_id, req.shopId]);
      if (svc.rows.length) {
        svcName = svc.rows[0].name;
        svcCost = svc.rows[0].cost;
      }
    }

    // Calcular time_end según duración del servicio (o +30 min por defecto)
    let duration = 30;
    if (service_id) {
      const svc = await pool.query('SELECT duration_minutes FROM services WHERE id=$1', [service_id]);
      if (svc.rows.length) duration = svc.rows[0].duration_minutes;
    }
    const [h, m] = time_start.split(':').map(Number);
    const end = new Date(2000, 0, 1, h, m + duration);
    const time_end = `${String(end.getHours()).padStart(2,'0')}:${String(end.getMinutes()).padStart(2,'0')}`;

    // Si viene client_id, resolver nombre
    let cName = client_name || null;
    if (client_id) {
      const cl = await pool.query('SELECT name FROM clients WHERE id=$1 AND shop_id=$2', [client_id, req.shopId]);
      if (cl.rows.length) cName = cl.rows[0].name;
    }

    // Validar puntos si hay canje
    const pointsCost = parseInt(redeem_points_cost) || 0;
    let redeemInfo = null;
    if (client_id && redeem_item_id && pointsCost > 0) {
      const cl = await pool.query('SELECT points FROM clients WHERE id=$1 AND shop_id=$2', [client_id, req.shopId]);
      if (!cl.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
      if (cl.rows[0].points < pointsCost) {
        return res.status(400).json({ error: `Puntos insuficientes. El cliente tiene ${cl.rows[0].points} pts y el premio cuesta ${pointsCost} pts.` });
      }
      redeemInfo = redeem_item_name || 'Premio canjeado';
    }

    const result = await pool.query(
      `INSERT INTO appointments
         (shop_id, client_id, client_name, service_id, service_name, price, cost, date,
          time_start, time_end, barber_name, commission_pct, notes, redeem_info)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [req.shopId, client_id || null, cName, service_id || null, svcName,
       parseFloat(price)||0, parseFloat(svcCost)||0, date, time_start, time_end,
       barber_name || null, parseInt(commission_pct)||50, notes || null, redeemInfo]
    );

    const appt = result.rows[0];

    // Restar puntos y registrar canje si corresponde
    const clientIdInt = parseInt(client_id) || null;
    const redeemItemIdInt = parseInt(redeem_item_id) || null;
    console.log(`[CANJE] client_id=${clientIdInt} item_id=${redeemItemIdInt} points=${pointsCost} redeemInfo=${redeemInfo}`);
    if (clientIdInt && redeemItemIdInt && pointsCost > 0 && redeemInfo) {
      const updateResult = await pool.query(
        'UPDATE clients SET points = points - $1 WHERE id = $2 AND shop_id = $3 RETURNING id, points',
        [pointsCost, clientIdInt, req.shopId]
      );
      console.log(`[CANJE] puntos restados:`, updateResult.rows[0]);
      await pool.query(
        `INSERT INTO points_redemptions (shop_id, client_id, item_id, item_name, points_used, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [req.shopId, clientIdInt, redeemItemIdInt, redeemInfo, pointsCost]
      );
    }

    res.status(201).json(appt);
  } catch (e) {
    console.error('Create appt error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/appointments/:id/status
router.put('/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending','confirmed','completed','noshow','cancelled'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Estado inválido' });

  try {
    const result = await pool.query(
      `UPDATE appointments SET status=$1 WHERE id=$2 AND shop_id=$3 RETURNING *`,
      [status, req.params.id, req.shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });

    const appt = result.rows[0];

    // Actualizar stats del cliente al completar
    if (status === 'completed' && appt.client_id) {
      // Calcular puntos: 10 puntos por cada $1000 gastados
      const shop = await pool.query('SELECT * FROM shops WHERE id=$1', [req.shopId]);
      const shopData = shop.rows[0];
      const pointsPerPeso = parseFloat(shopData.points_per_peso || 0.01);
      const pointsEarned = Math.floor(parseFloat(appt.price || 0) * pointsPerPeso);

      const updatedClient = await pool.query(
        `UPDATE clients SET
           total_visits = total_visits + 1,
           total_spent  = total_spent + $1,
           last_visit   = $2,
           points       = points + $3
         WHERE id = $4
         RETURNING id, name, phone, points`,
        [appt.price, appt.date, pointsEarned, appt.client_id]
      );

      const client = updatedClient.rows[0];

      // Mandar WhatsApp si tiene teléfono y WPP conectado
      if (client.phone && shopData.wpp_connected) {
        try {
          const wpp = require('../services/whatsapp');
          const { generateMessage } = require('../services/ai');
          const slug = shopData.booking_slug;
          const tiendaLink = slug
            ? `${process.env.APP_URL || 'https://filocrm1-production.up.railway.app'}/tienda/${slug}`
            : null;

          let msg = await generateMessage(req.shopId, 'turno_completado', {
            clientName: client.name,
            pointsEarned,
            totalPoints: client.points,
            tiendaLink
          });

          if (!msg) {
            msg = [
              `✂️ *¡Servicio completado!* Gracias ${client.name}.`,
              `⭐ *Puntos acumulados:* ${pointsEarned > 0 ? `+${pointsEarned} (total: ${client.points})` : client.points}`,
              tiendaLink ? `🎁 Ver premios: ${tiendaLink}` : ``,
              `¡Hasta la próxima! 💈`
            ].filter(Boolean).join('\n');
          }

          await wpp.sendText(req.shopId, client.phone, msg);
        } catch(wppErr) {
          console.error('Error enviando WPP puntos:', wppErr.message);
        }
      }
    }

    res.json(appt);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/appointments/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM appointments WHERE id=$1 AND shop_id=$2 RETURNING id',
      [req.params.id, req.shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
