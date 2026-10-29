const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');
const { getShopTz, shopDate } = require('../db/shopTz');
const { computeNet, dayCommissions, computeDayClose, saveDayClose, methodMovementsForDay, methodFlowForDay, dailySeries, monthReport } = require("../services/cashMath");

// GET /api/dashboard/today
router.get('/today', auth, async (req, res) => {
  const shopId = req.shopId;
  const today  = shopDate(await getShopTz(shopId));
  const isEnterpriseOwner = req.isEnterpriseOwner || false;

  // Filtro de shop_id: enterprise owner incluye sus sucursales
  const shopFilter = isEnterpriseOwner
    ? `(a.shop_id = $1 OR a.shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id = $1 AND is_branch = TRUE))`
    : `a.shop_id = $1`;
  const shopFilterPlain = isEnterpriseOwner
    ? `(shop_id = $1 OR shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id = $1 AND is_branch = TRUE))`
    : `shop_id = $1`;

  try {
    // Métricas del día (turnos + ventas de productos)
    const [metricsQ, prodRevenueQ] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status='completed' AND payment_method IS DISTINCT FROM 'debt' THEN price ELSE 0 END), 0) AS revenue,
           COALESCE(SUM(CASE WHEN status='completed' AND payment_method IS DISTINCT FROM 'debt' THEN price - COALESCE(cost,0) - (price * COALESCE(commission_pct,0) / 100.0) ELSE 0 END), 0) AS net_profit,
           COUNT(CASE WHEN status='completed' THEN 1 END)                                 AS completed,
           COUNT(CASE WHEN status='pending' OR status='confirmed' OR status='waiting_sena' THEN 1 END) AS pending,
           COUNT(CASE WHEN status='noshow' THEN 1 END)                                    AS noshows
         FROM appointments
         WHERE ${shopFilterPlain} AND date = $2`,
        [shopId, today]
      ),
      // Ventas de productos del día (las mismas que entran a la caja, con la fecha del local)
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS prod_revenue,
                COUNT(*) AS prod_count
         FROM expenses
         WHERE shop_id=$1 AND date = $2::date AND is_income=TRUE AND source_type='product_sale'`,
        [shopId, today]
      ),
    ]);
    const prodRevToday = parseFloat(prodRevenueQ.rows[0].prod_revenue);

    // Turnos del día completos con info del cliente
    const apptsQ = await pool.query(
      `SELECT a.*, c.name AS client_name, c.phone AS client_phone,
              s.name AS branch_name
       FROM appointments a
       LEFT JOIN clients c ON c.id = a.client_id
       LEFT JOIN shops s ON s.id = a.shop_id
       WHERE ${shopFilter} AND a.date = $2
       ORDER BY a.time_start`,
      [shopId, today]
    );

    // Gráfico últimos 7 días (enterprise owner incluye sucursales)
    const weekQ = await pool.query(
      `SELECT
         date::text,
         COALESCE(SUM(CASE WHEN status='completed' THEN price - cost - (price * COALESCE(commission_pct,0) / 100.0) ELSE 0 END), 0) AS net_profit,
         COUNT(CASE WHEN status='completed' THEN 1 END) AS completed
       FROM appointments
       WHERE ${shopFilterPlain} AND date >= CURRENT_DATE - INTERVAL '6 days' AND date <= CURRENT_DATE
       GROUP BY date
       ORDER BY date`,
      [shopId]
    );

    // Split de comisiones del dia (barberos) — agrupar por barbero usando su nombre real
    const splitsQ = await pool.query(
      `SELECT
         s.name AS barber_name,
         SUM(a.price * a.commission_pct / 100.0) AS commission,
         COUNT(*) AS cuts
       FROM appointments a
       JOIN shops s ON s.id = a.barber_id
       WHERE ${shopFilter} AND a.date = $2 AND a.status = 'completed'
         AND a.barber_id IS NOT NULL
       GROUP BY s.id, s.name
       ORDER BY s.name`,
      [shopId, today]
    );

    const m = metricsQ.rows[0];
    res.json({
      metrics: {
        revenue:      parseFloat(m.revenue) + prodRevToday,
        net_profit:   parseFloat(m.net_profit) + prodRevToday,
        completed:    parseInt(m.completed),
        pending:      parseInt(m.pending),
        noshows:      parseInt(m.noshows),
        prod_revenue: prodRevToday,
        prod_count:   parseInt(prodRevenueQ.rows[0].prod_count || 0),
      },
      appointments: apptsQ.rows,
      week:         weekQ.rows,
      splits:       splitsQ.rows,
    });
  } catch (e) {
    console.error('Dashboard error:', e.message);
    res.status(500).json({ error: 'Error al cargar dashboard' });
  }
});

module.exports = router;

// GET /api/dashboard/month — métricas del mes actual
router.get('/month', auth, async (req, res) => {
  const shopId = req.shopId;
  const isEnterpriseOwner = req.isEnterpriseOwner || false;
  const shopFilterMonth = isEnterpriseOwner
    ? `(shop_id = $1 OR shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id = $1 AND is_branch = TRUE))`
    : `shop_id = $1`;

  try {
    // Fechas del local (no del servidor, que está en UTC): el último día del mes después de las
    // 21 h el servidor ya está en el mes siguiente
    const today = shopDate(await getShopTz(shopId));
    const monthStart = today.slice(0, 8) + '01';
    const prevMonthStart = (() => { const d = new Date(monthStart + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })();
    const [monthQ, prodRevMonthQ] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status='completed' AND payment_method IS DISTINCT FROM 'debt' THEN price ELSE 0 END), 0)        AS revenue,
           COALESCE(SUM(CASE WHEN status='completed' AND payment_method IS DISTINCT FROM 'debt' THEN price - cost - (price * COALESCE(commission_pct,0) / 100.0) ELSE 0 END), 0) AS net_profit,
           COUNT(CASE WHEN status='completed' THEN 1 END)                               AS completed,
           COUNT(CASE WHEN status='noshow' THEN 1 END)                                  AS noshows,
           COUNT(*)                                                                      AS total
         FROM appointments
         WHERE ${shopFilterMonth}
           AND date >= $2::date
           AND date <= $3::date`,
        [shopId, monthStart, today]
      ),
      // Ventas de productos del mes: las mismas que entran a la caja (igual que el panel enterprise)
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS prod_revenue
         FROM expenses
         WHERE (shop_id=$1 OR (${isEnterpriseOwner ? `shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id=$1 AND is_branch=TRUE)` : 'FALSE'}))
           AND is_income=TRUE AND source_type='product_sale'
           AND date >= $2::date AND date <= $3::date`,
        [shopId, monthStart, today]
      ),
    ]);
    const prodRevMonth = parseFloat(prodRevMonthQ.rows[0].prod_revenue);

    // Mes anterior para comparar
    const prevQ = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN status='completed' THEN price ELSE 0 END), 0) AS revenue
       FROM appointments
       WHERE ${shopFilterMonth}
         AND date >= $2::date
         AND date < $3::date`,
      [shopId, prevMonthStart, monthStart]
    );

    // Ticket promedio
    const avgQ = await pool.query(
      `SELECT COALESCE(AVG(price), 0) AS avg_ticket
       FROM appointments
       WHERE ${shopFilterMonth} AND status='completed'
         AND date >= $2::date`,
      [shopId, monthStart]
    );

    // Clientes nuevos este mes (solo del shop propio, no sucursales)
    const newClientsQ = await pool.query(
      `SELECT COUNT(*) AS new_clients
       FROM clients
       WHERE shop_id=$1 AND created_at >= ($2::date::timestamp AT TIME ZONE $3::text)`,
      [shopId, monthStart, await getShopTz(shopId)]
    );

    // Clientes recurrentes (más de 1 visita este mes)
    const recurringQ = await pool.query(
      `SELECT COUNT(DISTINCT client_id) AS recurring
       FROM appointments
       WHERE ${shopFilterMonth} AND status='completed'
         AND date >= $2::date
         AND client_id IS NOT NULL
         AND client_id IN (
           SELECT client_id FROM appointments
           WHERE ${shopFilterMonth} AND status='completed'
             AND date >= $2::date
           GROUP BY client_id HAVING COUNT(*) > 1
         )`,
      [shopId, monthStart]
    );

    const m = monthQ.rows[0];
    const noshow_rate = parseInt(m.total) > 0
      ? Math.round((parseInt(m.noshows) / parseInt(m.total)) * 100)
      : 0;

    res.json({
      revenue:      parseFloat(m.revenue) + prodRevMonth,
      net_profit:   parseFloat(m.net_profit) + prodRevMonth,
      prod_revenue: prodRevMonth,
      completed:    parseInt(m.completed),
      noshows:      parseInt(m.noshows),
      noshow_rate,
      avg_ticket:   parseFloat(avgQ.rows[0].avg_ticket),
      prev_revenue: parseFloat(prevQ.rows[0].revenue),
      new_clients:  parseInt(newClientsQ.rows[0].new_clients),
      recurring:    parseInt(recurringQ.rows[0].recurring),
    });
  } catch (e) {
    console.error('Dashboard month error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dashboard/chart — facturación últimos 30 días
router.get('/chart', auth, async (req, res) => {
  const shopId = req.shopId;
  try {
    const result = await pool.query(
      `SELECT
         date::text,
         COALESCE(SUM(CASE WHEN status='completed' THEN price ELSE 0 END), 0) AS revenue,
         COUNT(CASE WHEN status='completed' THEN 1 END) AS completed
       FROM appointments
       WHERE shop_id=$1
         AND date >= CURRENT_DATE - INTERVAL '29 days'
         AND date <= CURRENT_DATE
       GROUP BY date ORDER BY date`,
      [shopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dashboard/top-services — servicios más vendidos del mes
router.get('/top-services', auth, async (req, res) => {
  const shopId = req.shopId;
  try {
    const result = await pool.query(
      `SELECT service_name AS name,
              COUNT(*) AS count,
              COALESCE(SUM(price), 0) AS revenue
       FROM appointments
       WHERE shop_id=$1 AND status='completed'
         AND date >= date_trunc('month', CURRENT_DATE)
         AND service_name IS NOT NULL
       GROUP BY service_name
       ORDER BY count DESC
       LIMIT 5`,
      [shopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dashboard/top-clients — clientes más frecuentes del mes
router.get('/top-clients', auth, async (req, res) => {
  const shopId = req.shopId;
  try {
    const result = await pool.query(
      `SELECT c.name, COUNT(*) AS visits, COALESCE(SUM(a.price), 0) AS spent
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
       WHERE a.shop_id=$1 AND a.status='completed'
         AND a.date >= date_trunc('month', CURRENT_DATE)
       GROUP BY c.id, c.name
       ORDER BY visits DESC
       LIMIT 5`,
      [shopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SISTEMA DE CAJA ───────────────────────────────────────────────────────────

// POST /api/dashboard/expenses — registrar gasto
router.post('/expenses', auth, async (req, res) => {
  const { amount, category, description, date, payment_method } = req.body;
  if (!amount || !category) return res.status(400).json({ error: 'Monto y categoría requeridos' });
  if (!(parseFloat(amount) > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
  const validCats = ['insumos','alquiler','servicios','salarios','otros'];
  if (!validCats.includes(category)) return res.status(400).json({ error: 'Categoría inválida' });
  try {
    const result = await pool.query(
      `INSERT INTO expenses (shop_id, amount, category, description, date, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.shopId, parseFloat(amount), category, description || null,
       date || shopDate(await getShopTz(req.shopId)),
       payment_method ? String(payment_method).trim() : null]
    );
    res.status(201).json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboard/expenses?date=YYYY-MM-DD — gastos de un día
router.get('/expenses', auth, async (req, res) => {
  const date = req.query.date || shopDate(await getShopTz(req.shopId));
  try {
    const result = await pool.query(
      `SELECT * FROM expenses WHERE shop_id=$1 AND date=$2 ORDER BY created_at DESC`,
      [req.shopId, date]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/dashboard/expenses/:id — asignar o cambiar con qué cuenta (método) se pagó o cobró un
// movimiento de caja: gastos, ingresos y también los automáticos (liquidaciones, fiado, señas, ventas).
// Solo cambia la cuenta; el monto no se toca. Si el día ya tiene cierre de caja, se rehace.
router.put('/expenses/:id', auth, async (req, res) => {
  if (req.isBarber) return res.status(403).json({ error: 'Solo el dueño puede modificar la caja' });
  const pm = req.body && req.body.payment_method != null ? String(req.body.payment_method).trim() : '';
  if (!pm || pm.length > 40 || pm === 'debt' || pm === 'mixed') return res.status(400).json({ error: 'Elegí una cuenta válida' });
  const db = await pool.connect();
  let began = false;
  try {
    await db.query('BEGIN'); began = true;
    const r = await db.query(
      `UPDATE expenses SET payment_method=$1 WHERE id=$2 AND shop_id=$3
        RETURNING id, payment_method, date::text AS date`,
      [pm, req.params.id, req.shopId]
    );
    if (!r.rows.length) { await db.query('ROLLBACK'); began = false; return res.status(404).json({ error: 'Movimiento no encontrado' }); }
    // Liquidaciones divididas: el detalle por método (payment_splits) acompaña al egreso
    await db.query('UPDATE payment_splits SET method=$1 WHERE expense_id=$2 AND shop_id=$3', [pm, req.params.id, req.shopId]);
    await db.query('COMMIT'); began = false;
    const day = r.rows[0].date;
    try {
      const has = await pool.query('SELECT 1 FROM cash_registers WHERE shop_id=$1 AND date=$2', [req.shopId, day]);
      if (has.rows.length) await saveDayClose(req.shopId, day, await computeDayClose(req.shopId, day));
    } catch (e) { console.warn('[CAJA] recalcular cierre tras cambiar cuenta:', e.message); }
    res.json({ ok: true, expense: { id: r.rows[0].id, payment_method: r.rows[0].payment_method } });
  } catch(e) {
    if (began) await db.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { db.release(); }
});

// DELETE /api/dashboard/expenses/:id — eliminar gasto
router.delete('/expenses/:id', auth, async (req, res) => {
  try {
    // Las filas automáticas dejan estado asociado (liquidación, deuda, seña): borrarlas dejaría la caja inconsistente.
    const r = await pool.query(
      `DELETE FROM expenses WHERE id=$1 AND shop_id=$2
         AND (source_type IS NULL OR source_type NOT IN ('barber_settlement','debt_payment','sena'))
       RETURNING id`,
      [req.params.id, req.shopId]
    );
    if (!r.rows.length) return res.status(409).json({ error: 'Este movimiento lo genera el sistema (liquidación, cobro de fiado o seña) y no se puede borrar desde acá.' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboard/cash?date=YYYY-MM-DD — resumen de caja del día
router.get('/cash', auth, async (req, res) => {
  const date = req.query.date || shopDate(await getShopTz(req.shopId));
  const shopId = req.shopId;
  try {
    // Ingresos por método de pago (precio completo — la seña se suma como income_item aparte).
    // Soporta multi-método: si appt.payment_method='mixed', se usan los payment_splits.
    let appts;
    try {
      appts = await pool.query(
      `WITH
         by_appt AS (
           SELECT a.id, a.price, a.payment_method, a.tip, a.status
             FROM appointments a
             WHERE a.shop_id=$1 AND a.date=$2 AND a.status='completed'
         ),
         splits_by_appt AS (
           SELECT ps.appointment_id, ps.method, SUM(ps.amount) AS amount
             FROM payment_splits ps
             JOIN by_appt ba ON ba.id = ps.appointment_id
             GROUP BY ps.appointment_id, ps.method
         ),
         method_totals AS (
           -- Appointments sin splits: cuenta por payment_method directo
           SELECT ba.payment_method AS method, SUM(ba.price) AS amount
             FROM by_appt ba
             WHERE NOT EXISTS (SELECT 1 FROM splits_by_appt sa WHERE sa.appointment_id = ba.id)
             GROUP BY ba.payment_method
           UNION ALL
           -- Appointments con splits: cuenta por cada split
           SELECT sa.method, SUM(sa.amount) FROM splits_by_appt sa GROUP BY sa.method
         )
       SELECT
         COALESCE(SUM(CASE WHEN method='cash'     THEN amount END),0) AS cash_total,
         COALESCE(SUM(CASE WHEN method='debit'    THEN amount END),0) AS debit_total,
         COALESCE(SUM(CASE WHEN method='credit'   THEN amount END),0) AS credit_total,
         COALESCE(SUM(CASE WHEN method='transfer' THEN amount END),0) AS transfer_total,
         COALESCE(SUM(CASE WHEN method='debt'     THEN amount END),0) AS debt_total,
         COALESCE(SUM(CASE WHEN method IS NULL    THEN amount END),0) AS no_method_total,
         (SELECT COALESCE(SUM(tip),0)   FROM by_appt) AS tips_total,
         (SELECT COALESCE(SUM(CASE WHEN payment_method IS DISTINCT FROM 'debt' THEN price ELSE 0 END),0) FROM by_appt) AS revenue_total,
         (SELECT COUNT(*) FROM by_appt) AS cuts_count
       FROM method_totals`,
      [shopId, date]
    );
    } catch(spErr) {
      if (/payment_splits.*does not exist|relation "payment_splits"/i.test(spErr.message)) {
        // Fallback a la query vieja si la migración 044 no corrió aún
        appts = await pool.query(
          `SELECT
             COALESCE(SUM(CASE WHEN payment_method='cash'     THEN price ELSE 0 END),0) AS cash_total,
             COALESCE(SUM(CASE WHEN payment_method='debit'    THEN price ELSE 0 END),0) AS debit_total,
             COALESCE(SUM(CASE WHEN payment_method='credit'   THEN price ELSE 0 END),0) AS credit_total,
             COALESCE(SUM(CASE WHEN payment_method='transfer' THEN price ELSE 0 END),0) AS transfer_total,
             COALESCE(SUM(CASE WHEN payment_method='debt'     THEN price ELSE 0 END),0) AS debt_total,
             COALESCE(SUM(CASE WHEN payment_method IS NULL    THEN price ELSE 0 END),0) AS no_method_total,
             COALESCE(SUM(tip),0)                                                        AS tips_total,
             COALESCE(SUM(CASE WHEN payment_method IS DISTINCT FROM 'debt' THEN price ELSE 0 END),0) AS revenue_total,
             COUNT(*) FILTER (WHERE status='completed')                                  AS cuts_count
           FROM appointments
           WHERE shop_id=$1 AND date=$2 AND status='completed'`,
          [shopId, date]
        );
      } else throw spErr;
    }
    // Gastos e ingresos extras del día (señas son informativas, no suman al net para evitar doble conteo)
    const exps = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN (is_income IS NULL OR is_income=FALSE) THEN amount ELSE 0 END),0) AS expenses_total,
         COALESCE(SUM(CASE WHEN is_income=TRUE AND source_type IS DISTINCT FROM 'sena' THEN amount ELSE 0 END),0) AS all_income,
         COALESCE(SUM(CASE WHEN is_income=TRUE AND source_type IS DISTINCT FROM 'debt_payment' AND source_type IS DISTINCT FROM 'sena' THEN amount ELSE 0 END),0) AS extra_income,
         json_agg(json_build_object(
           'id',id,'amount',amount,'category',category,'description',description,'source_type',source_type,'payment_method',payment_method
         ) ORDER BY created_at DESC) FILTER (WHERE is_income IS NULL OR is_income=FALSE) AS items,
         json_agg(json_build_object(
           'id',id,'amount',amount,'category',category,'description',description,'source_type',source_type,'payment_method',payment_method
         ) ORDER BY created_at DESC) FILTER (WHERE is_income=TRUE AND source_type IS DISTINCT FROM 'debt_payment') AS income_items
       FROM expenses WHERE shop_id=$1 AND date=$2`,
      [shopId, date]
    );
    // Cobros de fiado del día agrupados por método (para sumar a los totales de método)
    const debtCollected = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN payment_method='cash'     THEN amount ELSE 0 END),0) AS cash_col,
         COALESCE(SUM(CASE WHEN payment_method='debit'    THEN amount ELSE 0 END),0) AS debit_col,
         COALESCE(SUM(CASE WHEN payment_method='credit'   THEN amount ELSE 0 END),0) AS credit_col,
         COALESCE(SUM(CASE WHEN payment_method='transfer' THEN amount ELSE 0 END),0) AS transfer_col,
         COALESCE(SUM(amount),0) AS total_col
       FROM expenses
       WHERE shop_id=$1 AND date=$2 AND source_type='debt_payment'`,
      [shopId, date]
    );
    const a = appts.rows[0];
    const e = exps.rows[0];
    const dc = debtCollected.rows[0];
    const revenue      = parseFloat(a.revenue_total);
    const allIncome    = parseFloat(e.all_income || 0);
    const extraIncome  = parseFloat(e.extra_income || 0);
    const expenses     = parseFloat(e.expenses_total);
    const tips         = parseFloat(a.tips_total);
    // Comisiones devengadas del día (accrual diario)
    const dayComm = await dayCommissions(shopId, date);
    const commissions = dayComm.appt + dayComm.product;

    // Saldo de cada cuenta del día (misma cuenta que se guarda en el cierre)
    const breakdownMap = await methodFlowForDay(shopId, date);
    const breakdownRows = Object.entries(breakdownMap)
      .map(([key, total]) => ({ key, total: String(total) }))
      .sort((a, b) => a.key.localeCompare(b.key));

    res.json({
      date,
      cash_total:        parseFloat(a.cash_total)     + parseFloat(dc.cash_col),
      debit_total:       parseFloat(a.debit_total)    + parseFloat(dc.debit_col),
      credit_total:      parseFloat(a.credit_total)   + parseFloat(dc.credit_col),
      transfer_total:    parseFloat(a.transfer_total) + parseFloat(dc.transfer_col),
      debt_total:        Math.max(0, parseFloat(a.debt_total) - parseFloat(dc.total_col)),
      no_method_total:   parseFloat(a.no_method_total),
      tips_total:        tips,
      revenue_total:     revenue,
      extra_income:      extraIncome,
      expenses_total:    expenses,
      commissions_total: commissions,
      net_total:         await computeNet(shopId, date, { revenue, allIncome, expenses, apptCommissions: dayComm.appt, productCommissions: dayComm.product }),
      // Cómo se llega al neto: ingresos − comisiones − gastos del local (las liquidaciones ya son comisiones)
      net_parts:         (await dailySeries(shopId, date, date))[0] || null,
      cuts_count:        parseInt(a.cuts_count),
      expenses_items:    e.items || [],
      income_items:      e.income_items || [],
      method_breakdown:  breakdownRows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboard/cash/method-detail?date=&method= — TODOS los movimientos de una cuenta del día
router.get('/cash/method-detail', auth, async (req, res) => {
  const { method } = req.query;
  const tz = await getShopTz(req.shopId);
  const date = req.query.date || shopDate(tz);
  if (!method) return res.status(400).json({ error: 'Se requiere method' });
  try {
    res.json(await methodMovementsForDay(req.shopId, date, method, tz));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/dashboard/cash/close — cerrar caja del día (misma lógica que el cierre automático)
router.post("/cash/close", auth, async (req, res) => {
  const date = req.body.date || shopDate(await getShopTz(req.shopId));
  const shopId = req.shopId;
  try {
    const d = await computeDayClose(shopId, date);
    await saveDayClose(shopId, date, d);
    console.log(`[CAJA] Cierre registrado para shop ${shopId} fecha ${date} net=$${d.net_total}`);
    res.json({ ok: true, net_total: d.net_total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboard/cash/monthly?year=YYYY — P&L mensual del año
// Se calcula EN VIVO desde los turnos y movimientos (antes sumaba los cierres de caja guardados:
// los días sin cierre no aparecían y un cierre viejo no veía cobros posteriores).
router.get('/cash/monthly', auth, async (req, res) => {
  try {
    const tz = await getShopTz(req.shopId);
    const today = shopDate(tz);
    const year = parseInt(req.query.year) || parseInt(today.slice(0, 4));
    const yearEnd = `${year}-12-31` < today ? `${year}-12-31` : today;
    const prevEnd = `${year - 1}-12-31`;

    const empty = () => ({ revenue: 0, tips: 0, expenses: 0, net: 0, cuts: 0, days_worked: 0 });
    const byMonth = (days) => {
      const m = {};
      for (const d of days) {
        const k = parseInt(d.date.slice(5, 7));
        const x = m[k] || (m[k] = empty());
        x.revenue += d.ingresos; x.tips += d.tips; x.expenses += d.gastos; x.net += d.net; x.cuts += d.cuts;
        if (d.active) x.days_worked++;
      }
      return m;
    };

    const cur = `${year}-01-01` <= yearEnd ? await dailySeries(req.shopId, `${year}-01-01`, yearEnd) : [];
    const prev = await dailySeries(req.shopId, `${year - 1}-01-01`, prevEnd);
    const curM = byMonth(cur), prevM = byMonth(prev);

    const months = Object.keys(curM).map(Number).sort((a, b) => a - b)
      .filter(k => curM[k].days_worked > 0)
      .map(k => {
        const r = curM[k], p = prevM[k] && prevM[k].days_worked > 0 ? prevM[k] : null;
        return {
          month: k,
          revenue: r.revenue, tips: r.tips, expenses: r.expenses, net: r.net, cuts: r.cuts, days_worked: r.days_worked,
          prev_revenue: p ? p.revenue : null,
          prev_net: p ? p.net : null,
          delta_net_pct: p && p.net !== 0 ? Math.round(((r.net - p.net) / Math.abs(p.net)) * 100) : null,
        };
      });

    const active = cur.filter(d => d.active);
    const positive = active.filter(d => d.net > 0).map(d => d.net);
    const tot = (k) => months.reduce((a, m) => a + m[k], 0);
    res.json({
      year,
      months,
      totals: {
        revenue:       tot('revenue'),
        tips:          tot('tips'),
        expenses:      tot('expenses'),
        net:           tot('net'),
        cuts:          tot('cuts'),
        avg_daily_net: active.length ? tot('net') / active.length : 0,
        best_day_net:  active.length ? Math.max(...active.map(d => d.net)) : 0,
        worst_day_net: positive.length ? Math.min(...positive) : 0,
      },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboard/cash/week-compare — esta semana vs semana pasada (en vivo, por día del local)
router.get('/cash/week-compare', auth, async (req, res) => {
  try {
    const tz = await getShopTz(req.shopId);
    const today = shopDate(tz);
    const addDays = (ymd, n) => new Date(new Date(ymd + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
    const dowToday = new Date(today + 'T12:00:00Z').getUTCDay();          // 0=domingo
    const thisMondayStr = addDays(today, -(dowToday === 0 ? 6 : dowToday - 1));
    const lastMondayStr = addDays(thisMondayStr, -7);
    const lastSundayStr = addDays(thisMondayStr, -1);

    const [thisDays, lastDays] = await Promise.all([
      dailySeries(req.shopId, thisMondayStr, today),
      dailySeries(req.shopId, lastMondayStr, lastSundayStr),
    ]);
    const thisWeek = thisDays.filter(d => d.active), lastWeek = lastDays.filter(d => d.active);
    const sumWeek = rows => ({
      revenue:  rows.reduce((a, r) => a + r.ingresos, 0),
      tips:     rows.reduce((a, r) => a + r.tips, 0),
      expenses: rows.reduce((a, r) => a + r.gastos, 0),
      net:      rows.reduce((a, r) => a + r.net, 0),
      cuts:     rows.reduce((a, r) => a + r.cuts, 0),
      days:     rows.length,
    });
    const thisTotals = sumWeek(thisWeek), lastTotals = sumWeek(lastWeek);
    const delta = (curr, prev) => prev !== 0 ? Math.round(((curr - prev) / Math.abs(prev)) * 100) : null;
    const mapDay = d => ({ date: d.date, dow: d.dow, revenue: d.ingresos, tips: d.tips, expenses: d.gastos, net: d.net, cuts: d.cuts });

    res.json({
      this_week: { from: thisMondayStr, totals: thisTotals, days: thisWeek.map(mapDay) },
      last_week: { from: lastMondayStr, totals: lastTotals, days: lastWeek.map(mapDay) },
      delta: {
        revenue_pct: delta(thisTotals.revenue, lastTotals.revenue),
        net_pct:     delta(thisTotals.net,     lastTotals.net),
        cuts_pct:    delta(thisTotals.cuts,    lastTotals.cuts),
      },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboard/cash/history — historial de cierres
router.get('/cash/history', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM cash_registers WHERE shop_id=$1 ORDER BY date DESC LIMIT 30`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboard/cash/day-detail?date= — detalle completo de un día cerrado
router.get('/cash/day-detail', auth, async (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'Se requiere date' });
  const shopId = req.shopId;
  try {
    // Resumen del cierre guardado
    const reg = await pool.query(
      `SELECT * FROM cash_registers WHERE shop_id=$1 AND date::date = $2::date`,
      [shopId, date]
    );
    // Turnos completados del día
    const appts = await pool.query(
      `SELECT a.time_start, a.client_name, a.service_name, a.price, a.cost,
              a.commission_pct, a.tip, a.payment_method,
              ROUND(a.price * a.commission_pct / 100.0, 2) AS commission_amount,
              ROUND(a.price - COALESCE(a.cost,0) - (a.price * a.commission_pct / 100.0), 2) AS profit,
              s.name AS barber_name
       FROM appointments a
       LEFT JOIN shops s ON s.id = a.barber_id
       WHERE a.shop_id=$1 AND a.date=$2 AND a.status='completed'
       ORDER BY a.time_start ASC`,
      [shopId, date]
    );
    // Gastos e ingresos extras del día
    const expenses = await pool.query(
      `SELECT id, amount, category, description, is_income, source_type, payment_method, created_at
       FROM expenses WHERE shop_id=$1 AND date=$2
       ORDER BY created_at ASC`,
      [shopId, date]
    );
    res.json({
      register:  reg.rows[0] || null,
      appointments: appts.rows,
      expenses:  expenses.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboard/debts — deudas pendientes
router.get('/debts', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*, c.phone AS client_phone
       FROM client_debts d
       LEFT JOIN clients c ON c.id = d.client_id
       WHERE d.shop_id=$1 AND d.paid=FALSE
       ORDER BY d.created_at DESC`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/dashboard/debts/:id/pay — marcar deuda como pagada y acreditar en caja
router.put('/debts/:id/pay', auth, async (req, res) => {
  const { payment_method } = req.body;
  try {
    // Marcar deuda como pagada y obtener datos para caja
    const debtQ = await pool.query(
      `UPDATE client_debts SET paid=TRUE, paid_at=NOW()
       WHERE id=$1 AND shop_id=$2 AND paid=FALSE
       RETURNING appointment_id, amount, client_name`,
      [req.params.id, req.shopId]
    );
    if (!debtQ.rows.length) return res.status(404).json({ error: 'Deuda no encontrada o ya cobrada' });
    const debt = debtQ.rows[0];

    // Registrar el cobro como INGRESO en caja del día de hoy
    const pmLabel = { cash:'Efectivo', debit:'Débito', credit:'Crédito', transfer:'Transferencia' };
    const methodStr = payment_method && pmLabel[payment_method] ? ` (${pmLabel[payment_method]})` : '';
    await pool.query(
      `INSERT INTO expenses (shop_id, amount, category, description, date, is_income, source_type, source_id, payment_method)
       VALUES ($1,$2,'ventas',$3,$6,TRUE,'debt_payment',$4,$5)`,
      [req.shopId, parseFloat(debt.amount || 0),
       `Cobro fiado — ${debt.client_name}${methodStr}`,
       parseInt(req.params.id),
       payment_method || null,
       shopDate(await getShopTz(req.shopId))]
    );

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboard/month-report?year=2026&month=4 — datos para exportar PDF
router.get('/month-report', auth, async (req, res) => {
  const shopId = req.shopId;
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const from  = `${year}-${String(month).padStart(2,'0')}-01`;
  const to    = new Date(Date.UTC(year, month, 0)).toISOString().split('T')[0]; // último día del mes
  try {
    // Mismos números que el P&L y el panel enterprise (cálculo en vivo, día por día)
    res.json(await monthReport(shopId, from, to));
  } catch(e) {
    console.error('month-report error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
