const router = require('express').Router();
const pool   = require('../db/pool');
const wpp    = require('../services/whatsapp');

// Helper: verificar si un barbero trabaja en una fecha+hora dada
// barberSchedule: null = sin restricciones (siempre disponible)
// date: 'YYYY-MM-DD', timeStart: 'HH:MM'
function isBarberAvailable(barberSchedule, date, timeStart) {
  if (!barberSchedule) return true;
  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const d = new Date(date + 'T12:00:00');
  const dayKey = DAY_KEYS[d.getDay()];
  const dayCfg = barberSchedule[dayKey];
  if (!dayCfg || !dayCfg.active) return false;
  if (!timeStart || !dayCfg.from || !dayCfg.to) return true;
  return timeStart >= dayCfg.from && timeStart < dayCfg.to;
}

// GET /api/booking/:slug — info pública de la barbería para el formulario
router.get('/:slug', async (req, res) => {
  try {
    const shop = await pool.query(
      `SELECT id, name, city, address, phone, wpp_connected, schedule, home_service, allow_barber_choice, filo_plan, closed_days, is_enterprise_owner, enterprise_shared_wpp, sena_enabled, sena_pct, sena_alias, sena_cbu, is_branch, parent_enterprise_id
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

    // Si tiene eleccion de barbero activa, incluir lista de barberos con sus horarios
    // Para sucursales, heredar allow_barber_choice y barberos del enterprise owner
    const barberShopId = (shopData.is_branch && shopData.parent_enterprise_id)
      ? shopData.parent_enterprise_id
      : shopData.id;
    if (!shopData.allow_barber_choice && shopData.is_branch && shopData.parent_enterprise_id) {
      const ownerChoice = await pool.query(
        'SELECT allow_barber_choice FROM shops WHERE id=$1', [shopData.parent_enterprise_id]
      );
      if (ownerChoice.rows[0]?.allow_barber_choice) shopData.allow_barber_choice = true;
    }

    let barbers = [];
    if (shopData.allow_barber_choice) {
      const barbersQ = await pool.query(
        'SELECT id, name, barber_color, barber_schedule FROM shops WHERE parent_shop_id=$1 AND is_barber=TRUE ORDER BY name',
        [barberShopId]
      );
      barbers = barbersQ.rows;
    }

    // Si es sucursal sin seña propia, heredar sena_* del enterprise owner
    if (shopData.is_branch && shopData.parent_enterprise_id && !shopData.sena_enabled) {
      const ownerQ = await pool.query(
        'SELECT sena_enabled, sena_pct, sena_alias, sena_cbu FROM shops WHERE id=$1',
        [shopData.parent_enterprise_id]
      );
      if (ownerQ.rows.length && ownerQ.rows[0].sena_enabled) {
        shopData.sena_enabled = ownerQ.rows[0].sena_enabled;
        shopData.sena_pct     = ownerQ.rows[0].sena_pct;
        shopData.sena_alias   = ownerQ.rows[0].sena_alias;
        shopData.sena_cbu     = ownerQ.rows[0].sena_cbu;
      }
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
      if (svc.rows.length) duration = svc.rows[0].duration_minutes || 30;
    }

    // Generar slots según horario configurado
    const shopFull = await pool.query(
      'SELECT schedule, closed_days, allow_barber_choice, is_branch, parent_enterprise_id FROM shops WHERE id=$1',
      [shopId]
    );
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
    // workRanges: array de {from, to} en minutos — soporta franjas múltiples por día
    let workRanges = [{ from: 9 * 60, to: 20 * 60 }];

    if (schedule) {
      const daySchedule = schedule[dayKey];
      if (!daySchedule || !daySchedule.active) {
        return res.json({ slots: [], duration, closed: true });
      }
      // Normalizar: formato viejo {start, end} → nuevo {ranges:[...]}
      const ranges = daySchedule.ranges && Array.isArray(daySchedule.ranges)
        ? daySchedule.ranges
        : [{ start: daySchedule.start || '09:00', end: daySchedule.end || '20:00' }];
      workRanges = ranges.map(r => {
        const [sh, sm] = (r.start || '09:00').split(':').map(Number);
        const [eh, em] = (r.end   || '20:00').split(':').map(Number);
        return { from: sh * 60 + sm, to: eh * 60 + em };
      });
    }

    // Cargar barberos (para cálculo de disponibilidad por barbero)
    const shopRow = shopFull.rows[0];
    let allowBarberChoice = shopRow.allow_barber_choice;
    const barberShopId = (shopRow.is_branch && shopRow.parent_enterprise_id)
      ? shopRow.parent_enterprise_id : shopId;
    if (!allowBarberChoice && shopRow.is_branch && shopRow.parent_enterprise_id) {
      const ownerChoice = await pool.query('SELECT allow_barber_choice FROM shops WHERE id=$1', [shopRow.parent_enterprise_id]);
      allowBarberChoice = ownerChoice.rows[0]?.allow_barber_choice || false;
    }

    let barberMap = null; // { barberId -> [occupiedRanges] }
    if (allowBarberChoice) {
      const barbersQ = await pool.query(
        'SELECT id, barber_schedule FROM shops WHERE parent_shop_id=$1 AND is_barber=TRUE',
        [barberShopId]
      );
      if (barbersQ.rows.length) {
        // Solo barberos que trabajan este día/hora (se filtrará por slot abajo)
        const DAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];
        const bsDayKey = DAY_KEYS[dayOfWeek];

        barberMap = {};
        for (const b of barbersQ.rows) {
          const sched = b.barber_schedule;
          // Si tiene schedule, verificar que trabaja este día
          if (sched) {
            const cfg = sched[bsDayKey];
            if (!cfg || !cfg.active) continue; // no trabaja este día
          }
          barberMap[b.id] = { schedule: b.barber_schedule, ranges: [] };
        }

        if (Object.keys(barberMap).length > 0) {
          // Turnos ocupados por barbero ese día
          const occupiedByBarber = await pool.query(
            `SELECT barber_id, time_start, time_end FROM appointments
             WHERE shop_id=$1 AND date=$2 AND barber_id IS NOT NULL
               AND status NOT IN ('cancelled','noshow')
               AND NOT (status = 'waiting_sena' AND sena_expires_at IS NOT NULL AND sena_expires_at < NOW())`,
            [shopId, date]
          );
          for (const a of occupiedByBarber.rows) {
            if (!barberMap[a.barber_id]) continue;
            const [sh, sm] = String(a.time_start).split(':').map(Number);
            const [eh, em] = String(a.time_end || '00:00').split(':').map(Number);
            barberMap[a.barber_id].ranges.push({ from: sh * 60 + sm, to: eh * 60 + em || sh * 60 + sm + 30 });
          }
        } else {
          barberMap = null; // sin barberos disponibles este día → usar lógica normal
        }
      }
    }

    // Si no hay barberMap, usar la lógica original (turnos globales del shop)
    let occupiedRanges = [];
    if (!barberMap) {
      const occupied = await pool.query(
        `SELECT time_start, time_end FROM appointments
         WHERE shop_id=$1 AND date=$2
           AND status NOT IN ('cancelled','noshow')
           AND NOT (status = 'waiting_sena' AND sena_expires_at IS NOT NULL AND sena_expires_at < NOW())`,
        [shopId, date]
      );
      occupiedRanges = occupied.rows.map(a => {
        const [sh, sm] = String(a.time_start).split(':').map(Number);
        const [eh, em] = String(a.time_end || '00:00').split(':').map(Number);
        return { from: sh * 60 + sm, to: eh * 60 + em || sh * 60 + sm + 30 };
      });
    }

    const slots = [];
    const AR_OFFSET_MS = 3 * 60 * 60 * 1000;
    const nowAR = new Date(Date.now() - AR_OFFSET_MS);
    const todayAR = nowAR.toISOString().split('T')[0];

    // Construir lista de slots válidos a partir de todas las franjas horarias
    const validTimes = [];
    for (const range of workRanges) {
      for (let t = range.from; t + duration <= range.to; t += 30) {
        validTimes.push(t);
      }
    }

    for (const t of validTimes) {
      if (date === todayAR) {
        const nowMinsAR = nowAR.getUTCHours() * 60 + nowAR.getUTCMinutes();
        if (t <= nowMinsAR + 30) continue;
      }

      let available;
      if (barberMap) {
        // Con barberos: slot disponible si al menos 1 barbero que trabaja ese horario tiene el slot libre
        const DAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];
        const bsDayKey = DAY_KEYS[dayOfWeek];
        const slotHH = String(Math.floor(t / 60)).padStart(2, '0');
        const slotMM = String(t % 60).padStart(2, '0');
        const slotTime = `${slotHH}:${slotMM}`;
        available = Object.values(barberMap).some(b => {
          // Verificar que el barbero trabaja en este slot específico
          if (b.schedule) {
            const cfg = b.schedule[bsDayKey];
            if (!cfg || !cfg.active) return false;
            if (cfg.from && cfg.to && (slotTime < cfg.from || slotTime >= cfg.to)) return false;
          }
          return !b.ranges.some(o => t < o.to && t + duration > o.from);
        });
      } else {
        available = !occupiedRanges.some(o => t < o.to && t + duration > o.from);
      }

      if (available) {
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

// GET /api/booking/:slug/barber-busy?date=YYYY-MM-DD&time=HH:MM&duration=30
// Devuelve los IDs de barberos que ya tienen turno en ese slot
router.get('/:slug/barber-busy', async (req, res) => {
  const { date, time, duration } = req.query;
  if (!date || !time) return res.status(400).json({ error: 'Faltan parámetros' });
  try {
    const shop = await pool.query('SELECT id FROM shops WHERE booking_slug=$1', [req.params.slug]);
    if (!shop.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    const shopId = shop.rows[0].id;

    const dur = parseInt(duration) || 30;
    const [sh, sm] = time.split(':').map(Number);
    const slotFrom = sh * 60 + sm;
    const slotTo   = slotFrom + dur;

    const result = await pool.query(
      `SELECT DISTINCT barber_id FROM appointments
       WHERE shop_id=$1 AND date=$2 AND barber_id IS NOT NULL
         AND status NOT IN ('cancelled','noshow')
         AND NOT (status='waiting_sena' AND sena_expires_at IS NOT NULL AND sena_expires_at < NOW())
         AND (
           (EXTRACT(HOUR FROM time_start::time)*60 + EXTRACT(MINUTE FROM time_start::time)) < $4
           AND
           (EXTRACT(HOUR FROM COALESCE(time_end,time_start)::time)*60 + EXTRACT(MINUTE FROM COALESCE(time_end,time_start)::time) + CASE WHEN time_end IS NULL THEN 30 ELSE 0 END) > $3
         )`,
      [shopId, date, slotFrom, slotTo]
    );
    res.json({ busy: result.rows.map(r => r.barber_id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/booking/:slug/reserve — crear reserva
router.post('/:slug/reserve', async (req, res) => {
  const { client_name, client_phone, client_address, service_id, date, time_start, redeem_item_id, chosen_barber_id, is_member_booking, membership_id } = req.body;
  console.log(`[booking POST] slug=${req.params.slug} client=${client_name} date=${date} time=${time_start} phone=${client_phone||'null'}`);

  if (!client_name || !date || !time_start) {
    return res.status(400).json({ error: 'Nombre, fecha y hora son requeridos' });
  }

  // Fix #14: si viene redeem pero no hay teléfono, no se puede asociar cliente
  if (redeem_item_id && !client_phone) {
    return res.status(400).json({ error: 'Para canjear puntos necesitás ingresar tu número de WhatsApp.' });
  }

  try {
    const shop = await pool.query(
      'SELECT * FROM shops WHERE booking_slug = $1',
      [req.params.slug]
    );
    if (!shop.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    const shopData = shop.rows[0];

    // Si es sucursal sin seña propia, heredar sena_* del enterprise owner
    if (shopData.is_branch && shopData.parent_enterprise_id && !shopData.sena_enabled) {
      const ownerQ = await pool.query(
        'SELECT sena_enabled, sena_pct, sena_alias, sena_cbu FROM shops WHERE id=$1',
        [shopData.parent_enterprise_id]
      );
      if (ownerQ.rows.length && ownerQ.rows[0].sena_enabled) {
        shopData.sena_enabled = ownerQ.rows[0].sena_enabled;
        shopData.sena_pct     = ownerQ.rows[0].sena_pct;
        shopData.sena_alias   = ownerQ.rows[0].sena_alias;
        shopData.sena_cbu     = ownerQ.rows[0].sena_cbu;
      }
    }

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

    // Validar membresía activa con créditos disponibles (re-verificar en el servidor)
    if (is_member_booking && membership_id) {
      const mem = await pool.query(
        `SELECT id, credits_remaining, active FROM memberships WHERE id=$1 AND client_id IN (
           SELECT id FROM clients WHERE shop_id=$2
         )`,
        [parseInt(membership_id), shopData.id]
      );
      if (!mem.rows.length || !mem.rows[0].active) {
        return res.status(400).json({ error: 'La membresía no está activa.' });
      }
      if (mem.rows[0].credits_remaining !== null && mem.rows[0].credits_remaining <= 0) {
        return res.status(400).json({ error: 'Sin créditos disponibles en la membresía.' });
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
        duration    = svc.rows[0].duration_minutes || 30;
      }
    }

    // Calcular time_end
    const [h, m] = time_start.split(':').map(Number);
    const end = new Date(2000, 0, 1, h, m + duration);
    const time_end = `${String(end.getHours()).padStart(2,'0')}:${String(end.getMinutes()).padStart(2,'0')}`;

    // Determinar si se requiere seña
    const senaCbu = shopData.sena_cbu || shopData.sena_alias;
    const requiresSena = !is_member_booking && shopData.sena_enabled && svcPrice > 0 && senaCbu;
    const senaAmount = requiresSena ? Math.ceil(svcPrice * (shopData.sena_pct || 30) / 100) : 0;
    const senaExpiresAt = requiresSena ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null;
    const apptStatus = requiresSena ? 'waiting_sena' : 'pending';

    // Fix #1 + #2 + #6: todo dentro de una transacción con advisory lock por shop+fecha
    // para prevenir double-booking y double-redeem concurrente
    const pgClient = await pool.connect();
    let appt;
    let redeemInfo = null;
    let redeemItemId = null;
    let redeemPointsCost = 0;

    try {
      await pgClient.query('BEGIN');

      // Advisory lock por shop+date: serializa reservas concurrentes del mismo slot
      const dateInt = parseInt(date.replace(/-/g, '')) % 2147483647;
      await pgClient.query('SELECT pg_advisory_xact_lock($1, $2)', [shopData.id, dateInt]);

      // Verificar que el slot sigue disponible (dentro de la transacción con lock)
      // Si se eligió un barbero específico, solo verificar conflicto para ese barbero
      const conflictQuery = chosen_barber_id
        ? `SELECT id FROM appointments
           WHERE shop_id=$1 AND date=$2
             AND barber_id=$5
             AND status NOT IN ('cancelled','noshow')
             AND NOT (status = 'waiting_sena' AND sena_expires_at IS NOT NULL AND sena_expires_at < NOW())
             AND time_start < $3 AND time_end > $4`
        : `SELECT id FROM appointments
           WHERE shop_id=$1 AND date=$2
             AND status NOT IN ('cancelled','noshow')
             AND NOT (status = 'waiting_sena' AND sena_expires_at IS NOT NULL AND sena_expires_at < NOW())
             AND time_start < $3 AND time_end > $4`;
      const conflictParams = chosen_barber_id
        ? [shopData.id, date, time_end, time_start, parseInt(chosen_barber_id)]
        : [shopData.id, date, time_end, time_start];
      const conflict = await pgClient.query(conflictQuery, conflictParams);
      if (conflict.rows.length) {
        await pgClient.query('ROLLBACK');
        pgClient.release();
        return res.status(409).json({ error: 'Ese horario ya no está disponible. Por favor elegí otro.' });
      }

      // Buscar o crear cliente
      let clientId = null;
      if (client_phone) {
        const existing = await pgClient.query(
          'SELECT id FROM clients WHERE shop_id=$1 AND phone=$2',
          [shopData.id, client_phone]
        );
        if (existing.rows.length) {
          clientId = existing.rows[0].id;
          if (client_address) {
            await pgClient.query('UPDATE clients SET address=$1 WHERE id=$2', [client_address.trim(), clientId]);
          }
        } else {
          const newClient = await pgClient.query(
            'INSERT INTO clients (shop_id, name, phone, address) VALUES ($1,$2,$3,$4) RETURNING id',
            [shopData.id, client_name.trim(), client_phone.trim(), client_address?.trim() || null]
          );
          clientId = newClient.rows[0].id;
        }
      }

      // Fix #2 + #6: descontar puntos ANTES del INSERT del turno (atómico, dentro de transacción)
      if (redeem_item_id && clientId) {
        const item = await pgClient.query(
          'SELECT * FROM points_store WHERE id=$1 AND shop_id=$2 AND active=TRUE',
          [redeem_item_id, shopData.id]
        );
        if (item.rows.length) {
          const cost = item.rows[0].points_cost;
          const deducted = await pgClient.query(
            'UPDATE clients SET points = points - $1 WHERE id=$2 AND points >= $1 RETURNING points',
            [cost, clientId]
          );
          if (deducted.rows.length) {
            redeemInfo = item.rows[0].name;
            redeemItemId = item.rows[0].id;
            redeemPointsCost = cost;
          }
        }
      }

      // Asignar barbero
      let assignedBarberId = null;
      let assignedBarberCommission = 0;
      try {
        // Para sucursales, buscar barberos bajo el enterprise owner
        const barberShopId = (shopData.is_branch && shopData.parent_enterprise_id)
          ? shopData.parent_enterprise_id
          : shopData.id;

        if (chosen_barber_id && shopData.allow_barber_choice) {
          // Elección manual: validar que el barbero trabaja en esa fecha/hora
          const chosenId = parseInt(chosen_barber_id);
          const barberData = await pgClient.query(
            'SELECT id, barber_commission_pct, barber_schedule FROM shops WHERE id=$1 AND parent_shop_id=$2 AND is_barber=TRUE',
            [chosenId, barberShopId]
          );
          if (!barberData.rows.length) {
            await pgClient.query('ROLLBACK');
            pgClient.release();
            return res.status(400).json({ error: 'Barbero no encontrado' });
          }
          const chosenBarber = barberData.rows[0];
          if (!isBarberAvailable(chosenBarber.barber_schedule, date, time_start)) {
            await pgClient.query('ROLLBACK');
            pgClient.release();
            return res.status(400).json({ error: 'El barbero seleccionado no trabaja en esa fecha/horario' });
          }
          assignedBarberId = chosenId;
          assignedBarberCommission = parseInt(chosenBarber.barber_commission_pct) || 50;
        } else {
          // Auto-assign: solo barberos que trabajan en esa fecha/hora
          const barbers = await pgClient.query(
            'SELECT id, barber_commission_pct, barber_schedule FROM shops WHERE parent_shop_id=$1 AND is_barber=TRUE',
            [barberShopId]
          );
          const availableBarbers = barbers.rows.filter(b =>
            isBarberAvailable(b.barber_schedule, date, time_start)
          );
          if (availableBarbers.length) {
            const counts = await pgClient.query(
              `SELECT barber_id, COUNT(*) as total FROM appointments
               WHERE shop_id=$1 AND date=$2 AND barber_id IS NOT NULL GROUP BY barber_id`,
              [shopData.id, date]
            );
            const countMap = {};
            counts.rows.forEach(r => { countMap[r.barber_id] = parseInt(r.total); });
            let minCount = Infinity;
            for (const b of availableBarbers) {
              const c = countMap[b.id] || 0;
              if (c < minCount) { minCount = c; assignedBarberId = b.id; assignedBarberCommission = parseInt(b.barber_commission_pct) || 50; }
            }
          }
        }
      } catch(e) { console.error('autoAssign booking error:', e.message); }

      // Crear turno (con redeemInfo ya calculado)
      const apptResult = await pgClient.query(
        `INSERT INTO appointments
           (shop_id, client_id, client_name, service_id, service_name, price, cost, date, time_start, time_end, status, redeem_info, barber_id, commission_pct, member_booking, membership_id, payment_method, sena_amount, sena_status, sena_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [shopData.id, clientId, client_name.trim(), service_id||null, svcName,
         svcPrice, svcCost, date, time_start, time_end, apptStatus, redeemInfo,
         assignedBarberId, assignedBarberCommission,
         is_member_booking ? true : false,
         (is_member_booking && membership_id) ? parseInt(membership_id) : null,
         is_member_booking ? 'membership' : null,
         senaAmount, requiresSena ? 'pending' : null, senaExpiresAt]
      );
      appt = apptResult;

      // Fix #20: registrar canje dentro de la transacción con ON CONFLICT para idempotencia
      if (redeemInfo && redeemItemId && clientId) {
        await pgClient.query(
          `INSERT INTO points_redemptions (shop_id, client_id, item_id, item_name, points_used, status)
           VALUES ($1,$2,$3,$4,$5,'pending')
           ON CONFLICT DO NOTHING`,
          [shopData.id, clientId, redeemItemId, redeemInfo, redeemPointsCost]
        );
      }

      await pgClient.query('COMMIT');
    } catch(txErr) {
      await pgClient.query('ROLLBACK');
      pgClient.release();
      throw txErr;
    }
    pgClient.release();

    const dateFormatted = new Date(date + 'T12:00:00').toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });

    // Notificar por WhatsApp — fire-and-forget para no bloquear la respuesta HTTP
    // Determinar shopId para WPP: usar enterprise owner si la sucursal no tiene WPP propio
    const wpp = require('../services/whatsapp');
    const wppShopId = shopData.parent_enterprise_id || shopData.id;
    console.log(`[booking] turno creado id=${appt.rows[0]?.id} requiresSena=${!!requiresSena} senaCbu=${senaCbu||'null'} wpp_connected=${shopData.wpp_connected} wppShopId=${wppShopId} client_phone=${client_phone||'null'}`);

    if (requiresSena) {
      if (client_phone) {
        (async () => {
          try {
            const { generateMessage } = require('../services/ai');
            let msgCliente = await generateMessage(shopData.id, 'sena_instrucciones', {
              clientName: client_name,
              shopName: shopData.name,
              senaAmount,
              alias: senaCbu,
              minutesLimit: 60,
            });
            if (!msgCliente) msgCliente = `✂️ *${shopData.name}* — Reserva recibida\n\n👤 Hola ${client_name}! Tu turno del ${dateFormatted} a las *${time_start}* quedó *pendiente de seña*.\n\n💸 Para confirmar, enviá una seña de *$${senaAmount.toLocaleString('es-AR')}* al CVU/CBU:\n\n📲 *${senaCbu}*\n\n⏰ Tenés *60 minutos*. Si no se recibe, el turno queda libre.`;
            await wpp.sendText(wppShopId, client_phone, msgCliente);
            console.log(`[booking] WPP seña enviada OK a ${client_phone} via shop ${wppShopId}`);
          } catch(e) { console.error('[booking] WPP seña error:', e.message); }
        })();
      } else {
        console.log(`[booking] sin client_phone — no se envía WPP seña`);
      }
    } else {
      // Notificar al barbero
      if (shopData.phone) {
        const msg = `🔔 *Nueva reserva online*\n\n👤 ${client_name}${client_phone ? '\n📱 ' + client_phone : ''}\n✂️ ${svcName || 'Sin servicio'}\n📅 ${dateFormatted} a las *${time_start}*`;
        try { await wpp.sendText(wppShopId, shopData.phone, msg); } catch(e) { console.error('Error notificando al barbero:', e.message); }
      }
      // Notificar al cliente que su reserva fue recibida
      if (client_phone) {
        try {
          const { generateMessage } = require('../services/ai');
          let msg = await generateMessage(shopData.id, 'reserva_recibida', {
            clientName: client_name,
            shopName: shopData.name,
            fecha: dateFormatted,
            hora: time_start,
            serviceName: svcName || null,
          });
          if (!msg) msg = `✅ ¡Hola ${client_name}! Tu turno en ${shopData.name} está confirmado para el ${dateFormatted} a las ${time_start}${svcName ? ` (${svcName})` : ''}. ¡Te esperamos! ✂️`;
          await wpp.sendText(wppShopId, client_phone, msg);
        } catch (e) {
          console.error('Error notificando al cliente:', e.message);
        }
      }
    }

    const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });
    res.status(201).json({
      ok: true,
      redeem: redeemInfo,
      requires_sena: requiresSena,
      sena_amount: requiresSena ? senaAmount : null,
      sena_alias: requiresSena ? senaCbu : null,
      message: requiresSena
        ? `Tu reserva fue recibida. Para confirmarla, enviá una seña de $${senaAmount.toLocaleString('es-AR')} al CBU/CVU ${senaCbu} en los próximos 60 minutos.`
        : `¡Turno confirmado! Te esperamos el ${dateLabel} a las ${time_start} en ${shopData.name}.`,
      appointment: appt.rows[0]
    });
  } catch (e) {
    console.error('Booking error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
