const router    = require('express').Router();
const rateLimit = require('express-rate-limit');
const pool      = require('../db/pool');
const wpp       = require('../services/whatsapp');
const { phoneKey, phoneMatchSql } = require('../services/phoneMatch');

// De qué cuenta salen los barberos de una página de reservas. Los barberos de una sucursal
// están cargados en la sucursal; solo si la sucursal no tiene ninguno se usan los del dueño
// enterprise. (Antes las sucursales siempre buscaban en el enterprise, que no tiene barberos:
// la página no mostraba el equipo, no se podía elegir barbero ni se asignaba ninguno.)
async function barberOwnerId(db, shop) {
  if (!(shop.is_branch && shop.parent_enterprise_id)) return shop.id;
  const own = await db.query('SELECT 1 FROM shops WHERE parent_shop_id=$1 AND is_barber=TRUE LIMIT 1', [shop.id]);
  return own.rows.length ? shop.id : shop.parent_enterprise_id;
}

// Rate limits para endpoints públicos sin auth (bots scraping / abuso)
const publicGetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,                 // 60 lecturas/min por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Esperá un momento.' },
});

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
router.get('/:slug', publicGetLimiter, async (req, res) => {
  try {
    const shop = await pool.query(
      `SELECT id, name, city, address, phone, wpp_connected, schedule, home_service, allow_barber_choice, filo_plan, closed_days, is_enterprise_owner, enterprise_shared_wpp, sena_enabled, sena_pct, sena_alias, sena_cbu, is_branch, parent_enterprise_id, profile_photo_url, banner_photo_url, social_links
       FROM shops WHERE booking_slug = $1
        AND NOT (COALESCE(is_branch, FALSE) AND subscription_status = 'cancelled')`,
      [req.params.slug]
    );
    if (!shop.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    const shopData = shop.rows[0];

    // Si es enterprise owner con WPP compartido → devolver lista de sucursales para que el cliente elija
    if (shopData.is_enterprise_owner && shopData.enterprise_shared_wpp) {
      const branches = await pool.query(
        `SELECT id, name, branch_label, city, address, booking_slug
         FROM shops WHERE parent_enterprise_id=$1 AND is_branch=TRUE
           AND subscription_status IS DISTINCT FROM 'cancelled'
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
    const barberShopId = await barberOwnerId(pool, shopData);
    if (!shopData.allow_barber_choice && shopData.is_branch && shopData.parent_enterprise_id) {
      const ownerChoice = await pool.query(
        'SELECT allow_barber_choice FROM shops WHERE id=$1', [shopData.parent_enterprise_id]
      );
      if (ownerChoice.rows[0]?.allow_barber_choice) shopData.allow_barber_choice = true;
    }

    let barbers = [];
    if (shopData.allow_barber_choice) {
      const barbersQ = await pool.query(
        'SELECT id, name, barber_color, barber_schedule, profile_photo_url FROM shops WHERE parent_shop_id=$1 AND is_barber=TRUE ORDER BY name',
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

    // Bonus de puntos por elegir "cualquier profesional" (solo si el cliente puede elegir barbero)
    try {
      const cfg = await require('../services/anyBarberBonus').getBonusConfig(shopData.id);
      shopData.any_barber_bonus_pct = (cfg.enabled && shopData.allow_barber_choice && barbers && barbers.length > 1) ? cfg.pct : 0;
    } catch (_) { shopData.any_barber_bonus_pct = 0; }
    res.json({ shop: shopData, services: services.rows, barbers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/booking/:slug/team — lista pública de barberos con sus fotos
router.get('/:slug/team', publicGetLimiter, async (req, res) => {
  try {
    const shop = await pool.query(
      `SELECT id, is_branch, parent_enterprise_id
         FROM shops WHERE booking_slug=$1`,
      [req.params.slug]
    );
    if (!shop.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    const shopData = shop.rows[0];
    const barberShopId = await barberOwnerId(pool, shopData);
    const q = await pool.query(
      `SELECT id, name, barber_color, profile_photo_url, work_photos
         FROM shops
        WHERE parent_shop_id=$1 AND is_barber=TRUE
        ORDER BY name`,
      [barberShopId]
    );
    res.json({ barbers: q.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/booking/:slug/member-verify?phone=XXX — verifica membresía activa
router.get('/:slug/member-verify', publicGetLimiter, async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'Teléfono requerido' });

  try {
    const shop = await pool.query('SELECT id FROM shops WHERE booking_slug=$1', [req.params.slug]);
    if (!shop.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    const shopId = shop.rows[0].id;

    const key = phoneKey(phone);
    const client = key ? await pool.query(
      `SELECT id, name, phone FROM clients WHERE shop_id=$1 AND ${phoneMatchSql('phone', '$2')}
        ORDER BY total_visits DESC NULLS LAST, id LIMIT 1`,
      [shopId, key]
    ) : { rows: [] };
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
router.get('/:slug/available', publicGetLimiter, async (req, res) => {
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
      'SELECT schedule, closed_days, allow_barber_choice, is_branch, parent_enterprise_id, slot_interval_minutes FROM shops WHERE id=$1',
      [shopId]
    );
    const slotInterval = parseInt(shopFull.rows[0]?.slot_interval_minutes) || 30;
    const scheduleRaw = shopFull.rows[0]?.schedule;
    const schedule = scheduleRaw ? (() => { try { return JSON.parse(scheduleRaw); } catch { return null; } })() : null;

    // Verificar si el día es un día cerrado extraordinario
    const closedDaysRaw = shopFull.rows[0]?.closed_days;
    const closedDays = closedDaysRaw ? (() => { try { return JSON.parse(closedDaysRaw); } catch { return []; } })() : [];
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
    const barberShopId = await barberOwnerId(pool, { id: shopId, is_branch: shopRow.is_branch, parent_enterprise_id: shopRow.parent_enterprise_id });
    if (!allowBarberChoice && shopRow.is_branch && shopRow.parent_enterprise_id) {
      const ownerChoice = await pool.query('SELECT allow_barber_choice FROM shops WHERE id=$1', [shopRow.parent_enterprise_id]);
      allowBarberChoice = ownerChoice.rows[0]?.allow_barber_choice || false;
    }

    let barberMap = null; // { barberId -> [occupiedRanges] }
    let unassignedRanges = [];
    // Con barberos, la disponibilidad es por barbero aunque el cliente no pueda elegir:
    // cada barbero libre puede tomar un turno en el mismo horario (antes era 1 por horario en todo el local)
    {
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
          // Turnos sin barbero asignado (p.ej. los atiende el dueño): ocupan un lugar cada uno
          const unassignedQ = await pool.query(
            `SELECT time_start, time_end FROM appointments
             WHERE shop_id=$1 AND date=$2 AND barber_id IS NULL
               AND status NOT IN ('cancelled','noshow')
               AND NOT (status = 'waiting_sena' AND sena_expires_at IS NOT NULL AND sena_expires_at < NOW())`,
            [shopId, date]
          );
          unassignedRanges = unassignedQ.rows.map(a => {
            const [sh, sm] = String(a.time_start).split(':').map(Number);
            const [eh, em] = String(a.time_end || '00:00').split(':').map(Number);
            const endMin = eh * 60 + em;
            return { from: sh * 60 + sm, to: endMin > 0 ? endMin : sh * 60 + sm + 30 };
          });
          for (const a of occupiedByBarber.rows) {
            if (!barberMap[a.barber_id]) continue;
            const [sh, sm] = String(a.time_start).split(':').map(Number);
            const [eh, em] = String(a.time_end || '00:00').split(':').map(Number);
            const endMin = eh * 60 + em;
            barberMap[a.barber_id].ranges.push({ from: sh * 60 + sm, to: endMin > 0 ? endMin : sh * 60 + sm + 30 });
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
        const endMin = eh * 60 + em;
        return { from: sh * 60 + sm, to: endMin > 0 ? endMin : sh * 60 + sm + 30 };
      });
    }

    const slots = [];
    const AR_OFFSET_MS = 3 * 60 * 60 * 1000;
    const nowAR = new Date(Date.now() - AR_OFFSET_MS);
    const todayAR = nowAR.toISOString().split('T')[0];

    // Construir lista de slots válidos a partir de todas las franjas horarias
    const validTimes = [];
    for (const range of workRanges) {
      for (let t = range.from; t + duration <= range.to; t += slotInterval) {
        validTimes.push(t);
      }
    }

    for (const t of validTimes) {
      if (date === todayAR) {
        const nowMinsAR = nowAR.getUTCHours() * 60 + nowAR.getUTCMinutes();
        if (t <= nowMinsAR) continue;
      }

      let available;
      if (barberMap) {
        // Con barberos: slot disponible si al menos 1 barbero que trabaja ese horario tiene el slot libre
        const DAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];
        const bsDayKey = DAY_KEYS[dayOfWeek];
        const slotHH = String(Math.floor(t / 60)).padStart(2, '0');
        const slotMM = String(t % 60).padStart(2, '0');
        const slotTime = `${slotHH}:${slotMM}`;
        const freeCount = Object.values(barberMap).filter(b => {
          // Verificar que el barbero trabaja en este slot específico
          if (b.schedule) {
            const cfg = b.schedule[bsDayKey];
            if (!cfg || !cfg.active) return false;
            if (cfg.from && cfg.to && (slotTime < cfg.from || slotTime >= cfg.to)) return false;
          }
          return !b.ranges.some(o => t < o.to && t + duration > o.from);
        }).length;
        const unassignedHere = unassignedRanges.filter(o => t < o.to && t + duration > o.from).length;
        available = freeCount > unassignedHere;
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
router.get('/:slug/barber-busy', publicGetLimiter, async (req, res) => {
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

// GET /api/booking/:slug/barber-counts?date=YYYY-MM-DD
// Devuelve cuántos turnos tiene cada barbero ese día (para elegir el menos cargado)
router.get('/:slug/barber-counts', publicGetLimiter, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Falta date' });
  try {
    const shop = await pool.query('SELECT id FROM shops WHERE booking_slug=$1', [req.params.slug]);
    if (!shop.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    const shopId = shop.rows[0].id;
    const result = await pool.query(
      `SELECT barber_id, COUNT(*) as count FROM appointments
       WHERE shop_id=$1 AND date=$2 AND barber_id IS NOT NULL
         AND status NOT IN ('cancelled','noshow')
       GROUP BY barber_id`,
      [shopId, date]
    );
    const counts = {};
    for (const row of result.rows) counts[row.barber_id] = parseInt(row.count);
    res.json(counts);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Rate limit por IP+slug para /reserve: máx 10 reservas / 10 min
const _reserveAttempts = new Map();
const _reserveCleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _reserveAttempts) if (now > v.resetAt) _reserveAttempts.delete(k);
}, 15 * 60 * 1000);
if (typeof _reserveCleanup.unref === 'function') _reserveCleanup.unref();
function reserveRateLimit(req, res, next) {
  // req.ip respeta 'trust proxy' y no se puede falsificar con un header X-Forwarded-For propio
  const ip = (req.ip || 'unknown').toString();
  const key = `${ip}:${req.params.slug}`;
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const MAX = 10;
  let e = _reserveAttempts.get(key);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + windowMs };
  e.count++;
  _reserveAttempts.set(key, e);
  if (e.count > MAX) {
    res.set('Retry-After', String(Math.ceil((e.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'Demasiadas reservas. Esperá unos minutos.' });
  }
  next();
}

// POST /api/booking/:slug/reserve — crear reserva
router.post('/:slug/reserve', reserveRateLimit, async (req, res) => {
  const { service_id, date, time_start, redeem_item_id, chosen_barber_id, is_member_booking, membership_id } = req.body;
  // El cliente eligió "cualquier profesional": lo asigna el sistema (al menos cargado) y puede sumar bonus
  const anyBarber = req.body.any_barber === true;
  // Datos públicos: sin < > (evita HTML inyectado en el CRM del dueño) y con largo acotado
  const cleanTxt = (v, n) => (v == null ? '' : String(v)).replace(/[<>]/g, '').trim().slice(0, n);
  const client_name    = cleanTxt(req.body.client_name, 100);
  const client_phone   = cleanTxt(req.body.client_phone, 30);
  const client_address = cleanTxt(req.body.client_address, 200);
  console.log(`[booking POST] slug=${req.params.slug} client=${client_name} date=${date} time=${time_start} phone=${client_phone||'null'}`);

  if (!client_name || !date || !time_start) {
    return res.status(400).json({ error: 'Nombre, fecha y hora son requeridos' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Formato de fecha inválido (YYYY-MM-DD)' });
  }
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(time_start)) {
    return res.status(400).json({ error: 'Formato de hora inválido (HH:MM)' });
  }

  // Fix #14: si viene redeem pero no hay teléfono, no se puede asociar cliente
  if (redeem_item_id && !client_phone) {
    return res.status(400).json({ error: 'Para canjear puntos necesitás ingresar tu número de WhatsApp.' });
  }

  try {
    const shop = await pool.query(
      // Una sucursal desactivada no toma turnos (aunque alguien llame directo a la API)
      `SELECT * FROM shops WHERE booking_slug = $1
         AND NOT (COALESCE(is_branch, FALSE) AND subscription_status = 'cancelled')`,
      [req.params.slug]
    );
    if (!shop.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    const shopData = shop.rows[0];
    // Sucursal: hereda la elección de barbero del dueño enterprise (igual que la página de reserva)
    if (!shopData.allow_barber_choice && shopData.is_branch && shopData.parent_enterprise_id) {
      const oc = await pool.query('SELECT allow_barber_choice FROM shops WHERE id=$1', [shopData.parent_enterprise_id]);
      if (oc.rows[0]?.allow_barber_choice) shopData.allow_barber_choice = true;
    }

    // No se puede reservar en un día que ya pasó (según la zona horaria del local)
    {
      const { getShopTz, shopDate } = require('../db/shopTz');
      const todayLocal = shopDate(await getShopTz(shopData.id));
      if (date < todayLocal) {
        return res.status(400).json({ error: 'No se puede reservar en una fecha pasada.' });
      }
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

    // Verificar día cerrado extraordinario
    if (shopData.closed_days) {
      const closedDays = (() => { try { return JSON.parse(shopData.closed_days); } catch { return []; } })();
      if (closedDays.includes(date)) {
        return res.status(400).json({ error: 'La barbería no atiende ese día (día no laborable).' });
      }
    }

    // Verificar que el día esté habilitado en el horario
    if (shopData.schedule) {
      const schedule = (() => { try { return JSON.parse(shopData.schedule); } catch { return {}; } })();
      const dayNames = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
      const dayKey = dayNames[new Date(date + 'T12:00:00').getDay()];
      if (!schedule[dayKey]?.active) {
        return res.status(400).json({ error: 'La barbería no atiende ese día.' });
      }
    }

    // Validar membresía activa + que el teléfono del body sea el dueño de la membresía
    if (is_member_booking && membership_id) {
      if (!client_phone) return res.status(400).json({ error: 'Para reservar con membresía necesitás tu número.' });
      const normPhone = String(client_phone).replace(/\D/g, '').slice(-10);
      const mem = await pool.query(
        `SELECT m.id, m.credits_total, m.credits_used, m.active, c.phone
         FROM memberships m
         JOIN clients c ON c.id = m.client_id
         WHERE m.id=$1 AND c.shop_id=$2`,
        [parseInt(membership_id), shopData.id]
      );
      if (!mem.rows.length || !mem.rows[0].active) {
        return res.status(400).json({ error: 'La membresía no está activa.' });
      }
      const m = mem.rows[0];
      const memPhone = String(m.phone || '').replace(/\D/g, '').slice(-10);
      if (!memPhone || memPhone !== normPhone) {
        return res.status(403).json({ error: 'Esta membresía no te pertenece.' });
      }
      const remaining = m.credits_total !== null ? (parseInt(m.credits_total) - parseInt(m.credits_used || 0)) : null;
      if (remaining !== null && remaining <= 0) {
        return res.status(400).json({ error: 'Sin créditos disponibles en la membresía.' });
      }
    }

    // Resolver servicio
    let svcName = null, svcPrice = 0, svcCost = 0, duration = 30;
    let svcCommissionPct = null; // comisión custom del servicio (null = usar la del barbero)
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
        if (svc.rows[0].commission_pct !== null && svc.rows[0].commission_pct !== undefined) {
          svcCommissionPct = parseInt(svc.rows[0].commission_pct);
        }
      }
    }

    // Calcular time_end
    const [h, m] = time_start.split(':').map(Number);
    const end = new Date(2000, 0, 1, h, m + duration);
    const time_end = `${String(end.getHours()).padStart(2,'0')}:${String(end.getMinutes()).padStart(2,'0')}`;

    // Determinar si se requiere seña
    const senaCbu = shopData.sena_cbu || shopData.sena_alias;
    const requiresSena = !is_member_booking && shopData.sena_enabled && svcPrice > 0 && senaCbu;
    const senaPct = (shopData.sena_pct !== null && shopData.sena_pct !== undefined) ? parseFloat(shopData.sena_pct) : 30;
    const senaAmount = requiresSena ? Math.ceil(svcPrice * senaPct / 100) : 0;
    const senaExpiresAt = requiresSena ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null;
    const apptStatus = requiresSena ? 'waiting_sena' : 'pending';

    // Fix #1 + #2 + #6: todo dentro de una transacción con advisory lock por shop+fecha
    // para prevenir double-booking y double-redeem concurrente
    if (anyBarber) await require('../services/anyBarberBonus').ensureBonusSchema();
    const pgClient = await pool.connect();
    let appt;
    let redeemInfo = null;
    let redeemItemId = null;
    let redeemPointsCost = 0;

    try {
      await pgClient.query('BEGIN');

      // Advisory lock por shop+date: serializa reservas concurrentes del mismo slot.
      // Usamos hash estable (sin colisión por fechas) basado en md5 → int32
      const dateHash = parseInt(require('crypto').createHash('md5').update(date).digest('hex').slice(0, 8), 16) & 0x7fffffff;
      await pgClient.query('SELECT pg_advisory_xact_lock($1, $2)', [shopData.id, dateHash]);

      // Verificar que el slot sigue disponible (dentro de la transacción con lock)
      // Si se eligió un barbero específico, solo verificar conflicto para ese barbero
      // "Cualquier profesional" con barberos en el local: el choque se revisa por barbero más abajo
      // (antes un solo barbero ocupado bloqueaba el horario aunque otros estuvieran libres)
      const wantsAny = !chosen_barber_id || anyBarber;
      let skipGlobalConflict = false;
      if (wantsAny) {
        const bsId = await barberOwnerId(pgClient, shopData);
        const nb = await pgClient.query('SELECT COUNT(*)::int AS n FROM shops WHERE parent_shop_id=$1 AND is_barber=TRUE', [bsId]);
        skipGlobalConflict = nb.rows[0].n > 0;
      }
      const conflictQuery = (chosen_barber_id && !anyBarber)
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
      const conflictParams = (chosen_barber_id && !anyBarber)
        ? [shopData.id, date, time_end, time_start, parseInt(chosen_barber_id)]
        : [shopData.id, date, time_end, time_start];
      const conflict = skipGlobalConflict ? { rows: [] } : await pgClient.query(conflictQuery, conflictParams);
      if (conflict.rows.length) {
        await pgClient.query('ROLLBACK');
        pgClient.release();
        return res.status(409).json({ error: 'Ese horario ya no está disponible. Por favor elegí otro.' });
      }

      // Buscar o crear cliente
      let clientId = null;
      if (client_phone) {
        // Mismo cliente aunque haya escrito el número distinto que la última vez (con 54, 9, guiones…)
        const key = phoneKey(client_phone);
        const existing = key ? await pgClient.query(
          `SELECT id FROM clients WHERE shop_id=$1 AND ${phoneMatchSql('phone', '$2')}
            ORDER BY total_visits DESC NULLS LAST, id LIMIT 1`,
          [shopData.id, key]
        ) : { rows: [] };
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
        // Barberos de la sucursal (o del enterprise si la sucursal no tiene propios)
        const barberShopId = await barberOwnerId(pgClient, shopData);

        if (chosen_barber_id && shopData.allow_barber_choice && !anyBarber) {
          // Elección manual: validar que el barbero trabaja en esa fecha/hora
          const chosenId = parseInt(chosen_barber_id);
          if (Number.isNaN(chosenId)) {
            await pgClient.query('ROLLBACK');
            pgClient.release();
            return res.status(400).json({ error: 'ID de barbero inválido' });
          }
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
          // Auto-assign: solo barberos que trabajan en esa fecha/hora Y están libres en ese slot
          const barbers = await pgClient.query(
            'SELECT id, barber_commission_pct, barber_schedule FROM shops WHERE parent_shop_id=$1 AND is_barber=TRUE',
            [barberShopId]
          );
          const availableBarbers = barbers.rows.filter(b =>
            isBarberAvailable(b.barber_schedule, date, time_start)
          );
          if (availableBarbers.length) {
            // Filtrar los que YA tienen un turno pisándose en ese horario (anti double-booking)
            const busy = await pgClient.query(
              `SELECT DISTINCT barber_id FROM appointments
                WHERE shop_id=$1 AND date=$2 AND barber_id IS NOT NULL
                  AND status NOT IN ('cancelled','noshow')
                  AND time_start < $3 AND time_end > $4`,
              [shopData.id, date, time_end, time_start]
            );
            const busySet = new Set(busy.rows.map(r => r.barber_id));
            const freeBarbers = availableBarbers.filter(b => !busySet.has(b.id));
            const unassignedQ = await pgClient.query(
              `SELECT COUNT(*)::int AS n FROM appointments
                WHERE shop_id=$1 AND date=$2 AND barber_id IS NULL
                  AND status NOT IN ('cancelled','noshow')
                  AND NOT (status = 'waiting_sena' AND sena_expires_at IS NOT NULL AND sena_expires_at < NOW())
                  AND time_start < $3 AND time_end > $4`,
              [shopData.id, date, time_end, time_start]
            );
            if (freeBarbers.length <= unassignedQ.rows[0].n) {
              await pgClient.query('ROLLBACK');
              pgClient.release();
              return res.status(409).json({ error: 'Ningún barbero está libre en ese horario. Elegí otro.' });
            }
            // El barbero libre con menos trabajo ese día (sin contar cancelados / no vino).
            // Empate: el que tiene menos en la semana; si siguen empatados, al azar (no siempre el mismo).
            const counts = await pgClient.query(
              `SELECT barber_id,
                      COUNT(*) FILTER (WHERE date = $2::date) AS day_total,
                      COUNT(*) AS week_total
                 FROM appointments
                WHERE shop_id=$1 AND barber_id IS NOT NULL
                  AND status NOT IN ('cancelled','noshow')
                  AND date BETWEEN $2::date - 6 AND $2::date
                GROUP BY barber_id`,
              [shopData.id, date]
            );
            const dayMap = {}, weekMap = {};
            counts.rows.forEach(r => { dayMap[r.barber_id] = parseInt(r.day_total); weekMap[r.barber_id] = parseInt(r.week_total); });
            const load = (b) => [dayMap[b.id] || 0, weekMap[b.id] || 0];
            const minDay  = Math.min(...freeBarbers.map(b => load(b)[0]));
            const byDay   = freeBarbers.filter(b => load(b)[0] === minDay);
            const minWeek = Math.min(...byDay.map(b => load(b)[1]));
            const least   = byDay.filter(b => load(b)[1] === minWeek);
            // Si la página ya le mostró al cliente uno de los menos cargados, se respeta ese
            const shown = anyBarber && chosen_barber_id ? least.find(b => b.id === parseInt(chosen_barber_id)) : null;
            const pick = shown || least[Math.floor(Math.random() * least.length)];
            assignedBarberId = pick.id;
            assignedBarberCommission = parseInt(pick.barber_commission_pct) || 50;
          }
        }
      } catch(e) { console.error('autoAssign booking error:', e.message); }

      // Sin choque global ("cualquiera" con barberos), el turno tiene que quedar con un barbero libre
      if (skipGlobalConflict && !assignedBarberId) {
        await pgClient.query('ROLLBACK');
        pgClient.release();
        return res.status(409).json({ error: 'Ningún profesional está libre en ese horario. Elegí otro.' });
      }

      // Prioridad comisión: servicio custom > barbero > 0 (sin barbero asignado)
      if (assignedBarberId && svcCommissionPct !== null) {
        assignedBarberCommission = svcCommissionPct;
      }

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
      // Marcar el turno pedido con "cualquier profesional" (suma el bonus de puntos al cobrarlo)
      if (anyBarber && shopData.allow_barber_choice && assignedBarberId) {
        await pgClient.query('UPDATE appointments SET any_barber=TRUE WHERE id=$1', [appt.rows[0].id]);
        appt.rows[0].any_barber = true;
      }

      // Fix #20: registrar canje dentro de la transacción con ON CONFLICT para idempotencia.
      // Link al appointment para rollback automático si se cancela.
      if (redeemInfo && redeemItemId && clientId) {
        await pgClient.query(
          `INSERT INTO points_redemptions (shop_id, client_id, item_id, item_name, points_used, status, appointment_id)
           VALUES ($1,$2,$3,$4,$5,'pending',$6)
           ON CONFLICT DO NOTHING`,
          [shopData.id, clientId, redeemItemId, redeemInfo, redeemPointsCost, appt.rows[0].id]
        );
      }

      await pgClient.query('COMMIT');
    } catch(txErr) {
      await pgClient.query('ROLLBACK');
      pgClient.release();
      throw txErr;
    }
    pgClient.release();

    const _apptRow = appt.rows[0] || {};
    const _barberId = _apptRow.barber_id || null;

    // Emitir evento SSE en vivo: dueño/sucursal + enterprise owner ven la reserva al toque
    try {
      const sse = require('../services/sse');
      sse.emitWithParent(shopData.id, shopData.parent_enterprise_id, 'appointment.created', {
        id: _apptRow.id,
        shop_id: shopData.id,
        client_name,
        service_name: svcName,
        date, time_start, time_end,
        barber_id: _barberId,
        status: apptStatus,
        source: 'online',
      });
    } catch(sseErr) { console.warn('[booking] sse err:', sseErr.message); }

    // Notificación in-app: dueño + barbero asignado (si hay)
    try {
      const notif = require('../services/notifications');
      const recipients = [shopData.id];
      if (_barberId) recipients.push(_barberId);
      const timeStr = (time_start || '').slice(0,5);
      console.log(`[booking] disparando notif a recipients=${JSON.stringify(recipients)}`);
      await notif.createMany(recipients, {
        shopId: shopData.id,
        type: 'appointment.created',
        title: 'Nueva reserva online',
        body:  [client_name, svcName, `${date} ${timeStr}`].filter(Boolean).join(' · '),
        icon:  '📅',
        link:  '/app#agenda',
      });
    } catch(notifErr) {
      console.error('[booking] notif error:', notifErr.message, notifErr.stack);
    }

    const dateFormatted = new Date(date + 'T12:00:00').toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });

    // Notificar por WhatsApp — fire-and-forget para no bloquear la respuesta HTTP
    // Sale del WhatsApp del local; si es una sucursal sin WhatsApp propio (o con WhatsApp
    // compartido), sendText usa el del dueño enterprise
    const wpp = require('../services/whatsapp');
    const wppShopId = shopData.id;
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
      // Notificaciones por WhatsApp en segundo plano: con el ritmo anti-baneo cada envío
      // espera su turno, y el cliente que reserva no tiene que esperarlo.
      (async () => {
      // Notificar al barbero
      if (shopData.phone) {
        const msg = `🔔 *Nueva reserva online*\n\n👤 ${client_name}${client_phone ? '\n📱 ' + client_phone : ''}\n✂️ ${svcName || 'Sin servicio'}\n📅 ${dateFormatted} a las *${time_start}*`;
        // Apagado por defecto: suele ser el mismo número conectado (mensaje a sí mismo) y la reserva
        // ya llega como notificación en FILO. Se puede activar en Configuración → WhatsApp.
        try { await wpp.sendText(wppShopId, shopData.phone, msg, { category: 'owner_notice' }); } catch(e) { if (e.code !== 'AUTO_DISABLED') console.error('Error notificando al barbero:', e.message); }
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
          if (!msg) msg = require('../services/msgVariants').bookingText({ nombre: client_name, shop: shopData.name, fecha: dateFormatted, hora: time_start, servicio: svcName || null });
          await wpp.sendText(wppShopId, client_phone, msg, { category: 'booking_confirm' });
        } catch (e) {
          if (e.code !== 'AUTO_DISABLED') console.error('Error notificando al cliente:', e.message);
        }
      }
      })().catch(() => {});
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
