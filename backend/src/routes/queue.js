const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const { getShopTz, shopDate, shopTime } = require('../db/shopTz');

// ─── PUBLIC: join queue ──────────────────────────────────────────────────────
router.post('/:slug/join', async (req, res) => {
  try {
    const { slug } = req.params;
    const { name, phone, service_name, price, barber_id } = req.body;

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
    const insertRes = await pool.query(
      `INSERT INTO queue_entries (shop_id, client_name, client_phone, client_id, status, service_name, price, barber_id)
       VALUES ($1, $2, $3, $4, 'waiting', $5, $6, $7) RETURNING id`,
      [shop.id, resolvedName, phone || null, clientId, service_name || null, safePrice, validBarberId]
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
    const { entry_id } = req.body;
    if (!entry_id) return res.status(400).json({ error: 'entry_id requerido' });
    const shopRes = await pool.query('SELECT id FROM shops WHERE booking_slug=$1', [req.params.slug]);
    if (!shopRes.rows.length) return res.status(404).json({ error: 'Barbería no encontrada' });
    await pool.query(
      `UPDATE queue_entries SET status='left' WHERE id=$1 AND shop_id=$2 AND status IN ('waiting','called')`,
      [entry_id, shopRes.rows[0].id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// ─── Helper: si el usuario es un barbero, usar parent_shop_id ───────────────
async function resolveShopId(authShopId) {
  const r = await pool.query('SELECT parent_shop_id FROM shops WHERE id=$1', [authShopId]);
  return r.rows[0]?.parent_shop_id || authShopId;
}

// ─── PROTECTED: get queue ────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req.shopId);

    // paused + slug
    const shopRes = await pool.query(
      'SELECT queue_paused, booking_slug, name FROM shops WHERE id=$1',
      [shopId]
    );
    const shop = shopRes.rows[0] || {};

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

    // Si el que pide es un barbero, filtrar: solo ve sus entries + las sin asignar
    const callerRes = await pool.query('SELECT is_barber FROM shops WHERE id=$1', [req.shopId]);
    const callerIsBarber = callerRes.rows[0]?.is_barber || false;

    const barberFilter = callerIsBarber
      ? 'AND (barber_id = $2 OR barber_id IS NULL)'
      : '';
    const params = callerIsBarber ? [shopId, req.shopId] : [shopId];

    // entries (waiting + called)
    const entriesRes = await pool.query(
      `SELECT q.id, q.client_name, q.client_phone, q.status, q.created_at, q.called_at,
              q.service_name, q.price, q.barber_id,
              b.name AS barber_name,
              EXTRACT(EPOCH FROM (NOW() - q.created_at))/60 AS minutes_waiting
       FROM queue_entries q
       LEFT JOIN shops b ON b.id = q.barber_id
       WHERE q.shop_id=$1 AND q.status IN ('waiting','called') ${barberFilter}
       ORDER BY q.created_at ASC`,
      params
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

    // Today's appointments (for hybrid view) — date in shop timezone
    const shopTz = await getShopTz(shopId);
    const apptRes = await pool.query(
      `SELECT id, client_name, service_name, price, time_start, barber_name, barber_id, status, commission_pct
       FROM appointments
       WHERE shop_id=$1
         AND date = (NOW() AT TIME ZONE $2)::DATE
         AND status IN ('pending','confirmed')
       ORDER BY time_start ASC`,
      [shopId, shopTz]
    );

    return res.json({
      paused: shop.queue_paused || false,
      shop_slug: shop.booking_slug || '',
      entries: entriesRes.rows,
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

    const entryQuery = isBarber
      ? `SELECT id, client_name, client_phone FROM queue_entries
         WHERE shop_id=$1 AND status='waiting' AND (barber_id = $2 OR barber_id IS NULL)
         ORDER BY (barber_id IS NULL) ASC, created_at ASC LIMIT 1`
      : `SELECT id, client_name, client_phone FROM queue_entries
         WHERE shop_id=$1 AND status='waiting'
         ORDER BY created_at ASC LIMIT 1`;
    const entryParams = isBarber ? [shopId, req.shopId] : [shopId];

    const entryRes = await pool.query(entryQuery, entryParams);
    if (!entryRes.rows.length) {
      return res.json({ ok: false, message: 'No hay nadie en la fila para vos' });
    }
    const entry = entryRes.rows[0];

    const assignedBarberId = isBarber ? req.shopId : null;
    await pool.query(
      `UPDATE queue_entries SET status='called', called_at=NOW(), barber_id=COALESCE(barber_id,$1) WHERE id=$2`,
      [assignedBarberId, entry.id]
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
router.post('/complete/:id', auth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req.shopId);
    const { price, cost, service_name, service_id, payment_method, tip, barber_id, commission_pct, client_name } = req.body;

    const entryRes = await pool.query(
      'SELECT * FROM queue_entries WHERE id=$1 AND shop_id=$2',
      [req.params.id, shopId]
    );
    if (!entryRes.rows.length) return res.status(404).json({ error: 'No encontrado' });
    const entry = entryRes.rows[0];

    const p = parseFloat(price) || 0;
    const t = parseFloat(tip) || 0;
    let pct = parseInt(commission_pct) || 50;
    const c = parseFloat(cost) || 0;

    // Override comisión con la custom del servicio si existe (prioridad: servicio > barbero)
    if (service_id) {
      const svcRes = await pool.query(
        'SELECT commission_pct FROM services WHERE id=$1 AND shop_id=$2',
        [parseInt(service_id), shopId]
      );
      if (svcRes.rows.length && svcRes.rows[0].commission_pct !== null && svcRes.rows[0].commission_pct !== undefined) {
        pct = parseInt(svcRes.rows[0].commission_pct);
      }
    }

    // Get barber name if assigned
    let barberName = null;
    const finalBarberId = barber_id || entry.barber_id || null;
    if (finalBarberId) {
      const bRes = await pool.query('SELECT name FROM shops WHERE id=$1', [finalBarberId]);
      barberName = bRes.rows[0]?.name || null;
    }

    // Create appointment record (for caja + reporting)
    // Pre-compute date/time in shop's timezone to avoid UTC offset from Railway server
    const tz = await getShopTz(shopId);
    const localDate = shopDate(tz);
    const localTime = shopTime(tz);
    const finalClientId   = entry.client_id || null;
    const finalClientName = client_name || entry.client_name;
    const apptRes = await pool.query(
      `INSERT INTO appointments
         (shop_id, client_id, client_name, service_name, price, cost, date, time_start,
          barber_id, barber_name, commission_pct, payment_method, tip, status)
       VALUES ($1,$13,$2,$3,$4,$5,$11,$12,$6,$7,$8,$9,$10,'completed')
       RETURNING id`,
      [shopId, finalClientName, service_name || 'Walk-in', p, c,
       finalBarberId, barberName, pct, payment_method || 'cash', t, localDate, localTime, finalClientId]
    );
    const apptId = apptRes.rows[0].id;

    // Mark queue entry as served
    await pool.query(
      `UPDATE queue_entries
       SET status='served', served_at=NOW(),
           service_name=$1, price=$2, payment_method=$3, tip=$4,
           barber_id=$5, appointment_id=$6
       WHERE id=$7`,
      [service_name, p, payment_method, t, finalBarberId, apptId, req.params.id]
    );

    // Commission split if barber assigned + price > 0
    if (finalBarberId && p > 0) {
      const barberAmt = p * pct / 100;
      const ownerAmt  = p * (100 - pct) / 100;
      await pool.query(
        `INSERT INTO commission_splits
           (shop_id, barber_id, appointment_id, total_price, barber_pct, barber_amount, owner_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [shopId, finalBarberId, apptId, p, pct, barberAmt, ownerAmt]
      );
    }

    // Register debt if fiado
    if (payment_method === 'debt') {
      await pool.query(
        `INSERT INTO client_debts (shop_id, client_name, appointment_id, amount, description)
         VALUES ($1,$2,$3,$4,'Walk-in — fiado')`,
        [shopId, finalClientName, apptId, p]
      );
    }

    // Award points + update client stats if linked to a known client
    if (finalClientId && p > 0) {
      try {
        const shopData = (await pool.query(
          'SELECT points_per_peso, wpp_connected, booking_slug FROM shops WHERE id=$1',
          [shopId]
        )).rows[0];
        const pointsPerPeso = parseFloat(shopData?.points_per_peso || 0.01);
        const pointsEarned  = Math.floor(p * pointsPerPeso);

        const updatedClient = await pool.query(
          `UPDATE clients SET
             total_visits = total_visits + 1,
             total_spent  = total_spent  + $1,
             last_visit   = $2,
             points       = points       + $3
           WHERE id=$4
           RETURNING id, name, phone, points`,
          [p, localDate, pointsEarned, finalClientId]
        );

        // WhatsApp notification (non-blocking)
        const client = updatedClient.rows[0];
        if (client?.phone && shopData?.wpp_connected && pointsEarned > 0) {
          try {
            const wpp = require('../services/whatsapp');
            const slug = shopData.booking_slug;
            const tiendaLink = slug
              ? `${process.env.APP_URL || 'https://filocrm1-production.up.railway.app'}/tienda/${slug}`
              : null;
            const msg = `✅ ¡Gracias ${client.name}! Sumaste *${pointsEarned} puntos* en tu visita de hoy.\n🎯 Total acumulado: *${client.points} puntos*${tiendaLink ? `\n🛍️ Canjealos en ${tiendaLink}` : ''}`;
            wpp.sendText(shopId, client.phone, msg).catch(() => {});
          } catch (_) {}
        }
      } catch (pointsErr) {
        console.error('queue complete — points error (non-fatal):', pointsErr.message);
      }
    }

    return res.json({ ok: true, appointment_id: apptId });
  } catch (e) {
    console.error('queue complete error:', e.message, e.stack);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ─── PROTECTED: remove from queue ───────────────────────────────────────────
router.post('/remove/:id', auth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req.shopId);
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
