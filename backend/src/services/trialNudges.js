/**
 * Avisos a cuentas en prueba que no arrancan.
 *
 * - WhatsApp desde el número de FILO (el mismo de la bienvenida), con textos editables en
 *   Admin → Configuración. Como máximo un aviso por cuenta cada 20 h, entre las 10 y las 20.
 * - Alerta push al admin cuando una cuenta lleva 3 días sin turnos online o le quedan
 *   2 días de prueba, para llamarla.
 *
 * Cada aviso sale una sola vez por cuenta y canal (tabla trial_nudges).
 */
const pool = require('../db/pool');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Orden de prioridad: si corresponden varios, sale el más importante y los anteriores se saltean.
const KINDS = ['expired', 'ending', 'no_bookings', 'setup'];

// Qué aviso le corresponde a una cuenta ahora (o null). `row` viene de la consulta de candidatas.
function pickNudge(row, now = Date.now()) {
  const created = new Date(row.created_at).getTime();
  const age = now - created;
  if (row.subscription_status === 'expired') {
    if (row.first_payment_at) return null;            // ya fue cliente: no es una prueba sin uso
    const exp = row.expired_at ? new Date(row.expired_at).getTime() : null;
    return exp && now - exp >= 0 && now - exp <= 3 * DAY ? 'expired' : null;
  }
  if (row.subscription_status !== 'trial') return null;
  const ends = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : null;
  if (ends && ends > now && ends - now <= 2 * DAY) return 'ending';
  if (age >= 3 * DAY && !row.online_booking) return 'no_bookings';
  if (age >= DAY && (!row.own_services || !row.has_schedule)) return 'setup';
  return null;
}

// Alertas para el admin (se mandan una vez cada una)
function adminAlerts(row, now = Date.now()) {
  const k = pickNudge(row, now);
  return k === 'no_bookings' || k === 'ending' ? [k] : [];
}

function hourAR(now = new Date()) {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

function render(template, row, now = Date.now()) {
  const base = process.env.APP_URL || 'https://filocrm.com.ar';
  const ends = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : null;
  const left = ends ? Math.ceil((ends - now) / DAY) : null;
  const cuando = left == null ? 'pronto' : left <= 0 ? 'hoy' : left === 1 ? 'mañana' : `en ${left} días`;
  // {resumen}: cambia según si la cuenta ya usó FILO o no
  const n = parseInt(row.appts_count) || 0;
  const resumen = n > 0
    ? `Hasta ahora cargaste ${n} ${n === 1 ? 'turno' : 'turnos'}.`
    : 'Si todavía no llegaste a probarlo, lo configuramos juntos en 10 minutos antes de que termine.';
  return String(template || '')
    .replace(/\{nombre\}/g, row.name || '')
    .replace(/\{link\}/g, base + '/app')
    .replace(/\{link_reservas\}/g, row.booking_slug ? `${base}/reservar/${row.booking_slug}` : base + '/app')
    .replace(/\{turnos\}/g, String(row.appts_count || 0))
    .replace(/\{cuando\}/g, cuando)
    .replace(/\{resumen\}/g, resumen)
    .trim();
}

const ALERT_TEXT = {
  no_bookings: (r) => ({ title: '📞 Prueba sin arrancar', body: `${r.name || 'Una cuenta'} lleva 3 días sin turnos online. Llamala.` }),
  ending:      (r) => ({ title: '⏳ Prueba por terminar', body: `A ${r.name || 'una cuenta'} le quedan 2 días de prueba (${r.appts_count || 0} turnos cargados).` }),
};

let _running = false;

async function candidates() {
  const r = await pool.query(`
    SELECT s.id, s.name, s.phone, s.booking_slug, s.subscription_status, s.created_at,
           s.trial_ends_at, s.expired_at, s.first_payment_at,
           (to_jsonb(s)->>'schedule') IS NOT NULL AS has_schedule,
           (SELECT COUNT(*)::int FROM services sv WHERE sv.shop_id = s.id AND sv.active = TRUE
              AND (sv.name, sv.price) NOT IN (('Corte de cabello',12000),('Corte + barba',16000),('Barba',8000),('Corte + lavado',14000))
           ) AS own_services,
           EXISTS (SELECT 1 FROM notifications n WHERE n.recipient_shop_id = s.id AND n.type = 'appointment.created') AS online_booking,
           (SELECT COUNT(*)::int FROM appointments a WHERE a.shop_id = s.id AND a.status <> 'cancelled') AS appts_count,
           (SELECT MAX(t.sent_at) FROM trial_nudges t WHERE t.shop_id = s.id AND t.channel = 'wpp') AS last_wpp_at,
           COALESCE((SELECT json_agg(t.kind || ':' || t.channel) FROM trial_nudges t WHERE t.shop_id = s.id), '[]'::json) AS sent
      FROM shops s
     WHERE s.subscription_status IN ('trial', 'expired')
       AND COALESCE(s.is_test, FALSE) = FALSE
       AND COALESCE(s.is_barber, FALSE) = FALSE
       AND COALESCE(s.is_branch, FALSE) = FALSE
       AND COALESCE(s.is_enterprise_owner, FALSE) = FALSE
       AND s.is_system IS DISTINCT FROM TRUE
       AND s.plan IS DISTINCT FROM 'test'
       AND s.created_at > NOW() - INTERVAL '60 days'
     ORDER BY s.created_at
     LIMIT 300`);
  return r.rows;
}

async function record(shopId, kind, channel) {
  await pool.query(
    `INSERT INTO trial_nudges (shop_id, kind, channel) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [shopId, kind, channel]
  );
}

async function runTrialNudges({ now = new Date(), ignoreHours = false } = {}) {
  if (_running) return { wpp: 0, alerts: 0 };
  _running = true;
  let wppSent = 0, alertsSent = 0;
  try {
    const st = {};
    (await pool.query(`SELECT key, value FROM app_settings WHERE key LIKE 'trial_%' OR key = 'welcome_wpp_shop_id'`))
      .rows.forEach(r => { st[r.key] = r.value; });
    const nudgesOn = st.trial_nudges_enabled === 'true';
    const alertsOn = st.trial_alerts_enabled === 'true';
    if (!nudgesOn && !alertsOn) return { wpp: 0, alerts: 0 };

    const h = hourAR(now);
    const rows = await candidates();
    const ms = now.getTime();

    // Alertas al admin (9 a 22)
    if (alertsOn && (ignoreHours || (h >= 9 && h < 22))) {
      const push = require('./push');
      for (const row of rows) {
        for (const kind of adminAlerts(row, ms)) {
          if (row.sent.includes(kind + ':admin')) continue;
          const t = ALERT_TEXT[kind](row);
          await push.sendToAdmins({ ...t, icon: '/favicon.ico', data: { url: '/admin', type: 'trial.' + kind, shopId: row.id } }).catch(() => {});
          await record(row.id, kind, 'admin');
          alertsSent++;
        }
      }
    }

    // WhatsApp a la cuenta (10 a 20), solo con el número de FILO conectado
    if (nudgesOn && (ignoreHours || (h >= 10 && h < 20))) {
      const senderId = parseInt(st.welcome_wpp_shop_id);
      const sender = senderId ? (await pool.query('SELECT wpp_connected FROM shops WHERE id=$1', [senderId])).rows[0] : null;
      if (sender && sender.wpp_connected) {
        const wpp = require('./whatsapp');
        for (const row of rows) {
          if (!row.phone) continue;
          const kind = pickNudge(row, ms);
          if (!kind || row.sent.includes(kind + ':wpp')) continue;
          if (row.last_wpp_at && ms - new Date(row.last_wpp_at).getTime() < 20 * HOUR) continue;
          const msg = render(st['trial_nudge_' + kind], row, ms);
          if (!msg) continue;
          try {
            await wpp.sendText(senderId, row.phone, msg);
            await record(row.id, kind, 'wpp');
            wppSent++;
          } catch (e) {
            // Números que no se pueden contactar: no reintentar. El resto (desconexión, topes) se reintenta en la próxima vuelta.
            if (['OPTED_OUT', 'NOT_ON_WHATSAPP'].includes(e.code)) await record(row.id, kind, 'wpp').catch(() => {});
            else console.warn(`[TRIAL-NUDGE] shop ${row.id} (${kind}) no enviado: ${e.message}`);
            if (['DAILY_CAP', 'FIRST_CONTACT_CAP', 'CIRCUIT_OPEN', 'CAREFUL_MODE'].includes(e.code)) break;
          }
        }
      }
    }
    if (wppSent || alertsSent) console.log(`[TRIAL-NUDGE] whatsapp=${wppSent} alertas=${alertsSent}`);
  } catch (e) {
    console.error('[TRIAL-NUDGE] error:', e.message);
  } finally {
    _running = false;
  }
  return { wpp: wppSent, alerts: alertsSent };
}

module.exports = { runTrialNudges, pickNudge, adminAlerts, render, KINDS };
