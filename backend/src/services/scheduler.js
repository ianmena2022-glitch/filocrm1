/**
 * FILO CRM — Scheduler interno
 * Corre tareas periódicas dentro del proceso Node (sin dependencias externas).
 * Se arranca una vez desde index.js al iniciar el servidor.
 */
const pool = require('../db/pool');

// Devuelve {date, hours, minutes, mins, day} para la timezone dada (respeta DST).
// Si tz es inválido o no se pasa, cae a America/Argentina/Buenos_Aires.
function nowInTz(tz) {
  const TZ = tz || 'America/Argentina/Buenos_Aires';
  try {
    // es-ES Intl para armar "YYYY-MM-DD HH:MM" en la timezone del shop
    const str = new Date().toLocaleString('sv-SE', { timeZone: TZ });
    const [datePart, timePart] = str.split(' ');
    const [h, m] = timePart.split(':').map(Number);
    const d = new Date(datePart + 'T00:00:00Z');
    return {
      date:    datePart,
      hours:   h,
      minutes: m,
      mins:    h * 60 + m,
      day:     ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'][d.getUTCDay()]
    };
  } catch (_) {
    // Fallback UTC-3
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
    return {
      date:    d.toISOString().split('T')[0],
      hours:   d.getUTCHours(),
      minutes: d.getUTCMinutes(),
      mins:    d.getUTCHours() * 60 + d.getUTCMinutes(),
      day:     ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'][d.getUTCDay()]
    };
  }
}

// Compat: la mayoría de los callers usan Argentina sin más
function nowArgentina() { return nowInTz('America/Argentina/Buenos_Aires'); }

function yesterdayInTz(tz) {
  const TZ = tz || 'America/Argentina/Buenos_Aires';
  try {
    const d = new Date(new Date().getTime() - 24 * 60 * 60 * 1000);
    return d.toLocaleString('sv-SE', { timeZone: TZ }).split(' ')[0];
  } catch (_) {
    return new Date(Date.now() - 3 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000)
             .toISOString().split('T')[0];
  }
}

// ── Cierre automático de caja ─────────────────────────────────────────────────
// Corre cada 30 min y cierra la caja del DÍA ANTERIOR (siempre a partir de las 00:00
// de cada día). Idempotente vía ON CONFLICT: si entran ventas tardías del día anterior
// después de medianoche, se van reflejando al próximo tick.
async function runCajaAutoClose() {
  const now  = nowArgentina(); // sólo para el log general
  let closed = 0;

  try {
    const shops = await pool.query(
      `SELECT id, timezone FROM shops
       WHERE (is_barber IS NULL OR is_barber = FALSE)`
    );

    for (const shop of shops.rows) {
      try {
        // Fecha de AYER en la timezone del shop (si no está seteada, cae a AR)
        const date = yesterdayInTz(shop.timezone);

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

    if (closed > 0) console.log(`[CAJA AUTO] ${closed} caja(s) cerrada(s) · ${now.hours}:${String(now.minutes).padStart(2,'0')} AR`);
  } catch(e) {
    console.error('[CAJA AUTO] Error general:', e.message);
  }
}

// ── Auto-expiración de trials vencidos ────────────────────────────────────────
// Pasa a 'expired' las cuentas con trial vencido + 3 días de gracia (coincide
// con el paywall) para que el estado en admin refleje el bloqueo real.
async function runTrialExpiration() {
  try {
    const GRACE = 3;
    const r = await pool.query(`
      UPDATE shops
         SET subscription_status = 'expired',
             expired_at = COALESCE(expired_at, NOW()),
             trial_ends_at = COALESCE(trial_ends_at, created_at + INTERVAL '7 days')
       WHERE subscription_status = 'trial'
         AND (is_test IS NULL OR is_test = FALSE)
         AND plan IS DISTINCT FROM 'test'
         AND (
           (trial_ends_at IS NOT NULL AND trial_ends_at < NOW() - ($1::int || ' days')::interval)
           OR
           (trial_ends_at IS NULL AND created_at < NOW() - ($2::int || ' days')::interval)
         )
       RETURNING id, name, email
    `, [GRACE, 7 + GRACE]);
    if (r.rowCount > 0) {
      console.log(`[TRIAL] ${r.rowCount} cuenta(s) pasaron a 'expired' por trial vencido`);
      try {
        const push = require('./push');
        for (const row of r.rows) {
          push.sendToAdmins({
            title: '⏰ Trial vencido',
            body:  `${row.name || row.email} se quedó sin trial`,
            icon:  '/favicon.ico',
            data:  { url: '/admin', type: 'trial.expired', shopId: row.id }
          }).catch(()=>{});
        }
      } catch(_) {}
    }
  } catch (e) {
    console.error('[TRIAL] Error auto-expiración:', e.message);
  }
}

// ── Auto-expiración de cuentas activas con cuota vencida ──────────────────────
// Pasa a 'expired' las cuentas 'active' cuyo trial_ends_at + 3 días de gracia
// ya pasaron sin renovación. Esto cubre clientes que pagaron alguna vez pero
// no renovaron en el ciclo siguiente.
async function runActiveExpiration() {
  try {
    const GRACE = 3;
    const { rowCount } = await pool.query(`
      UPDATE shops
         SET subscription_status = 'expired',
             expired_at = COALESCE(expired_at, NOW())
       WHERE subscription_status = 'active'
         AND (is_test IS NULL OR is_test = FALSE)
         AND plan IS DISTINCT FROM 'test'
         AND trial_ends_at IS NOT NULL
         AND trial_ends_at < NOW() - ($1::int || ' days')::interval
    `, [GRACE]);
    if (rowCount > 0) console.log(`[ACTIVE-EXP] ${rowCount} cuenta(s) 'active' pasaron a 'expired' por falta de renovación`);
  } catch (e) {
    console.error('[ACTIVE-EXP] Error auto-expiración:', e.message);
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
            AND expired_at < NOW() - ($1::int || ' days')::interval)
           OR
           -- caso 2: trial/active pero hace mucho que venció y nunca entró
           (subscription_status IN ('trial','active')
            AND trial_ends_at IS NOT NULL
            AND trial_ends_at < NOW() - ($2::int || ' days')::interval)
         )`,
      [CANCEL_AFTER_DAYS, GRACE + CANCEL_AFTER_DAYS]
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
const _schedulerHandles = [];
function _addInterval(fn, ms) {
  const h = setInterval(fn, ms);
  if (typeof h.unref === 'function') h.unref();
  _schedulerHandles.push(h);
  return h;
}
function _addTimeout(fn, ms) {
  const h = setTimeout(fn, ms);
  if (typeof h.unref === 'function') h.unref();
  _schedulerHandles.push(h);
  return h;
}

// ── POLLING DE TRANSFERENCIAS ENTRANTES ──────────────────────────────────
// MP no notifica depósitos CVU por webhook de forma confiable. Cada 10s
// consultamos los pagos recientes y los matcheamos contra pending_transfers.
async function runTransferPolling() {
  try {
    const pool = require('../db/pool');
    const pendingQ = await pool.query(
      `SELECT 1 FROM pending_transfers WHERE matched=FALSE AND expires_at > NOW() LIMIT 1`
    );
    if (!pendingQ.rows.length) return;

    const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
    if (!MP_TOKEN) return;
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const url = `https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&status=approved&begin_date=${encodeURIComponent(since)}&end_date=NOW&range=date_created&limit=50`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${MP_TOKEN}`, 'Accept': 'application/json' } });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      if (!/404/.test(String(res.status))) console.warn(`[Poll Transfer] MP search ${res.status}: ${txt.slice(0,200)}`);
      return;
    }
    const data = await res.json();
    const results = data?.results || [];
    if (!results.length) return;

    const internals = require('../routes/payments')._internals || {};
    const { tryMatchIncomingTransfer, activateShopPlan } = internals;
    if (!tryMatchIncomingTransfer || !activateShopPlan) {
      console.warn('[Poll Transfer] internals no disponibles en payments.js');
      return;
    }

    for (const p of results) {
      try {
        const paymentId = String(p.id);
        const already = await pool.query('SELECT 1 FROM mp_processed_payments WHERE payment_id=$1', [paymentId]);
        if (already.rows.length) continue;
        if (p.external_reference?.startsWith('filo:')) continue;

        const match = await tryMatchIncomingTransfer(paymentId, p.transaction_amount);
        if (match.matched) {
          await activateShopPlan({
            shopId: match.shopId,
            plan:   match.plan,
            paymentId,
            paidAmount: parseFloat(p.transaction_amount) || 0,
            promotionId: match.promotionId || null
          });
        }
      } catch(e) { console.error('[Poll Transfer] item error:', e.message); }
    }
  } catch(e) {
    console.error('[Poll Transfer] error:', e.message);
  }
}

function startScheduler() {
  console.log('⏰ Scheduler FILO iniciado (intervalo: 30 min + poll transferencias 10s)');

  _addTimeout(runCajaAutoClose, 10_000);
  _addInterval(runCajaAutoClose, 30 * 60 * 1000);

  _addTimeout(runTrialExpiration, 60_000);
  _addInterval(runTrialExpiration, 24 * 60 * 60 * 1000);

  _addTimeout(runActiveExpiration, 75_000);
  _addInterval(runActiveExpiration, 24 * 60 * 60 * 1000);

  _addTimeout(runExpiredCleanup, 90_000);
  _addInterval(runExpiredCleanup, 24 * 60 * 60 * 1000);

  _addInterval(runTransferPolling, 10 * 1000);
}

function stopScheduler() {
  for (const h of _schedulerHandles) {
    clearInterval(h);
    clearTimeout(h);
  }
  _schedulerHandles.length = 0;
}

module.exports = { startScheduler, stopScheduler, nowInTz, yesterdayInTz, nowArgentina };
