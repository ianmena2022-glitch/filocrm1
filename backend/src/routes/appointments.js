const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// Retorna el shopId real (dueño), sea barbero o dueño
function realShopId(req) {
  return req.isBarber && req.parentShopId ? req.parentShopId : req.shopId;
}

// Auto-asigna el barbero con menos turnos en esa fecha
async function autoAssignBarber(shopId, date) {
  try {
    // Obtener todos los barberos activos del shop
    const barbers = await pool.query(
      `SELECT id FROM shops WHERE parent_shop_id = $1 AND is_barber = TRUE`,
      [shopId]
    );
    if (!barbers.rows.length) return null;

    // Contar turnos de cada barbero en esa fecha
    const counts = await pool.query(
      `SELECT barber_id, COUNT(*) as total
       FROM appointments
       WHERE shop_id = $1 AND date = $2 AND barber_id IS NOT NULL
       GROUP BY barber_id`,
      [shopId, date]
    );

    const countMap = {};
    counts.rows.forEach(r => { countMap[r.barber_id] = parseInt(r.total); });

    // Asignar al que tenga menos turnos (0 si no tiene ninguno)
    let minCount = Infinity;
    let assignedId = null;
    for (const b of barbers.rows) {
      const c = countMap[b.id] || 0;
      if (c < minCount) {
        minCount = c;
        assignedId = b.id;
      }
    }
    return assignedId;
  } catch (e) {
    console.error('autoAssignBarber error:', e.message);
    return null;
  }
}

// GET /api/appointments?date=YYYY-MM-DD
router.get('/', auth, async (req, res) => {
  const { date } = req.query;
  const d = date || new Date().toISOString().split('T')[0];
  const shopId = realShopId(req);

  console.log(`[GET appts] isBarber=${req.isBarber} shopId=${req.shopId} parentShopId=${req.parentShopId} realShopId=${shopId} date=${d}`);

  try {
    let result;

    if (req.isBarber) {
      // Barbero solo ve SUS turnos
      result = await pool.query(
        `SELECT a.*, c.name AS client_name, c.phone AS client_phone, c.address AS client_address,
                b.name AS assigned_barber_name
         FROM appointments a
         LEFT JOIN clients c ON c.id = a.client_id
         LEFT JOIN shops b ON b.id = a.barber_id
         WHERE a.shop_id = $1 AND a.date = $2 AND a.barber_id = $3
         ORDER BY a.time_start`,
        [shopId, d, req.shopId]
      );
    } else if (req.isEnterpriseOwner) {
      // Enterprise owner ve sus turnos + los de todas sus sucursales
      result = await pool.query(
        `SELECT a.*, c.name AS client_name, c.phone AS client_phone, c.address AS client_address,
                b.name AS assigned_barber_name,
                s.name AS branch_name
         FROM appointments a
         LEFT JOIN clients c ON c.id = a.client_id
         LEFT JOIN shops b ON b.id = a.barber_id
         LEFT JOIN shops s ON s.id = a.shop_id
         WHERE a.date = $2
           AND (a.shop_id = $1 OR a.shop_id IN (
             SELECT id FROM shops WHERE parent_enterprise_id = $1 AND is_branch = TRUE
           ))
         ORDER BY a.time_start`,
        [shopId, d]
      );
    } else {
      // Dueño/sucursal ve todos sus turnos
      result = await pool.query(
        `SELECT a.*, c.name AS client_name, c.phone AS client_phone, c.address AS client_address,
                b.name AS assigned_barber_name
         FROM appointments a
         LEFT JOIN clients c ON c.id = a.client_id
         LEFT JOIN shops b ON b.id = a.barber_id
         WHERE a.shop_id = $1 AND a.date = $2
         ORDER BY a.time_start`,
        [shopId, d]
      );
    }

    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/appointments
router.post('/', auth, async (req, res) => {
  const {
    client_id, client_name, service_id, service_name,
    price, cost, date, time_start, barber_id, barber_name,
    commission_pct, notes,
    redeem_item_id, redeem_item_name, redeem_points_cost
  } = req.body;

  if (!time_start || !date) return res.status(400).json({ error: 'Fecha y hora son requeridas' });

  const shopId = realShopId(req);

  try {
    // Resolver servicio
    let svcName = service_name || null;
    let svcCost = cost || 0;
    let duration = 30;
    if (service_id) {
      const svc = await pool.query('SELECT * FROM services WHERE id=$1 AND shop_id=$2', [service_id, shopId]);
      if (svc.rows.length) {
        svcName = svc.rows[0].name;
        svcCost = svc.rows[0].cost;
        duration = svc.rows[0].duration_minutes || 30;
      }
    }

    // Calcular time_end
    const [h, m] = time_start.split(':').map(Number);
    const end = new Date(2000, 0, 1, h, m + duration);
    const time_end = `${String(end.getHours()).padStart(2,'0')}:${String(end.getMinutes()).padStart(2,'0')}`;

    // Resolver nombre del cliente
    let cName = client_name || null;
    if (client_id) {
      const cl = await pool.query('SELECT name FROM clients WHERE id=$1 AND shop_id=$2', [client_id, shopId]);
      if (cl.rows.length) cName = cl.rows[0].name;
    }

    // Validar puntos si hay canje (verificación atómica con UPDATE condicional para evitar race condition)
    const pointsCost = parseInt(redeem_points_cost) || 0;
    let redeemInfo = null;
    if (client_id && redeem_item_id && pointsCost > 0) {
      const cl = await pool.query('SELECT points FROM clients WHERE id=$1 AND shop_id=$2', [client_id, shopId]);
      if (!cl.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
      if (cl.rows[0].points < pointsCost) {
        return res.status(400).json({ error: `Puntos insuficientes. El cliente tiene ${cl.rows[0].points} pts y el premio cuesta ${pointsCost} pts.` });
      }
      redeemInfo = redeem_item_name || 'Premio canjeado';
    }

    // Pre-descontar puntos atómicamente (WHERE points >= $1 garantiza no llegar a negativos)
    if (client_id && redeem_item_id && pointsCost > 0 && redeemInfo) {
      const deducted = await pool.query(
        'UPDATE clients SET points = points - $1 WHERE id=$2 AND shop_id=$3 AND points >= $1 RETURNING points',
        [pointsCost, parseInt(client_id), shopId]
      );
      if (!deducted.rows.length) {
        return res.status(400).json({ error: 'Puntos insuficientes (verificación concurrente fallida)' });
      }
    }

    // Resolver barber_id:
    // 1) Si lo manda el frontend explícitamente, usarlo
    // 2) Si el que crea el turno ES un barbero, asignárselo a sí mismo
    // 3) Si es el dueño y no especificó, auto-asignar al barbero con menos turnos
    let assignedBarberId = barber_id ? parseInt(barber_id) : null;

    if (!assignedBarberId && req.isBarber) {
      assignedBarberId = req.shopId;
    }

    if (!assignedBarberId) {
      assignedBarberId = await autoAssignBarber(shopId, date);
    }

    console.log(`[APPT] Auto-asignando barber_id=${assignedBarberId} para shop=${shopId} fecha=${date}`);

    // Obtener comision real del barbero asignado (0 si no hay barbero asignado)
    let realCommissionPct = 0;
    if (assignedBarberId) {
      realCommissionPct = 50; // default si hay barbero pero sin % configurado
      const barberData = await pool.query(
        'SELECT barber_commission_pct FROM shops WHERE id=$1', [assignedBarberId]
      );
      if (barberData.rows.length && barberData.rows[0].barber_commission_pct) {
        realCommissionPct = parseInt(barberData.rows[0].barber_commission_pct);
      }
    }
    console.log(`[APPT] commission_pct del barbero ${assignedBarberId}: ${realCommissionPct}%`);

    const result = await pool.query(
      `INSERT INTO appointments
         (shop_id, client_id, client_name, service_id, service_name, price, cost, date,
          time_start, time_end, barber_id, barber_name, commission_pct, notes, redeem_info)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        shopId,
        client_id || null, cName,
        service_id || null, svcName,
        parseFloat(price)||0, parseFloat(svcCost)||0,
        date, time_start, time_end,
        assignedBarberId,
        barber_name || null,
        realCommissionPct,
        notes || null,
        redeemInfo
      ]
    );

    const appt = result.rows[0];

    // Registrar canje (puntos ya descontados atómicamente antes del INSERT del turno)
    // Fix #20: ON CONFLICT DO NOTHING para idempotencia ante reintentos
    const clientIdInt = parseInt(client_id) || null;
    const redeemItemIdInt = parseInt(redeem_item_id) || null;
    if (clientIdInt && redeemItemIdInt && pointsCost > 0 && redeemInfo) {
      await pool.query(
        `INSERT INTO points_redemptions (shop_id, client_id, item_id, item_name, points_used, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         ON CONFLICT DO NOTHING`,
        [shopId, clientIdInt, redeemItemIdInt, redeemInfo, pointsCost]
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
  const { status, payment_method, tip } = req.body;
  const shopId = realShopId(req);
  const validStatuses = ['pending','confirmed','completed','noshow','cancelled','waiting_sena'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Estado inválido' });

  try {
    const shopConditionStatus = req.isEnterpriseOwner
      ? `(shop_id = $5 OR shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id = $5 AND is_branch = TRUE))`
      : `shop_id = $5`;

    const result = await pool.query(
      `UPDATE appointments SET status=$1,
         payment_method = CASE WHEN $2::text IS NOT NULL THEN $2::text ELSE payment_method END,
         tip = CASE WHEN $3::numeric IS NOT NULL THEN $3::numeric ELSE tip END
       WHERE id=$4 AND ${shopConditionStatus} RETURNING *`,
      [status, payment_method || null, tip !== undefined ? parseFloat(tip) : null, req.params.id, shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });

    const appt = result.rows[0];

    // Si es fiado, registrar deuda
    if (status === 'completed' && payment_method === 'debt') {
      await pool.query(
        `INSERT INTO client_debts (shop_id, client_id, client_name, appointment_id, amount, description)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [shopId, appt.client_id || null, appt.client_name, appt.id,
         parseFloat(appt.price || 0), `Turno ${appt.service_name || ''} - ${appt.date}`]
      );
      console.log(`[CAJA] Deuda registrada para ${appt.client_name}: $${appt.price}`);
    }

    // Notificar al cliente cuando el turno es confirmado
    // Fix #3: usar enterprise owner para WPP si la sucursal no tiene socket propio
    if (status === 'confirmed' && appt.client_id) {
      try {
        const shopData = (await pool.query('SELECT name, wpp_connected, booking_slug, parent_enterprise_id FROM shops WHERE id=$1', [shopId])).rows[0];
        const client = (await pool.query('SELECT name, phone FROM clients WHERE id=$1', [appt.client_id])).rows[0];
        if (shopData?.wpp_connected && client?.phone) {
          const { generateMessage } = require('../services/ai');
          const wpp = require('../services/whatsapp');
          const wppShopId = shopData.parent_enterprise_id || shopId;
          const fecha = appt.date ? new Date(appt.date).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
          const hora = appt.time_start ? appt.time_start.slice(0,5) : '';
          let msg = await generateMessage(shopId, 'turno_confirmado', {
            clientName: client.name,
            shopName: shopData.name,
            fecha,
            hora,
            serviceName: appt.service_name || null,
          });
          if (!msg) msg = `✅ ¡Turno confirmado, ${client.name}! Te esperamos el ${fecha} a las ${hora}${appt.service_name ? ` para ${appt.service_name}` : ''}. Cualquier cambio avisanos. 💈`;
          await wpp.sendText(wppShopId, client.phone, msg);
        }
      } catch (wppErr) {
        console.error('[appointments] Error enviando WPP confirmado:', wppErr.message);
      }
    }

    // Actualizar stats del cliente al completar
    // Fix #3: usar enterprise owner para WPP si la sucursal no tiene socket propio
    if (status === 'completed' && appt.client_id) {
      const shop = await pool.query('SELECT * FROM shops WHERE id=$1', [shopId]);
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

      if (client.phone && shopData.wpp_connected) {
        try {
          const wpp = require('../services/whatsapp');
          const { generateMessage } = require('../services/ai');
          const wppShopId = shopData.parent_enterprise_id || shopId;
          const slug = shopData.booking_slug;
          const tiendaLink = slug
            ? `${process.env.APP_URL || 'https://filocrm1-production.up.railway.app'}/tienda/${slug}`
            : null;

          let msg = await generateMessage(shopId, 'turno_completado', {
            clientName: client.name,
            pointsEarned,
            totalPoints: client.points,
            tiendaLink
          });

          if (!msg) {
            const tpls = shopData.msg_templates ? JSON.parse(shopData.msg_templates) : {};
            const tplBase = tpls.completado || '✂️ *¡Servicio completado!* Gracias {nombre}.\n⭐ Puntos acumulados: +{puntos} (total: {total})\n🎁 Ver premios: {link}\n¡Hasta la próxima! 💈';
            msg = tplBase
              .replace('{nombre}', client.name)
              .replace('{puntos}', pointsEarned)
              .replace('{total}', client.points)
              .replace('{link}', tiendaLink || '');
          }

          await wpp.sendText(wppShopId, client.phone, msg);
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

// PUT /api/appointments/:id — editar turno
router.put('/:id', auth, async (req, res) => {
  const { client_name, time_start, time_end, price, status } = req.body;
  const shopId = realShopId(req);
  try {
    const result = await pool.query(
      `UPDATE appointments SET
         client_name = COALESCE($1, client_name),
         time_start  = COALESCE($2, time_start),
         time_end    = COALESCE($3, time_end),
         price       = COALESCE($4, price),
         status      = COALESCE($5, status)
       WHERE id=$6 AND shop_id=$7 RETURNING *`,
      [client_name||null, time_start||null, time_end||null,
       price !== undefined ? parseFloat(price) : null,
       status||null, req.params.id, shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/appointments/:id/sena — confirmar o marcar como perdida la seña
router.put('/:id/sena', auth, async (req, res) => {
  const { action } = req.body; // 'confirm' | 'lost'
  if (!['confirm', 'lost'].includes(action)) return res.status(400).json({ error: 'Acción inválida' });
  const shopId = realShopId(req);

  try {
    let newStatus, newSenaStatus;
    if (action === 'confirm') {
      newStatus = 'pending';
      newSenaStatus = 'confirmed';
    } else {
      newStatus = 'cancelled';
      newSenaStatus = 'lost';
    }

    // Enterprise owner puede confirmar señas de sus sucursales también
    const shopCondition = req.isEnterpriseOwner
      ? `(shop_id = $2 OR shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id = $2 AND is_branch = TRUE))`
      : `shop_id = $2`;

    // FOR UPDATE para evitar race condition con el scheduler (expirePendingSenas)
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT id, status FROM appointments WHERE id=$1 AND ${shopCondition} FOR UPDATE`,
        [req.params.id, shopId]
      );
      if (!locked.rows.length || locked.rows[0].status !== 'waiting_sena') {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Turno no encontrado o ya fue procesado' });
      }
      result = await client.query(
        `UPDATE appointments SET status=$1, sena_status=$2 WHERE id=$3 RETURNING *`,
        [newStatus, newSenaStatus, req.params.id]
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      client.release();
      throw txErr;
    }
    client.release();
    if (!result.rows.length) return res.status(404).json({ error: 'Turno no encontrado o ya fue procesado' });

    const appt = result.rows[0];

    // Al confirmar seña → registrar como ingreso en caja (transfer del día)
    if (action === 'confirm' && appt.sena_amount > 0) {
      try {
        const today = new Date().toISOString().split('T')[0];
        await pool.query(
          `INSERT INTO expenses (shop_id, amount, category, description, date, is_income, source_type, source_id, payment_method)
           VALUES ($1, $2, 'otros', $3, $4, TRUE, 'sena', $5, 'transfer')
           ON CONFLICT DO NOTHING`,
          [appt.shop_id, parseFloat(appt.sena_amount),
           `Seña - ${appt.client_name || 'Sin nombre'}`,
           today, appt.id]
        );
      } catch (senaErr) {
        // No fallar la confirmación si el registro en caja falla
        console.error('[SENA] Error registrando en caja:', senaErr.message);
      }
    }

    res.json({ ok: true, appointment: appt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/appointments/:id
router.delete('/:id', auth, async (req, res) => {
  const shopId = realShopId(req);
  try {
    const shopConditionDel = req.isEnterpriseOwner
      ? `(shop_id = $2 OR shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id = $2 AND is_branch = TRUE))`
      : `shop_id = $2`;

    const result = await pool.query(
      `DELETE FROM appointments WHERE id=$1 AND ${shopConditionDel} RETURNING id`,
      [req.params.id, shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
