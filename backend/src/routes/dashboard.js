const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// GET /api/dashboard/today
router.get('/today', auth, async (req, res) => {
  const shopId = req.shopId;
  const today  = new Date().toISOString().split('T')[0];

  try {
    // Métricas del día (turnos + ventas de productos)
    const [metricsQ, prodRevenueQ] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status='completed' AND payment_method IS DISTINCT FROM 'debt' THEN price ELSE 0 END), 0)          AS revenue,
           COALESCE(SUM(CASE WHEN status='completed' AND payment_method IS DISTINCT FROM 'debt' THEN price - cost - (price * COALESCE(commission_pct,0) / 100.0) ELSE 0 END), 0) AS net_profit,
           COUNT(CASE WHEN status='completed' THEN 1 END)                                 AS completed,
           COUNT(CASE WHEN status='pending' OR status='confirmed' THEN 1 END)             AS pending,
           COUNT(CASE WHEN status='noshow' THEN 1 END)                                    AS noshows
         FROM appointments
         WHERE shop_id = $1 AND date = $2`,
        [shopId, today]
      ),
      pool.query(
        `SELECT COALESCE(SUM(total_price),0) AS prod_revenue
         FROM product_sales
         WHERE shop_id=$1 AND sold_at::date = $2`,
        [shopId, today]
      ),
    ]);
    const prodRevToday = parseFloat(prodRevenueQ.rows[0].prod_revenue);

    // Turnos del día completos con info del cliente
    const apptsQ = await pool.query(
      `SELECT a.*, c.name AS client_name, c.phone AS client_phone
       FROM appointments a
       LEFT JOIN clients c ON c.id = a.client_id
       WHERE a.shop_id = $1 AND a.date = $2
       ORDER BY a.time_start`,
      [shopId, today]
    );

    // Gráfico últimos 7 días
    const weekQ = await pool.query(
      `SELECT
         date::text,
         COALESCE(SUM(CASE WHEN status='completed' THEN price - cost - (price * COALESCE(commission_pct,0) / 100.0) ELSE 0 END), 0) AS net_profit,
         COUNT(CASE WHEN status='completed' THEN 1 END) AS completed
       FROM appointments
       WHERE shop_id = $1 AND date >= CURRENT_DATE - INTERVAL '6 days' AND date <= CURRENT_DATE
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
       WHERE a.shop_id = $1 AND a.date = $2 AND a.status = 'completed'
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
  try {
    const [monthQ, prodRevMonthQ] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status='completed' AND payment_method IS DISTINCT FROM 'debt' THEN price ELSE 0 END), 0)        AS revenue,
           COALESCE(SUM(CASE WHEN status='completed' AND payment_method IS DISTINCT FROM 'debt' THEN price - cost - (price * COALESCE(commission_pct,0) / 100.0) ELSE 0 END), 0) AS net_profit,
           COUNT(CASE WHEN status='completed' THEN 1 END)                               AS completed,
           COUNT(CASE WHEN status='noshow' THEN 1 END)                                  AS noshows,
           COUNT(*)                                                                      AS total
         FROM appointments
         WHERE shop_id=$1
           AND date >= date_trunc('month', CURRENT_DATE)
           AND date <= CURRENT_DATE`,
        [shopId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(total_price),0) AS prod_revenue
         FROM product_sales
         WHERE shop_id=$1
           AND sold_at >= date_trunc('month', CURRENT_DATE)`,
        [shopId]
      ),
    ]);
    const prodRevMonth = parseFloat(prodRevMonthQ.rows[0].prod_revenue);

    // Mes anterior para comparar
    const prevQ = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN status='completed' THEN price ELSE 0 END), 0) AS revenue
       FROM appointments
       WHERE shop_id=$1
         AND date >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
         AND date < date_trunc('month', CURRENT_DATE)`,
      [shopId]
    );

    // Ticket promedio
    const avgQ = await pool.query(
      `SELECT COALESCE(AVG(price), 0) AS avg_ticket
       FROM appointments
       WHERE shop_id=$1 AND status='completed'
         AND date >= date_trunc('month', CURRENT_DATE)`,
      [shopId]
    );

    // Clientes nuevos este mes
    const newClientsQ = await pool.query(
      `SELECT COUNT(*) AS new_clients
       FROM clients
       WHERE shop_id=$1 AND created_at >= date_trunc('month', CURRENT_DATE)`,
      [shopId]
    );

    // Clientes recurrentes (más de 1 visita este mes)
    const recurringQ = await pool.query(
      `SELECT COUNT(DISTINCT client_id) AS recurring
       FROM appointments
       WHERE shop_id=$1 AND status='completed'
         AND date >= date_trunc('month', CURRENT_DATE)
         AND client_id IS NOT NULL
         AND client_id IN (
           SELECT client_id FROM appointments
           WHERE shop_id=$1 AND status='completed'
             AND date >= date_trunc('month', CURRENT_DATE)
           GROUP BY client_id HAVING COUNT(*) > 1
         )`,
      [shopId]
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
  const { amount, category, description, date } = req.body;
  if (!amount || !category) return res.status(400).json({ error: 'Monto y categoría requeridos' });
  const validCats = ['insumos','alquiler','servicios','salarios','otros'];
  if (!validCats.includes(category)) return res.status(400).json({ error: 'Categoría inválida' });
  try {
    const result = await pool.query(
      `INSERT INTO expenses (shop_id, amount, category, description, date)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.shopId, parseFloat(amount), category, description || null,
       date || new Date().toISOString().split('T')[0]]
    );
    res.status(201).json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboard/expenses?date=YYYY-MM-DD — gastos de un día
router.get('/expenses', auth, async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  try {
    const result = await pool.query(
      `SELECT * FROM expenses WHERE shop_id=$1 AND date=$2 ORDER BY created_at DESC`,
      [req.shopId, date]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/dashboard/expenses/:id — eliminar gasto
router.delete('/expenses/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM expenses WHERE id=$1 AND shop_id=$2', [req.params.id, req.shopId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboard/cash?date=YYYY-MM-DD — resumen de caja del día
router.get('/cash', auth, async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const shopId = req.shopId;
  try {
    // Ingresos por método de pago
    const appts = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN payment_method='cash' THEN price ELSE 0 END),0)     AS cash_total,
         COALESCE(SUM(CASE WHEN payment_method='debit' THEN price ELSE 0 END),0)    AS debit_total,
         COALESCE(SUM(CASE WHEN payment_method='credit' THEN price ELSE 0 END),0)   AS credit_total,
         COALESCE(SUM(CASE WHEN payment_method='transfer' THEN price ELSE 0 END),0) AS transfer_total,
         COALESCE(SUM(CASE WHEN payment_method='debt' THEN price ELSE 0 END),0)     AS debt_total,
         COALESCE(SUM(CASE WHEN payment_method IS NULL THEN price ELSE 0 END),0)    AS no_method_total,
         COALESCE(SUM(tip),0)                                                        AS tips_total,
         COALESCE(SUM(CASE WHEN payment_method IS DISTINCT FROM 'debt' THEN price ELSE 0 END),0) AS revenue_total,
         COUNT(*) FILTER (WHERE status='completed')                                  AS cuts_count
       FROM appointments
       WHERE shop_id=$1 AND date=$2 AND status='completed'`,
      [shopId, date]
    );
    // Gastos e ingresos extras del día (separados por is_income)
    const exps = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN (is_income IS NULL OR is_income=FALSE) THEN amount ELSE 0 END),0) AS expenses_total,
         COALESCE(SUM(CASE WHEN is_income=TRUE THEN amount ELSE 0 END),0) AS extra_income,
         json_agg(json_build_object(
           'id',id,'amount',amount,'category',category,'description',description,'source_type',source_type
         ) ORDER BY created_at DESC) FILTER (WHERE is_income IS NULL OR is_income=FALSE) AS items,
         json_agg(json_build_object(
           'id',id,'amount',amount,'category',category,'description',description,'source_type',source_type
         ) ORDER BY created_at DESC) FILTER (WHERE is_income=TRUE) AS income_items
       FROM expenses WHERE shop_id=$1 AND date=$2`,
      [shopId, date]
    );
    const a = appts.rows[0];
    const e = exps.rows[0];
    const revenue      = parseFloat(a.revenue_total);
    const extraIncome  = parseFloat(e.extra_income || 0);
    const expenses     = parseFloat(e.expenses_total);
    const tips         = parseFloat(a.tips_total);
    // Comisiones devengadas del día (accrual diario)
    const commissionQ = await pool.query(
      `SELECT COALESCE(SUM(price * commission_pct / 100.0),0) AS total_commission
       FROM appointments WHERE shop_id=$1 AND date=$2 AND status='completed'`,
      [shopId, date]
    );
    const commissions = parseFloat(commissionQ.rows[0].total_commission);
    res.json({
      date,
      cash_total:        parseFloat(a.cash_total),
      debit_total:       parseFloat(a.debit_total),
      credit_total:      parseFloat(a.credit_total),
      transfer_total:    parseFloat(a.transfer_total),
      debt_total:        parseFloat(a.debt_total),
      no_method_total:   parseFloat(a.no_method_total),
      tips_total:        tips,
      revenue_total:     revenue,
      extra_income:      extraIncome,
      expenses_total:    expenses,
      commissions_total: commissions,
      net_total:         revenue + tips + extraIncome - expenses - commissions,
      cuts_count:        parseInt(a.cuts_count),
      expenses_items:    e.items || [],
      income_items:      e.income_items || [],
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/dashboard/cash/close — cerrar caja del día
router.post('/cash/close', auth, async (req, res) => {
  const date = req.body.date || new Date().toISOString().split('T')[0];
  const shopId = req.shopId;
  try {
    // Calcular todo
    const appts = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN payment_method='cash' THEN price ELSE 0 END),0)     AS cash_total,
         COALESCE(SUM(CASE WHEN payment_method='debit' THEN price ELSE 0 END),0)    AS debit_total,
         COALESCE(SUM(CASE WHEN payment_method='credit' THEN price ELSE 0 END),0)   AS credit_total,
         COALESCE(SUM(CASE WHEN payment_method='transfer' THEN price ELSE 0 END),0) AS transfer_total,
         COALESCE(SUM(CASE WHEN payment_method='debt' THEN price ELSE 0 END),0)     AS debt_total,
         COALESCE(SUM(tip),0) AS tips_total,
         COALESCE(SUM(CASE WHEN payment_method IS DISTINCT FROM 'debt' THEN price ELSE 0 END),0) AS revenue_total,
         COALESCE(SUM(CASE WHEN payment_method IS DISTINCT FROM 'debt' THEN price * commission_pct / 100.0 ELSE 0 END),0) AS commissions_total,
         COUNT(*) FILTER (WHERE status='completed') AS cuts_count
       FROM appointments WHERE shop_id=$1 AND date=$2 AND status='completed'`,
      [shopId, date]
    );
    const exps = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS expenses_total FROM expenses WHERE shop_id=$1 AND date=$2`,
      [shopId, date]
    );
    const a = appts.rows[0];
    const revenue = parseFloat(a.revenue_total);
    const expenses = parseFloat(exps.rows[0].expenses_total);
    const tips = parseFloat(a.tips_total);
    const commissions = parseFloat(a.commissions_total);
    const net = revenue + tips - expenses - commissions;

    await pool.query(
      `INSERT INTO cash_registers
         (shop_id, date, cash_total, debit_total, credit_total, transfer_total,
          debt_total, tips_total, expenses_total, revenue_total, net_total, cuts_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (shop_id, date) DO UPDATE SET
         cash_total=$3, debit_total=$4, credit_total=$5, transfer_total=$6,
         debt_total=$7, tips_total=$8, expenses_total=$9, revenue_total=$10,
         net_total=$11, cuts_count=$12, closed_at=NOW()`,
      [shopId, date, a.cash_total, a.debit_total, a.credit_total, a.transfer_total,
       a.debt_total, tips, expenses, revenue, net, a.cuts_count]
    );
    console.log(`[CAJA] Cierre registrado para shop ${shopId} fecha ${date} net=$${net}`);
    res.json({ ok: true, net_total: net });
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
       WHERE id=$1 AND shop_id=$2
       RETURNING appointment_id, amount, client_name`,
      [req.params.id, req.shopId]
    );
    if (!debtQ.rows.length) return res.status(404).json({ error: 'Deuda no encontrada' });
    const debt = debtQ.rows[0];

    // Registrar el cobro como INGRESO en caja del día de hoy
    const pmLabel = { cash:'Efectivo', debit:'Débito', credit:'Crédito', transfer:'Transferencia' };
    const methodStr = payment_method && pmLabel[payment_method] ? ` (${pmLabel[payment_method]})` : '';
    await pool.query(
      `INSERT INTO expenses (shop_id, amount, category, description, is_income, source_type, source_id)
       VALUES ($1,$2,'ventas',$3,TRUE,'debt_payment',$4)`,
      [req.shopId, parseFloat(debt.amount || 0),
       `Cobro fiado — ${debt.client_name}${methodStr}`,
       parseInt(req.params.id)]
    );

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/dashboard/cash/auto-close — cerrar caja de todos los shops
// Llamado por el scheduler a la hora de cierre + 3hs
router.post('/cash/auto-close', async (req, res) => {
  const secret = req.headers['x-scheduler-secret'];
  if (secret !== process.env.JWT_SECRET) return res.status(403).json({ error: 'No autorizado' });
  try {
    // Obtener todos los shops con horario configurado
    const shops = await pool.query(
      `SELECT id, schedule FROM shops WHERE is_barber=FALSE AND (is_barber IS NULL OR is_barber=FALSE) AND schedule IS NOT NULL`
    );
    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const dayNames = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    const dayKey = dayNames[now.getDay()];
    let closed = 0;

    for (const shop of shops.rows) {
      try {
        const schedule = JSON.parse(shop.schedule);
        const daySchedule = schedule[dayKey];
        if (!daySchedule?.active || !daySchedule?.end) continue;
        const [endH, endM] = daySchedule.end.split(':').map(Number);
        const closeMins = endH * 60 + endM + 180; // cierre + 3hs
        // Solo cerrar si estamos en la ventana ±30min del cierre + 3hs
        if (Math.abs(nowMins - closeMins) <= 30) {
          // Calcular y guardar cierre
          const appts = await pool.query(
            `SELECT
               COALESCE(SUM(CASE WHEN payment_method='cash' THEN price ELSE 0 END),0) AS cash_total,
               COALESCE(SUM(CASE WHEN payment_method='debit' THEN price ELSE 0 END),0) AS debit_total,
               COALESCE(SUM(CASE WHEN payment_method='credit' THEN price ELSE 0 END),0) AS credit_total,
               COALESCE(SUM(CASE WHEN payment_method='transfer' THEN price ELSE 0 END),0) AS transfer_total,
               COALESCE(SUM(CASE WHEN payment_method='debt' THEN price ELSE 0 END),0) AS debt_total,
               COALESCE(SUM(tip),0) AS tips_total,
               COALESCE(SUM(price),0) AS revenue_total,
               COALESCE(SUM(price * commission_pct / 100.0),0) AS commissions_total,
               COUNT(*) FILTER (WHERE status='completed') AS cuts_count
             FROM appointments WHERE shop_id=$1 AND date=$2 AND status='completed'`,
            [shop.id, today]
          );
          const exps = await pool.query(
            `SELECT COALESCE(SUM(amount),0) AS expenses_total FROM expenses WHERE shop_id=$1 AND date=$2`,
            [shop.id, today]
          );
          const a = appts.rows[0];
          const revenue = parseFloat(a.revenue_total);
          const expenses = parseFloat(exps.rows[0].expenses_total);
          const tips = parseFloat(a.tips_total);
          const commissions = parseFloat(a.commissions_total);
          const net = revenue + tips - expenses - commissions;
          await pool.query(
            `INSERT INTO cash_registers
               (shop_id, date, cash_total, debit_total, credit_total, transfer_total,
                debt_total, tips_total, expenses_total, revenue_total, net_total, cuts_count)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (shop_id, date) DO UPDATE SET
               cash_total=$3, debit_total=$4, credit_total=$5, transfer_total=$6,
               debt_total=$7, tips_total=$8, expenses_total=$9, revenue_total=$10,
               net_total=$11, cuts_count=$12, closed_at=NOW()`,
            [shop.id, today, a.cash_total, a.debit_total, a.credit_total, a.transfer_total,
             a.debt_total, tips, expenses, revenue, net, a.cuts_count]
          );
          closed++;
          console.log(`[CAJA AUTO] Shop ${shop.id} cerrado · net=$${net}`);
        }
      } catch(e) { console.error(`[CAJA AUTO] Error shop ${shop.id}:`, e.message); }
    }
    res.json({ ok: true, closed });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboard/month-report?year=2026&month=4 — datos para exportar PDF
router.get('/month-report', auth, async (req, res) => {
  const shopId = req.shopId;
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const from  = `${year}-${String(month).padStart(2,'0')}-01`;
  const to    = new Date(year, month, 0).toISOString().split('T')[0]; // último día del mes

  try {
    // Métricas generales
    const metricsQ = await pool.query(
      `SELECT
         COALESCE(SUM(price),0)                                                          AS revenue,
         COALESCE(SUM(tip),0)                                                             AS tips_total,
         COALESCE(SUM(price * commission_pct / 100.0),0)                                 AS commissions_total,
         COUNT(*) FILTER (WHERE status='completed')                                       AS completed,
         COALESCE(SUM(CASE WHEN payment_method='cash'     THEN price ELSE 0 END),0)      AS cash,
         COALESCE(SUM(CASE WHEN payment_method='debit'    THEN price ELSE 0 END),0)      AS debit,
         COALESCE(SUM(CASE WHEN payment_method='credit'   THEN price ELSE 0 END),0)      AS credit,
         COALESCE(SUM(CASE WHEN payment_method='transfer' THEN price ELSE 0 END),0)      AS transfer,
         COALESCE(SUM(CASE WHEN payment_method='debt'     THEN price ELSE 0 END),0)      AS debt
       FROM appointments
       WHERE shop_id=$1 AND date >= $2 AND date <= $3 AND status='completed'`,
      [shopId, from, to]
    );

    // Gastos del mes
    const expensesQ = await pool.query(
      `SELECT * FROM expenses WHERE shop_id=$1 AND date >= $2 AND date <= $3 ORDER BY date`,
      [shopId, from, to]
    );

    // Cierres diarios del mes
    const cashQ = await pool.query(
      `SELECT * FROM cash_registers WHERE shop_id=$1 AND date >= $2 AND date <= $3 ORDER BY date`,
      [shopId, from, to]
    );

    const m = metricsQ.rows[0];
    const expTotal = expensesQ.rows.reduce((s,e) => s + parseFloat(e.amount), 0);
    const revenue = parseFloat(m.revenue);
    const tips = parseFloat(m.tips_total);
    const commissions = parseFloat(m.commissions_total);

    res.json({
      revenue,
      tips_total:        tips,
      commissions_total: commissions,
      expenses_total:    expTotal,
      net_total:         revenue + tips - commissions - expTotal,
      completed:         parseInt(m.completed),
      by_payment: {
        cash:     parseFloat(m.cash),
        debit:    parseFloat(m.debit),
        credit:   parseFloat(m.credit),
        transfer: parseFloat(m.transfer),
        debt:     parseFloat(m.debt),
      },
      expenses:       expensesQ.rows,
      cash_registers: cashQ.rows,
    });
  } catch(e) {
    console.error('month-report error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
