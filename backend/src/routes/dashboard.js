const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// GET /api/dashboard/today
router.get('/today', auth, async (req, res) => {
  const shopId = req.shopId;
  const today  = new Date().toISOString().split('T')[0];

  try {
    // Métricas del día
    const metricsQ = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status='completed' THEN price ELSE 0 END), 0)          AS revenue,
         COALESCE(SUM(CASE WHEN status='completed' THEN price - cost ELSE 0 END), 0)   AS net_profit,
         COUNT(CASE WHEN status='completed' THEN 1 END)                                 AS completed,
         COUNT(CASE WHEN status='pending' OR status='confirmed' THEN 1 END)             AS pending,
         COUNT(CASE WHEN status='noshow' THEN 1 END)                                    AS noshows
       FROM appointments
       WHERE shop_id = $1 AND date = $2`,
      [shopId, today]
    );

    // Turnos del día completos con info del cliente
    const apptsQ = await pool.query(
      `SELECT a.*, c.name AS client_name, c.phone AS client_phone
       FROM appointments a
       LEFT JOIN clients c ON c.id = a.client_id
       WHERE a.shop_id = $1 AND a.date = $2
       ORDER BY a.time_start`,
      [shopId, today]
    );

    // Gráfico últimos 7 días
    const weekQ = await pool.query(
      `SELECT
         date::text,
         COALESCE(SUM(CASE WHEN status='completed' THEN price - cost ELSE 0 END), 0) AS net_profit,
         COUNT(CASE WHEN status='completed' THEN 1 END) AS completed
       FROM appointments
       WHERE shop_id = $1 AND date >= CURRENT_DATE - INTERVAL '6 days' AND date <= CURRENT_DATE
       GROUP BY date
       ORDER BY date`,
      [shopId]
    );

    // Split de comisiones del día (barberos)
    const splitsQ = await pool.query(
      `SELECT
         barber_name,
         SUM(price * commission_pct / 100.0) AS commission,
         COUNT(*) AS cuts
       FROM appointments
       WHERE shop_id = $1 AND date = $2 AND status = 'completed' AND barber_name IS NOT NULL
       GROUP BY barber_name`,
      [shopId, today]
    );

    const m = metricsQ.rows[0];
    res.json({
      metrics: {
        revenue:     parseFloat(m.revenue),
        net_profit:  parseFloat(m.net_profit),
        completed:   parseInt(m.completed),
        pending:     parseInt(m.pending),
        noshows:     parseInt(m.noshows),
      },
      appointments: apptsQ.rows,
      week:         weekQ.rows,
      splits:       splitsQ.rows,
    });
  } catch (e) {
    console.error('Dashboard error:', e.message);
    res.status(500).json({ error: 'Error al cargar dashboard' });
  }
});

module.exports = router;
