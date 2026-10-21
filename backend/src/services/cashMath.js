// Cálculos de caja compartidos por dashboard (vivo), cierres manuales/automáticos,
// scheduler y enterprise, para que TODOS usen la misma definición.
const pool = require('../db/pool');
const { getShopTz } = require('../db/shopTz');

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
  const m = await methodTotalsForDay(shopId, date);
  const ap = await pool.query(
    `SELECT
       COALESCE(SUM(tip),0) AS tips_total,
       COALESCE(SUM(CASE WHEN payment_method IS DISTINCT FROM 'debt' THEN price ELSE 0 END),0) AS revenue_total,
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
  return {
    cash_total: m.cash_total, debit_total: m.debit_total, credit_total: m.credit_total,
    transfer_total: m.transfer_total, debt_total: m.debt_total,
    tips_total: parseFloat(ap.rows[0].tips_total), expenses_total: expenses,
    revenue_total: revenue, net_total: net, cuts_count: parseInt(ap.rows[0].cuts_count),
  };
}

async function saveDayClose(shopId, date, d) {
  await pool.query(
    `INSERT INTO cash_registers
       (shop_id, date, cash_total, debit_total, credit_total, transfer_total,
        debt_total, tips_total, expenses_total, revenue_total, net_total, cuts_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (shop_id, date) DO UPDATE SET
       cash_total=$3, debit_total=$4, credit_total=$5, transfer_total=$6,
       debt_total=$7, tips_total=$8, expenses_total=$9, revenue_total=$10,
       net_total=$11, cuts_count=$12, closed_at=NOW()`,
    [shopId, date, d.cash_total, d.debit_total, d.credit_total, d.transfer_total,
     d.debt_total, d.tips_total, d.expenses_total, d.revenue_total, d.net_total, d.cuts_count]
  );
}

module.exports = { methodTotalsForDay, dayCommissions, computeNet, computeDayClose, saveDayClose };
