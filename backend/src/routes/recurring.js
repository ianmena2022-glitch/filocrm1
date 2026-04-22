const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// ── Helpers ────────────────────────────────────────────────────────────────

/** Devuelve array de fechas (YYYY-MM-DD) para una regla recurrente */
function generateDates(dayOfWeek, everyWeeks, weeksAhead = 10) {
  const dates = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Primera ocurrencia desde hoy (inclusive hoy si coincide)
  let cur = new Date(today);
  while (cur.getDay() !== dayOfWeek) cur.setDate(cur.getDate() + 1);

  const end = new Date(today);
  end.setDate(end.getDate() + weeksAhead * 7);

  while (cur <= end) {
    dates.push(cur.toISOString().split('T')[0]);
    cur = new Date(cur);
    cur.setDate(cur.getDate() + everyWeeks * 7);
  }
  return dates;
}

/** Calcula time_end a partir de time_start + duration */
function calcTimeEnd(timeStart, durationMins) {
  const [h, m] = timeStart.split(':').map(Number);
  const end = new Date(2000, 0, 1, h, m + durationMins);
  return `${String(end.getHours()).padStart(2,'0')}:${String(end.getMinutes()).padStart(2,'0')}`;
}

/** Genera turnos en BD para una regla. Omite fechas ya existentes. */
async function generateAppointments(client, rule, dates) {
  const timeEnd = calcTimeEnd(rule.time_start, rule.duration_mins || 30);
  let created = 0;
  for (const date of dates) {
    // Verificar si ya existe turno de esta regla en esa fecha
    const exists = await client.query(
      `SELECT id FROM appointments WHERE recurring_id=$1 AND date=$2`,
      [rule.id, date]
    );
    if (exists.rows.length) continue;

    // Verificar conflicto de barbero
    if (rule.barber_id) {
      const conflict = await client.query(
        `SELECT id FROM appointments
         WHERE shop_id=$1 AND date=$2 AND barber_id=$3
           AND status NOT IN ('cancelled','noshow')
           AND time_start < $4 AND time_end > $5`,
        [rule.shop_id, date, rule.barber_id, timeEnd, rule.time_start]
      );
      if (conflict.rows.length) continue; // saltar fecha si hay conflicto
    }

    await client.query(
      `INSERT INTO appointments
         (shop_id, client_id, client_name, service_id, service_name,
          price, barber_id, date, time_start, time_end, status, recurring_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)`,
      [rule.shop_id, rule.client_id, rule.client_name,
       rule.service_id, rule.service_name, rule.service_price,
       rule.barber_id, date, rule.time_start, timeEnd, rule.id]
    );
    created++;
  }
  return created;
}

// ── GET /api/recurring — listar reglas activas ─────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*,
              c.name AS client_display,
              s.name AS barber_display
         FROM recurring_appointments r
         LEFT JOIN clients c ON c.id = r.client_id
         LEFT JOIN shops   s ON s.id = r.barber_id
        WHERE r.shop_id=$1
        ORDER BY r.day_of_week, r.time_start`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/recurring/preview — preview de fechas (sin escribir) ─────────
router.post('/preview', auth, (req, res) => {
  const { day_of_week, every_weeks } = req.body;
  if (day_of_week === undefined || !every_weeks) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  const dates = generateDates(parseInt(day_of_week), parseInt(every_weeks), 8);
  res.json({ dates });
});

// ── POST /api/recurring — crear regla + generar turnos ────────────────────
router.post('/', auth, async (req, res) => {
  const {
    client_id, client_name, client_phone,
    barber_id, service_id, service_name, service_price, duration_mins,
    day_of_week, time_start, every_weeks, notes
  } = req.body;

  if (!client_name || day_of_week === undefined || !time_start || !every_weeks) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  const pgClient = await pool.connect();
  try {
    await pgClient.query('BEGIN');

    // Insertar regla
    const ruleRes = await pgClient.query(
      `INSERT INTO recurring_appointments
         (shop_id, client_id, client_name, client_phone, barber_id,
          service_id, service_name, service_price, duration_mins,
          day_of_week, time_start, every_weeks, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [req.shopId,
       client_id || null, client_name, client_phone || null,
       barber_id || null, service_id || null,
       service_name || null, service_price || 0,
       duration_mins || 30, parseInt(day_of_week),
       time_start, parseInt(every_weeks), notes || null]
    );
    const rule = ruleRes.rows[0];

    // Generar turnos para las próximas 8 semanas
    const dates = generateDates(parseInt(day_of_week), parseInt(every_weeks), 8);
    const created = await generateAppointments(pgClient, rule, dates);

    await pgClient.query('COMMIT');
    res.json({ rule, appointments_created: created });
  } catch(e) {
    await pgClient.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    pgClient.release();
  }
});

// ── PATCH /api/recurring/:id — editar notas / pausar ──────────────────────
router.patch('/:id', auth, async (req, res) => {
  const { notes, active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE recurring_appointments
          SET notes=$1, active=COALESCE($2, active)
        WHERE id=$3 AND shop_id=$4
        RETURNING *`,
      [notes || null, active !== undefined ? active : null, req.params.id, req.shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/recurring/:id — eliminar regla + borrar futuros pendientes
router.delete('/:id', auth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE recurring_appointments SET active=FALSE WHERE id=$1 AND shop_id=$2',
      [req.params.id, req.shopId]
    );
    const r = await pool.query(
      `DELETE FROM appointments
        WHERE recurring_id=$1 AND status='pending' AND date >= CURRENT_DATE`,
      [req.params.id]
    );
    res.json({ ok: true, appointments_deleted: r.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/recurring/generate — job diario: reponer turnos ─────────────
router.post('/generate', auth, async (req, res) => {
  try {
    const rules = await pool.query(
      `SELECT * FROM recurring_appointments WHERE active=TRUE AND shop_id=$1`,
      [req.shopId]
    );
    let total = 0;
    const pgClient = await pool.connect();
    try {
      await pgClient.query('BEGIN');
      for (const rule of rules.rows) {
        const dates = generateDates(rule.day_of_week, rule.every_weeks, 8);
        total += await generateAppointments(pgClient, rule, dates);
      }
      await pgClient.query('COMMIT');
    } catch(e) {
      await pgClient.query('ROLLBACK');
      throw e;
    } finally {
      pgClient.release();
    }
    res.json({ ok: true, appointments_created: total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Función exportable para el job diario ─────────────────────────────────
async function runDailyGeneration() {
  try {
    const rules = await pool.query(
      `SELECT * FROM recurring_appointments WHERE active=TRUE`
    );
    let total = 0;
    const pgClient = await pool.connect();
    try {
      await pgClient.query('BEGIN');
      for (const rule of rules.rows) {
        const dates = generateDates(rule.day_of_week, rule.every_weeks, 8);
        total += await generateAppointments(pgClient, rule, dates);
      }
      await pgClient.query('COMMIT');
      if (total > 0) console.log(`[RECURRING] Generados ${total} turnos automáticos`);
    } catch(e) {
      await pgClient.query('ROLLBACK');
      console.error('[RECURRING] Error en generación diaria:', e.message);
    } finally {
      pgClient.release();
    }
  } catch(e) {
    console.error('[RECURRING] Error accediendo a reglas:', e.message);
  }
}

module.exports = router;
module.exports.runDailyGeneration = runDailyGeneration;
