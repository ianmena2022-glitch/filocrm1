const pool = require('./db/pool');
const wpp  = require('./services/whatsapp');

const MP_BASE  = 'https://api.mercadopago.com';
const MP_TOKEN = () => process.env.MP_ACCESS_TOKEN;

async function mpGet(path) {
  const res = await fetch(`${MP_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${MP_TOKEN()}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Error MP');
  return data;
}

// Corre cada hora y envía recordatorios de turnos que son en ~12hs
async function sendReminders() {
  try {
    const now = new Date();

    // Ventana: turnos que empiezan entre 1:30hs y 2:30hs desde ahora (~2hs antes)
    const windowStart = new Date(now.getTime() + 1.5 * 60 * 60 * 1000);
    const windowEnd   = new Date(now.getTime() + 2.5 * 60 * 60 * 1000);

    const startDate = windowStart.toISOString().split('T')[0];
    const endDate   = windowEnd.toISOString().split('T')[0];

    const startTime = `${String(windowStart.getHours()).padStart(2,'0')}:${String(windowStart.getMinutes()).padStart(2,'0')}`;
    const endTime   = `${String(windowEnd.getHours()).padStart(2,'0')}:${String(windowEnd.getMinutes()).padStart(2,'0')}`;

    // Buscar turnos en esa ventana con cliente con teléfono, en shops con WPP conectado
    let query, params;

    if (startDate === endDate) {
      query = `
        SELECT a.id, a.shop_id, a.client_name, a.service_name, a.date, a.time_start,
               c.phone AS client_phone, c.name AS client_name_db,
               s.name AS shop_name, s.msg_templates, s.wpp_connected
        FROM appointments a
        JOIN shops s ON s.id = a.shop_id
        LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.date = $1
          AND a.time_start >= $2
          AND a.time_start < $3
          AND a.status IN ('pending','confirmed')
          AND s.wpp_connected = TRUE
          AND c.phone IS NOT NULL
          AND c.phone != ''
          AND a.reminder_sent_at IS NULL
      `;
      params = [startDate, startTime, endTime];
    } else {
      // Ventana cruza medianoche — dos queries separadas
      query = `
        SELECT a.id, a.shop_id, a.client_name, a.service_name, a.date, a.time_start,
               c.phone AS client_phone, c.name AS client_name_db,
               s.name AS shop_name, s.msg_templates, s.wpp_connected
        FROM appointments a
        JOIN shops s ON s.id = a.shop_id
        LEFT JOIN clients c ON c.id = a.client_id
        WHERE (
          (a.date = $1 AND a.time_start >= $2)
          OR
          (a.date = $3 AND a.time_start < $4)
        )
          AND a.status IN ('pending','confirmed')
          AND s.wpp_connected = TRUE
          AND c.phone IS NOT NULL
          AND c.phone != ''
          AND a.reminder_sent_at IS NULL
      `;
      params = [startDate, startTime, endDate, endTime];
    }

    const result = await pool.query(query, params);

    if (!result.rows.length) return;

    console.log(`[CRON] ${result.rows.length} recordatorio(s) a enviar`);

    for (const appt of result.rows) {
      try {
        const clientName = appt.client_name_db || appt.client_name || 'Cliente';
        const hora = String(appt.time_start).slice(0, 5);
        const fecha = new Date(appt.date + 'T12:00:00').toLocaleDateString('es-AR', {
          weekday: 'long', day: 'numeric', month: 'long'
        });

        // Generar mensaje con IA, con fallback si falla
        let msg;
        try {
          const { generateMessage } = require('./services/ai');
          msg = await generateMessage(appt.shop_id, 'recordatorio', {
            clientName,
            hora,
            fecha,
            shopName: appt.shop_name || 'la barbería',
            serviceName: appt.service_name || null
          });
        } catch(e) {}

        if (!msg) {
          msg = `¡Hola ${clientName}! 👋\n\nTe recordamos tu turno mañana a las *${hora}* en ${appt.shop_name}. ¡Te esperamos! ✂️`;
        }

        await wpp.sendText(appt.shop_id, appt.client_phone, msg);

        // Marcar como enviado en el turno para no duplicar
        await pool.query(
          'UPDATE appointments SET reminder_sent_at = NOW() WHERE id = $1',
          [appt.id]
        );

        console.log(`[CRON] Recordatorio enviado a ${clientName} (${appt.client_phone}) — turno ${fecha} ${hora}`);
      } catch(e) {
        console.error(`[CRON] Error enviando recordatorio a ${appt.client_phone}:`, e.message);
      }
    }
  } catch(e) {
    console.error('[CRON] Error en sendReminders:', e.message);
  }
}

async function closeCashRegisters() {
  try {
    const appUrl = process.env.APP_URL || 'https://filocrm.com.ar';
    const res = await fetch(`${appUrl}/api/dashboard/cash/auto-close`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-scheduler-secret': process.env.JWT_SECRET
      }
    });
    const data = await res.json();
    if (data.closed > 0) console.log(`[CRON] Caja cerrada para ${data.closed} barbería(s)`);
  } catch(e) {
    console.error('[CRON] Error en closeCashRegisters:', e.message);
  }
}

// Verifica cada shop activo contra MP y revoca acceso si la suscripción no está 'authorized'
async function syncSubscriptions() {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, mp_shop_subscription_id, mp_shop_status
       FROM shops
       WHERE subscription_status = 'active'
         AND mp_shop_subscription_id IS NOT NULL
         AND (is_test = FALSE OR is_test IS NULL)`
    );
    if (!rows.length) return;
    console.log(`[CRON] Verificando ${rows.length} suscripción(es) activa(s)`);

    for (const shop of rows) {
      try {
        // Si ya está marcado como cancelled en BD, verificar con MP si el período venció
        const sub = await mpGet(`/preapproval/${shop.mp_shop_subscription_id}`);
        if (sub.status !== 'authorized') {
          await pool.query(
            "UPDATE shops SET subscription_status='expired', mp_shop_status=$1, expired_at=COALESCE(expired_at, NOW()) WHERE id=$2",
            [sub.status, shop.id]
          );
          console.log(`[CRON] ${shop.email} → MP status=${sub.status} → acceso revocado`);
        }
      } catch (e) {
        // Si el ID almacenado es el plan_id y da 404, el shop canceló manualmente
        // sin que el webhook actualizara el ID. Verificar por mp_shop_status en BD.
        if (shop.mp_shop_status === 'cancelled') {
          await pool.query(
            "UPDATE shops SET subscription_status='expired', expired_at=COALESCE(expired_at, NOW()) WHERE id=$1",
            [shop.id]
          );
          console.log(`[CRON] ${shop.email} → cancelado manualmente (sin sub_id válido) → acceso revocado`);
        } else {
          // No revocar acceso por error de red/MP — fail-safe
          console.error(`[CRON] Error verificando suscripción de ${shop.email}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('[CRON] Error en syncSubscriptions:', e.message);
  }
}

// Elimina cuentas con subscription_status expirado/cancelado por más de 15 días
async function deleteExpiredAccounts() {
  try {
    const { rows } = await pool.query(
      `DELETE FROM shops
       WHERE subscription_status IN ('expired','cancelled')
         AND expired_at IS NOT NULL
         AND expired_at < NOW() - INTERVAL '15 days'
         AND (is_test = FALSE OR is_test IS NULL)
       RETURNING email`
    );
    if (rows.length) {
      console.log(`[CRON] ${rows.length} cuenta(s) eliminadas por inactividad: ${rows.map(r => r.email).join(', ')}`);
    }
  } catch (e) {
    console.error('[CRON] Error en deleteExpiredAccounts:', e.message);
  }
}

// Envía mensajes de rescate automático a clientes que no vienen hace N días
async function sendAutoRescue() {
  try {
    const { generateMessage } = require('./services/ai');
    const baseUrl = process.env.APP_URL || 'https://filocrm1-production.up.railway.app';

    const { rows } = await pool.query(
      `SELECT c.id, c.shop_id, c.name, c.phone,
              s.name AS shop_name, s.booking_slug, s.wpp_connected, s.churn_days
       FROM clients c
       JOIN shops s ON s.id = c.shop_id
       WHERE s.wpp_connected = TRUE
         AND c.phone IS NOT NULL AND c.phone != ''
         AND c.last_visit IS NOT NULL
         AND c.last_visit < CURRENT_DATE - (s.churn_days || ' days')::INTERVAL
         AND (
           c.last_rescue_sent IS NULL
           OR c.last_rescue_sent < CURRENT_DATE - (s.churn_days || ' days')::INTERVAL
         )
         AND (s.is_test = FALSE OR s.is_test IS NULL)`
    );

    if (!rows.length) return;
    console.log(`[CRON] ${rows.length} mensaje(s) de rescate automático a enviar`);

    for (const client of rows) {
      try {
        const daysSince = Math.floor((Date.now() - new Date(client.last_visit)) / 86400000);
        const bookingLink = client.booking_slug ? `${baseUrl}/reservar/${client.booking_slug}` : null;

        let msg = await generateMessage(client.shop_id, 'rescate_auto', {
          clientName: client.name,
          shopName: client.shop_name,
          daysSince,
          bookingLink,
        });
        if (!msg) msg = `¡Hola ${client.name}! Hace un tiempo que no te vemos por ${client.shop_name}. 🪒 Reservá tu próximo turno cuando quieras.${bookingLink ? `\n${bookingLink}` : ''}`;

        await wpp.sendText(client.shop_id, client.phone, msg);
        await pool.query('UPDATE clients SET last_rescue_sent = NOW() WHERE id = $1', [client.id]);
        console.log(`[CRON] Rescate enviado a ${client.name} (shop ${client.shop_id})`);
      } catch (e) {
        console.error(`[CRON] Error enviando rescate a ${client.name}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[CRON] Error en sendAutoRescue:', e.message);
  }
}

async function runHourlyTasks() {
  await sendReminders();
  await closeCashRegisters();
  await syncSubscriptions();
  await deleteExpiredAccounts();
}

async function runDailyTasks() {
  await sendAutoRescue();
}

let _dailyTasksLastRun = null;

function startScheduler() {
  console.log('⏰ Scheduler iniciado (recordatorios + cierre de caja + sync suscripciones + limpieza de cuentas + rescate auto)');
  runHourlyTasks();
  setInterval(runHourlyTasks, 60 * 60 * 1000);

  // Tareas diarias: correr una vez al arrancar, luego verificar cada hora si ya corrió hoy
  const runDailyIfNeeded = async () => {
    const today = new Date().toISOString().split('T')[0];
    if (_dailyTasksLastRun !== today) {
      _dailyTasksLastRun = today;
      await runDailyTasks();
    }
  };
  runDailyIfNeeded();
  setInterval(runDailyIfNeeded, 60 * 60 * 1000);
}

module.exports = { startScheduler };
