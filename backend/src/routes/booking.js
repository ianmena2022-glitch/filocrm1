const router = require('express').Router();
const pool   = require('../db/pool');
const wpp    = require('../services/whatsapp');

// GET /api/booking/:slug — info pública de la barbería para el formulario
router.get('/:slug', async (req, res) => {
  try {
    const shop = await pool.query(
      `SELECT id, name, city, address, phone, wpp_connected
       FROM shops WHERE booking_slug = $1`,
      [req.params.slug]
    );
    if (!shop.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    const shopData = shop.rows[0];

    const services = await pool.query(
      `SELECT id, name, price, duration_minutes
       FROM services WHERE shop_id = $1 AND active = TRUE ORDER BY name`,
      [shopData.id]
    );

    res.json({ shop: shopData, services: services.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/booking/:slug/available?date=YYYY-MM-DD&service_id=X
// Devuelve los slots disponibles para una fecha y servicio
router.get('/:slug/available', async (req, res) => {
  const { date, service_id } = req.query;
  if (!date) return res.status(400).json({ error: 'Fecha requerida' });

  try {
    const shop = await pool.query(
      'SELECT id FROM shops WHERE booking_slug = $1',
      [req.params.slug]
    );
    if (!shop.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    const shopId = shop.rows[0].id;

    // Duración del servicio
    let duration = 30;
    if (service_id) {
      const svc = await pool.query(
        'SELECT duration_minutes FROM services WHERE id=$1 AND shop_id=$2',
        [service_id, shopId]
      );
      if (svc.rows.length) duration = svc.rows[0].duration_minutes;
    }

    // Turnos ya ocupados ese día
    const occupied = await pool.query(
      `SELECT time_start, time_end FROM appointments
       WHERE shop_id=$1 AND date=$2 AND status NOT IN ('cancelled','noshow')
       ORDER BY time_start`,
      [shopId, date]
    );

    // Generar slots de 30 minutos entre 9:00 y 20:00
    const workStart = 9 * 60;
    const workEnd   = 20 * 60;

    const occupiedRanges = occupied.rows.map(a => {
      const [sh, sm] = String(a.time_start).split(':').map(Number);
      const [eh, em] = String(a.time_end || '00:00').split(':').map(Number);
      return { from: sh * 60 + sm, to: eh * 60 + em || sh * 60 + sm + 30 };
    });

    const slots = [];
    for (let t = workStart; t + duration <= workEnd; t += 30) {
      const isOccupied = occupiedRanges.some(o => t < o.to && t + duration > o.from);

      // No mostrar slots en el pasado si es hoy
      const today = new Date().toISOString().split('T')[0];
      if (date === today) {
        const now = new Date();
        const nowMins = now.getHours() * 60 + now.getMinutes();
        if (t <= nowMins + 30) continue; // al menos 30 min de anticipación
      }

      if (!isOccupied) {
        const hh = String(Math.floor(t / 60)).padStart(2, '0');
        const mm = String(t % 60).padStart(2, '0');
        slots.push(`${hh}:${mm}`);
      }
    }

    res.json({ slots, duration });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/booking/:slug/reserve — crear reserva
router.post('/:slug/reserve', async (req, res) => {
  const { client_name, client_phone, service_id, date, time_start, redeem_item_id } = req.body;

  if (!client_name || !date || !time_start) {
    return res.status(400).json({ error: 'Nombre, fecha y hora son requeridos' });
  }

  try {
    const shop = await pool.query(
      'SELECT * FROM shops WHERE booking_slug = $1',
      [req.params.slug]
    );
    if (!shop.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    const shopData = shop.rows[0];

    // Resolver servicio
    let svcName = null, svcPrice = 0, svcCost = 0, duration = 30;
    if (service_id) {
      const svc = await pool.query(
        'SELECT * FROM services WHERE id=$1 AND shop_id=$2',
        [service_id, shopData.id]
      );
      if (svc.rows.length) {
        svcName     = svc.rows[0].name;
        svcPrice    = svc.rows[0].price;
        svcCost     = svc.rows[0].cost;
        duration    = svc.rows[0].duration_minutes;
      }
    }

    // Calcular time_end
    const [h, m] = time_start.split(':').map(Number);
    const end = new Date(2000, 0, 1, h, m + duration);
    const time_end = `${String(end.getHours()).padStart(2,'0')}:${String(end.getMinutes()).padStart(2,'0')}`;

    // Verificar que el slot sigue disponible
    const conflict = await pool.query(
      `SELECT id FROM appointments
       WHERE shop_id=$1 AND date=$2
         AND status NOT IN ('cancelled','noshow')
         AND time_start < $3 AND time_end > $4`,
      [shopData.id, date, time_end, time_start]
    );
    if (conflict.rows.length) {
      return res.status(409).json({ error: 'Ese horario ya no está disponible. Por favor elegí otro.' });
    }

    // Buscar o crear cliente
    let clientId = null;
    if (client_phone) {
      const existing = await pool.query(
        'SELECT id FROM clients WHERE shop_id=$1 AND phone=$2',
        [shopData.id, client_phone]
      );
      if (existing.rows.length) {
        clientId = existing.rows[0].id;
      } else {
        const newClient = await pool.query(
          'INSERT INTO clients (shop_id, name, phone) VALUES ($1,$2,$3) RETURNING id',
          [shopData.id, client_name.trim(), client_phone.trim()]
        );
        clientId = newClient.rows[0].id;
      }
    }

    // Crear turno
    const appt = await pool.query(
      `INSERT INTO appointments
         (shop_id, client_id, client_name, service_id, service_name, price, cost, date, time_start, time_end, status, redeem_info)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)
       RETURNING *`,
      [shopData.id, clientId, client_name.trim(), service_id||null, svcName,
       svcPrice, svcCost, date, time_start, time_end, null]
    );

    // Notificar al barbero por WhatsApp si está conectado
    if (shopData.wpp_connected && shopData.phone) {
      const dateFormatted = new Date(date + 'T12:00:00').toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });
      const msg = `🔔 *Nueva reserva online*\n\n👤 ${client_name}${client_phone ? '\n📱 ' + client_phone : ''}\n✂️ ${svcName || 'Sin servicio'}\n📅 ${dateFormatted} a las *${time_start}*`;
      try {
        await wpp.sendText(shopData.id, shopData.phone, msg);
      } catch (e) {
        console.error('Error notificando al barbero:', e.message);
      }
    }

    // Procesar canje de puntos si viene con la reserva
    let redeemInfo = null;
    if (redeem_item_id && clientId) {
      try {
        const item = await pool.query(
          'SELECT * FROM points_store WHERE id=$1 AND shop_id=$2 AND active=TRUE',
          [redeem_item_id, shopData.id]
        );
        const clientPts = await pool.query('SELECT points FROM clients WHERE id=$1', [clientId]);
        if (item.rows.length && clientPts.rows.length) {
          const pts = clientPts.rows[0].points;
          const cost = item.rows[0].points_cost;
          if (pts >= cost) {
            await pool.query('UPDATE clients SET points = points - $1 WHERE id=$2', [cost, clientId]);
            await pool.query(
              `INSERT INTO points_redemptions (shop_id, client_id, item_id, item_name, points_used, status)
               VALUES ($1,$2,$3,$4,$5,'pending')`,
              [shopData.id, clientId, item.rows[0].id, item.rows[0].name, cost]
            );
            redeemInfo = item.rows[0].name;
            // Guardar en el turno
            await pool.query(
              'UPDATE appointments SET redeem_info=$1 WHERE id=$2',
              [item.rows[0].name, appt.rows[0].id]
            );
          }
        }
      } catch(e) { console.error('Redeem error:', e.message); }
    }

    res.status(201).json({
      ok: true,
      redeem: redeemInfo,
      message: `¡Turno confirmado! Te esperamos el ${new Date(date + 'T12:00:00').toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' })} a las ${time_start} en ${shopData.name}.`,
      appointment: appt.rows[0]
    });
  } catch (e) {
    console.error('Booking error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
