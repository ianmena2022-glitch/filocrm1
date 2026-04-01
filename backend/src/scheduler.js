const pool = require('./db/pool');
const wpp  = require('./services/whatsapp');

// Corre cada hora y envía recordatorios de turnos que son en ~12hs
async function sendReminders() {
  try {
    const now = new Date();

    // Ventana: turnos que empiezan entre 11:30hs y 12:30hs desde ahora
    const windowStart = new Date(now.getTime() + 11.5 * 60 * 60 * 1000);
    const windowEnd   = new Date(now.getTime() + 12.5 * 60 * 60 * 1000);

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

function startScheduler() {
  console.log('⏰ Scheduler de recordatorios iniciado');
  // Correr inmediatamente al arrancar (por si hay turnos pendientes)
  sendReminders();
  // Luego cada hora
  setInterval(sendReminders, 60 * 60 * 1000);
}

module.exports = { startScheduler };
