const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Solo enterprise owners pueden acceder
// Verifica JWT primero; si el flag no está en el token (cuenta creada antes del fix),
// hace fallback a DB chequeando filo_plan='enterprise' y no es branch ni barbero
async function enterpriseOnly(req, res, next) {
  if (req.isEnterpriseOwner) return next();
  try {
    const r = await pool.query(
      `SELECT filo_plan, is_branch, is_barber, is_enterprise_owner
       FROM shops WHERE id=$1`,
      [req.shopId]
    );
    const s = r.rows[0];
    if (!s) return res.status(403).json({ error: 'Solo el owner enterprise puede hacer esto' });
    const isOwner = s.is_enterprise_owner ||
      (s.filo_plan === 'enterprise' && !s.is_branch && !s.is_barber);
    if (!isOwner) return res.status(403).json({ error: 'Solo el owner enterprise puede hacer esto' });
    // Actualizar flag en DB para que el próximo token ya lo traiga
    if (!s.is_enterprise_owner) {
      await pool.query('UPDATE shops SET is_enterprise_owner=TRUE WHERE id=$1', [req.shopId]);
    }
    next();
  } catch(e) { res.status(500).json({ error: e.message }); }
}

// ── GET /api/enterprise/branches — listar sucursales (incluye sede principal) ─
router.get('/branches', auth, enterpriseOnly, async (req, res) => {
  try {
    const cols = `id, name, email, branch_label, city, address, wpp_connected, subscription_status, created_at`;
    const [ownerRes, branchRes] = await Promise.all([
      pool.query(`SELECT ${cols} FROM shops WHERE id=$1`, [req.shopId]),
      pool.query(`SELECT ${cols} FROM shops WHERE parent_enterprise_id=$1 AND is_branch=TRUE ORDER BY name`, [req.shopId])
    ]);
    const main = { ...ownerRes.rows[0], is_main: true, branch_label: ownerRes.rows[0]?.branch_label || 'Sede Principal' };
    res.json([main, ...branchRes.rows]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/enterprise/branches — crear sucursal ───────────────────────────
router.post('/branches', auth, enterpriseOnly, async (req, res) => {
  const { name, branch_label, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });

  try {
    // Verificar que no exista cuenta con ese email
    const exists = await pool.query('SELECT id FROM shops WHERE email=$1', [email.toLowerCase()]);
    if (exists.rows.length)
      return res.status(400).json({ error: 'Ya existe una cuenta con ese email' });

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO shops
         (name, email, password, plan, filo_plan,
          is_branch, parent_enterprise_id, branch_label,
          subscription_status, trial_ends_at)
       VALUES ($1,$2,$3,'staff','enterprise',TRUE,$4,$5,'active','2099-12-31')
       RETURNING *`,
      [name.trim(), email.toLowerCase().trim(), hash, req.shopId, branch_label || null]
    );

    const branch = result.rows[0];

    // Servicios por defecto para la sucursal
    await pool.query(
      `INSERT INTO services (shop_id, name, price, duration_minutes) VALUES
         ($1,'Corte de cabello',3500,30),
         ($1,'Corte + Barba',5500,45),
         ($1,'Arreglo de barba',2500,20)`,
      [branch.id]
    );

    res.status(201).json({ ok: true, branch, generated_password: password });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/enterprise/branches/:id — editar sucursal ───────────────────────
router.put('/branches/:id', auth, enterpriseOnly, async (req, res) => {
  const { name, branch_label, city, address } = req.body;
  try {
    const result = await pool.query(
      `UPDATE shops SET
         name         = COALESCE($1, name),
         branch_label = COALESCE($2, branch_label),
         city         = COALESCE($3, city),
         address      = COALESCE($4, address)
       WHERE id=$5 AND parent_enterprise_id=$6 AND is_branch=TRUE
       RETURNING id, name, branch_label, city, address`,
      [name||null, branch_label||null, city||null, address||null, req.params.id, req.shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Sucursal no encontrada' });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/enterprise/branches/:id — desactivar sucursal ────────────────
router.delete('/branches/:id', auth, enterpriseOnly, async (req, res) => {
  try {
    await pool.query(
      `UPDATE shops SET subscription_status='cancelled'
       WHERE id=$1 AND parent_enterprise_id=$2 AND is_branch=TRUE`,
      [req.params.id, req.shopId]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/stats — stats consolidadas de todas las sucursales ────
router.get('/stats', auth, enterpriseOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         s.id, s.name, s.branch_label, s.wpp_connected, s.subscription_status,
         s.city, s.address, s.created_at,
         -- Hoy
         COUNT(a.id) FILTER (WHERE a.date = CURRENT_DATE AND a.status='completed') AS cuts_today,
         COALESCE(SUM(a.price) FILTER (WHERE a.date = CURRENT_DATE AND a.status='completed'), 0) AS revenue_today,
         -- Este mes
         COUNT(a.id) FILTER (
           WHERE LEFT(a.date::text,7) = TO_CHAR(CURRENT_DATE AT TIME ZONE 'America/Argentina/Buenos_Aires','YYYY-MM') AND a.status='completed'
         ) AS cuts_month,
         COALESCE(SUM(a.price) FILTER (
           WHERE LEFT(a.date::text,7) = TO_CHAR(CURRENT_DATE AT TIME ZONE 'America/Argentina/Buenos_Aires','YYYY-MM') AND a.status='completed'
         ), 0) AS revenue_month,
         -- Comisiones mes
         COALESCE(SUM(a.price * a.commission_pct / 100.0) FILTER (
           WHERE LEFT(a.date::text,7) = TO_CHAR(CURRENT_DATE AT TIME ZONE 'America/Argentina/Buenos_Aires','YYYY-MM') AND a.status='completed'
         ), 0) AS commissions_month,
         -- Gastos mes (egresos reales)
         COALESCE((SELECT SUM(e.amount) FROM expenses e
           WHERE e.shop_id=s.id AND (e.is_income IS NULL OR e.is_income=FALSE)
             AND LEFT(e.date::text,7) = TO_CHAR(CURRENT_DATE AT TIME ZONE 'America/Argentina/Buenos_Aires','YYYY-MM')
         ), 0) AS expenses_month,
         -- Última semana (7 días)
         COUNT(a.id) FILTER (WHERE a.date >= CURRENT_DATE-6 AND a.status='completed') AS cuts_week,
         COALESCE(SUM(a.price) FILTER (WHERE a.date >= CURRENT_DATE-6 AND a.status='completed'), 0) AS revenue_week,
         -- Ticket promedio del mes
         COALESCE(AVG(a.price) FILTER (
           WHERE LEFT(a.date::text,7) = TO_CHAR(CURRENT_DATE AT TIME ZONE 'America/Argentina/Buenos_Aires','YYYY-MM') AND a.status='completed'
         ), 0) AS avg_ticket_month,
         -- Barberos activos
         (SELECT COUNT(*) FROM shops b WHERE b.parent_shop_id=s.id AND b.is_barber=TRUE) AS barber_count,
         -- Clientes totales y nuevos este mes
         (SELECT COUNT(*) FROM clients c WHERE c.shop_id=s.id) AS client_count,
         (SELECT COUNT(*) FROM clients c WHERE c.shop_id=s.id
           AND date_trunc('month',c.created_at)=date_trunc('month',NOW())) AS new_clients_month,
         -- Turnos pendientes hoy
         (SELECT COUNT(*) FROM appointments a2 WHERE a2.shop_id=s.id AND a2.date=CURRENT_DATE
           AND a2.status IN ('pending','confirmed')) AS pending_today,
         -- Turno próximo
         (SELECT MIN(a2.time_start::text) FROM appointments a2
           WHERE a2.shop_id=s.id AND a2.date=CURRENT_DATE AND a2.status IN ('pending','confirmed')) AS next_appt
       FROM shops s
       LEFT JOIN appointments a ON a.shop_id=s.id
       WHERE s.id=$1 OR (s.parent_enterprise_id=$1 AND s.is_branch=TRUE)
       GROUP BY s.id,s.name,s.branch_label,s.wpp_connected,s.subscription_status,s.city,s.address,s.created_at
       ORDER BY revenue_month DESC`,
      [req.shopId]
    );

    const branches = result.rows;
    const totals = {
      revenue_today:     branches.reduce((s,b) => s + parseFloat(b.revenue_today||0), 0),
      revenue_week:      branches.reduce((s,b) => s + parseFloat(b.revenue_week||0), 0),
      revenue_month:     branches.reduce((s,b) => s + parseFloat(b.revenue_month||0), 0),
      cuts_today:        branches.reduce((s,b) => s + parseInt(b.cuts_today||0), 0),
      cuts_week:         branches.reduce((s,b) => s + parseInt(b.cuts_week||0), 0),
      cuts_month:        branches.reduce((s,b) => s + parseInt(b.cuts_month||0), 0),
      barber_count:      branches.reduce((s,b) => s + parseInt(b.barber_count||0), 0),
      client_count:      branches.reduce((s,b) => s + parseInt(b.client_count||0), 0),
      new_clients_month: branches.reduce((s,b) => s + parseInt(b.new_clients_month||0), 0),
      commissions_month: branches.reduce((s,b) => s + parseFloat(b.commissions_month||0), 0),
      expenses_month:    branches.reduce((s,b) => s + parseFloat(b.expenses_month||0), 0),
      pending_today:     branches.reduce((s,b) => s + parseInt(b.pending_today||0), 0),
    };
    totals.profit_month = totals.revenue_month - totals.commissions_month - totals.expenses_month;
    totals.avg_ticket   = totals.cuts_month > 0 ? totals.revenue_month / totals.cuts_month : 0;

    res.json({ branches, totals });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/config — configuración del owner ─────────────────────
router.get('/config', auth, enterpriseOnly, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT name, email, phone, city, enterprise_currency, enterprise_timezone,
              enterprise_logo_url, enterprise_notes, enterprise_shared_wpp, booking_slug
       FROM shops WHERE id=$1`,
      [req.shopId]
    );
    res.json(r.rows[0] || {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/enterprise/config — guardar configuración ───────────────────────
router.put('/config', auth, enterpriseOnly, async (req, res) => {
  const { name, phone, city, enterprise_currency, enterprise_timezone, enterprise_notes, enterprise_shared_wpp } = req.body;
  try {
    // Para booleans, null = no tocar; true/false = actualizar
    const sharedWpp = typeof enterprise_shared_wpp === 'boolean' ? enterprise_shared_wpp : null;
    const r = await pool.query(
      `UPDATE shops SET
         name                  = COALESCE($1, name),
         phone                 = COALESCE($2, phone),
         city                  = COALESCE($3, city),
         enterprise_currency   = COALESCE($4, enterprise_currency),
         enterprise_timezone   = COALESCE($5, enterprise_timezone),
         enterprise_notes      = COALESCE($6, enterprise_notes),
         enterprise_shared_wpp = CASE WHEN $7::boolean IS NOT NULL THEN $7::boolean ELSE enterprise_shared_wpp END
       WHERE id=$8
       RETURNING name, phone, city, enterprise_currency, enterprise_timezone, enterprise_notes, enterprise_shared_wpp`,
      [name||null, phone||null, city||null,
       enterprise_currency||null, enterprise_timezone||null, enterprise_notes||null,
       sharedWpp, req.shopId]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/shared-wpp — para sucursales: saber si el owner usa WPP compartido ──
router.get('/shared-wpp', auth, async (req, res) => {
  try {
    const shop = await pool.query('SELECT parent_enterprise_id, is_branch FROM shops WHERE id=$1', [req.shopId]);
    const s = shop.rows[0];
    if (!s?.is_branch || !s?.parent_enterprise_id) return res.json({ shared_wpp: false });
    const parent = await pool.query('SELECT enterprise_shared_wpp FROM shops WHERE id=$1', [s.parent_enterprise_id]);
    res.json({ shared_wpp: parent.rows[0]?.enterprise_shared_wpp || false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/branches-wpp-status — estado WPP del owner y sus sucursales ──
router.get('/branches-wpp-status', auth, enterpriseOnly, async (req, res) => {
  try {
    const ownerQ = await pool.query(
      'SELECT enterprise_shared_wpp, wpp_connected, (wpp_session IS NOT NULL) AS wpp_had_session FROM shops WHERE id=$1',
      [req.shopId]
    );
    const owner = ownerQ.rows[0] || {};

    const branchQ = await pool.query(
      `SELECT id, name, wpp_connected, (wpp_session IS NOT NULL) AS wpp_had_session
       FROM shops WHERE parent_enterprise_id=$1 AND is_branch=TRUE ORDER BY name`,
      [req.shopId]
    );
    res.json({
      shared_wpp:      owner.enterprise_shared_wpp || false,
      owner_connected: owner.wpp_connected || false,
      owner_had_session: owner.wpp_had_session || false,
      branches:        branchQ.rows
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/stats/history?days=30 — serie temporal por sucursal ──
router.get('/stats/history', auth, enterpriseOnly, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  try {
    const result = await pool.query(
      `SELECT
         s.id AS branch_id,
         s.name AS branch_name,
         s.branch_label,
         a.date::text AS date,
         COALESCE(SUM(a.price) FILTER (WHERE a.status='completed'), 0) AS revenue,
         COUNT(a.id)  FILTER (WHERE a.status='completed') AS cuts
       FROM shops s
       LEFT JOIN appointments a
         ON a.shop_id = s.id
         AND a.date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
       WHERE s.parent_enterprise_id = $1 AND s.is_branch = TRUE
       GROUP BY s.id, s.name, s.branch_label, a.date
       ORDER BY a.date DESC, s.name`,
      [req.shopId, days]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Helper: verificar que la sucursal pertenece al enterprise owner ────────────
async function verifyBranch(req, res) {
  const r = await pool.query(
    'SELECT id FROM shops WHERE id=$1 AND parent_enterprise_id=$2 AND is_branch=TRUE',
    [req.params.id, req.shopId]
  );
  if (!r.rows.length) { res.status(404).json({ error: 'Sucursal no encontrada' }); return null; }
  return req.params.id;
}

// ── GET /api/enterprise/branches/:id/cash?date= ───────────────────────────────
router.get('/branches/:id/cash', auth, enterpriseOnly, async (req, res) => {
  const branchId = await verifyBranch(req, res);
  if (!branchId) return;
  const date = req.query.date || new Date().toISOString().split('T')[0];
  try {
    const appts = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN payment_method='cash' THEN price ELSE 0 END),0)     AS cash_total,
         COALESCE(SUM(CASE WHEN payment_method='debit' THEN price ELSE 0 END),0)    AS debit_total,
         COALESCE(SUM(CASE WHEN payment_method='credit' THEN price ELSE 0 END),0)   AS credit_total,
         COALESCE(SUM(CASE WHEN payment_method='transfer' THEN price ELSE 0 END),0) AS transfer_total,
         COALESCE(SUM(CASE WHEN payment_method='debt' THEN price ELSE 0 END),0)     AS debt_total,
         COALESCE(SUM(CASE WHEN payment_method IS NULL THEN price ELSE 0 END),0)    AS no_method_total,
         COALESCE(SUM(tip),0) AS tips_total,
         COALESCE(SUM(CASE WHEN payment_method IS DISTINCT FROM 'debt' THEN price ELSE 0 END),0) AS revenue_total,
         COUNT(*) FILTER (WHERE status='completed') AS cuts_count
       FROM appointments
       WHERE shop_id=$1 AND date=$2 AND status='completed'`,
      [branchId, date]
    );
    const exps = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN (is_income IS NULL OR is_income=FALSE) THEN amount ELSE 0 END),0) AS expenses_total,
         COALESCE(SUM(CASE WHEN is_income=TRUE THEN amount ELSE 0 END),0) AS all_income,
         COALESCE(SUM(CASE WHEN is_income=TRUE AND (source_type IS DISTINCT FROM 'debt_payment') THEN amount ELSE 0 END),0) AS extra_income,
         json_agg(json_build_object('id',id,'amount',amount,'category',category,'description',description,'source_type',source_type,'payment_method',payment_method) ORDER BY created_at DESC)
           FILTER (WHERE is_income IS NULL OR is_income=FALSE) AS items,
         json_agg(json_build_object('id',id,'amount',amount,'category',category,'description',description,'source_type',source_type,'payment_method',payment_method) ORDER BY created_at DESC)
           FILTER (WHERE is_income=TRUE AND source_type IS DISTINCT FROM 'debt_payment') AS income_items
       FROM expenses WHERE shop_id=$1 AND date=$2`,
      [branchId, date]
    );
    const dc = (await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN payment_method='cash'     THEN amount ELSE 0 END),0) AS cash_col,
         COALESCE(SUM(CASE WHEN payment_method='debit'    THEN amount ELSE 0 END),0) AS debit_col,
         COALESCE(SUM(CASE WHEN payment_method='credit'   THEN amount ELSE 0 END),0) AS credit_col,
         COALESCE(SUM(CASE WHEN payment_method='transfer' THEN amount ELSE 0 END),0) AS transfer_col,
         COALESCE(SUM(amount),0) AS total_col
       FROM expenses WHERE shop_id=$1 AND date=$2 AND source_type='debt_payment'`,
      [branchId, date]
    )).rows[0];
    const commQ = await pool.query(
      `SELECT COALESCE(SUM(price * commission_pct / 100.0),0) AS total_commission
       FROM appointments WHERE shop_id=$1 AND date=$2 AND status='completed'`,
      [branchId, date]
    );
    const a = appts.rows[0]; const e = exps.rows[0];
    const revenue = parseFloat(a.revenue_total);
    const allIncome = parseFloat(e.all_income || 0);
    const extraIncome = parseFloat(e.extra_income || 0);
    const expenses = parseFloat(e.expenses_total);
    const tips = parseFloat(a.tips_total);
    const commissions = parseFloat(commQ.rows[0].total_commission);
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
      net_total:         revenue + tips + allIncome - expenses - commissions,
      cuts_count:        parseInt(a.cuts_count),
      expenses_items:    e.items || [],
      income_items:      e.income_items || [],
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/branches/:id/cash/method-detail?date=&method= ─────────
router.get('/branches/:id/cash/method-detail', auth, enterpriseOnly, async (req, res) => {
  const branchId = await verifyBranch(req, res);
  if (!branchId) return;
  const { method } = req.query;
  const date = req.query.date || new Date().toISOString().split('T')[0];
  if (!method) return res.status(400).json({ error: 'Se requiere method' });
  try {
    const appts = await pool.query(
      `SELECT a.id, a.client_name, a.service_name, a.price, a.cost, a.commission_pct,
              a.tip, a.time_start,
              ROUND(a.price * a.commission_pct / 100.0, 2) AS commission_amount,
              ROUND(a.price - COALESCE(a.cost,0) - (a.price * a.commission_pct / 100.0), 2) AS profit,
              s.name AS barber_name
       FROM appointments a
       LEFT JOIN shops s ON s.id = a.barber_id
       WHERE a.shop_id=$1 AND a.date=$2 AND a.payment_method=$3 AND a.status='completed'
       ORDER BY a.time_start ASC`,
      [branchId, date, method]
    );
    const debts = await pool.query(
      `SELECT id, description, amount, created_at
       FROM expenses
       WHERE shop_id=$1 AND date=$2 AND source_type='debt_payment' AND payment_method=$3
       ORDER BY created_at ASC`,
      [branchId, date, method]
    );
    const apptTotal = appts.rows.reduce((s, a) => s + parseFloat(a.price || 0), 0);
    const debtTotal = debts.rows.reduce((s, d) => s + parseFloat(d.amount || 0), 0);
    res.json({
      method, date,
      appointments:       appts.rows,
      debt_payments:      debts.rows,
      appointments_total: apptTotal,
      debt_total:         debtTotal,
      grand_total:        apptTotal + debtTotal,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/branches/:id/cash/history ─────────────────────────────
router.get('/branches/:id/cash/history', auth, enterpriseOnly, async (req, res) => {
  const branchId = await verifyBranch(req, res);
  if (!branchId) return;
  try {
    const result = await pool.query(
      `SELECT * FROM cash_registers WHERE shop_id=$1 ORDER BY date DESC LIMIT 30`,
      [branchId]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/branches/:id/cash/day-detail?date= ───────────────────
router.get('/branches/:id/cash/day-detail', auth, enterpriseOnly, async (req, res) => {
  const branchId = await verifyBranch(req, res);
  if (!branchId) return;
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'Se requiere date' });
  try {
    const reg = await pool.query(
      `SELECT * FROM cash_registers WHERE shop_id=$1 AND date::date = $2::date`,
      [branchId, date]
    );
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
      [branchId, date]
    );
    const expenses = await pool.query(
      `SELECT id, amount, category, description, is_income, source_type, payment_method, created_at
       FROM expenses WHERE shop_id=$1 AND date=$2
       ORDER BY created_at ASC`,
      [branchId, date]
    );
    res.json({
      register:     reg.rows[0] || null,
      appointments: appts.rows,
      expenses:     expenses.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/branches/:id/month-report?year=&month= ───────────────
router.get('/branches/:id/month-report', auth, enterpriseOnly, async (req, res) => {
  const branchId = await verifyBranch(req, res);
  if (!branchId) return;
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const from  = `${year}-${String(month).padStart(2,'0')}-01`;
  const to    = new Date(year, month, 0).toISOString().split('T')[0];
  try {
    const metricsQ = await pool.query(
      `SELECT
         COALESCE(SUM(price),0)                                                     AS revenue,
         COALESCE(SUM(tip),0)                                                        AS tips_total,
         COALESCE(SUM(price * commission_pct / 100.0),0)                            AS commissions_total,
         COUNT(*) FILTER (WHERE status='completed')                                  AS completed,
         COALESCE(SUM(CASE WHEN payment_method='cash'     THEN price ELSE 0 END),0) AS cash,
         COALESCE(SUM(CASE WHEN payment_method='debit'    THEN price ELSE 0 END),0) AS debit,
         COALESCE(SUM(CASE WHEN payment_method='credit'   THEN price ELSE 0 END),0) AS credit,
         COALESCE(SUM(CASE WHEN payment_method='transfer' THEN price ELSE 0 END),0) AS transfer,
         COALESCE(SUM(CASE WHEN payment_method='debt'     THEN price ELSE 0 END),0) AS debt
       FROM appointments
       WHERE shop_id=$1 AND date >= $2 AND date <= $3 AND status='completed'`,
      [branchId, from, to]
    );
    const expensesQ = await pool.query(
      `SELECT * FROM expenses WHERE shop_id=$1 AND date >= $2 AND date <= $3 ORDER BY date`,
      [branchId, from, to]
    );
    const cashQ = await pool.query(
      `SELECT * FROM cash_registers WHERE shop_id=$1 AND date >= $2 AND date <= $3 ORDER BY date`,
      [branchId, from, to]
    );
    const m = metricsQ.rows[0];
    const expTotal = expensesQ.rows.reduce((s,e) => s + parseFloat(e.amount), 0);
    const revenue = parseFloat(m.revenue);
    const tips = parseFloat(m.tips_total);
    const commissions = parseFloat(m.commissions_total);
    res.json({
      revenue, tips_total: tips, commissions_total: commissions,
      expenses_total: expTotal,
      net_total: revenue + tips - commissions - expTotal,
      completed: parseInt(m.completed),
      by_payment: { cash: parseFloat(m.cash), debit: parseFloat(m.debit), credit: parseFloat(m.credit), transfer: parseFloat(m.transfer), debt: parseFloat(m.debt) },
      expenses:       expensesQ.rows,
      cash_registers: cashQ.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/branches/:id/debts ────────────────────────────────────
router.get('/branches/:id/debts', auth, enterpriseOnly, async (req, res) => {
  const branchId = await verifyBranch(req, res);
  if (!branchId) return;
  try {
    const result = await pool.query(
      `SELECT d.*, c.phone AS client_phone
       FROM client_debts d
       LEFT JOIN clients c ON c.id = d.client_id
       WHERE d.shop_id=$1 AND d.paid=FALSE
       ORDER BY d.created_at DESC`,
      [branchId]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
