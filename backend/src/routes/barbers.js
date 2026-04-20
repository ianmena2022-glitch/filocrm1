const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');
const crypto = require('crypto');

// Middleware: solo dueños (no barberos)
function ownerOnly(req, res, next) {
  if (req.isBarber) return res.status(403).json({ error: 'Solo el dueño puede hacer esto' });
  next();
}

// GET /api/barbers — listar barberos del equipo
router.get('/', auth, ownerOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, barber_commission_pct, barber_color, barber_schedule, created_at,
         (SELECT COUNT(*) FROM appointments WHERE barber_id=s.id AND date=CURRENT_DATE AND status NOT IN ('cancelled','noshow')) AS turnos_hoy
       FROM shops s WHERE parent_shop_id=$1 AND is_barber=TRUE ORDER BY name`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/barbers/invite — generar código de invitación
router.post('/invite', auth, ownerOnly, async (req, res) => {
  const { barber_name } = req.body;

  // Verificar límite de 10 barberos
  const count = await pool.query(
    'SELECT COUNT(*) FROM shops WHERE parent_shop_id=$1 AND is_barber=TRUE',
    [req.shopId]
  );
  if (parseInt(count.rows[0].count) >= 10) {
    return res.status(400).json({ error: 'Límite de 10 barberos alcanzado' });
  }

  try {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase(); // ej: A3F2B1C4
    await pool.query(
      'INSERT INTO staff_invites (shop_id, code, barber_name) VALUES ($1, $2, $3)',
      [req.shopId, code, barber_name || null]
    );

    const baseUrl = process.env.APP_URL || 'https://filocrm1-production.up.railway.app';
    const link = `${baseUrl}/app?invite=${code}`;
    res.json({ ok: true, code, link, expires_in: '7 días' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/barbers/:id — editar barbero (comisión, color, horarios)
router.put('/:id', auth, ownerOnly, async (req, res) => {
  const { barber_commission_pct, barber_color, name, barber_schedule } = req.body;
  try {
    // barber_schedule puede ser null (sin restricciones) o un objeto con días
    const scheduleVal = barber_schedule !== undefined
      ? (barber_schedule ? JSON.stringify(barber_schedule) : null)
      : undefined;

    const result = await pool.query(
      `UPDATE shops SET
         barber_commission_pct = COALESCE($1, barber_commission_pct),
         barber_color = COALESCE($2, barber_color),
         name = COALESCE($3, name),
         barber_schedule = CASE WHEN $6 THEN $5::jsonb ELSE barber_schedule END
       WHERE id=$4 AND parent_shop_id=$7
       RETURNING id, name, barber_commission_pct, barber_color, barber_schedule`,
      [
        barber_commission_pct || null,
        barber_color || null,
        name || null,
        req.params.id,
        scheduleVal || null,
        barber_schedule !== undefined, // $6: si se envió el campo
        req.shopId
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Barbero no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/barbers/:id — eliminar barbero del equipo
router.delete('/:id', auth, ownerOnly, async (req, res) => {
  try {
    await pool.query(
      'UPDATE shops SET parent_shop_id=NULL, is_barber=FALSE WHERE id=$1 AND parent_shop_id=$2',
      [req.params.id, req.shopId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/barbers/stats — stats del equipo para el dashboard del dueño
router.get('/stats', auth, ownerOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.name, s.barber_color, s.barber_commission_pct,
  COUNT(a.id) FILTER (WHERE a.date = CURRENT_DATE AND a.status NOT IN ('cancelled','noshow')) AS turnos_hoy,
  COUNT(a.id) FILTER (WHERE a.status = 'completed' AND date_trunc('month', a.date::timestamptz) = date_trunc('month', NOW())) AS completados_mes,
  COALESCE(SUM(a.price) FILTER (WHERE a.status = 'completed' AND date_trunc('month', a.date::timestamptz) = date_trunc('month', NOW())), 0) AS facturado_mes,
  COALESCE(SUM(a.price * a.commission_pct / 100.0) FILTER (WHERE a.status = 'completed' AND date_trunc('month', a.date::timestamptz) = date_trunc('month', NOW())), 0) AS comision_mes,
  COALESCE(SUM(a.price * a.commission_pct / 100.0) FILTER (WHERE a.status = 'completed' AND (a.commission_settled IS NULL OR a.commission_settled = FALSE)), 0)
  + COALESCE((SELECT SUM(ps.barber_commission_amount) FROM product_sales ps WHERE ps.barber_id=s.id AND ps.commission_settled=FALSE AND ps.shop_id=$1), 0)
  AS pending_commission,
  COUNT(a.id) FILTER (WHERE a.status = 'completed' AND (a.commission_settled IS NULL OR a.commission_settled = FALSE)) AS pending_appointments,
  COALESCE((SELECT COUNT(*) FROM product_sales ps WHERE ps.barber_id=s.id AND ps.commission_settled=FALSE AND ps.shop_id=$1), 0) AS pending_product_sales
FROM shops s
LEFT JOIN appointments a ON a.barber_id = s.id
  AND (a.shop_id = $1 OR a.shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id = $1 AND is_branch = TRUE))
WHERE s.parent_shop_id = $1 AND s.is_barber = TRUE
GROUP BY s.id, s.name, s.barber_color, s.barber_commission_pct
ORDER BY s.name`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/barbers/assign — asignar turno al barbero con menos turnos hoy
router.post('/assign', auth, async (req, res) => {
  const { appointment_id } = req.body;
  const ownerShopId = req.isBarber ? req.parentShopId : req.shopId;

  try {
    // Obtener barbero con menos turnos hoy
    const result = await pool.query(
      `SELECT s.id, s.name,
         COUNT(a.id) FILTER (WHERE a.date = CURRENT_DATE AND a.status NOT IN ('cancelled','noshow')) AS turnos_hoy
       FROM shops s
       LEFT JOIN appointments a ON a.barber_id = s.id AND a.shop_id = $1
       WHERE s.parent_shop_id = $1 AND s.is_barber = TRUE
       GROUP BY s.id, s.name
       ORDER BY turnos_hoy ASC, RANDOM()
       LIMIT 1`,
      [ownerShopId]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'No hay barberos disponibles' });
    const barber = result.rows[0];

    await pool.query(
      'UPDATE appointments SET barber_id=$1, barber_name=$2 WHERE id=$3 AND shop_id=$4',
      [barber.id, barber.name, appointment_id, ownerShopId]
    );

    res.json({ ok: true, barber });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/barbers/parent-config — config de la cuenta principal (para barberos)
router.get('/parent-config', auth, async (req, res) => {
  try {
    const parentId = req.parentShopId || req.shopId;
    const result = await pool.query(
      'SELECT commission_enabled, name FROM shops WHERE id=$1',
      [parentId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Shop no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/barbers/:id/pending-settlement — turnos completados sin liquidar
router.get('/:id/pending-settlement', auth, ownerOnly, async (req, res) => {
  try {
    const barberQ = await pool.query(
      'SELECT id, name, barber_commission_pct FROM shops WHERE id=$1 AND parent_shop_id=$2 AND is_barber=TRUE',
      [req.params.id, req.shopId]
    );
    if (!barberQ.rows.length) return res.status(404).json({ error: 'Barbero no encontrado' });
    const barber = barberQ.rows[0];

    const appts = await pool.query(
      `SELECT id, date, time_start, service_name, price, commission_pct
       FROM appointments
       WHERE shop_id=$1 AND barber_id=$2 AND status='completed'
         AND (commission_settled IS NULL OR commission_settled=FALSE)
       ORDER BY date DESC`,
      [req.shopId, barber.id]
    );

    const totalPrice = appts.rows.reduce((s, a) => s + parseFloat(a.price || 0), 0);
    const apptCommission = appts.rows.reduce((s, a) => {
      const pct = parseInt(a.commission_pct || barber.barber_commission_pct || 50);
      return s + parseFloat(a.price || 0) * pct / 100;
    }, 0);

    const productSalesQ = await pool.query(
      `SELECT id, product_name, total_price, barber_commission_pct, barber_commission_amount, sold_at
       FROM product_sales
       WHERE barber_id=$1 AND shop_id=$2 AND commission_settled=FALSE
       ORDER BY sold_at DESC`,
      [barber.id, req.shopId]
    );
    const productCommission = productSalesQ.rows.reduce((s, ps) => s + parseFloat(ps.barber_commission_amount || 0), 0);
    const totalCommission = apptCommission + productCommission;

    res.json({
      barber,
      appointments: appts.rows,
      count: appts.rows.length,
      total_price: totalPrice,
      appt_commission: apptCommission,
      product_sales: productSalesQ.rows,
      product_commission: productCommission,
      commission_amount: totalCommission
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/barbers/:id/settle — crear liquidación
router.post('/:id/settle', auth, ownerOnly, async (req, res) => {
  const { notes } = req.body;
  try {
    const barberQ = await pool.query(
      'SELECT id, name, barber_commission_pct FROM shops WHERE id=$1 AND parent_shop_id=$2 AND is_barber=TRUE',
      [req.params.id, req.shopId]
    );
    if (!barberQ.rows.length) return res.status(404).json({ error: 'Barbero no encontrado' });
    const barber = barberQ.rows[0];

    const appts = await pool.query(
      `SELECT id, price, commission_pct FROM appointments
       WHERE shop_id=$1 AND barber_id=$2 AND status='completed'
         AND (commission_settled IS NULL OR commission_settled=FALSE)`,
      [req.shopId, barber.id]
    );

    const productSalesQ = await pool.query(
      `SELECT id, barber_commission_amount FROM product_sales
       WHERE barber_id=$1 AND shop_id=$2 AND commission_settled=FALSE`,
      [barber.id, req.shopId]
    );

    if (!appts.rows.length && !productSalesQ.rows.length) {
      return res.status(400).json({ error: 'No hay comisiones pendientes para liquidar' });
    }

    const totalPrice = appts.rows.reduce((s, a) => s + parseFloat(a.price || 0), 0);
    const apptCommission = appts.rows.reduce((s, a) => {
      const pct = parseInt(a.commission_pct || barber.barber_commission_pct || 50);
      return s + parseFloat(a.price || 0) * pct / 100;
    }, 0);
    const productCommission = productSalesQ.rows.reduce((s, ps) => s + parseFloat(ps.barber_commission_amount || 0), 0);
    const commissionAmount = apptCommission + productCommission;

    const notesExtra = [
      appts.rows.length ? `${appts.rows.length} turno${appts.rows.length !== 1 ? 's' : ''}` : null,
      productSalesQ.rows.length ? `${productSalesQ.rows.length} venta${productSalesQ.rows.length !== 1 ? 's' : ''} de producto` : null,
    ].filter(Boolean).join(' · ');

    const settlement = await pool.query(
      `INSERT INTO barber_settlements (shop_id, barber_id, barber_name, appointments_count, total_price, commission_pct_avg, commission_amount, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.shopId, barber.id, barber.name, appts.rows.length, totalPrice, barber.barber_commission_pct, commissionAmount,
       notes ? `${notes} — ${notesExtra}` : notesExtra]
    );

    if (appts.rows.length) {
      const apptIds = appts.rows.map(a => a.id);
      await pool.query(
        `UPDATE appointments SET commission_settled=TRUE, commission_settled_at=NOW(), settlement_id=$1
         WHERE id = ANY($2::int[])`,
        [settlement.rows[0].id, apptIds]
      );
    }

    if (productSalesQ.rows.length) {
      await pool.query(
        `UPDATE product_sales SET commission_settled=TRUE, settlement_id=$1
         WHERE barber_id=$2 AND shop_id=$3 AND commission_settled=FALSE`,
        [settlement.rows[0].id, barber.id, req.shopId]
      );
    }

    // Registrar egreso en caja
    await pool.query(
      `INSERT INTO expenses (shop_id, amount, category, description, is_income, source_type, source_id)
       VALUES ($1,$2,'comisiones',$3,FALSE,'barber_settlement',$4)`,
      [req.shopId, commissionAmount,
       `Comisión ${barber.name} — ${notesExtra}`,
       settlement.rows[0].id]
    );

    res.json({ ok: true, settlement: settlement.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/barbers/:id/settlements — historial de liquidaciones
router.get('/:id/settlements', auth, ownerOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM barber_settlements WHERE shop_id=$1 AND barber_id=$2 ORDER BY settled_at DESC`,
      [req.shopId, req.params.id]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
