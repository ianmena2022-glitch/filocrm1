/**
 * FILO CRM — Scheduler interno
 * Corre tareas periódicas dentro del proceso Node (sin dependencias externas).
 * Se arranca una vez desde index.js al iniciar el servidor.
 */
const pool = require('../db/pool');
const { computeDayClose, saveDayClose, deleteEmptyDayClose } = require('./cashMath');

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
    // Cuentas canceladas no se procesan (no tienen actividad y solo cargan la base cada 30 min)
    const shops = await pool.query(
      `SELECT id, timezone FROM shops
       WHERE (is_barber IS NULL OR is_barber = FALSE)
         AND subscription_status IS DISTINCT FROM 'cancelled'`
    );

    for (const shop of shops.rows) {
      try {
        // Fecha de AYER en la timezone del shop (si no está seteada, cae a AR)
        const date = yesterdayInTz(shop.timezone);

        // Misma lógica que el cierre manual (splits, seña, liquidaciones sin doble descuento)
        const d = await computeDayClose(shop.id, date);
        // Días sin movimientos (local cerrado, cuenta sin uso) no generan un cierre en $0:
        // inflaban "días trabajados" y bajaban los promedios del resultado mensual
        if (!d.has_activity) { await deleteEmptyDayClose(shop.id, date); continue; }
        await saveDayClose(shop.id, date, d);
        const net = d.net_total;

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
// Pasa a 'expired' las cuentas con trial vencido (sin gracia, coincide con el paywall)
// para que el estado en admin refleje el bloqueo real.
async function runTrialExpiration() {
  try {
    const GRACE = 0;
    const r = await pool.query(`
      UPDATE shops
         SET subscription_status = 'expired',
             expired_at = COALESCE(expired_at, NOW()),
             trial_ends_at = COALESCE(trial_ends_at, created_at + INTERVAL '7 days')
       WHERE subscription_status = 'trial'
         AND (is_test IS NULL OR is_test = FALSE)
         AND (is_barber IS NULL OR is_barber = FALSE)   -- los barberos no tienen prueba propia: dependen del local
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
         AND (is_barber IS NULL OR is_barber = FALSE)
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
    //      trial_ends_at (+ 3 días de gracia si era paga) + 30 días ya pasaron
    const GRACE = 3;
    const { rows } = await pool.query(
      `SELECT id, email FROM shops
       WHERE (is_test IS NULL OR is_test = FALSE)
         AND (is_barber IS NULL OR is_barber = FALSE)
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
            AND trial_ends_at < NOW() - ((CASE WHEN subscription_status = 'trial' THEN $1::int ELSE $2::int END) || ' days')::interval)
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
let _pollTick = 0;
async function runTransferPolling() {
  try {
    const pool = require('../db/pool');
    _pollTick++;
    // Con órdenes vigentes se revisa cada 10 s; con órdenes vencidas hace menos de 7 días
    // (transferencias que pueden llegar tarde) alcanza con cada 2 minutos.
    const pendingQ = await pool.query(
      `SELECT BOOL_OR(expires_at > NOW()) AS vigente FROM pending_transfers
        WHERE matched=FALSE AND expires_at > NOW() - INTERVAL '7 days'`
    );
    const vigente = pendingQ.rows[0]?.vigente;
    if (vigente == null) return;               // no hay nada que esperar
    if (!vigente && _pollTick % 12 !== 0) return;

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
    const { tryMatchIncomingTransfer, activateShopPlan, recordUnmatchedPayment } = internals;
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
        } else if (!match.alreadyHandled && recordUnmatchedPayment) {
          // Entró plata mientras alguien esperaba su transferencia y no coincide con ninguna orden
          await recordUnmatchedPayment({
            paymentId, amount: p.transaction_amount, reason: 'sin_orden',
            payer: p.payer?.email || p.payer?.identification?.number || null,
            detail: p.description || null,
          });
        }
      } catch(e) { console.error('[Poll Transfer] item error:', e.message); }
    }
  } catch(e) {
    console.error('[Poll Transfer] error:', e.message);
  }
}

// ── Recordatorios de turno por WhatsApp (X minutos antes, 2 h por defecto) ──────
// Cada local elige cuánto antes (shops.reminder_minutes: de 20 minutos a 1 día).
// Reactivado: antes vivía en un scheduler que dejó de cargarse y nadie los recibía.
// Reglas: zona horaria del local, solo entre 08:00 y 22:00 locales, una sola vez por turno
// (reminder_sent_at), sin avisar a turnos recién reservados (ya recibieron confirmación),
// y el envío pasa por el ritmo/topes anti-baneo de services/whatsapp.js.
// Apagar todo con WPP_REMINDERS=off; un local puede desactivarlos desde sus plantillas.
let _remindersRunning = false;

function fixMananaToHoy(msg) {
  return String(msg).replace(/(^|[^\p{L}])(la |esta |de |pasado |por la )?(mañana)(?![\p{L}])/giu,
    (all, pre, qual, word) => qual ? all : pre + (word[0] === 'M' ? 'Hoy' : 'hoy'));
}

function isQuietHour(tz, now = new Date()) {
  const h = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'America/Argentina/Buenos_Aires', hour: '2-digit', hourCycle: 'h23' }).format(now));
  return h < 8 || h >= 22;
}

async function runAppointmentReminders({ ignoreQuietHours = false } = {}) {
  if (process.env.WPP_REMINDERS === 'off') return { sent: 0, skipped: 0 };
  if (_remindersRunning) return { sent: 0, skipped: 0 };
  _remindersRunning = true;
  let sent = 0, skipped = 0;
  try {
    const TZ = `COALESCE(s.timezone, 'America/Argentina/Buenos_Aires')`;
    // Minutos antes del turno elegidos por el local (to_jsonb: funciona aunque falte la columna)
    const MIN = `LEAST(1440, GREATEST(20, COALESCE(NULLIF(to_jsonb(s)->>'reminder_minutes', '')::int, 120)))`;
    const baseSelect = `
      SELECT a.id, a.shop_id, a.client_name, a.service_name, a.date::text AS date, a.time_start,
             c.phone AS client_phone, c.name AS client_name_db,
             s.name AS shop_name, s.msg_templates,
             ${TZ} AS tz,
             a.date > (NOW() AT TIME ZONE ${TZ})::date AS is_tomorrow
        FROM appointments a
        JOIN shops s   ON s.id = a.shop_id
        JOIN clients c ON c.id = a.client_id
       WHERE a.status IN ('pending','confirmed')
         AND a.reminder_sent_at IS NULL
         AND a.created_at < NOW() - INTERVAL '3 hours'
         AND c.phone IS NOT NULL AND c.phone <> ''
         AND (s.wpp_connected = TRUE
              OR EXISTS (SELECT 1 FROM shops o WHERE o.id = s.parent_enterprise_id AND o.wpp_connected = TRUE))`;
    // X minutos antes del turno: sale en la primera vuelta (cada 10 min) en que faltan X minutos
    // o un poco más; si alguna vuelta se pierde hay margen (45 min, o la mitad de X si X es corto)
    // para no saltearlo, sin avisar nunca un turno que ya empezó.
    const sameDay = (await pool.query(
      `${baseSelect}
         AND ((a.date + a.time_start)::timestamp AT TIME ZONE ${TZ})
             BETWEEN NOW() + make_interval(mins => GREATEST(${MIN} - 45, ${MIN} / 2))
                 AND NOW() + make_interval(mins => ${MIN} + 10)
       ORDER BY a.date, a.time_start LIMIT 200`
    )).rows;
    // Turnos temprano (antes de las 08:30 + X, con X menor a 12 h): X antes cae en el horario de
    // silencio, así que el aviso sale la noche anterior, entre las 20 y las 22 del local.
    const nightBefore = (await pool.query(
      `${baseSelect}
         AND ${MIN} < 720
         AND a.time_start < ('08:30'::time + make_interval(mins => ${MIN}))
         AND a.date = ((NOW() AT TIME ZONE ${TZ})::date + 1)
         AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE ${TZ})) BETWEEN 20 AND 21
       ORDER BY a.date, a.time_start LIMIT 200`
    )).rows.map(r => ({ ...r, _nightBefore: true }));
    const rows = [...nightBefore, ...sameDay.filter(r => !nightBefore.some(n => n.id === r.id))];
    if (!rows.length) return { sent, skipped };

    const wpp = require('./whatsapp');
    const markDone = (id) => pool.query('UPDATE appointments SET reminder_sent_at = NOW() WHERE id = $1', [id]);

    for (const a of rows) {
      if (!ignoreQuietHours && isQuietHour(a.tz)) { skipped++; continue; }
      let tpls = {};
      try { tpls = a.msg_templates ? JSON.parse(a.msg_templates) : {}; } catch (_) {}
      if (tpls.recordatorio_auto === false) { skipped++; continue; }   // el local los desactivó
      if (!(await wpp.autoEnabled(a.shop_id, 'reminders'))) { await markDone(a.id).catch(() => {}); skipped++; continue; } // apagado en Configuración → WhatsApp

      const nombre = a.client_name_db || a.client_name || 'Cliente';
      const hora   = String(a.time_start).slice(0, 5);
      const fecha  = new Date(a.date + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });

      let msg = null;
      if (tpls.recordatorio && String(tpls.recordatorio).trim()) {
        msg = wpp.renderTemplate(tpls.recordatorio, { nombre, hora, barberia: a.shop_name || 'la barbería', fecha, servicio: a.service_name || '' });
      } else {
        try {
          const { generateMessage } = require('./ai');
          msg = await generateMessage(a.shop_id, 'recordatorio', { clientName: nombre, hora, fecha, shopName: a.shop_name || 'la barbería', serviceName: a.service_name || null });
        } catch (_) {}
      }
      // ¿El turno es mañana? (aviso de la noche anterior, o 12/24 h antes que cae el día previo)
      const tomorrow = !!a._nightBefore || a.is_tomorrow === true;
      if (!msg) msg = require('./msgVariants').reminderText({ nombre, hora, shop: a.shop_name || 'la barbería', manana: tomorrow });
      // Si el turno es hoy, plantillas viejas que dicen "mañana" (el día) se corrigen a "hoy", sin
      // tocar "a la mañana" / "esta mañana" / "pasado mañana" (la hora del día).
      if (!tomorrow) msg = fixMananaToHoy(msg);
      else msg = String(msg).replace(/(^|[^\p{L}])(hoy)(?![\p{L}])/giu, (all, pre, w) => pre + (w[0] === 'H' ? 'Mañana' : 'mañana'));

      try {
        await wpp.sendText(a.shop_id, a.client_phone, msg, { category: 'reminders' });
        await markDone(a.id);
        sent++;
      } catch (e) {
        if (e.code === 'OPTED_OUT' || e.code === 'NOT_ON_WHATSAPP' || e.code === 'AUTO_DISABLED' || e.code === 'CAREFUL_MODE') {
          await markDone(a.id).catch(() => {});   // no reintentar nunca
          skipped++;
        } else if (e.code === 'DAILY_CAP' || e.code === 'FIRST_CONTACT_CAP' || e.code === 'CIRCUIT_OPEN') {
          console.warn(`[REMINDERS] pausa por tope (${e.code}) en shop ${a.shop_id}`);
          skipped++;
        } else {
          console.warn(`[REMINDERS] turno ${a.id} no enviado: ${e.message}`);
          skipped++;
        }
      }
    }
    if (sent || skipped) console.log(`[REMINDERS] enviados=${sent} omitidos=${skipped}`);
  } catch (e) {
    console.error('[REMINDERS] error:', e.message);
  } finally {
    _remindersRunning = false;
  }
  return { sent, skipped };
}

function startScheduler() {
  console.log('⏰ Scheduler FILO iniciado (intervalo: 30 min + poll transferencias 10s + recordatorios de turno 10 min)');

  _addTimeout(runAppointmentReminders, 120_000);
  _addInterval(runAppointmentReminders, 10 * 60 * 1000);

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

module.exports = { startScheduler, stopScheduler, nowInTz, yesterdayInTz, nowArgentina, runAppointmentReminders, isQuietHour, fixMananaToHoy };
