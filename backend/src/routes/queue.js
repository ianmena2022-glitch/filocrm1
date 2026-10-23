const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const { getShopTz, shopDate, shopTime } = require('../db/shopTz');
const { normalizeDebtMethod } = require('../services/cashMath');
const crypto  = require('crypto');
const rateLimit = require('express-rate-limit');

// La fila pública no tiene login: se limita cuántas veces se puede anotar una misma conexión
// (evita que alguien llene la fila con nombres falsos y teléfonos ajenos).
const joinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de anotarse. Esperá unos minutos.' },
});
const MAX_WAITING_PER_SHOP = 80;

// Cada lugar en la fila tiene una clave privada que solo conoce el celular que se anotó:
// sin ella no se puede ver el nombre ni sacar a nadie de la fila.
let _queueTokenCol = null;
function ensureQueueTokenColumn() {
  if (!_queueTokenCol) {
    _queueTokenCol = pool.query('ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS public_token VARCHAR(40)')
      .catch(e => { _queueTokenCol = null; console.warn('[QUEUE] public_token:', e.message); });
  }
  return _queueTokenCol;
}
const tokenOk = (entryToken, given) => !entryToken || (typeof given === 'string' && given === entryToken);

// El vínculo cliente de la fila → turno se crea solo si la columna todavía no existe (idempotente)
let _queueApptCol = null;
function ensureQueueApptColumn() {
  if (!_queueApptCol) {
    _queueApptCol = pool.query('ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS appointment_id INT REFERENCES appointments(id) ON DELETE SET NULL')
      .catch(e => { _queueApptCol = null; console.warn('[QUEUE] appointment_id:', e.message); });
  }
  return _queueApptCol;
}

// Al llamar a un cliente de la fila se crea su turno (confirmado, "fila virtual") para que
// aparezca en la agenda del dueño/cajera y se pueda cobrar desde ahí. El barbero puede
// seguir cobrándolo desde su pantalla: /complete reutiliza este mismo turno.
async function createQueueAppointment(shopId, entry, barberId) {
  const tz = await getShopTz(shopId);
  const localDate = shopDate(tz);
  const localTime = shopTime(tz);
  const finalBarberId = barberId || entry.barber_id || null;

  let barberName = null, barberPct = null;
  if (finalBarberId) {
    const b = await pool.query('SELECT name, barber_commission_pct FROM shops WHERE id=$1', [finalBarberId]);
    barberName = b.rows[0]?.name || null;
    barberPct  = b.rows[0]?.barber_commission_pct != null ? parseInt(b.rows[0].barber_commission_pct) : null;
  }

  let svc = null;
  if (entry.service_name) {
    const r = await pool.query(
      'SELECT id, cost, commission_pct, duration_minutes FROM services WHERE shop_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1',
      [shopId, entry.service_name]
    );
    svc = r.rows[0] || null;
  }
  const pct = !finalBarberId ? 0
    : (svc && svc.commission_pct !== null && svc.commission_pct !== undefined) ? parseInt(svc.commission_pct)
    : (barberPct != null ? barberPct : 50);

  const [h, m] = localTime.split(':').map(Number);
  const end = new Date(2000, 0, 1, h, m + ((svc && svc.duration_minutes) || 30));
  const timeEnd = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;

  const ins = await pool.query(
    `INSERT INTO appointments
       (shop_id, client_id, client_name, service_id, service_name, price, cost, date, time_start, time_end,
        barber_id, barber_name, commission_pct, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'confirmed')
     RETURNING id`,
    [shopId, entry.client_id || null, entry.client_name, svc ? svc.id : null, entry.service_name || 'Fila virtual',
     parseFloat(entry.price) || 0, svc ? (parseFloat(svc.cost) || 0) : 0, localDate, localTime, timeEnd,
     finalBarberId, barberName, pct]
  );
  const apptId = ins.rows[0].id;
  await pool.query('UPDATE queue_entries SET appointment_id=$1 WHERE id=$2', [apptId, entry.id]);
  if (entry.any_barber) {
    await pool.query('UPDATE appointments SET any_barber=TRUE WHERE id=$1', [apptId]).catch(() => {});
  }
  try {
    require('../services/sse').emit(shopId, 'appointment.updated', { id: apptId, shop_id: shopId, status: 'confirmed', date: localDate, time_start: localTime, barber_id: finalBarberId });
  } catch (_) {}
  return apptId;
}

// ─── Cálculo de la espera de un cliente de la fila ───────────────────────────
// Simula a cada barbero con lo que ya tiene: el cliente que está atendiendo, sus turnos
// agendados de hoy y la gente de la fila que le toca antes. Así, si elegí a un barbero que
// está atendiendo y tiene un turno después, no me dice "sos el siguiente".
const toMin = (hhmm) => { const [h, m] = String(hhmm || '00:00').split(':').map(Number); return h * 60 + (m || 0); };

async function computeWaitInfo(shopId, entry) {
  const tz = await getShopTz(shopId);
  const today = shopDate(tz);
  const now = toMin(shopTime(tz));

  const [barbersQ, aheadQ, calledQ, apptQ, avgQ] = await Promise.all([
    pool.query('SELECT id FROM shops WHERE parent_shop_id=$1 AND is_barber=TRUE', [shopId]),
    pool.query(`SELECT id, barber_id FROM queue_entries WHERE shop_id=$1 AND status='waiting' AND id < $2 ORDER BY id`, [shopId, entry.id]),
    pool.query(`SELECT barber_id, called_at FROM queue_entries WHERE shop_id=$1 AND status='called'`, [shopId]),
    // Turnos agendados de hoy sin cobrar (los de la fila ya están contados como "llamados")
    pool.query(
      `SELECT a.barber_id, a.time_start::text AS ts, a.time_end::text AS te FROM appointments a
        WHERE a.shop_id=$1 AND a.date=$2::date AND a.status IN ('pending','confirmed')
          AND NOT EXISTS (SELECT 1 FROM queue_entries q WHERE q.appointment_id = a.id)
        ORDER BY a.time_start`, [shopId, today]).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (served_at - called_at))/60) AS avg_min FROM queue_entries
        WHERE shop_id=$1 AND status='served' AND called_at IS NOT NULL AND served_at > NOW() - INTERVAL '4 hours'`, [shopId]),
  ]);

  // Duración de cada atención: lo que vienen tardando hoy (entre 10 y 60 min); si no hay datos, 25
  const obs = avgQ.rows[0]?.avg_min != null ? parseFloat(avgQ.rows[0].avg_min) : null;
  const dur = obs && obs > 0 ? Math.min(Math.max(Math.round(obs), 10), 60) : 25;

  // Un "carril" por barbero (sin barberos: uno solo, el del local)
  const lanes = {};
  const ids = barbersQ.rows.map(r => r.id);
  const keyOf = (barberId) => (ids.length ? barberId : 'local');
  (ids.length ? ids : ['local']).forEach(id => { lanes[id] = { free: now, appts: [] }; });

  // Quien está en el sillón
  for (const c of calledQ.rows) {
    const lane = lanes[keyOf(c.barber_id)];
    if (!lane) continue;
    let calledMin = now;
    if (c.called_at) {
      const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(c.called_at));
      calledMin = toMin(t);
    }
    lane.free = Math.max(lane.free, calledMin + dur, now + 5);
  }
  // Turnos agendados
  for (const a of apptQ.rows) {
    const lane = lanes[keyOf(a.barber_id)];
    if (!lane) continue; // turno sin barbero en un local con barberos: no se sabe quién lo toma
    const s = toMin(a.ts), e = a.te ? toMin(a.te) : s + 30;
    if (e <= now) continue;                       // ya pasó (no vino / quedó sin cobrar)
    if (s <= now) { lane.free = Math.max(lane.free, e); continue; } // lo está atendiendo ahora
    lane.appts.push({ s, e, used: false });
  }

  // Ubicar una atención en un carril: los turnos agendados que se pisan van primero
  const place = (lane, commit) => {
    let start = lane.free, apptsBefore = 0;
    const used = [];
    for (const a of lane.appts) {
      if (a.used) continue;
      if (a.s < start + dur) { start = Math.max(start, a.s) + (a.e - a.s); apptsBefore++; used.push(a); }
    }
    if (commit) { used.forEach(a => { a.used = true; }); lane.free = start + dur; }
    return { start, apptsBefore };
  };
  const bestLane = (barberId) => {
    if (barberId && lanes[keyOf(barberId)]) return lanes[keyOf(barberId)];
    let best = null, bestStart = Infinity;
    for (const lane of Object.values(lanes)) {
      const { start } = place(lane, false);
      if (start < bestStart) { bestStart = start; best = lane; }
    }
    return best;
  };

  // Los que están antes en la fila. Si elegí a un barbero, solo me demoran los suyos
  // (el barbero llama primero a los que lo eligieron a él).
  const mine = entry.barber_id && lanes[keyOf(entry.barber_id)];
  const relevant = mine ? aheadQ.rows.filter(r => r.barber_id === entry.barber_id) : aheadQ.rows;
  const starts = [];
  for (const r of relevant) {
    const lane = bestLane(r.barber_id);
    const res = place(lane, true);
    lane.apptsServed = (lane.apptsServed || 0) + res.apptsBefore;
    starts.push(res.start);
  }
  const finalLane = bestLane(mine ? entry.barber_id : null);
  const me = place(finalLane, false);
  // Turnos agendados que ese barbero atiende antes que yo
  const apptsAhead = (finalLane.apptsServed || 0) + me.apptsBefore;

  // Gente de la fila que se atiende antes que yo (con "cualquiera", los que esperan a otro
  // barbero que se libera después no cuentan)
  const queueAhead = starts.filter(t => t <= me.start).length;
  return {
    position: queueAhead + apptsAhead,
    people_ahead: queueAhead + apptsAhead,
    queue_ahead: queueAhead,
    appointments_ahead: apptsAhead,
    estimated_wait_min: Math.max(0, Math.round(me.start - now)),
  };
}

// ─── PUBLIC: join queue ──────────────────────────────────────────────────────
router.post('/:slug/join', joinLimiter, async (req, res) => {
  try {
    const { slug } = req.params;
    const { service_name, price, barber_id } = req.body;
    // Datos públicos: sin < > y con largo acotado
    const cleanTxt = (v, n) => (v == null ? '' : String(v)).replace(/[<>]/g, '').trim().slice(0, n);
    const name  = cleanTxt(req.body.name, 100);
    const phone = cleanTxt(req.body.phone, 30);

    if (!name) {
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

    // Topes: misma persona anotada dos veces, o fila llena
    if (phone) {
      const dup = await pool.query(
        `SELECT 1 FROM queue_entries WHERE shop_id=$1 AND status IN ('waiting','called')
           AND regexp_replace(client_phone, '[^0-9]', '', 'g') = regexp_replace($2, '[^0-9]', '', 'g') LIMIT 1`,
        [shop.id, phone]
      );
      if (dup.rows.length) return res.status(409).json({ error: 'Ese teléfono ya está anotado en la fila.' });
    }
    const waitingCnt = await pool.query(`SELECT COUNT(*)::int AS n FROM queue_entries WHERE shop_id=$1 AND status='waiting'`, [shop.id]);
    if (waitingCnt.rows[0].n >= MAX_WAITING_PER_SHOP) {
      return res.status(429).json({ error: 'La fila está completa en este momento. Probá en un rato.' });
    }

    // Look up client by phone — link if already registered, auto-create si es nuevo
    let clientId = null;
    let resolvedName = name.trim();
    if (phone) {
      const phoneClean = phone.trim();
      const clientRes = await pool.query(
        'SELECT id, name FROM clients WHERE shop_id=$1 AND phone=$2 LIMIT 1',
        [shop.id, phoneClean]
      );
      if (clientRes.rows.length) {
        clientId    = clientRes.rows[0].id;
        resolvedName = clientRes.rows[0].name; // use the stored name for known clients
      } else {
        // Cliente nuevo — crear en la base para que gane puntos y quede en el CRM
        try {
          const created = await pool.query(
            `INSERT INTO clients (shop_id, name, phone, notes)
             VALUES ($1, $2, $3, 'Alta automática desde fila virtual')
             RETURNING id`,
            [shop.id, resolvedName, phoneClean]
          );
          clientId = created.rows[0].id;
          console.log(`[QUEUE] cliente nuevo auto-creado shop=${shop.id} id=${clientId} phone=${phoneClean}`);
        } catch (createErr) {
          // No bloquear el join si falla el alta del cliente (ej: unique constraint race)
          console.error('[QUEUE] no se pudo crear cliente auto:', createErr.message);
        }
      }
    }

    // Validar que el barbero elegido pertenezca a este shop (si vino uno)
    let validBarberId = null;
    if (barber_id) {
      const bChk = await pool.query(
        'SELECT id FROM shops WHERE id=$1 AND parent_shop_id=$2 AND is_barber=TRUE',
        [parseInt(barber_id), shop.id]
      );
      if (bChk.rows.length) validBarberId = bChk.rows[0].id;
    }

    // Insert entry (con servicio y barbero opcional). Precio no puede ser negativo.
    const safePrice = Math.max(0, parseFloat(price) || 0);
    await ensureQueueTokenColumn();
    const publicToken = crypto.randomBytes(16).toString('hex');
    const insertRes = await pool.query(
      `INSERT INTO queue_entries (shop_id, client_name, client_phone, client_id, status, service_name, price, barber_id, public_token)
       VALUES ($1, $2, $3, $4, 'waiting', $5, $6, $7, $8) RETURNING id`,
      [shop.id, resolvedName, phone || null, clientId, cleanTxt(service_name, 120) || null, safePrice, validBarberId, publicToken]
    );
    const entry_id = insertRes.rows[0].id;
    // Eligió "cualquier profesional" pudiendo elegir (hay 2+ barberos): puede sumar el bonus de puntos
    if (!validBarberId) {
      try {
        const nb = await pool.query('SELECT COUNT(*)::int AS n FROM shops WHERE parent_shop_id=$1 AND is_barber=TRUE', [shop.id]);
        if (nb.rows[0].n > 1) {
          await require('../services/anyBarberBonus').ensureBonusSchema();
          await pool.query('UPDATE queue_entries SET any_barber=TRUE WHERE id=$1', [entry_id]);
        }
      } catch (e) { console.warn('[QUEUE] any_barber:', e.message); }
    }

    // Posición y espera reales: tiene en cuenta el barbero elegido, a quién está atendiendo
    // y sus turnos agendados (antes contaba solo la gente anotada antes en todo el local)
    const info = await computeWaitInfo(shop.id, { id: entry_id, barber_id: validBarberId });

    return res.json({
      entry_id,
      token: publicToken,
      client_name: name.trim(),
      ...info,
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
    const { entry_id, t } = req.query;

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
    await ensureQueueTokenColumn();
    const entryRes = await pool.query(
      `SELECT id, client_name, status, created_at, called_at, public_token, barber_id
       FROM queue_entries WHERE id=$1 AND shop_id=$2`,
      [parseInt(entry_id) || 0, shop.id]
    );
    if (!entryRes.rows.length || !tokenOk(entryRes.rows[0].public_token, t)) {
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

    // waiting — posición y espera reales (barbero elegido, su cliente actual y sus turnos)
    const info = await computeWaitInfo(shop.id, entry);

    return res.json({
      entry_id: entry.id,
      status: entry.status,
      ...info,
      client_name: entry.client_name,
      shop_name: shop.name,
      queue_paused: shop.queue_paused
    });
  } catch (e) {
    console.error('queue status error', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ─── PUBLIC: get services for a shop (used by fila.html) ────────────────────
// ─── PUBLIC: list barbers for the barber selector in fila ────────────────────
router.get('/:slug/barbers', async (req, res) => {
  try {
    const shopRes = await pool.query(
      'SELECT id FROM shops WHERE booking_slug=$1', [req.params.slug]
    );
    if (!shopRes.rows.length) return res.json([]);
    const bRes = await pool.query(
      `SELECT id, name, barber_color FROM shops
        WHERE parent_shop_id=$1 AND is_barber=TRUE
        ORDER BY name ASC`,
      [shopRes.rows[0].id]
    );
    res.json(bRes.rows);
  } catch(e) { res.status(500).json([]); }
});

// ─── PUBLIC: bonus de puntos por elegir "cualquier profesional" ─────────────
router.get('/:slug/any-bonus', async (req, res) => {
  try {
    const shopRes = await pool.query('SELECT id FROM shops WHERE booking_slug=$1', [req.params.slug]);
    if (!shopRes.rows.length) return res.json({ pct: 0 });
    const nb = await pool.query('SELECT COUNT(*)::int AS n FROM shops WHERE parent_shop_id=$1 AND is_barber=TRUE', [shopRes.rows[0].id]);
    const cfg = await require('../services/anyBarberBonus').getBonusConfig(shopRes.rows[0].id);
    res.json({ pct: (cfg.enabled && nb.rows[0].n > 1) ? cfg.pct : 0 });
  } catch (e) { res.json({ pct: 0 }); }
});

router.get('/:slug/services', async (req, res) => {
  try {
    const shopRes = await pool.query(
      'SELECT id FROM shops WHERE booking_slug=$1', [req.params.slug]
    );
    if (!shopRes.rows.length) return res.json([]);
    const svcRes = await pool.query(
      'SELECT id, name, price, duration_minutes FROM services WHERE shop_id=$1 AND active=true ORDER BY name ASC',
      [shopRes.rows[0].id]
    );
    res.json(svcRes.rows);
  } catch(e) { res.status(500).json([]); }
});

// ─── PUBLIC: leave queue ─────────────────────────────────────────────────────
router.post('/:slug/leave', async (req, res) => {
  try {
    const { entry_id, token } = req.body;
    if (!entry_id) return res.status(400).json({ error: 'entry_id requerido' });
    const shopRes = await pool.query('SELECT id FROM shops WHERE booking_slug=$1', [req.params.slug]);
    if (!shopRes.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    await ensureQueueTokenColumn();
    await ensureQueueApptColumn();
    // Solo quien se anotó (tiene la clave) puede salir; las entradas viejas sin clave siguen funcionando
    const left = await pool.query(
      `UPDATE queue_entries SET status='left'
        WHERE id=$1 AND shop_id=$2 AND status IN ('waiting','called')
          AND (public_token IS NULL OR public_token = $3)
        RETURNING appointment_id`,
      [parseInt(entry_id) || 0, shopRes.rows[0].id, typeof token === 'string' ? token : '']
    );
    if (!left.rows.length) return res.status(404).json({ error: 'Entrada no encontrada' });
    // Si ya lo habían llamado, su turno "fila virtual" sin cobrar se cancela
    if (left.rows[0].appointment_id) {
      await pool.query(`UPDATE appointments SET status='cancelled' WHERE id=$1 AND status IN ('pending','confirmed')`,
        [left.rows[0].appointment_id]).catch(() => {});
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// ─── Helper: si el usuario es un barbero, usar parent_shop_id ───────────────
async function resolveShopId(authShopId) {
  const r = await pool.query('SELECT parent_shop_id FROM shops WHERE id=$1', [authShopId]);
  return r.rows[0]?.parent_shop_id || authShopId;
}

// ─── PROTECTED: get queue ────────────────────────────────────────────────────
// El dueño ve toda la fila. El barbero también ve toda la fila (con la marca de a quién espera
// cada cliente), pero los turnos de hoy son los suyos + los sin asignar, y los teléfonos de los
// clientes que eligieron a otro barbero no se muestran.
router.get('/', auth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req.shopId);

    // Consultas independientes en paralelo (antes eran 8 viajes a la base uno tras otro)
    const [shopRes, callerRes, shopTz] = await Promise.all([
      pool.query('SELECT queue_paused, booking_slug, name FROM shops WHERE id=$1', [shopId]),
      pool.query('SELECT is_barber FROM shops WHERE id=$1', [req.shopId]),
      getShopTz(shopId),
    ]);
    const shop = shopRes.rows[0] || {};
    const callerIsBarber = callerRes.rows[0]?.is_barber || false;

    // Auto-generar booking_slug si no existe (así el QR de la fila siempre funciona)
    if (!shop.booking_slug) {
      const generated = (shop.name || 'barberia')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) + '-' + shopId;
      await pool.query('UPDATE shops SET booking_slug=$1 WHERE id=$2 AND (booking_slug IS NULL OR booking_slug = \'\')', [generated, shopId]);
      shop.booking_slug = generated;
    }

    const apptBarberFilter = callerIsBarber ? 'AND (barber_id = $3 OR barber_id IS NULL)' : '';
    const apptParams = callerIsBarber ? [shopId, shopTz, req.shopId] : [shopId, shopTz];
    // "Atendidos hoy": del barbero si es un barbero, del local si es el dueño; el día corta a medianoche del local
    const servedBarberFilter = callerIsBarber ? 'AND barber_id = $3' : '';
    const servedParams = callerIsBarber ? [shopId, shopTz, req.shopId] : [shopId, shopTz];

    const [entriesRes, avgRes, servedRes, apptRes] = await Promise.all([
      // entries (waiting + called)
      pool.query(
        `SELECT q.id, q.client_name, q.client_phone, q.status, q.created_at, q.called_at,
                q.service_name, q.price, q.barber_id,
                b.name AS barber_name,
                EXTRACT(EPOCH FROM (NOW() - q.created_at))/60 AS minutes_waiting
         FROM queue_entries q
         LEFT JOIN shops b ON b.id = q.barber_id
         WHERE q.shop_id=$1 AND q.status IN ('waiting','called')
         ORDER BY q.created_at ASC`,
        [shopId]
      ),
      // avg wait
      pool.query(
        `SELECT AVG(EXTRACT(EPOCH FROM (served_at - called_at))/60) AS avg_min
         FROM queue_entries
         WHERE shop_id=$1 AND status='served' AND served_at > NOW() - INTERVAL '4 hours'`,
        [shopId]
      ),
      // served today
      pool.query(
        `SELECT COUNT(*)::int AS cnt FROM queue_entries
         WHERE shop_id=$1 AND status='served'
           AND (served_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date ${servedBarberFilter}`,
        servedParams
      ),
      // Today's appointments (for hybrid view) — date in shop timezone
      pool.query(
        `SELECT id, client_name, service_name, price, time_start, barber_name, barber_id, status, commission_pct
         FROM appointments
         WHERE shop_id=$1
           AND date = (NOW() AT TIME ZONE $2)::DATE
           AND status IN ('pending','confirmed') ${apptBarberFilter}
         ORDER BY time_start ASC`,
        apptParams
      ),
    ]);

    const avg_wait_min = avgRes.rows[0].avg_min != null
      ? parseFloat(avgRes.rows[0].avg_min)
      : null;

    // Un barbero no ve el teléfono de los clientes que eligieron a otro barbero
    const entries = callerIsBarber
      ? entriesRes.rows.map(e => (e.barber_id && e.barber_id !== req.shopId) ? { ...e, client_phone: null } : e)
      : entriesRes.rows;

    return res.json({
      paused: shop.queue_paused || false,
      shop_slug: shop.booking_slug || '',
      entries,
      avg_wait_min,
      served_today: servedRes.rows[0].cnt,
      appointments_today: apptRes.rows
    });
  } catch (e) {
    console.error('queue GET error', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ─── PROTECTED: call next ────────────────────────────────────────────────────
router.post('/next', auth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req.shopId);

    // Get shop name
    const shopRes = await pool.query('SELECT name FROM shops WHERE id=$1', [shopId]);
    const shopName = shopRes.rows[0]?.name || 'la barbería';

    // Si el que llama es barbero: priorizar entries asignadas a él, después "cualquier barbero" (NULL)
    const callerRes = await pool.query('SELECT is_barber FROM shops WHERE id=$1', [req.shopId]);
    const isBarber = callerRes.rows[0]?.is_barber || false;

    // El dueño/cajera puede llamar para un barbero en particular (elige quién atiende) o sin barbero
    let forBarberId = isBarber ? req.shopId : null;
    if (!isBarber && req.body && req.body.barber_id) {
      const bChk = await pool.query(
        'SELECT id FROM shops WHERE id=$1 AND parent_shop_id=$2 AND is_barber=TRUE',
        [parseInt(req.body.barber_id), shopId]
      );
      if (!bChk.rows.length) return res.status(400).json({ error: 'Barbero inválido para este local' });
      forBarberId = bChk.rows[0].id;
    }

    // Para un barbero: primero los que lo eligieron a él, después los "cualquiera".
    // Sin barbero: el primero que llegó.
    const entryQuery = forBarberId
      ? `SELECT * FROM queue_entries
         WHERE shop_id=$1 AND status='waiting' AND (barber_id = $2 OR barber_id IS NULL)
         ORDER BY (barber_id IS NULL) ASC, created_at ASC LIMIT 1`
      : `SELECT * FROM queue_entries
         WHERE shop_id=$1 AND status='waiting'
         ORDER BY created_at ASC LIMIT 1`;
    const entryParams = forBarberId ? [shopId, forBarberId] : [shopId];

    const entryRes = await pool.query(entryQuery, entryParams);
    if (!entryRes.rows.length) {
      return res.json({ ok: false, message: forBarberId && !isBarber ? 'No hay nadie en la fila para ese barbero' : 'No hay nadie en la fila para vos' });
    }
    const entry = entryRes.rows[0];

    const assignedBarberId = forBarberId;
    // UPDATE condicional: si dos personas llaman a la vez, solo una se queda con el cliente
    const claimed = await pool.query(
      `UPDATE queue_entries SET status='called', called_at=NOW(), barber_id=COALESCE(barber_id,$1)
        WHERE id=$2 AND status='waiting' RETURNING id`,
      [assignedBarberId, entry.id]
    );
    if (!claimed.rows.length) {
      return res.json({ ok: false, message: 'Ese cliente ya fue llamado. Probá de nuevo.' });
    }
    // Turno "fila virtual" en la agenda para poder cobrarlo desde el panel principal
    try {
      await ensureQueueApptColumn();
      await createQueueAppointment(shopId, entry, assignedBarberId);
    } catch (apptErr) {
      console.error('[QUEUE] no se pudo crear el turno de la fila (no frena el llamado):', apptErr.message);
    }

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
      // A quien se llama le toca ahora (antes, si quedaba gente en la fila, le decía "quedan N antes que vos")
      const msg = `¡Hola ${entry.client_name}! *Es tu turno* en ${shopName} 💈\n¡Vení ahora, te estamos esperando! ✂️`;
      try {
        const wpp = require('../services/whatsapp');
        wpp.sendText(shopId, entry.client_phone, msg).catch(() => {});
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
    const shopId = await resolveShopId(req.shopId);
    await pool.query(
      `UPDATE queue_entries SET status='served', served_at=NOW()
       WHERE id=$1 AND shop_id=$2`,
      [req.params.id, shopId]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error('queue serve error', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ─── PROTECTED: complete walk-in with payment (hybrid) ──────────────────────
// Todo el cobro va en UNA transacción: o queda registrado completo (turno cobrado, cliente
// atendido, deuda, comisión, puntos) o no queda nada y el cliente se puede volver a cobrar.
// Antes, si el servidor se cortaba a mitad de camino (p.ej. un deploy), el cliente podía
// quedar "atendido" sin cobro registrado.
router.post('/complete/:id', auth, async (req, res) => {
  let db = null, began = false;
  try {
    const shopId = await resolveShopId(req.shopId);
    const { price, cost, service_name, service_id, payment_method: rawPaymentMethod, tip, barber_id, commission_pct, client_name } = req.body;

    // ── Lecturas previas (fuera de la transacción) ──
    const payment_method = await normalizeDebtMethod([shopId], rawPaymentMethod);
    const p = parseFloat(price) || 0;
    const t = parseFloat(tip) || 0;
    let pct = parseInt(commission_pct) || 50;
    const c = parseFloat(cost) || 0;
    const svcIdInt = service_id && !Number.isNaN(parseInt(service_id)) ? parseInt(service_id) : null;
    if (svcIdInt) {
      const svcRes = await pool.query('SELECT commission_pct FROM services WHERE id=$1 AND shop_id=$2', [svcIdInt, shopId]);
      if (svcRes.rows.length && svcRes.rows[0].commission_pct !== null && svcRes.rows[0].commission_pct !== undefined) {
        pct = parseInt(svcRes.rows[0].commission_pct);
      }
    }
    const tz = await getShopTz(shopId);
    const localDate = shopDate(tz);
    const localTime = shopTime(tz);
    const shopData = (await pool.query('SELECT points_per_peso, wpp_connected, booking_slug FROM shops WHERE id=$1', [shopId])).rows[0];
    const ab = require('../services/anyBarberBonus');
    const bonusCfg = await ab.getBonusConfig(shopId);
    const tipMethod = (t > 0 && req.body.tip_method) ? String(req.body.tip_method).trim() : null;

    // ── Transacción ──
    db = await pool.connect();
    await db.query('BEGIN'); began = true;

    // Tomar al cliente de la fila con candado: dos cobros a la vez → uno solo
    const entryRes = await db.query('SELECT * FROM queue_entries WHERE id=$1 AND shop_id=$2 FOR UPDATE', [req.params.id, shopId]);
    if (!entryRes.rows.length) { await db.query('ROLLBACK'); began = false; return res.status(404).json({ error: 'No encontrado' }); }
    const entry = entryRes.rows[0];
    if (entry.status === 'served') {
      await db.query('ROLLBACK'); began = false;
      return res.json({ ok: true, appointment_id: entry.appointment_id || null, already_completed: true });
    }

    const finalBarberId = barber_id || entry.barber_id || null;
    let barberName = null;
    if (finalBarberId) {
      const bRes = await db.query('SELECT name FROM shops WHERE id=$1', [finalBarberId]);
      barberName = bRes.rows[0]?.name || null;
    }
    const finalClientId   = entry.client_id || null;
    const finalClientName = client_name || entry.client_name;

    // Si al llamarlo ya se creó su turno ("fila virtual"), se cobra ESE turno en vez de crear otro.
    // Si la cajera ya lo cobró desde la agenda, no se cobra dos veces.
    let apptId = null;
    if (entry.appointment_id) {
      const ex = await db.query('SELECT id, status FROM appointments WHERE id=$1 AND shop_id=$2 FOR UPDATE', [entry.appointment_id, shopId]);
      if (ex.rows.length) {
        if (ex.rows[0].status === 'completed') {
          await db.query(`UPDATE queue_entries SET status='served', served_at=COALESCE(served_at, NOW()) WHERE id=$1`, [entry.id]);
          await db.query('COMMIT'); began = false;
          return res.json({ ok: true, appointment_id: ex.rows[0].id, already_completed: true });
        }
        if (['pending', 'confirmed'].includes(ex.rows[0].status)) {
          await db.query(
            `UPDATE appointments SET client_name=$1, service_id=COALESCE($2::int, service_id), service_name=$3, price=$4, cost=$5,
                    barber_id=$6, barber_name=$7, commission_pct=$8, payment_method=$9, tip=$10, status='completed'
              WHERE id=$11 AND shop_id=$12`,
            [finalClientName, svcIdInt, service_name || 'Walk-in', p, c,
             finalBarberId, barberName, pct, payment_method || 'cash', t, ex.rows[0].id, shopId]
          );
          apptId = ex.rows[0].id;
        }
      }
    }
    if (!apptId) {
      const apptRes = await db.query(
        `INSERT INTO appointments
           (shop_id, client_id, client_name, service_name, price, cost, date, time_start,
            barber_id, barber_name, commission_pct, payment_method, tip, status)
         VALUES ($1,$13,$2,$3,$4,$5,$11,$12,$6,$7,$8,$9,$10,'completed')
         RETURNING id`,
        [shopId, finalClientName, service_name || 'Walk-in', p, c,
         finalBarberId, barberName, pct, payment_method || 'cash', t, localDate, localTime, finalClientId]
      );
      apptId = apptRes.rows[0].id;
    }

    if (tipMethod) {
      await db.query('SAVEPOINT tm');
      try { await db.query('UPDATE appointments SET tip_method=$1 WHERE id=$2', [tipMethod, apptId]); await db.query('RELEASE SAVEPOINT tm'); }
      catch (_) { await db.query('ROLLBACK TO SAVEPOINT tm'); } // tolerante si la migración 045 no corrió aún
    }

    // Cliente atendido
    await db.query(
      `UPDATE queue_entries
       SET status='served', served_at=NOW(),
           service_name=$1, price=$2, payment_method=$3, tip=$4,
           barber_id=$5, appointment_id=$6
       WHERE id=$7`,
      [service_name, p, payment_method, t, finalBarberId, apptId, entry.id]
    );

    // Comisión si hay barbero y precio
    if (finalBarberId && p > 0) {
      await db.query(
        `INSERT INTO commission_splits
           (shop_id, barber_id, appointment_id, total_price, barber_pct, barber_amount, owner_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [shopId, finalBarberId, apptId, p, pct, p * pct / 100, p * (100 - pct) / 100]
      );
    }

    // Fiado → deuda
    if (payment_method === 'debt') {
      await db.query(
        `INSERT INTO client_debts (shop_id, client_id, client_name, appointment_id, amount, description)
         SELECT $1::int, $5::int, $2::text, $3::int, $4::numeric, 'Walk-in — fiado'
          WHERE NOT EXISTS (SELECT 1 FROM client_debts WHERE appointment_id=$3::int AND paid=FALSE)`,
        [shopId, finalClientName, apptId, p, finalClientId]
      );
    }

    // Puntos + estadísticas del cliente
    let pointsEarned = 0, client = null;
    if (finalClientId && p > 0) {
      const pointsPerPeso = parseFloat(shopData?.points_per_peso || 0.01);
      const basePoints = Math.floor(p * pointsPerPeso);
      // Bonus por "cualquier profesional" (la marca puede venir de la fila o del turno)
      const bonus = entry.any_barber ? ab.bonusPoints(basePoints, bonusCfg) : 0;
      if (bonus > 0) await db.query('UPDATE appointments SET bonus_points=$1, any_barber=TRUE WHERE id=$2', [bonus, apptId]);
      pointsEarned = basePoints + bonus;
      const updatedClient = await db.query(
        `UPDATE clients SET
           total_visits = total_visits + 1,
           total_spent  = total_spent  + $1,
           last_visit   = $2,
           points       = points       + $3
         WHERE id=$4
         RETURNING id, name, phone, points`,
        [p, localDate, pointsEarned, finalClientId]
      );
      client = updatedClient.rows[0] || null;
    }

    await db.query('COMMIT'); began = false;

    // ── Después de registrar: avisos (no afectan el cobro) ──
    try { require('../services/sse').emit(shopId, 'appointment.updated', { id: apptId, shop_id: shopId, status: 'completed' }); } catch (_) {}
    if (client?.phone && shopData?.wpp_connected && pointsEarned > 0) {
      try {
        const wpp = require('../services/whatsapp');
        const slug = shopData.booking_slug;
        const tiendaLink = slug ? `${process.env.APP_URL || 'https://filocrm1-production.up.railway.app'}/tienda/${slug}` : null;
        const msg = `✅ ¡Gracias ${client.name}! Sumaste *${pointsEarned} puntos* en tu visita de hoy.\n🎯 Total acumulado: *${client.points} puntos*${tiendaLink ? `\n🛍️ Canjealos en ${tiendaLink}` : ''}`;
        wpp.sendText(shopId, client.phone, msg).catch(() => {});
      } catch (_) {}
    }

    return res.json({ ok: true, appointment_id: apptId });
  } catch (e) {
    if (began && db) { try { await db.query('ROLLBACK'); } catch (_) {} }
    console.error('queue complete error:', e.message, e.stack);
    return res.status(500).json({ error: 'No se pudo registrar el cobro. Intentá de nuevo.' });
  } finally {
    if (db) db.release();
  }
});

// ─── PROTECTED: remove from queue ───────────────────────────────────────────
router.post('/remove/:id', auth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req.shopId);
    // Si ya tenía su turno de "fila virtual" sin cobrar, también se cancela para que no quede colgado en la agenda
    await pool.query(
      `UPDATE appointments SET status='cancelled'
        WHERE shop_id=$2 AND status IN ('pending','confirmed')
          AND id IN (SELECT appointment_id FROM queue_entries WHERE id=$1 AND shop_id=$2 AND appointment_id IS NOT NULL)`,
      [req.params.id, shopId]
    ).catch(() => {});
    await pool.query(
      `UPDATE queue_entries SET status='left' WHERE id=$1 AND shop_id=$2`,
      [req.params.id, shopId]
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
    const shopId = await resolveShopId(req.shopId);
    const result = await pool.query(
      `UPDATE shops SET queue_paused = NOT queue_paused WHERE id=$1 RETURNING queue_paused`,
      [shopId]
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
    const shopId = await resolveShopId(req.shopId);
    await pool.query(
      `UPDATE appointments SET status='cancelled'
        WHERE shop_id=$1 AND status IN ('pending','confirmed')
          AND id IN (SELECT appointment_id FROM queue_entries WHERE shop_id=$1 AND status='called' AND appointment_id IS NOT NULL)`,
      [shopId]
    ).catch(() => {});
    await pool.query(
      `UPDATE queue_entries SET status='left'
       WHERE shop_id=$1 AND status IN ('waiting','called')`,
      [shopId]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error('queue clear error', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
