/**
 * FILO CRM — Scheduler interno
 * Corre tareas periódicas dentro del proceso Node (sin dependencias externas).
 * Se arranca una vez desde index.js al iniciar el servidor.
 */
const pool = require('../db/pool');

// Argentina = UTC-3
function nowArgentina() {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return {
    date:    d.toISOString().split('T')[0],          // "YYYY-MM-DD"
    hours:   d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    mins:    d.getUTCHours() * 60 + d.getUTCMinutes(),
    day:     ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'][d.getUTCDay()]
  };
}

// ── Cierre automático de caja ─────────────────────────────────────────────────
async function runCajaAutoClose() {
  const now  = nowArgentina();
  const { date, mins, day } = now;
  let closed = 0;

  try {
    const shops = await pool.query(
      `SELECT id, schedule FROM shops
       WHERE (is_barber IS NULL OR is_barber = FALSE)
         AND schedule IS NOT NULL`
    );

    for (const shop of shops.rows) {
      try {
        const schedule = JSON.parse(shop.schedule);
        const daySchedule = schedule[day];
        if (!daySchedule?.active || !daySchedule?.end) continue;

        const [endH, endM] = daySchedule.end.split(':').map(Number);
        const closeMins = endH * 60 + endM;

        // Cerrar si ya pasó la hora de cierre (con al menos 30min de gracia)
        // y no se cerró aún hoy — ON CONFLICT actualiza, es idempotente
        if (mins < closeMins + 30) continue;

        // Calcular totales del día
        const appts = await pool.query(
          `SELECT
             COALESCE(SUM(CASE WHEN payment_method='cash'     THEN price ELSE 0 END),0) AS cash_total,
             COALESCE(SUM(CASE WHEN payment_method='debit'    THEN price ELSE 0 END),0) AS debit_total,
             COALESCE(SUM(CASE WHEN payment_method='credit'   THEN price ELSE 0 END),0) AS credit_total,
             COALESCE(SUM(CASE WHEN payment_method='transfer' THEN price ELSE 0 END),0) AS transfer_total,
             COALESCE(SUM(CASE WHEN payment_method='debt'     THEN price ELSE 0 END),0) AS debt_total,
             COALESCE(SUM(tip),0)   AS tips_total,
             COALESCE(SUM(CASE WHEN payment_method IS DISTINCT FROM 'debt' THEN price ELSE 0 END),0) AS revenue_total,
             COALESCE(SUM(price * commission_pct / 100.0),0) AS commissions_total,
             COUNT(*) FILTER (WHERE status='completed') AS cuts_count
           FROM appointments
           WHERE shop_id=$1 AND date=$2 AND status='completed'`,
          [shop.id, date]
        );
        const exps = await pool.query(
          `SELECT
             COALESCE(SUM(CASE WHEN (is_income IS NULL OR is_income=FALSE) THEN amount ELSE 0 END),0) AS expenses_total,
             COALESCE(SUM(CASE WHEN is_income=TRUE THEN amount ELSE 0 END),0) AS extra_income
           FROM expenses WHERE shop_id=$1 AND date=$2`,
          [shop.id, date]
        );

        const a = appts.rows[0];
        const revenue    = parseFloat(a.revenue_total);
        const expenses   = parseFloat(exps.rows[0].expenses_total);
        const extraInc   = parseFloat(exps.rows[0].extra_income || 0);
        const tips       = parseFloat(a.tips_total);
        const commissions = parseFloat(a.commissions_total);
        const net        = revenue + tips + extraInc - expenses - commissions;

        await pool.query(
          `INSERT INTO cash_registers
             (shop_id, date, cash_total, debit_total, credit_total, transfer_total,
              debt_total, tips_total, expenses_total, revenue_total, net_total, cuts_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (shop_id, date) DO UPDATE SET
             cash_total=$3, debit_total=$4, credit_total=$5, transfer_total=$6,
             debt_total=$7, tips_total=$8, expenses_total=$9, revenue_total=$10,
             net_total=$11, cuts_count=$12, closed_at=NOW()`,
          [shop.id, date,
           a.cash_total, a.debit_total, a.credit_total, a.transfer_total,
           a.debt_total, tips, expenses, revenue, net, a.cuts_count]
        );

        closed++;
        console.log(`[CAJA AUTO] ✅ Shop ${shop.id} · ${date} · net=$${net.toFixed(2)}`);
      } catch(e) {
        console.error(`[CAJA AUTO] ❌ Error shop ${shop.id}:`, e.message);
      }
    }

    if (closed > 0) console.log(`[CAJA AUTO] ${closed} caja(s) cerrada(s) · ${date} ${now.hours}:${String(now.minutes).padStart(2,'0')}`);
  } catch(e) {
    console.error('[CAJA AUTO] Error general:', e.message);
  }
}

// ── Auto-expiración de trials vencidos ────────────────────────────────────────
// Pasa a 'expired' las cuentas que llevan más de 10 días con trial vencido
// sin haber pagado (cubre casos donde el usuario nunca volvió a loguearse)
async function runTrialExpiration() {
  try {
    const { rowCount } = await pool.query(`
      UPDATE shops
         SET subscription_status = 'expired',
             expired_at = COALESCE(expired_at, NOW())
       WHERE subscription_status = 'trial'
         AND trial_ends_at IS NOT NULL
         AND trial_ends_at < NOW() - INTERVAL '10 days'
         AND (is_test IS NULL OR is_test = FALSE)
         AND plan IS DISTINCT FROM 'test'
    `);
    if (rowCount > 0) console.log(`[TRIAL] ${rowCount} cuenta(s) pasaron a 'expired' por trial vencido`);
  } catch (e) {
    console.error('[TRIAL] Error auto-expiración:', e.message);
  }
}

// ── Auto-cancelación de cuentas expiradas ─────────────────────────────────────
// Después de CANCEL_AFTER_DAYS días en status 'expired', se desconecta WhatsApp
// y se marca la cuenta como 'cancelled' para no consumir recursos del server.
const CANCEL_AFTER_DAYS = 30;

async function runExpiredCleanup() {
  try {
    // Buscar shops que deben cancelarse. Dos casos:
    //   1. Ya marcados como 'expired' con expired_at registrado hace >30 días
    //   2. Nunca volvieron a entrar (status sigue en trial/active) pero
    //      trial_ends_at + 3 días de gracia + 30 días ya pasaron
    const GRACE = 3;
    const { rows } = await pool.query(
      `SELECT id, email FROM shops
       WHERE (is_test IS NULL OR is_test = FALSE)
         AND (plan IS DISTINCT FROM 'test')
         AND (
           -- caso 1: ya marcado expired con fecha registrada
           (subscription_status = 'expired'
            AND expired_at IS NOT NULL
            AND expired_at < NOW() - INTERVAL '${CANCEL_AFTER_DAYS} days')
           OR
           -- caso 2: trial/active pero hace mucho que venció y nunca entró
           (subscription_status IN ('trial','active')
            AND trial_ends_at IS NOT NULL
            AND trial_ends_at < NOW() - INTERVAL '${GRACE + CANCEL_AFTER_DAYS} days')
         )`
    );

    if (!rows.length) return;

    // Import lazy para evitar circular dependency al arrancar
    const wpp = require('./whatsapp');

    for (const shop of rows) {
      try {
        // 1. Desconectar y limpiar sesión de WhatsApp (libera WebSocket + /tmp + DB)
        await wpp.clearSession(shop.id);

        // 2. Marcar como cancelado
        await pool.query(
          `UPDATE shops SET subscription_status='cancelled', wpp_connected=FALSE WHERE id=$1`,
          [shop.id]
        );

        console.log(`[CLEANUP] Shop ${shop.id} (${shop.email}) cancelado automáticamente tras ${CANCEL_AFTER_DAYS} días expirado`);
      } catch (e) {
        console.error(`[CLEANUP] Error cancelando shop ${shop.id}:`, e.message);
      }
    }

    console.log(`[CLEANUP] ${rows.length} cuenta(s) cancelada(s) automáticamente`);
  } catch (e) {
    console.error('[CLEANUP] Error general:', e.message);
  }
}

// ── Arrancar scheduler ────────────────────────────────────────────────────────
function startScheduler() {
  console.log('⏰ Scheduler FILO iniciado (intervalo: 30 min)');

  // Primera ejecución al arrancar (por si el servidor se reinició después del cierre)
  setTimeout(runCajaAutoClose, 10_000); // 10s después del arranque

  // Cada 30 minutos
  setInterval(runCajaAutoClose, 30 * 60 * 1000);

  // Auto-expiración de trials + limpieza: una vez al día
  setTimeout(runTrialExpiration, 60_000);
  setInterval(runTrialExpiration, 24 * 60 * 60 * 1000);

  setTimeout(runExpiredCleanup, 90_000); // 1.5 min después (corre tras la expiración)
  setInterval(runExpiredCleanup, 24 * 60 * 60 * 1000);
}

module.exports = { startScheduler };
