const router = require('express').Router();
const pool   = require('../db/pool');
const wpp    = require('../services/whatsapp');

// GET /api/booking/:slug — info pública de la barbería para el formulario
router.get('/:slug', async (req, res) => {
  try {
    const shop = await pool.query(
      `SELECT id, name, city, address, phone, wpp_connected, schedule, home_service, allow_barber_choice, filo_plan, closed_days, is_enterprise_owner, enterprise_shared_wpp, sena_enabled, sena_pct, sena_alias
       FROM shops WHERE booking_slug = $1`,
      [req.params.slug]
    );
    if (!shop.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    const shopData = shop.rows[0];

    // Si es enterprise owner con WPP compartido → devolver lista de sucursales para que el cliente elija
    if (shopData.is_enterprise_owner && shopData.enterprise_shared_wpp) {
      const branches = await pool.query(
        `SELECT id, name, branch_label, city, address, booking_slug
         FROM shops WHERE parent_enterprise_id=$1 AND is_branch=TRUE
         ORDER BY name`,
        [shopData.id]
      );
      return res.json({
        is_enterprise: true,
        enterprise: { name: shopData.name },
        branches: branches.rows
      });
    }

    const services = await pool.query(
      `SELECT id, name, price, duration_minutes
       FROM services WHERE shop_id = $1 AND active = TRUE ORDER BY name`,
      [shopData.id]
    );

    // Si tiene eleccion de barbero activa, incluir lista de barberos
    let barbers = [];
    if (shopData.allow_barber_choice) {
      const barbersQ = await pool.query(
        'SELECT id, name, barber_color FROM shops WHERE parent_shop_id=$1 AND is_barber=TRUE ORDER BY name',
        [shopData.id]
      );
      barbers = barbersQ.rows;
    }

    res.json({ shop: shopData, services: services.rows, barbers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/booking/:slug/member-verify?phone=XXX — verifica membresía activa
router.get('/:slug/member-verify', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'Teléfono requerido' });

  try {
    const shop = await pool.query('SELECT id FROM shops WHERE booking_slug=$1', [req.params.slug]);
    if (!shop.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    const shopId = shop.rows[0].id;

    const client = await pool.query(
      'SELECT id, name, phone FROM clients WHERE shop_id=$1 AND phone=$2',
      [shopId, phone]
    );
    if (!client.rows.length) return res.status(404).json({ error: 'No se encontró un cliente con ese número' });
    const clientData = client.rows[0];

    const memQ = await pool.query(
      `SELECT id, plan, credits_total, credits_used, active, renews_at
       FROM memberships WHERE shop_id=$1 AND client_id=$2 AND active=TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [shopId, clientData.id]
    );
    if (!memQ.rows.length) {
      return res.status(404).json({ error: 'No tenés una membresía activa en esta barbería' });
    }
    const mem = memQ.rows[0];

    if (mem.plan === 'basic' && mem.credits_used >= mem.credits_total) {
      return res.status(400).json({ error: `Ya usaste todos tus créditos de este mes (${mem.credits_used}/${mem.credits_total})` });
    }

    res.json({ client: clientData, membership: mem });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

    // Generar slots según horario configurado
    const shopFull = await pool.query('SELECT schedule, closed_days FROM shops WHERE id=$1', [shopId]);
    const scheduleRaw = shopFull.rows[0]?.schedule;
    const schedule = scheduleRaw ? JSON.parse(scheduleRaw) : null;

    // Verificar si el día es un día cerrado extraordinario
    const closedDaysRaw = shopFull.rows[0]?.closed_days;
    const closedDays = closedDaysRaw ? JSON.parse(closedDaysRaw) : [];
    if (closedDays.includes(date)) {
      return res.json({ slots: [], duration, closed: true, closed_extraordinary: true });
    }

    // Día de la semana (0=domingo, 1=lunes... 6=sábado)
    const dayOfWeek = new Date(date + 'T12:00:00').getDay();
    const dayNames = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    const dayKey = dayNames[dayOfWeek];

    // Si hay horario configurado, verificar si ese día trabajan
    let workStart = 9 * 60;
    let workEnd   = 20 * 60;

    if (schedule) {
      const daySchedule = schedule[dayKey];
      if (!daySchedule || !daySchedule.active) {
        return res.json({ slots: [], duration, closed: true });
      }
      const [startH, startM] = daySchedule.start.split(':').map(Number);
      const [endH, endM]     = daySchedule.end.split(':').map(Number);
      workStart = startH * 60 + startM;
      workEnd   = endH * 60 + endM;
    }

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
  const { client_name, client_phone, client_address, service_id, date, time_start, redeem_item_id, chosen_barber_id, is_member_booking, membership_id } = req.body;

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

    // Verificar día cerrado extraordinario
    if (shopData.closed_days) {
      const closedDays = JSON.parse(shopData.closed_days);
      if (closedDays.includes(date)) {
        return res.status(400).json({ error: 'La barbería no atiende ese día (día no laborable).' });
      }
    }

    // Verificar que el día esté habilitado en el horario
    if (shopData.schedule) {
      const schedule = JSON.parse(shopData.schedule);
      const dayNames = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
      const dayKey = dayNames[new Date(date + 'T12:00:00').getDay()];
      if (!schedule[dayKey]?.active) {
        return res.status(400).json({ error: 'La barbería no atiende ese día.' });
      }
    }

    // Resolver servicio
    let svcName = null, svcPrice = 0, svcCost = 0, duration = 30;
    if (service_id) {
      const svc = await pool.query(
        'SELECT * FROM services WHERE id=$1 AND shop_id=$2',
        [service_id, shopData.id]
      );
      if (svc.rows.length) {
        svcName     = svc.rows[0].name;
        svcPrice    = is_member_booking ? 0 : svc.rows[0].price; // membresía = sin cargo
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
        // Actualizar domicilio si viene en la reserva
        if (client_address) {
          await pool.query('UPDATE clients SET address=$1 WHERE id=$2', [client_address.trim(), clientId]);
        }
      } else {
        const newClient = await pool.query(
          'INSERT INTO clients (shop_id, name, phone, address) VALUES ($1,$2,$3,$4) RETURNING id',
          [shopData.id, client_name.trim(), client_phone.trim(), client_address?.trim() || null]
        );
        clientId = newClient.rows[0].id;
      }
    }

    // Asignar barbero: elegido por el cliente o auto-asignado por menos turnos
    let assignedBarberId = null;
    let assignedBarberCommission = 0; // 0 si no hay barbero asignado
    try {
      if (chosen_barber_id && shopData.allow_barber_choice) {
        // Usar el barbero elegido por el cliente
        assignedBarberId = parseInt(chosen_barber_id);
      } else {
        // Auto-asignar al barbero con menos turnos
        const barbers = await pool.query(
          'SELECT id FROM shops WHERE parent_shop_id=$1 AND is_barber=TRUE', [shopData.id]
        );
        if (barbers.rows.length) {
          const counts = await pool.query(
            `SELECT barber_id, COUNT(*) as total FROM appointments
             WHERE shop_id=$1 AND date=$2 AND barber_id IS NOT NULL GROUP BY barber_id`,
            [shopData.id, date]
          );
          const countMap = {};
          counts.rows.forEach(r => { countMap[r.barber_id] = parseInt(r.total); });
          let minCount = Infinity;
          for (const b of barbers.rows) {
            const c = countMap[b.id] || 0;
            if (c < minCount) { minCount = c; assignedBarberId = b.id; }
          }
        }
      }
      if (assignedBarberId) {
        assignedBarberCommission = 50; // default si hay barbero pero sin % configurado
        const barberData = await pool.query(
          'SELECT barber_commission_pct FROM shops WHERE id=$1', [assignedBarberId]
        );
        if (barberData.rows[0]?.barber_commission_pct) {
          assignedBarberCommission = parseInt(barberData.rows[0].barber_commission_pct);
        }
      }
    } catch(e) { console.error('autoAssign booking error:', e.message); }

    // Determinar si se requiere seña
    const requiresSena = !is_member_booking && shopData.sena_enabled && svcPrice > 0 && shopData.sena_alias;
    const senaAmount = requiresSena ? Math.ceil(svcPrice * (shopData.sena_pct || 30) / 100) : 0;
    const senaExpiresAt = requiresSena ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null;
    const apptStatus = requiresSena ? 'waiting_sena' : 'pending';

    // Crear turno
    const appt = await pool.query(
      `INSERT INTO appointments
         (shop_id, client_id, client_name, service_id, service_name, price, cost, date, time_start, time_end, status, redeem_info, barber_id, commission_pct, member_booking, membership_id, payment_method, sena_amount, sena_status, sena_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [shopData.id, clientId, client_name.trim(), service_id||null, svcName,
       svcPrice, svcCost, date, time_start, time_end, apptStatus, null,
       assignedBarberId, assignedBarberCommission,
       is_member_booking ? true : false,
       (is_member_booking && membership_id) ? parseInt(membership_id) : null,
       is_member_booking ? 'membership' : null,
       senaAmount, requiresSena ? 'pending' : null, senaExpiresAt]
    );

    // Notificar por WhatsApp
    if (shopData.wpp_connected) {
      const dateFormatted = new Date(date + 'T12:00:00').toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });
      if (requiresSena) {
        // Mensaje al cliente con instrucciones de seña
        if (client_phone) {
          const msgCliente = `✂️ *${shopData.name}* — Reserva recibida\n\n👤 Hola ${client_name}! Tu turno del ${dateFormatted} a las *${time_start}* quedó *pendiente de seña*.\n\n💸 Para confirmar el turno, enviá una seña de *$${senaAmount.toLocaleString('es-AR')}* al alias:\n\n📲 *${shopData.sena_alias}*\n\n⏰ Tenés *60 minutos* para realizar la transferencia. Si no se recibe, el turno se cancela automáticamente.`;
          try { await wpp.sendText(shopData.id, client_phone, msgCliente); } catch(e) { console.error('WPP seña cliente:', e.message); }
        }
      } else if (shopData.phone) {
        const msg = `🔔 *Nueva reserva online*\n\n👤 ${client_name}${client_phone ? '\n📱 ' + client_phone : ''}\n✂️ ${svcName || 'Sin servicio'}\n📅 ${dateFormatted} a las *${time_start}*`;
        try { await wpp.sendText(shopData.id, shopData.phone, msg); } catch(e) { console.error('Error notificando al barbero:', e.message); }
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

    const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });
    res.status(201).json({
      ok: true,
      redeem: redeemInfo,
      requires_sena: requiresSena,
      sena_amount: requiresSena ? senaAmount : null,
      sena_alias: requiresSena ? shopData.sena_alias : null,
      message: requiresSena
        ? `Tu reserva fue recibida. Para confirmarla, enviá una seña de $${senaAmount.toLocaleString('es-AR')} al alias ${shopData.sena_alias} en los próximos 60 minutos.`
        : `¡Turno confirmado! Te esperamos el ${dateLabel} a las ${time_start} en ${shopData.name}.`,
      appointment: appt.rows[0]
    });
  } catch (e) {
    console.error('Booking error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
