// Cálculos de caja compartidos por dashboard (vivo), cierres manuales/automáticos,
// scheduler y enterprise, para que TODOS usen la misma definición.
const pool = require('../db/pool');
const { getShopTz } = require('../db/shopTz');

// Precio de un turno sin su parte fiada: en un pago dividido, lo fiado no es ingreso hasta que se
// cobra (igual que un turno fiado entero, que se excluye aparte). `t` es la tabla o alias del turno.
const paidPriceSql = (t) => `(${t}.price - CASE WHEN ${t}.payment_method='mixed' THEN COALESCE((SELECT SUM(ps.amount) FROM payment_splits ps WHERE ps.appointment_id=${t}.id AND ps.method='debt'),0) ELSE 0 END)`;

const isMissing = (e, what) => new RegExp(`${what}.*does not exist|relation "${what}"|column.*${what}`, 'i').test(e.message || '');

// Ingresos por método del día (splits-aware, neto de seña ya cobrada + seña por su método).
async function methodTotalsForDay(shopId, date) {
  const run = (withSplits) => pool.query(
    `WITH
       by_appt AS (
         SELECT id, price, payment_method,
                CASE WHEN sena_status='confirmed' THEN COALESCE(sena_amount,0) ELSE 0 END AS sena
           FROM appointments
           WHERE shop_id=$1 AND date=$2::date AND status='completed'
       ),
       ${withSplits ? `splits_by_appt AS (
         SELECT ps.appointment_id, ps.method, SUM(ps.amount) AS amount
           FROM payment_splits ps JOIN by_appt ba ON ba.id = ps.appointment_id
           GROUP BY ps.appointment_id, ps.method
       ),` : ''}
       method_totals AS (
         SELECT ba.payment_method AS method, SUM(GREATEST(ba.price - ba.sena, 0)) AS amount
           FROM by_appt ba
           ${withSplits ? 'WHERE NOT EXISTS (SELECT 1 FROM splits_by_appt sa WHERE sa.appointment_id = ba.id)' : ''}
           GROUP BY ba.payment_method
         ${withSplits ? 'UNION ALL SELECT sa.method, SUM(sa.amount) FROM splits_by_appt sa GROUP BY sa.method' : ''}
         UNION ALL
         SELECT e.payment_method, SUM(e.amount) FROM expenses e
           WHERE e.shop_id=$1 AND e.date=$2::date AND e.is_income=TRUE AND e.source_type='sena'
             AND e.payment_method IS NOT NULL
           GROUP BY e.payment_method
       )
     SELECT
       COALESCE(SUM(CASE WHEN method='cash'     THEN amount END),0)::numeric AS cash_total,
       COALESCE(SUM(CASE WHEN method='debit'    THEN amount END),0)::numeric AS debit_total,
       COALESCE(SUM(CASE WHEN method='credit'   THEN amount END),0)::numeric AS credit_total,
       COALESCE(SUM(CASE WHEN method='transfer' THEN amount END),0)::numeric AS transfer_total,
       COALESCE(SUM(CASE WHEN method='debt'     THEN amount END),0)::numeric AS debt_total
     FROM method_totals`,
    [shopId, date]
  );
  try { return (await run(true)).rows[0]; }
  catch (e) {
    if (isMissing(e, 'payment_splits') || isMissing(e, 'sena')) return (await run(false)).rows[0];
    throw e;
  }
}

// Saldo de cada cuenta (método de pago) en el día: lo que entró menos lo que salió por esa cuenta.
// Ingresos: turnos (netos de seña; mixtos por split), ventas de productos, cobros de fiado,
// señas y propinas. Egresos: gastos, compras, liquidaciones. Es lo que ve la cajera en la caja en
// vivo y lo que se guarda en el cierre, así los dos números coinciden.
// Devuelve { [method]: total }.
async function methodFlowForDay(shopId, date) {
  const map = {};
  const add = (rows, sign = 1) => rows.forEach(r => {
    if (r.key == null) return;
    map[r.key] = (map[r.key] || 0) + sign * parseFloat(r.total || 0);
  });

  // Turnos: splits-aware y netos de la seña ya cobrada
  const apptSql = (withSplits) => `
    WITH by_appt AS (
      SELECT id, GREATEST(price - CASE WHEN sena_status='confirmed' THEN COALESCE(sena_amount,0) ELSE 0 END, 0) AS price, payment_method
        FROM appointments
       WHERE shop_id=$1 AND date=$2 AND status='completed' AND payment_method IS NOT NULL
    )
    ${withSplits ? `, splits_by_appt AS (
      SELECT ps.appointment_id, ps.method, SUM(ps.amount) AS amount
        FROM payment_splits ps JOIN by_appt ba ON ba.id = ps.appointment_id
       GROUP BY ps.appointment_id, ps.method
    )` : ''}
    SELECT method AS key, SUM(amount) AS total FROM (
      SELECT ba.payment_method AS method, SUM(ba.price) AS amount FROM by_appt ba
       ${withSplits ? 'WHERE NOT EXISTS (SELECT 1 FROM splits_by_appt sa WHERE sa.appointment_id = ba.id)' : ''}
       GROUP BY ba.payment_method
      ${withSplits ? 'UNION ALL SELECT sa.method, SUM(sa.amount) FROM splits_by_appt sa GROUP BY sa.method' : ''}
    ) t GROUP BY method`;
  try { add((await pool.query(apptSql(true), [shopId, date])).rows); }
  catch (e) {
    if (!/payment_splits/i.test(e.message)) throw e;
    add((await pool.query(apptSql(false), [shopId, date])).rows);
  }

  // Ingresos registrados como movimientos: ventas de productos, cobros de fiado y señas
  add((await pool.query(
    `SELECT payment_method AS key, COALESCE(SUM(amount),0) AS total
       FROM expenses
      WHERE shop_id=$1 AND date=$2 AND is_income=TRUE
        AND source_type IN ('product_sale','debt_payment','sena') AND payment_method IS NOT NULL
      GROUP BY payment_method`, [shopId, date])).rows);

  // Propinas: por su método propio si lo tienen; si no, por el del turno (en mixtos, proporcional)
  const tipSql = (withTipMethod, withSplits) => {
    const noTm = withTipMethod ? 'AND a.tip_method IS NULL' : '';
    const parts = [];
    if (withTipMethod) parts.push(`SELECT a.tip_method AS method, a.tip AS amt FROM appointments a
        WHERE a.shop_id=$1 AND a.date=$2 AND a.status='completed' AND a.tip > 0 AND a.tip_method IS NOT NULL`);
    parts.push(`SELECT a.payment_method AS method, a.tip AS amt FROM appointments a
        WHERE a.shop_id=$1 AND a.date=$2 AND a.status='completed' AND a.tip > 0 ${noTm}
          AND a.payment_method IS NOT NULL AND a.payment_method NOT IN ('debt','mixed')
          ${withSplits ? 'AND NOT EXISTS (SELECT 1 FROM payment_splits ps WHERE ps.appointment_id=a.id)' : ''}`);
    if (withSplits) parts.push(`SELECT ps.method, a.tip * ps.amount / NULLIF(t.total,0)
        FROM appointments a
        JOIN payment_splits ps ON ps.appointment_id=a.id
        JOIN (SELECT appointment_id, SUM(amount) AS total FROM payment_splits GROUP BY appointment_id) t ON t.appointment_id=a.id
       WHERE a.shop_id=$1 AND a.date=$2 AND a.status='completed' AND a.tip > 0 ${noTm} AND ps.method <> 'debt'`);
    return `SELECT method AS key, SUM(amt) AS total FROM (${parts.join(' UNION ALL ')}) x GROUP BY method`;
  };
  let tmOk = true, spOk = true;
  for (let i = 0; i < 4; i++) {
    try { add((await pool.query(tipSql(tmOk, spOk), [shopId, date])).rows); break; }
    catch (err) {
      if (tmOk && /tip_method/i.test(err.message)) tmOk = false;
      else if (spOk && /payment_splits/i.test(err.message)) spOk = false;
      else throw err;
    }
  }

  // Egresos por cuenta (gastos, compras de insumos, liquidaciones)
  add((await pool.query(
    `SELECT payment_method AS key, COALESCE(SUM(amount),0) AS total
       FROM expenses
      WHERE shop_id=$1 AND date=$2 AND (is_income IS NULL OR is_income=FALSE) AND payment_method IS NOT NULL
      GROUP BY payment_method`, [shopId, date])).rows, -1);

  return map;
}

// Comisiones devengadas del día: turnos completados (todos, incluso fiados, porque se liquidan igual)
// + comisiones de ventas de productos.
async function dayCommissions(shopId, date) {
  const tz = await getShopTz(shopId);
  const a = await pool.query(
    `SELECT COALESCE(SUM(price * COALESCE(commission_pct,0) / 100.0),0) AS c
       FROM appointments WHERE shop_id=$1 AND date=$2::date AND status='completed'`,
    [shopId, date]
  );
  const p = await pool.query(
    `SELECT COALESCE(SUM(barber_commission_amount),0) AS c
       FROM product_sales WHERE shop_id=$1 AND (sold_at AT TIME ZONE $3::text)::date = $2::date`,
    [shopId, date, tz]
  ).catch(() => ({ rows: [{ c: 0 }] }));
  return { appt: parseFloat(a.rows[0].c), product: parseFloat(p.rows[0].c) };
}

// Neto = facturado + propinas del dueño + ingresos extra − gastos (sin liquidaciones)
//        − comisiones devengadas (turnos + productos) − bonus liquidados ese día.
// Las liquidaciones (comisión+propina+bonus) NO se restan otra vez: ya están por devengado.
async function computeNet(shopId, date, { revenue, allIncome, expenses, apptCommissions, productCommissions = 0 }) {
  const tz = await getShopTz(shopId);
  const r = await pool.query(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM expenses
                  WHERE shop_id=$1 AND date=$2::date AND source_type='barber_settlement'
                    AND (is_income IS NULL OR is_income=FALSE)),0) AS settlements,
       COALESCE((SELECT SUM(amount) FROM barber_bonuses
                  WHERE shop_id=$1 AND commission_settled=TRUE
                    AND (settled_at AT TIME ZONE $3::text)::date = $2::date),0) AS bonuses,
       COALESCE((SELECT SUM(tip) FROM appointments
                  WHERE shop_id=$1 AND date=$2::date AND status='completed' AND barber_id IS NULL),0) AS owner_tips`,
    [shopId, date, tz]
  );
  const x = r.rows[0];
  return revenue + parseFloat(x.owner_tips) + allIncome
       - (expenses - parseFloat(x.settlements))
       - apptCommissions - productCommissions - parseFloat(x.bonuses);
}

// Cálculo completo de cierre de un día (lo usan cierre manual, auto-close y scheduler).
async function computeDayClose(shopId, date) {
  // Los saldos por cuenta del cierre son los mismos que ve la cajera en la caja en vivo
  const flow = await methodFlowForDay(shopId, date);
  const m = {
    cash_total: flow.cash || 0, debit_total: flow.debit || 0, credit_total: flow.credit || 0,
    transfer_total: flow.transfer || 0, debt_total: flow.debt || 0,
  };
  const ap = await pool.query(
    `SELECT
       COALESCE(SUM(tip),0) AS tips_total,
       COALESCE(SUM(CASE WHEN payment_method IS DISTINCT FROM 'debt' THEN ${paidPriceSql('appointments')} ELSE 0 END),0) AS revenue_total,
       COUNT(*) AS cuts_count
     FROM appointments WHERE shop_id=$1 AND date=$2::date AND status='completed'`,
    [shopId, date]
  );
  const ex = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN is_income IS NULL OR is_income=FALSE THEN amount ELSE 0 END),0) AS expenses_total,
       COALESCE(SUM(CASE WHEN is_income=TRUE AND source_type IS DISTINCT FROM 'sena' THEN amount ELSE 0 END),0) AS all_income
     FROM expenses WHERE shop_id=$1 AND date=$2::date`,
    [shopId, date]
  );
  const c = await dayCommissions(shopId, date);
  const revenue = parseFloat(ap.rows[0].revenue_total);
  const expenses = parseFloat(ex.rows[0].expenses_total);
  const net = await computeNet(shopId, date, {
    revenue, allIncome: parseFloat(ex.rows[0].all_income || 0), expenses,
    apptCommissions: c.appt, productCommissions: c.product,
  });
  const allIncome = parseFloat(ex.rows[0].all_income || 0);
  return {
    cash_total: m.cash_total, debit_total: m.debit_total, credit_total: m.credit_total,
    transfer_total: m.transfer_total, debt_total: m.debt_total,
    tips_total: parseFloat(ap.rows[0].tips_total), expenses_total: expenses,
    revenue_total: revenue, net_total: net, cuts_count: parseInt(ap.rows[0].cuts_count),
    method_breakdown: Object.entries(flow).map(([key, total]) => ({ key, total: String(total) })).sort((a, b) => a.key.localeCompare(b.key)),
    // Día sin ningún movimiento (local cerrado): no se guarda un cierre en $0
    has_activity: parseInt(ap.rows[0].cuts_count) > 0 || expenses > 0 || allIncome > 0 || Object.values(flow).some(v => Math.abs(v) > 0.005),
  };
}

let _breakdownCol = null;
function ensureBreakdownColumn() {
  if (!_breakdownCol) {
    _breakdownCol = pool.query('ALTER TABLE cash_registers ADD COLUMN IF NOT EXISTS method_breakdown JSONB')
      .catch(e => { _breakdownCol = null; console.warn('[caja] method_breakdown:', e.message); });
  }
  return _breakdownCol;
}

// ── Números del local día por día, calculados EN VIVO desde los turnos y movimientos ──
// Es la única fórmula para P&L, comparación semanal y panel enterprise (no depende de que la
// caja se haya cerrado ese día ni de una foto vieja del cierre).
//   facturado   = turnos cobrados (sin fiado) + ventas de productos
//   ingresos    = turnos cobrados (sin fiado) + propinas de los turnos del dueño + todo otro ingreso
//                 (productos, cobros de fiado, ingresos extra; la seña ya está dentro del turno)
//   gastos      = gastos del local (sin liquidaciones) + comisiones de los barberos
//                 (turnos + productos + bonos). Las liquidaciones son el pago de esas comisiones:
//                 restarlas otra vez las contaría dos veces.
//   neto        = ingresos − gastos   (igual que la caja diaria)
async function dailySeries(shopId, from, to) {
  const tz = await getShopTz(shopId);
  const r = await pool.query(
    `WITH d AS (SELECT generate_series($2::date, $3::date, INTERVAL '1 day')::date AS date),
     ap AS (
       SELECT date,
              COALESCE(SUM(${paidPriceSql('appointments')}) FILTER (WHERE payment_method IS DISTINCT FROM 'debt'),0) AS revenue,
              COUNT(*) AS cuts,
              COALESCE(SUM(price * COALESCE(commission_pct,0) / 100.0),0)               AS appt_comm,
              COALESCE(SUM(tip) FILTER (WHERE barber_id IS NULL),0)                      AS owner_tips,
              COALESCE(SUM(tip),0)                                                       AS tips,
              COALESCE(SUM(price),0)                                                     AS price_all
         FROM appointments
        WHERE shop_id=$1 AND status='completed' AND date BETWEEN $2::date AND $3::date
        GROUP BY date),
     ex AS (
       SELECT date,
              COALESCE(SUM(amount) FILTER (WHERE is_income=TRUE AND source_type IS DISTINCT FROM 'sena'),0) AS all_income,
              COALESCE(SUM(amount) FILTER (WHERE is_income=TRUE AND source_type='product_sale'),0)          AS product_income,
              COALESCE(SUM(amount) FILTER (WHERE is_income IS NULL OR is_income=FALSE),0)                   AS expenses,
              COALESCE(SUM(amount) FILTER (WHERE source_type='barber_settlement'
                                              AND (is_income IS NULL OR is_income=FALSE)),0)                AS settlements
         FROM expenses
        WHERE shop_id=$1 AND date BETWEEN $2::date AND $3::date
        GROUP BY date),
     ps AS (
       SELECT (sold_at AT TIME ZONE $4::text)::date AS date, COALESCE(SUM(barber_commission_amount),0) AS prod_comm
         FROM product_sales
        WHERE shop_id=$1 AND (sold_at AT TIME ZONE $4::text)::date BETWEEN $2::date AND $3::date
        GROUP BY 1),
     bo AS (
       SELECT (settled_at AT TIME ZONE $4::text)::date AS date, COALESCE(SUM(amount),0) AS bonuses
         FROM barber_bonuses
        WHERE shop_id=$1 AND commission_settled=TRUE
          AND (settled_at AT TIME ZONE $4::text)::date BETWEEN $2::date AND $3::date
        GROUP BY 1)
     SELECT d.date::text AS date, EXTRACT(DOW FROM d.date)::int AS dow,
            COALESCE(ap.revenue,0) AS revenue, COALESCE(ap.cuts,0) AS cuts, COALESCE(ap.appt_comm,0) AS appt_comm,
            COALESCE(ap.owner_tips,0) AS owner_tips, COALESCE(ap.tips,0) AS tips, COALESCE(ap.price_all,0) AS price_all,
            COALESCE(ex.all_income,0) AS all_income, COALESCE(ex.product_income,0) AS product_income,
            COALESCE(ex.expenses,0) AS expenses, COALESCE(ex.settlements,0) AS settlements,
            COALESCE(ps.prod_comm,0) AS prod_comm, COALESCE(bo.bonuses,0) AS bonuses
       FROM d
       LEFT JOIN ap ON ap.date = d.date
       LEFT JOIN ex ON ex.date = d.date
       LEFT JOIN ps ON ps.date = d.date
       LEFT JOIN bo ON bo.date = d.date
      ORDER BY d.date`,
    [shopId, from, to, tz]
  );
  const n = (v) => parseFloat(v || 0);
  return r.rows.map(x => {
    const revenue = n(x.revenue), products = n(x.product_income);
    const ingresos = revenue + n(x.owner_tips) + n(x.all_income);
    const opExpenses = n(x.expenses) - n(x.settlements);
    const commissions = n(x.appt_comm) + n(x.prod_comm) + n(x.bonuses);
    const gastos = opExpenses + commissions;
    const cuts = parseInt(x.cuts) || 0;
    return {
      date: x.date, dow: x.dow,
      facturado: revenue + products,
      ingresos, op_expenses: opExpenses, commissions, gastos,
      net: ingresos - gastos,
      cuts, tips: n(x.tips), price_all: n(x.price_all),
      active: cuts > 0 || ingresos > 0 || n(x.expenses) > 0,
    };
  });
}

// Resumen de un período: suma de dailySeries (misma cuenta que la caja diaria)
async function periodSummary(shopId, from, to) {
  const days = await dailySeries(shopId, from, to);
  const sum = (k) => days.reduce((a, d) => a + d[k], 0);
  const cuts = sum('cuts');
  return {
    revenue: sum('facturado'),        // facturado: turnos cobrados (sin fiado) + productos
    ingresos: sum('ingresos'),
    expenses: sum('op_expenses'),     // gastos del local sin liquidaciones
    commissions: sum('commissions'),
    gastos: sum('gastos'),            // gastos del local + comisiones
    net: sum('ingresos') - sum('gastos'),
    cuts,
    avg_ticket: cuts > 0 ? sum('price_all') / cuts : 0,
    tips: sum('tips'),
    days_active: days.filter(d => d.active).length,
  };
}

// Reporte mensual (exportable) de un local: mismos números que el P&L y el panel enterprise.
async function monthReport(shopId, from, to) {
  const [days, metricsQ, expensesQ] = await Promise.all([
    dailySeries(shopId, from, to),
    pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN payment_method='cash'     THEN price ELSE 0 END),0) AS cash,
         COALESCE(SUM(CASE WHEN payment_method='debit'    THEN price ELSE 0 END),0) AS debit,
         COALESCE(SUM(CASE WHEN payment_method='credit'   THEN price ELSE 0 END),0) AS credit,
         COALESCE(SUM(CASE WHEN payment_method='transfer' THEN price ELSE 0 END),0) AS transfer,
         COALESCE(SUM(CASE WHEN payment_method='debt'     THEN price ELSE 0 END),0) AS debt
       FROM appointments
       WHERE shop_id=$1 AND date >= $2 AND date <= $3 AND status='completed'`,
      [shopId, from, to]),
    // Solo egresos (la tabla expenses también guarda ingresos: ventas, cobros de fiado, señas)
    pool.query(
      `SELECT * FROM expenses WHERE shop_id=$1 AND date >= $2 AND date <= $3
         AND (is_income IS NULL OR is_income=FALSE) ORDER BY date`,
      [shopId, from, to]),
  ]);
  const sum = (k) => days.reduce((a, d) => a + d[k], 0);
  const m = metricsQ.rows[0];
  const ingresos = sum('ingresos'), gastos = sum('gastos');
  return {
    ingresos,
    gastos,                                   // gastos del local + comisiones (igual que el P&L)
    revenue: ingresos,                        // compatibilidad: lo que el reporte muestra arriba
    facturado: sum('facturado'),
    commissions_total: sum('commissions'),
    expenses_total: sum('op_expenses'),       // gastos del local (sin liquidaciones)
    egresos_total: expensesQ.rows.reduce((s, e) => s + parseFloat(e.amount), 0), // total de la tabla de egresos
    net_total: ingresos - gastos,
    tips_total: sum('tips'),
    completed: sum('cuts'),
    by_payment: {
      cash: parseFloat(m.cash), debit: parseFloat(m.debit), credit: parseFloat(m.credit),
      transfer: parseFloat(m.transfer), debt: parseFloat(m.debt),
    },
    expenses: expensesQ.rows,
    // Día por día, en vivo (antes: solo los días con caja cerrada)
    cash_registers: days.filter(d => d.active).map(d => ({
      date: d.date, cuts_count: d.cuts, revenue_total: d.ingresos, expenses_total: d.gastos, net_total: d.net,
    })),
  };
}

async function saveDayClose(shopId, date, d) {
  await ensureBreakdownColumn();
  await pool.query(
    `INSERT INTO cash_registers
       (shop_id, date, cash_total, debit_total, credit_total, transfer_total,
        debt_total, tips_total, expenses_total, revenue_total, net_total, cuts_count, method_breakdown)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     ON CONFLICT (shop_id, date) DO UPDATE SET
       cash_total=$3, debit_total=$4, credit_total=$5, transfer_total=$6,
       debt_total=$7, tips_total=$8, expenses_total=$9, revenue_total=$10,
       net_total=$11, cuts_count=$12, method_breakdown=$13::jsonb, closed_at=NOW()`,
    [shopId, date, d.cash_total, d.debit_total, d.credit_total, d.transfer_total,
     d.debt_total, d.tips_total, d.expenses_total, d.revenue_total, d.net_total, d.cuts_count,
     JSON.stringify(d.method_breakdown || [])]
  );
}

// Borra el cierre de un día que quedó sin movimientos (p.ej. se anuló el único turno)
async function deleteEmptyDayClose(shopId, date) {
  await pool.query('DELETE FROM cash_registers WHERE shop_id=$1 AND date=$2', [shopId, date]);
}

// El sistema reconoce el fiado por la clave 'debt'. Si el shop creó un método propio marcado
// como fiado (is_debt) con otra clave, se normaliza a 'debt' al guardar para que caja, deudas
// y reportes lo traten igual.
async function normalizeDebtMethod(shopIds, key) {
  if (!key || key === 'debt') return key;
  const ids = (Array.isArray(shopIds) ? shopIds : [shopIds]).filter(Boolean).map(Number);
  if (!ids.length) return key;
  try {
    const r = await pool.query(
      `SELECT 1 FROM payment_methods WHERE shop_id = ANY($1::int[]) AND key=$2 AND is_debt=TRUE LIMIT 1`,
      [ids, key]
    );
    return r.rows.length ? 'debt' : key;
  } catch (_) { return key; }
}

// Todos los movimientos de una cuenta (método de pago) en un día: ingresos (turnos netos de seña,
// señas, ventas de productos, cobros de fiado, propinas) y egresos (gastos, compras, liquidaciones).
// grand_total coincide con el saldo de esa cuenta en el resumen de caja (method_breakdown).
async function methodMovementsForDay(shopId, date, method, tz) {
  const hhmm = (v) => String(v || '').slice(0, 5);
  {
    // ── Turnos completados con esa cuenta (netos de la seña ya cobrada; en mixtos, el monto del split) ──
    let appts;
    const apptSql = (withSplits) => `
      WITH
        base AS (
          SELECT a.id, a.client_name, a.service_name, a.price, a.cost, a.commission_pct, a.tip, a.time_start,
                 a.barber_id, a.payment_method,
                 CASE WHEN a.sena_status='confirmed' THEN COALESCE(a.sena_amount,0) ELSE 0 END AS sena
            FROM appointments a
           WHERE a.shop_id=$1 AND a.date=$2 AND a.status='completed'
        ),
        ${withSplits ? `split_tot AS (
          SELECT ps.appointment_id, SUM(ps.amount) AS amount
            FROM payment_splits ps JOIN base b ON b.id = ps.appointment_id
           WHERE ps.method=$3 GROUP BY ps.appointment_id
        ),` : ''}
        merged AS (
          SELECT b.*, GREATEST(b.price - b.sena, 0) AS amount, FALSE AS is_split
            FROM base b
           WHERE b.payment_method=$3
             ${withSplits ? 'AND NOT EXISTS (SELECT 1 FROM payment_splits ps WHERE ps.appointment_id=b.id)' : ''}
          ${withSplits ? `UNION ALL
          SELECT b.*, st.amount, TRUE FROM base b JOIN split_tot st ON st.appointment_id=b.id` : ''}
        )
      SELECT m.id, m.client_name, m.service_name, m.amount::numeric AS price, m.sena::numeric AS sena_applied,
             m.cost, m.commission_pct, m.tip, m.time_start, m.is_split,
             ROUND(m.amount::numeric * COALESCE(m.commission_pct,0) / 100.0, 2) AS commission_amount,
             ROUND(m.amount::numeric - COALESCE(m.cost,0) - (m.amount::numeric * COALESCE(m.commission_pct,0) / 100.0), 2) AS profit,
             s.name AS barber_name
        FROM merged m LEFT JOIN shops s ON s.id = m.barber_id
       WHERE m.amount > 0
       ORDER BY m.time_start ASC`;
    try { appts = await pool.query(apptSql(true), [shopId, date, method]); }
    catch (spErr) {
      if (/payment_splits/i.test(spErr.message)) appts = await pool.query(apptSql(false), [shopId, date, method]);
      else throw spErr;
    }

    const localTime = `to_char(created_at AT TIME ZONE $4::text, 'HH24:MI')`;
    // ── Señas cobradas con esa cuenta ──
    const senas = await pool.query(
      `SELECT id, description, amount, ${localTime} AS time
         FROM expenses
        WHERE shop_id=$1 AND date=$2 AND is_income=TRUE AND source_type='sena' AND payment_method=$3
        ORDER BY created_at ASC`, [shopId, date, method, tz]);
    // ── Cobros de fiado ──
    const debts = await pool.query(
      `SELECT id, description, amount, ${localTime} AS time
         FROM expenses
        WHERE shop_id=$1 AND date=$2 AND is_income=TRUE AND source_type='debt_payment' AND payment_method=$3
        ORDER BY created_at ASC`, [shopId, date, method, tz]);
    // ── Ventas de productos ──
    const prodSales = await pool.query(
      `SELECT id, description, amount, ${localTime} AS time
         FROM expenses
        WHERE shop_id=$1 AND date=$2 AND source_type='product_sale' AND payment_method=$3 AND is_income=TRUE
        ORDER BY created_at ASC`, [shopId, date, method, tz]);
    // ── Egresos con esa cuenta: gastos, compras de insumos, liquidaciones, etc. ──
    const outflows = await pool.query(
      `SELECT id, category, description, amount, source_type, ${localTime} AS time
         FROM expenses
        WHERE shop_id=$1 AND date=$2 AND (is_income IS NULL OR is_income=FALSE) AND payment_method=$3
        ORDER BY created_at ASC`, [shopId, date, method, tz]);

    // ── Propinas que entran por esa cuenta (mismas reglas que el resumen de caja) ──
    const tipSql = (withTipMethod, withSplits) => {
      const noTm = withTipMethod ? 'AND a.tip_method IS NULL' : '';
      const parts = [];
      if (withTipMethod) parts.push(`SELECT a.id, a.client_name, a.time_start, a.tip AS amt FROM appointments a
          WHERE a.shop_id=$1 AND a.date=$2 AND a.status='completed' AND a.tip > 0 AND a.tip_method=$3`);
      parts.push(`SELECT a.id, a.client_name, a.time_start, a.tip AS amt FROM appointments a
          WHERE a.shop_id=$1 AND a.date=$2 AND a.status='completed' AND a.tip > 0 ${noTm}
            AND a.payment_method=$3 AND a.payment_method NOT IN ('debt','mixed')
            ${withSplits ? 'AND NOT EXISTS (SELECT 1 FROM payment_splits ps WHERE ps.appointment_id=a.id)' : ''}`);
      if (withSplits) parts.push(`SELECT a.id, a.client_name, a.time_start, a.tip * ps.amount / NULLIF(t.total,0) AS amt
          FROM appointments a
          JOIN payment_splits ps ON ps.appointment_id=a.id AND ps.method=$3 AND ps.method <> 'debt'
          JOIN (SELECT appointment_id, SUM(amount) AS total FROM payment_splits GROUP BY appointment_id) t ON t.appointment_id=a.id
         WHERE a.shop_id=$1 AND a.date=$2 AND a.status='completed' AND a.tip > 0 ${noTm}`);
      return `SELECT * FROM (${parts.join(' UNION ALL ')}) x ORDER BY time_start ASC`;
    };
    let tips = [], tmOk = true, spOk = true;
    for (let i = 0; i < 4; i++) {
      try { tips = (await pool.query(tipSql(tmOk, spOk), [shopId, date, method])).rows; break; }
      catch (err) {
        if (tmOk && /tip_method/i.test(err.message)) tmOk = false;
        else if (spOk && /payment_splits/i.test(err.message)) spOk = false;
        else throw err;
      }
    }

    // ── Lista unificada, en orden del día ──
    const num = (v) => parseFloat(v || 0);
    const movements = [];
    appts.rows.forEach(a => movements.push({
      kind: 'appointment', id: a.id, time: hhmm(a.time_start), sign: 1, amount: num(a.price),
      title: a.client_name || 'Sin nombre', subtitle: a.service_name || '', barber_name: a.barber_name || null,
      profit: num(a.profit), commission_amount: num(a.commission_amount), sena_applied: num(a.sena_applied), is_split: !!a.is_split,
    }));
    senas.rows.forEach(r => movements.push({ kind: 'sena', time: r.time, sign: 1, amount: num(r.amount), title: 'Seña cobrada', subtitle: r.description || '' }));
    prodSales.rows.forEach(r => movements.push({ kind: 'product_sale', time: r.time, sign: 1, amount: num(r.amount), title: 'Venta producto', subtitle: r.description || '' }));
    debts.rows.forEach(r => movements.push({ kind: 'debt_payment', time: r.time, sign: 1, amount: num(r.amount), title: 'Cobro fiado', subtitle: r.description || '' }));
    tips.forEach(t => movements.push({ kind: 'tip', time: hhmm(t.time_start), sign: 1, amount: num(t.amt), title: 'Propina', subtitle: t.client_name || '' }));
    outflows.rows.forEach(r => movements.push({
      kind: 'expense', time: r.time, sign: -1, amount: num(r.amount), source_type: r.source_type || 'manual',
      category: r.category || null, title: r.source_type === 'barber_settlement' ? 'Liquidación barbero' : 'Gasto',
      subtitle: r.description || '', expense_id: r.id,
    }));
    movements.sort((x, y) => String(x.time).localeCompare(String(y.time)));

    const sum = (list) => list.reduce((s, m) => s + m.amount, 0);
    const incomes = movements.filter(m => m.sign > 0), outs = movements.filter(m => m.sign < 0);
    const apptTotal = sum(movements.filter(m => m.kind === 'appointment'));
    return {
      method, date,
      movements,
      income_total:  sum(incomes),
      expense_total: sum(outs),
      grand_total:   sum(incomes) - sum(outs),
      // compatibilidad con la versión anterior
      appointments:        appts.rows,
      debt_payments:       debts.rows,
      product_sales:       prodSales.rows,
      appointments_total:  apptTotal,
      debt_total:          sum(movements.filter(m => m.kind === 'debt_payment')),
      product_sales_total: sum(movements.filter(m => m.kind === 'product_sale')),
    };
  }
}

module.exports = { paidPriceSql, monthReport, dailySeries, periodSummary, normalizeDebtMethod, methodTotalsForDay, methodFlowForDay, dayCommissions, computeNet, computeDayClose, saveDayClose, deleteEmptyDayClose, methodMovementsForDay };
