const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');
const { getShopTz, shopDate } = require('../db/shopTz');
const { normalizeDebtMethod } = require('../services/cashMath');

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

// El vínculo turno ↔ cliente de la fila (para la marca "Fila virtual"); se crea solo si falta
let _queueApptCol = null;
function ensureQueueApptColumn() {
  if (!_queueApptCol) {
    _queueApptCol = pool.query('ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS appointment_id INT REFERENCES appointments(id) ON DELETE SET NULL')
      .catch(e => { _queueApptCol = null; console.warn('[APPT] queue_entries.appointment_id:', e.message); });
  }
  return _queueApptCol;
}

// GET /api/appointments?date=YYYY-MM-DD
router.get('/', auth, async (req, res) => {
  const { date } = req.query;
  const shopId = realShopId(req);
  const d = date || shopDate(await getShopTz(shopId));

  console.log(`[GET appts] isBarber=${req.isBarber} shopId=${req.shopId} parentShopId=${req.parentShopId} realShopId=${shopId} date=${d}`);

  try {
    await ensureQueueApptColumn();
    let result;

    if (req.isBarber) {
      // Barbero solo ve SUS turnos
      result = await pool.query(
        `SELECT a.*, COALESCE(c.name, a.client_name) AS client_name, c.phone AS client_phone, c.address AS client_address,
                b.name AS assigned_barber_name,
                EXISTS (SELECT 1 FROM queue_entries q WHERE q.appointment_id = a.id) AS from_queue
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
        `SELECT a.*, COALESCE(c.name, a.client_name) AS client_name, c.phone AS client_phone, c.address AS client_address,
                b.name AS assigned_barber_name,
                EXISTS (SELECT 1 FROM queue_entries q WHERE q.appointment_id = a.id) AS from_queue,
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
        `SELECT a.*, COALESCE(c.name, a.client_name) AS client_name, c.phone AS client_phone, c.address AS client_address,
                b.name AS assigned_barber_name,
                EXISTS (SELECT 1 FROM queue_entries q WHERE q.appointment_id = a.id) AS from_queue
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
    let svcCommissionPct = null; // comisión custom del servicio (null = usar la del barbero)
    if (service_id) {
      const svc = await pool.query('SELECT * FROM services WHERE id=$1 AND shop_id=$2', [service_id, shopId]);
      if (svc.rows.length) {
        svcName = svc.rows[0].name;
        svcCost = svc.rows[0].cost;
        duration = svc.rows[0].duration_minutes || 30;
        if (svc.rows[0].commission_pct !== null && svc.rows[0].commission_pct !== undefined) {
          svcCommissionPct = parseInt(svc.rows[0].commission_pct);
        }
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
    let assignedBarberId = null;
    if (barber_id !== null && barber_id !== undefined && barber_id !== '') {
      const parsed = parseInt(barber_id);
      if (Number.isNaN(parsed)) return res.status(400).json({ error: 'barber_id inválido' });
      // Validar que el barbero pertenezca al shop
      const bCheck = await pool.query(
        'SELECT 1 FROM shops WHERE id=$1 AND parent_shop_id=$2 AND is_barber=TRUE',
        [parsed, shopId]
      );
      if (!bCheck.rows.length) return res.status(400).json({ error: 'Barbero inválido para este shop' });
      assignedBarberId = parsed;
    }

    if (!assignedBarberId && req.isBarber) {
      assignedBarberId = req.shopId;
    }

    if (!assignedBarberId) {
      assignedBarberId = await autoAssignBarber(shopId, date);
    }

    console.log(`[APPT] Auto-asignando barber_id=${assignedBarberId} para shop=${shopId} fecha=${date}`);

    // Obtener comision real del barbero asignado (0 si no hay barbero asignado)
    // Prioridad: comisión custom del servicio > comisión del barbero > 50% default
    let realCommissionPct = 0;
    if (assignedBarberId) {
      if (svcCommissionPct !== null) {
        realCommissionPct = svcCommissionPct;
        console.log(`[APPT] usando commission_pct custom del servicio: ${svcCommissionPct}%`);
      } else {
        realCommissionPct = 50; // default si hay barbero pero sin % configurado
        const barberData = await pool.query(
          'SELECT barber_commission_pct FROM shops WHERE id=$1', [assignedBarberId]
        );
        if (barberData.rows.length && barberData.rows[0].barber_commission_pct) {
          realCommissionPct = parseInt(barberData.rows[0].barber_commission_pct);
        }
        console.log(`[APPT] commission_pct del barbero ${assignedBarberId}: ${realCommissionPct}%`);
      }
    }

    // En alta MANUAL del dueño/barbero se permite overlap: solo rechazamos si
    // hay otro turno con la MISMA hora exacta de inicio para ese barbero.
    // La revisión y el alta van juntas bajo un candado por barbero y día: si llegan dos
    // pedidos a la vez (doble clic, PC lenta) el segundo espera y ve el turno del primero.
    const lockClient = await pool.connect();
    let result;
    try {
      await lockClient.query('BEGIN');
      if (assignedBarberId) {
        await lockClient.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [shopId, `${assignedBarberId}:${date}`]);
        const conflict = await lockClient.query(
          `SELECT id FROM appointments
           WHERE shop_id=$1 AND barber_id=$2 AND date=$3
             AND status NOT IN ('cancelled','noshow')
             AND time_start = $4`,
          [shopId, assignedBarberId, date, time_start]
        );
        if (conflict.rows.length) {
          await lockClient.query('ROLLBACK');
          // Los puntos del premio ya se habían descontado: devolverlos
          if (client_id && redeem_item_id && pointsCost > 0 && redeemInfo) {
            await pool.query('UPDATE clients SET points = points + $1 WHERE id=$2 AND shop_id=$3',
              [pointsCost, parseInt(client_id), shopId]).catch(() => {});
          }
          return res.status(409).json({ error: `El barbero ya tiene un turno a las ${time_start}. Elegí otra hora.` });
        }
      }
      result = await lockClient.query(
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
      await lockClient.query('COMMIT');
    } catch (txErr) {
      try { await lockClient.query('ROLLBACK'); } catch (_) {}
      throw txErr;
    } finally {
      lockClient.release();
    }

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
// Helper: valida y persiste splits de pago para un appointment.
// Si llegan splits válidos, pisa payment_method a 'mixed'.
// _validateSplits devuelve los splits limpios (o null si no vino ninguno) y tira si no suman.
function _validateSplits(price, splits) {
  if (!Array.isArray(splits) || splits.length === 0) return null;
  const clean = splits
    .map(s => ({ method: String(s.method||'').trim(), amount: parseFloat(s.amount) || 0 }))
    .filter(s => s.method && s.amount > 0);
  if (!clean.length) return null;
  const total = clean.reduce((n, s) => n + s.amount, 0);
  const priceN = parseFloat(price || 0);
  // Toleramos ±1 peso de redondeo
  if (priceN > 0 && Math.abs(total - priceN) > 1) {
    throw new Error(`Los pagos ($${total.toFixed(2)}) no suman el precio del servicio ($${priceN.toFixed(2)})`);
  }
  return clean;
}

// Retorna { effectivePaymentMethod, totalPaid }. Borrar + insertar van en una transacción.
async function _writeAppointmentSplits(db, shopId, apptId, clean) {
  const total = clean.reduce((n, s) => n + s.amount, 0);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM payment_splits WHERE appointment_id=$1', [apptId]);
    for (const s of clean) {
      await client.query(
        `INSERT INTO payment_splits (shop_id, appointment_id, method, amount) VALUES ($1,$2,$3,$4)`,
        [shopId, apptId, s.method, s.amount]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
  return {
    effectivePaymentMethod: clean.length === 1 ? clean[0].method : 'mixed',
    totalPaid: total
  };
}

// GET /api/appointments/:id/payment — cómo se cobró un turno (para corregir el cobro)
router.get('/:id/payment', auth, async (req, res) => {
  if (req.isBarber) return res.status(403).json({ error: 'Solo el dueño puede corregir cobros' });
  const shopId = realShopId(req);
  const shopCond = req.isEnterpriseOwner
    ? `(shop_id = $2 OR shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id = $2 AND is_branch = TRUE))`
    : `shop_id = $2`;
  try {
    const q = await pool.query(
      `SELECT * FROM appointments WHERE id=$1 AND ${shopCond}`, [req.params.id, shopId]
    );
    if (!q.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });
    const a = q.rows[0];
    let splits = [];
    try {
      splits = (await pool.query(
        'SELECT method, amount FROM payment_splits WHERE appointment_id=$1 ORDER BY id', [a.id]
      )).rows.map(s => ({ method: s.method, amount: parseFloat(s.amount) }));
    } catch (_) { /* sin tabla de splits */ }
    res.json({
      id: a.id, status: a.status, client_name: a.client_name, service_name: a.service_name,
      price: parseFloat(a.price || 0),
      sena_amount: a.sena_status === 'confirmed' ? parseFloat(a.sena_amount || 0) : 0,
      payment_method: a.payment_method, tip: parseFloat(a.tip || 0), tip_method: a.tip_method || null,
      splits,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/status', auth, async (req, res) => {
  const { status, payment_method, tip, payment_splits, tip_method, edit_payment } = req.body;
  const shopId = realShopId(req);
  const validStatuses = ['pending','confirmed','completed','noshow','cancelled','waiting_sena'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Estado inválido' });
  // Corregir un cobro ya hecho: solo el dueño, y solo sobre un turno cobrado
  if (edit_payment && (req.isBarber || status !== 'completed')) {
    return res.status(403).json({ error: 'Solo el dueño puede corregir un cobro' });
  }

  try {
    const shopConditionStatus = req.isEnterpriseOwner
      ? `(shop_id = $5 OR shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id = $5 AND is_branch = TRUE))`
      : `shop_id = $5`;

    // Barberos solo pueden modificar sus propios turnos
    const barberCondition = req.isBarber ? ` AND barber_id = ${parseInt(req.shopId)}` : '';

    // Capturar status PREVIO para detectar transiciones y evitar doble award de puntos.
    // Nota: shopConditionStatus usa $5 (reusado del UPDATE), acá reescribimos a $2.
    const shopCondPrev = req.isEnterpriseOwner
      ? `(shop_id = $2 OR shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id = $2 AND is_branch = TRUE))`
      : `shop_id = $2`;
    const prevQ = await pool.query(
      `SELECT status, shop_id FROM appointments WHERE id=$1 AND ${shopCondPrev}${barberCondition}`,
      [req.params.id, shopId]
    );
    // Validar pertenencia ANTES de tocar payment_splits (evita borrar/crear splits de turnos ajenos)
    if (!prevQ.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });
    const prevStatus = prevQ.rows[0].status || null;
    const apptShopId = prevQ.rows[0].shop_id;

    // Un turno ya cobrado no se vuelve a cobrar (p.ej. el barbero lo cobró desde su pantalla y
    // la cajera tenía la agenda sin actualizar). Para corregir un cobro se manda edit_payment.
    const isNewCharge = status === 'completed' && prevStatus !== 'completed';
    if (status === 'completed' && prevStatus === 'completed' && !edit_payment) {
      return res.status(409).json({ error: 'Este turno ya fue cobrado. Actualizá la agenda.', code: 'ALREADY_COMPLETED' });
    }
    if (edit_payment && prevStatus !== 'completed') {
      return res.status(400).json({ error: 'Este turno todavía no fue cobrado' });
    }

    // Validar los splits ANTES de tomar el turno (si están mal no se toca nada)
    let effectivePM = await normalizeDebtMethod([apptShopId, shopId], payment_method);
    let splitsToWrite = null;
    if (Array.isArray(payment_splits) && payment_splits.length) {
      // Total a repartir = precio menos la seña ya cobrada (la seña entra a caja por su cuenta)
      const priceQ = await pool.query(
        `SELECT price, CASE WHEN sena_status='confirmed' THEN COALESCE(sena_amount,0) ELSE 0 END AS sena
           FROM appointments WHERE id=$1 AND shop_id=$2`,
        [req.params.id, apptShopId]
      );
      const price = Math.max(parseFloat(priceQ.rows[0]?.price || 0) - parseFloat(priceQ.rows[0]?.sena || 0), 0);
      try { splitsToWrite = _validateSplits(price, payment_splits); }
      catch(spErr) { return res.status(400).json({ error: spErr.message }); }
    }

    // Si lo cobran dos personas a la vez, solo una se queda con el cobro. Estado y método de pago se
    // guardan en el mismo UPDATE: antes se marcaba "completado" primero y el método después, y si el
    // pedido se cortaba en el medio el turno quedaba cobrado sin método (y sin sumar la visita al cliente).
    if (isNewCharge) {
      const claimPM = splitsToWrite ? (splitsToWrite.length === 1 ? splitsToWrite[0].method : 'mixed') : (effectivePM || null);
      const claim = await pool.query(
        `UPDATE appointments SET status='completed',
           payment_method = COALESCE($3::text, payment_method)
         WHERE id=$1 AND shop_id=$2 AND status IS DISTINCT FROM 'completed' RETURNING id`,
        [req.params.id, apptShopId, claimPM]
      );
      if (!claim.rows.length) {
        return res.status(409).json({ error: 'Este turno ya fue cobrado. Actualizá la agenda.', code: 'ALREADY_COMPLETED' });
      }
    }

    // Un turno sin barbero (p.ej. de la fila, llamado desde la caja) se puede asignar al cobrarlo
    if (status === 'completed' && !req.isBarber && req.body.barber_id) {
      const bId = parseInt(req.body.barber_id);
      const bQ = await pool.query(
        'SELECT name, barber_commission_pct FROM shops WHERE id=$1 AND parent_shop_id=$2 AND is_barber=TRUE',
        [bId, apptShopId]
      );
      if (bQ.rows.length) {
        const svcQ = await pool.query(
          `SELECT s.commission_pct FROM appointments a JOIN services s ON s.id=a.service_id WHERE a.id=$1`, [req.params.id]
        );
        const svcPct = svcQ.rows[0]?.commission_pct;
        const pct = (svcPct !== null && svcPct !== undefined) ? parseInt(svcPct)
          : (bQ.rows[0].barber_commission_pct ? parseInt(bQ.rows[0].barber_commission_pct) : 50);
        await pool.query(
          'UPDATE appointments SET barber_id=$1, barber_name=$2, commission_pct=$3 WHERE id=$4 AND shop_id=$5 AND barber_id IS NULL',
          [bId, bQ.rows[0].name, pct, req.params.id, apptShopId]
        );
      }
    }

    if (splitsToWrite) {
      try {
        const r = await _writeAppointmentSplits(pool, apptShopId, parseInt(req.params.id), splitsToWrite);
        effectivePM = r.effectivePaymentMethod;
      } catch (spErr) {
        if (isNewCharge) await pool.query('UPDATE appointments SET status=$1, payment_method=NULL WHERE id=$2', [prevStatus, req.params.id]).catch(() => {});
        throw spErr;
      }
    } else if (status !== 'completed' || payment_method) {
      // Reabrir el turno o cambiar a un método simple invalida los splits viejos.
      // (Si sigue 'completed' sin método nuevo, se conservan: p.ej. solo se edita la propina.)
      await pool.query('DELETE FROM payment_splits WHERE appointment_id=$1 AND shop_id=$2', [req.params.id, apptShopId]).catch(()=>{});
    }

    const tipVal = tip !== undefined ? parseFloat(tip) : null;
    const tipMethodVal = (tipVal && tip_method) ? String(tip_method).trim() : null;
    let result;
    try {
    try {
      result = await pool.query(
        `UPDATE appointments SET status=$1,
           payment_method = CASE WHEN $2::text IS NOT NULL THEN $2::text ELSE payment_method END,
           tip = CASE WHEN $3::numeric IS NOT NULL THEN $3::numeric ELSE tip END,
           tip_method = CASE WHEN $3::numeric IS NOT NULL THEN $6::text ELSE tip_method END
         WHERE id=$4 AND ${shopConditionStatus}${barberCondition} RETURNING *`,
        [status, effectivePM || null, tipVal, req.params.id, shopId, tipMethodVal]
      );
    } catch (tmErr) {
      if (!/tip_method/i.test(tmErr.message)) throw tmErr;
      result = await pool.query(
        `UPDATE appointments SET status=$1,
           payment_method = CASE WHEN $2::text IS NOT NULL THEN $2::text ELSE payment_method END,
           tip = CASE WHEN $3::numeric IS NOT NULL THEN $3::numeric ELSE tip END
         WHERE id=$4 AND ${shopConditionStatus}${barberCondition} RETURNING *`,
        [status, effectivePM || null, tipVal, req.params.id, shopId]
      );
    }
    } catch (upErr) {
      // El cobro no terminó de guardarse: el turno vuelve a como estaba (se puede volver a cobrar)
      if (isNewCharge) {
        await pool.query('UPDATE appointments SET status=$1, payment_method=NULL WHERE id=$2', [prevStatus, req.params.id]).catch(() => {});
        await pool.query('DELETE FROM payment_splits WHERE appointment_id=$1', [req.params.id]).catch(() => {});
      }
      throw upErr;
    }
    if (!result.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });

    const appt = result.rows[0];
    const wasCompleted = prevStatus === 'completed';
    const nowCompleted = status === 'completed';

    // Corrección de un cobro de un día que ya tiene cierre de caja: rehacer ese cierre para que
    // los totales por método (efectivo, transferencia, …) queden con lo corregido
    if (edit_payment) {
      try {
        const day = (await pool.query('SELECT date::text AS d FROM appointments WHERE id=$1', [appt.id])).rows[0].d;
        const has = await pool.query('SELECT 1 FROM cash_registers WHERE shop_id=$1 AND date=$2', [appt.shop_id, day]);
        if (has.rows.length) {
          const { computeDayClose, saveDayClose } = require('../services/cashMath');
          await saveDayClose(appt.shop_id, day, await computeDayClose(appt.shop_id, day));
        }
      } catch (e) { console.warn('[APPT] recalcular cierre tras corregir cobro:', e.message); }
    }

    // Si el turno venía de la fila virtual, cobrarlo / cancelarlo cierra también al cliente en la fila
    // (así deja de aparecer "en el sillón" en la pantalla del barbero)
    if (status === 'completed' || status === 'cancelled' || status === 'noshow') {
      const closeSql = status === 'completed'
        ? `UPDATE queue_entries SET status='served', served_at=COALESCE(served_at, NOW())
            WHERE appointment_id=$1 AND status IN ('waiting','called')`
        : `UPDATE queue_entries SET status='left'
            WHERE appointment_id=$1 AND status IN ('waiting','called')`;
      try { await pool.query(closeSql, [appt.id]); }
      catch (e) { console.warn('[APPT] cerrar entrada de la fila:', e.message); }
    }

    // SSE: broadcast cambio de status para refrescar agendas abiertas en vivo
    try {
      const sse = require('../services/sse');
      // Al local del turno y a su cuenta Enterprise (si es sucursal)
      sse.emitShop(appt.shop_id, 'appointment.updated', {
        id: appt.id, shop_id: appt.shop_id, status: appt.status,
        date: appt.date, time_start: appt.time_start, barber_id: appt.barber_id,
      }).catch(() => {});
    } catch(_) {}


    // Si es fiado, registrar deuda
    if (status === 'completed' && effectivePM === 'debt') {
      await pool.query(
        `INSERT INTO client_debts (shop_id, client_id, client_name, appointment_id, amount, description)
         SELECT $1::int, $2::int, $3::text, $4::int, $5::numeric, $6::text
          WHERE NOT EXISTS (SELECT 1 FROM client_debts WHERE appointment_id=$4::int AND paid=FALSE)`,
        [appt.shop_id, appt.client_id || null, appt.client_name, appt.id,
         // La seña ya cobrada no es deuda
         Math.max(parseFloat(appt.price || 0) - (appt.sena_status === 'confirmed' ? parseFloat(appt.sena_amount || 0) : 0), 0),
         `Turno ${appt.service_name || ''} - ${appt.date}`]
      );
      console.log(`[CAJA] Deuda registrada para ${appt.client_name}: $${appt.price}`);
    }
    // Si el turno deja de ser fiado (se reabre, se cancela o se corrige el método),
    // la deuda pendiente que había generado ya no existe
    const stillDebt = status === 'completed' && appt.payment_method === 'debt';
    if (!stillDebt && (wasCompleted || prevStatus === 'completed')) {
      await pool.query('DELETE FROM client_debts WHERE appointment_id=$1 AND paid=FALSE', [appt.id])
        .catch(e => console.warn('[APPT] limpiar deuda:', e.message));
    }

    // Notificar al cliente cuando el turno es confirmado
    // Fix #3: usar enterprise owner para WPP si la sucursal no tiene socket propio
    // En segundo plano: con el ritmo anti-baneo el envío puede tardar varios segundos y la
    // pantalla no tiene que esperarlo.
    if (status === 'confirmed' && appt.client_id) (async () => {
      try {
        const shopData = (await pool.query('SELECT name, wpp_connected, booking_slug, parent_enterprise_id FROM shops WHERE id=$1', [appt.shop_id])).rows[0];
        const client = (await pool.query('SELECT name, phone FROM clients WHERE id=$1', [appt.client_id])).rows[0];
        const wpp = require('../services/whatsapp');
        // Sale del WhatsApp del local del turno (o del enterprise si corresponde: lo decide sendText)
        if (client?.phone && await wpp.autoEnabled(appt.shop_id, 'confirm') && await wpp.hasWhatsApp(appt.shop_id)) {
          const { generateMessage } = require('../services/ai');
          const wppShopId = appt.shop_id;
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
          await wpp.sendText(wppShopId, client.phone, msg, { category: 'confirm' });
        }
      } catch (wppErr) {
        console.error('[appointments] Error enviando WPP confirmado:', wppErr.message);
      }
    })();

    // Si el turno pasa a cancelled/noshow, devolver el premio canjeado (si lo había)
    if (['cancelled','noshow'].includes(status) && prevStatus !== status) {
      try {
        const redQ = await pool.query(
          `SELECT id, client_id, item_id, points_used FROM points_redemptions
           WHERE appointment_id=$1 AND shop_id=$2 AND status='pending'`,
          [appt.id, appt.shop_id]
        );
        for (const red of redQ.rows) {
          if (red.client_id) {
            await pool.query(`UPDATE clients SET points = points + $1 WHERE id=$2 AND shop_id=$3`,
              [red.points_used, red.client_id, appt.shop_id]);
          }
          if (red.item_id) {
            await pool.query(`UPDATE points_store SET stock = stock + 1 WHERE id=$1 AND shop_id=$2 AND stock IS NOT NULL`,
              [red.item_id, appt.shop_id]);
          }
          await pool.query(`UPDATE points_redemptions SET status='cancelled' WHERE id=$1`, [red.id]);
          console.log(`[APPT ${appt.id}] status=${status} → redemption ${red.id} refund: +${red.points_used} pts`);
        }
      } catch(e) { console.error('[APPT] refund redemption error:', e.message); }
    }

    // Rollback de puntos si el turno sale de 'completed' (ej: dueño lo marcó completed por error)
    if (wasCompleted && !nowCompleted && appt.client_id) {
      try {
        const shop = await pool.query('SELECT points_per_peso FROM shops WHERE id=$1', [shopId]);
        const rawPpp = shop.rows[0]?.points_per_peso;
        const pointsPerPeso = (rawPpp === null || rawPpp === undefined || rawPpp === '') ? 0.01 : parseFloat(rawPpp);
        const pointsToRemove = Math.floor(parseFloat(appt.price || 0) * pointsPerPeso) + (parseInt(appt.bonus_points) || 0);
        if (parseInt(appt.bonus_points) > 0) {
          await pool.query('UPDATE appointments SET bonus_points=0 WHERE id=$1', [appt.id]).catch(() => {});
        }
        if (pointsToRemove > 0 || parseFloat(appt.price || 0) > 0) {
          await pool.query(
            `UPDATE clients SET
               total_visits = GREATEST(total_visits - 1, 0),
               total_spent  = GREATEST(total_spent - $1::numeric, 0),
               points       = GREATEST(points - $2::int, 0)
             WHERE id = $3::int AND shop_id = $4::int`,
            [parseFloat(appt.price || 0), parseInt(pointsToRemove) || 0, appt.client_id, shopId]
          );
          console.log(`[APPT ${appt.id}] rollback: -${pointsToRemove} pts, -$${appt.price} de cliente ${appt.client_id}`);
        }
      } catch(e) { console.error('[APPT] rollback points error:', e.message); }
    }

    // Actualizar stats del cliente al completar (SOLO si no estaba ya completado — evita doble award)
    // Fix #3: usar enterprise owner para WPP si la sucursal no tiene socket propio
    if (status === 'completed' && !wasCompleted && appt.client_id) try {
      // Solo las columnas que se usan (SELECT * traía también la sesión de WhatsApp, que pesa)
      const shop = await pool.query('SELECT points_per_peso, msg_templates FROM shops WHERE id=$1', [shopId]);
      const shopData = shop.rows[0];
      const rawPpp = shopData.points_per_peso;
      const pointsPerPeso = (rawPpp === null || rawPpp === undefined || rawPpp === '') ? 0.01 : parseFloat(rawPpp);
      const basePoints = Math.floor(parseFloat(appt.price || 0) * pointsPerPeso);
      // Bonus por haber elegido "cualquier profesional" (si el local lo tiene activo)
      let bonus = 0;
      if (appt.any_barber) {
        try {
          const ab = require('../services/anyBarberBonus');
          bonus = ab.bonusPoints(basePoints, await ab.getBonusConfig(appt.shop_id));
          if (bonus > 0) await pool.query('UPDATE appointments SET bonus_points=$1 WHERE id=$2', [bonus, appt.id]);
        } catch (e) { console.warn('[APPT] bonus cualquier profesional:', e.message); bonus = 0; }
      }
      const pointsEarned = basePoints + bonus;

      const updatedClient = await pool.query(
        `UPDATE clients SET
           total_visits = total_visits + 1,
           total_spent  = total_spent + $1,
           last_visit   = $2,
           points       = points + $3
         WHERE id = $4 AND shop_id = $5
         RETURNING id, name, phone, points`,
        [appt.price, appt.date, pointsEarned, appt.client_id, shopId]
      );
      if (!updatedClient.rows.length) {
        console.warn(`[APPT] cliente ${appt.client_id} no pertenece al shop ${shopId}, no se actualizan puntos`);
      }

      const client = updatedClient.rows[0];

      // El "gracias + puntos" sale en segundo plano: cobrar no espera a WhatsApp ni a la IA
      if (client && client.phone) (async () => {
        try {
          const wpp = require('../services/whatsapp');
          if (!(await wpp.autoEnabled(appt.shop_id, 'thanks')) || !(await wpp.hasWhatsApp(appt.shop_id))) return;
          const { generateMessage } = require('../services/ai');
          const wppShopId = appt.shop_id;
          // Sin link: un link en un mensaje que el cliente no pidió aumenta el riesgo de que
          // WhatsApp lo tome como spam
          const tiendaLink = null;

          let msg = await generateMessage(shopId, 'turno_completado', {
            clientName: client.name,
            pointsEarned,
            totalPoints: client.points,
            tiendaLink
          });

          if (!msg) {
            const tpls = shopData.msg_templates ? JSON.parse(shopData.msg_templates) : {};
            const tplBase = tpls.completado || '✂️ *¡Gracias {nombre}!*\n⭐ Sumaste +{puntos} puntos (total: {total}).\n¡Hasta la próxima! 💈';
            msg = wpp.renderTemplate(tplBase, {
              nombre: client.name,
              puntos: pointsEarned,
              total:  client.points,
              link:   tiendaLink || ''
            });
          }

          msg = String(msg).replace(/https?:\/\/\S+/g, '').replace(/[ \t]+\n/g, '\n').trim();
          await wpp.sendText(wppShopId, client.phone, msg, { category: 'thanks' });
        } catch(wppErr) {
          console.error('Error enviando WPP puntos:', wppErr.message);
        }
      })();
    } catch (stErr) {
      // El cobro ya quedó guardado: no se responde error (la pantalla creería que no se cobró)
      console.error(`[APPT ${appt.id}] cobrado, pero no se pudo sumar la visita/puntos al cliente ${appt.client_id}:`, stErr.message);
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

  // Barberos no pueden reasignar turno a otro barbero: ignoramos el campo si viene
  const hasBarberField = !req.isBarber && Object.prototype.hasOwnProperty.call(req.body, 'barber_id');
  const newBarberId = hasBarberField
    ? (req.body.barber_id === null || req.body.barber_id === '' ? null : parseInt(req.body.barber_id))
    : undefined;

  // Barberos solo pueden editar sus propios turnos
  const barberCondition = req.isBarber ? ` AND barber_id = ${parseInt(req.shopId)}` : '';

  try {
    // Al reasignar barbero, validar que pertenezca al shop y permitir overlap
    // (solo rechazamos si otro turno del mismo barbero empieza EXACTAMENTE a la misma hora).
    if (hasBarberField && newBarberId) {
      if (Number.isNaN(newBarberId)) return res.status(400).json({ error: 'barber_id inválido' });
      const bCheck = await pool.query(
        'SELECT 1 FROM shops WHERE id=$1 AND parent_shop_id=$2 AND is_barber=TRUE',
        [newBarberId, shopId]
      );
      if (!bCheck.rows.length) return res.status(400).json({ error: 'Barbero inválido para este shop' });
      const curr = await pool.query('SELECT date, time_start FROM appointments WHERE id=$1 AND shop_id=$2', [req.params.id, shopId]);
      if (!curr.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });
      const d  = curr.rows[0].date;
      const ts = time_start || curr.rows[0].time_start;
      const conflict = await pool.query(
        `SELECT id FROM appointments
         WHERE shop_id=$1 AND barber_id=$2 AND date=$3 AND id<>$4
           AND status NOT IN ('cancelled','noshow')
           AND time_start = $5`,
        [shopId, newBarberId, d, req.params.id, ts]
      );
      if (conflict.rows.length) {
        return res.status(409).json({ error: `El barbero ya tiene un turno a las ${ts}. Elegí otra hora.` });
      }
    }

    // Recalcular commission_pct si cambia el barbero (respeta comisión custom del servicio)
    let newCommissionPct = null;
    if (hasBarberField) {
      const curr = await pool.query('SELECT service_id FROM appointments WHERE id=$1 AND shop_id=$2', [req.params.id, shopId]);
      if (curr.rows.length) {
        let svcPct = null;
        if (curr.rows[0].service_id) {
          const svc = await pool.query('SELECT commission_pct FROM services WHERE id=$1 AND shop_id=$2', [curr.rows[0].service_id, shopId]);
          if (svc.rows.length && svc.rows[0].commission_pct !== null && svc.rows[0].commission_pct !== undefined) {
            svcPct = parseInt(svc.rows[0].commission_pct);
          }
        }
        if (newBarberId === null) {
          newCommissionPct = 0;
        } else if (svcPct !== null) {
          newCommissionPct = svcPct;
        } else {
          const b = await pool.query('SELECT barber_commission_pct FROM shops WHERE id=$1', [newBarberId]);
          newCommissionPct = (b.rows.length && b.rows[0].barber_commission_pct) ? parseInt(b.rows[0].barber_commission_pct) : 50;
        }
      }
    }

    const priceBeforeQ = price !== undefined
      ? await pool.query('SELECT price, commission_settled FROM appointments WHERE id=$1 AND shop_id=$2', [req.params.id, shopId])
      : { rows: [] };
    const priceBefore = priceBeforeQ.rows.length ? parseFloat(priceBeforeQ.rows[0].price || 0) : null;
    // Con la comisión ya pagada al barbero, cambiar el precio (o el barbero) dejaría la liquidación mal
    const settledQ = (price !== undefined || hasBarberField)
      ? await pool.query('SELECT price, barber_id, commission_settled FROM appointments WHERE id=$1 AND shop_id=$2', [req.params.id, shopId])
      : { rows: [] };
    const settled = settledQ.rows[0];
    if (settled && settled.commission_settled) {
      const priceChanges  = price !== undefined && Math.abs(parseFloat(price) - parseFloat(settled.price || 0)) > 0.005;
      const barberChanges = hasBarberField && (newBarberId || null) !== (settled.barber_id || null);
      if (priceChanges || barberChanges) {
        return res.status(409).json({ error: 'La comisión de este turno ya se liquidó al barbero: no se puede cambiar el precio ni el barbero.' });
      }
    }

    const result = await pool.query(
      `UPDATE appointments SET
         client_name    = COALESCE($1, client_name),
         time_start     = COALESCE($2, time_start),
         time_end       = COALESCE($3, time_end),
         price          = COALESCE($4, price),
         status         = COALESCE($5, status),
         barber_id      = CASE WHEN $8::boolean THEN $9::int ELSE barber_id END,
         commission_pct = CASE WHEN $8::boolean THEN $10::int ELSE commission_pct END
       WHERE id=$6 AND shop_id=$7${barberCondition} RETURNING *`,
      [client_name||null, time_start||null, time_end||null,
       price !== undefined ? parseFloat(price) : null,
       status||null, req.params.id, shopId,
       hasBarberField, newBarberId, newCommissionPct]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });
    const edited = result.rows[0];

    // Si el turno ya estaba cobrado y cambió el precio, mantener coherentes splits y deuda.
    const newPrice = parseFloat(edited.price || 0);
    if (edited.status === 'completed' && priceBefore !== null && Math.abs(newPrice - priceBefore) > 0.005) {
      const sena = edited.sena_status === 'confirmed' ? parseFloat(edited.sena_amount || 0) : 0;
      const target = Math.max(newPrice - sena, 0);   // lo que se cobra por métodos (la seña entra aparte)
      try {
        // Splits: se reescalan proporcionalmente; el último absorbe el redondeo
        const sp = await pool.query(
          'SELECT id, amount FROM payment_splits WHERE appointment_id=$1 ORDER BY id', [edited.id]
        );
        const oldTotal = sp.rows.reduce((n, r) => n + parseFloat(r.amount), 0);
        if (sp.rows.length && oldTotal > 0) {
          let acc = 0;
          for (let i = 0; i < sp.rows.length; i++) {
            const isLast = i === sp.rows.length - 1;
            const amt = isLast ? Math.round((target - acc) * 100) / 100
                               : Math.round(target * parseFloat(sp.rows[i].amount) / oldTotal * 100) / 100;
            acc += amt;
            await pool.query('UPDATE payment_splits SET amount=$1 WHERE id=$2', [Math.max(amt, 0), sp.rows[i].id]);
          }
        }
      } catch (spErr) {
        if (!/payment_splits/i.test(spErr.message)) console.error('[APPT] resync splits:', spErr.message);
      }
      // Deuda pendiente: ajustar el monto. Si ya fue cobrada no se toca (la plata ya entró a caja).
      await pool.query(
        `UPDATE client_debts SET amount=$1 WHERE appointment_id=$2 AND paid=FALSE`,
        [target, edited.id]
      ).catch(() => {});
    }

    res.json(edited);
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

    // Al confirmar seña → registrar como ingreso en caja
    if (action === 'confirm' && appt.sena_amount > 0) {
      try {
        // Usar el método de pago configurado para señas, o 'transfer' como default
        const shopCfg = await pool.query('SELECT sena_payment_method, timezone FROM shops WHERE id=$1', [appt.shop_id]);
        const today = shopDate(shopCfg.rows[0]?.timezone);
        const senaPayMethod = shopCfg.rows[0]?.sena_payment_method || 'transfer';
        await pool.query(
          `INSERT INTO expenses (shop_id, amount, category, description, date, is_income, source_type, source_id, payment_method)
           VALUES ($1, $2, 'otros', $3, $4, TRUE, 'sena', $5, $6)
           ON CONFLICT DO NOTHING`,
          [appt.shop_id, parseFloat(appt.sena_amount),
           `Seña - ${appt.client_name || 'Sin nombre'}`,
           today, appt.id, senaPayMethod]
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

    // Barberos solo pueden borrar sus propios turnos
    const barberCondition = req.isBarber ? ` AND barber_id = ${parseInt(req.shopId)}` : '';

    // Capturar datos del turno ANTES del delete para hacer rollback de puntos/stats y redemption.
    // Reescribimos la condición a $2 (shopConditionDel usa $2 también, verificar).
    const shopCondDelSelect = req.isEnterpriseOwner
      ? `(shop_id = $2 OR shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id = $2 AND is_branch = TRUE))`
      : `shop_id = $2`;
    const apptQ = await pool.query(
      `SELECT * FROM appointments
       WHERE id=$1 AND ${shopCondDelSelect}${barberCondition}`,
      [req.params.id, shopId]
    );
    if (!apptQ.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });
    const apptBefore = apptQ.rows[0];
    if (apptBefore.commission_settled) {
      return res.status(409).json({ error: 'La comisión de este turno ya se liquidó al barbero: no se puede borrar.' });
    }
    // La deuda pendiente de un fiado borrado deja de existir
    await pool.query('DELETE FROM client_debts WHERE appointment_id=$1 AND paid=FALSE', [apptBefore.id]).catch(() => {});

    // Rollback de redemption asociado (devuelve puntos + stock + marca el canje como cancelado)
    try {
      const redQ = await pool.query(
        `SELECT id, client_id, item_id, points_used, status FROM points_redemptions
         WHERE appointment_id=$1 AND shop_id=$2 AND status='pending'`,
        [apptBefore.id, apptBefore.shop_id]
      );
      for (const red of redQ.rows) {
        if (red.client_id) {
          await pool.query(
            `UPDATE clients SET points = points + $1 WHERE id=$2 AND shop_id=$3`,
            [red.points_used, red.client_id, apptBefore.shop_id]
          );
        }
        if (red.item_id) {
          // Si el item tiene stock, lo devolvemos (si es NULL = ilimitado, no toca)
          await pool.query(
            `UPDATE points_store SET stock = stock + 1
             WHERE id=$1 AND shop_id=$2 AND stock IS NOT NULL`,
            [red.item_id, apptBefore.shop_id]
          );
        }
        await pool.query(
          `UPDATE points_redemptions SET status='cancelled' WHERE id=$1`,
          [red.id]
        );
        console.log(`[APPT ${apptBefore.id}] redemption ${red.id} cancelled: +${red.points_used} pts, +1 stock`);
      }
    } catch(e) { console.error('[APPT] rollback redemption error:', e.message); }

    // Si estaba completed, revertir stats y puntos ganados por el turno
    if (apptBefore.status === 'completed' && apptBefore.client_id) {
      try {
        const shop = await pool.query('SELECT points_per_peso FROM shops WHERE id=$1', [apptBefore.shop_id]);
        const rawPpp = shop.rows[0]?.points_per_peso;
        const pointsPerPeso = (rawPpp === null || rawPpp === undefined || rawPpp === '') ? 0.01 : parseFloat(rawPpp);
        const pointsToRemove = Math.floor(parseFloat(apptBefore.price || 0) * pointsPerPeso) + (parseInt(apptBefore.bonus_points) || 0);
        await pool.query(
          `UPDATE clients SET
             total_visits = GREATEST(total_visits - 1, 0),
             total_spent  = GREATEST(total_spent - $1, 0),
             points       = GREATEST(points - $2, 0)
           WHERE id = $3 AND shop_id = $4`,
          [apptBefore.price, pointsToRemove, apptBefore.client_id, apptBefore.shop_id]
        );
      } catch(e) { console.error('[APPT] rollback stats error:', e.message); }
    }

    const result = await pool.query(
      `DELETE FROM appointments WHERE id=$1 AND ${shopConditionDel}${barberCondition} RETURNING id`,
      [req.params.id, shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
