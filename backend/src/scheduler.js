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

    // Ventana: turnos que empiezan entre 1:30hs y 2:30hs desde ahora
    const windowStart = new Date(now.getTime() + 1.5 * 60 * 60 * 1000);
    const windowEnd   = new Date(now.getTime() + 2.5 * 60 * 60 * 1000);

    // Los turnos están guardados en hora Argentina (UTC-3).
    // El servidor corre en UTC → restar 3h antes de extraer fecha/hora.
    const AR_OFFSET_MS = 3 * 60 * 60 * 1000;
    const wsAR = new Date(windowStart.getTime() - AR_OFFSET_MS);
    const weAR = new Date(windowEnd.getTime()   - AR_OFFSET_MS);

    const startDate = wsAR.toISOString().split('T')[0];
    const endDate   = weAR.toISOString().split('T')[0];

    const startTime = `${String(wsAR.getUTCHours()).padStart(2,'0')}:${String(wsAR.getUTCMinutes()).padStart(2,'0')}`;
    const endTime   = `${String(weAR.getUTCHours()).padStart(2,'0')}:${String(weAR.getUTCMinutes()).padStart(2,'0')}`;

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

// Cancela turnos 'waiting_sena' cuya seña no llegó en 60 minutos
async function expirePendingSenas() {
  try {
    const { rows } = await pool.query(
      `UPDATE appointments
       SET status='cancelled', sena_status='lost'
       WHERE status='waiting_sena' AND sena_expires_at < NOW()
       RETURNING id, shop_id, client_name, client_id, date, time_start, sena_amount`
    );
    if (!rows.length) return;
    console.log(`[CRON] ${rows.length} seña(s) vencida(s) — turnos cancelados`);

    // Notificar al cliente por WhatsApp
    for (const appt of rows) {
      try {
        const shopQ = await pool.query('SELECT wpp_connected FROM shops WHERE id=$1', [appt.shop_id]);
        if (!shopQ.rows[0]?.wpp_connected) continue;
        const clientQ = await pool.query('SELECT phone FROM clients WHERE id=$1', [appt.client_id]);
        const phone = clientQ.rows[0]?.phone;
        if (!phone) continue;
        const fecha = new Date(appt.date + 'T12:00:00').toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });
        const hora = String(appt.time_start).slice(0, 5);
        const msg = `⚠️ Tu turno del ${fecha} a las *${hora}* fue *cancelado* porque no se recibió la seña de $${parseFloat(appt.sena_amount).toLocaleString('es-AR')}. Si querés reservar de nuevo, ingresá al sistema de turnos.`;
        await wpp.sendText(appt.shop_id, phone, msg);
      } catch(e) { console.error('[CRON] Error notificando seña vencida:', e.message); }
    }
  } catch(e) {
    console.error('[CRON] Error en expirePendingSenas:', e.message);
  }
}

async function runHourlyTasks() {
  await sendReminders();
  await closeCashRegisters();
  await syncSubscriptions();
  await deleteExpiredAccounts();
  await expirePendingSenas();
}

function startScheduler() {
  console.log('⏰ Scheduler iniciado (recordatorios + cierre de caja + sync suscripciones + limpieza de cuentas + señas)');
  runHourlyTasks();
  setInterval(runHourlyTasks, 60 * 60 * 1000);
}

module.exports = { startScheduler };
