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

// GET /api/dashboard/month — métricas del mes actual
router.get('/month', auth, async (req, res) => {
  const shopId = req.shopId;
  try {
    const monthQ = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status='completed' THEN price ELSE 0 END), 0)        AS revenue,
         COALESCE(SUM(CASE WHEN status='completed' THEN price - cost ELSE 0 END), 0) AS net_profit,
         COUNT(CASE WHEN status='completed' THEN 1 END)                               AS completed,
         COUNT(CASE WHEN status='noshow' THEN 1 END)                                  AS noshows,
         COUNT(*)                                                                      AS total
       FROM appointments
       WHERE shop_id=$1
         AND date >= date_trunc('month', CURRENT_DATE)
         AND date <= CURRENT_DATE`,
      [shopId]
    );

    // Mes anterior para comparar
    const prevQ = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN status='completed' THEN price ELSE 0 END), 0) AS revenue
       FROM appointments
       WHERE shop_id=$1
         AND date >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
         AND date < date_trunc('month', CURRENT_DATE)`,
      [shopId]
    );

    // Ticket promedio
    const avgQ = await pool.query(
      `SELECT COALESCE(AVG(price), 0) AS avg_ticket
       FROM appointments
       WHERE shop_id=$1 AND status='completed'
         AND date >= date_trunc('month', CURRENT_DATE)`,
      [shopId]
    );

    // Clientes nuevos este mes
    const newClientsQ = await pool.query(
      `SELECT COUNT(*) AS new_clients
       FROM clients
       WHERE shop_id=$1 AND created_at >= date_trunc('month', CURRENT_DATE)`,
      [shopId]
    );

    // Clientes recurrentes (más de 1 visita este mes)
    const recurringQ = await pool.query(
      `SELECT COUNT(DISTINCT client_id) AS recurring
       FROM appointments
       WHERE shop_id=$1 AND status='completed'
         AND date >= date_trunc('month', CURRENT_DATE)
         AND client_id IS NOT NULL
         AND client_id IN (
           SELECT client_id FROM appointments
           WHERE shop_id=$1 AND status='completed'
             AND date >= date_trunc('month', CURRENT_DATE)
           GROUP BY client_id HAVING COUNT(*) > 1
         )`,
      [shopId]
    );

    const m = monthQ.rows[0];
    const noshow_rate = parseInt(m.total) > 0
      ? Math.round((parseInt(m.noshows) / parseInt(m.total)) * 100)
      : 0;

    res.json({
      revenue:      parseFloat(m.revenue),
      net_profit:   parseFloat(m.net_profit),
      completed:    parseInt(m.completed),
      noshows:      parseInt(m.noshows),
      noshow_rate,
      avg_ticket:   parseFloat(avgQ.rows[0].avg_ticket),
      prev_revenue: parseFloat(prevQ.rows[0].revenue),
      new_clients:  parseInt(newClientsQ.rows[0].new_clients),
      recurring:    parseInt(recurringQ.rows[0].recurring),
    });
  } catch (e) {
    console.error('Dashboard month error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dashboard/chart — facturación últimos 30 días
router.get('/chart', auth, async (req, res) => {
  const shopId = req.shopId;
  try {
    const result = await pool.query(
      `SELECT
         date::text,
         COALESCE(SUM(CASE WHEN status='completed' THEN price ELSE 0 END), 0) AS revenue,
         COUNT(CASE WHEN status='completed' THEN 1 END) AS completed
       FROM appointments
       WHERE shop_id=$1
         AND date >= CURRENT_DATE - INTERVAL '29 days'
         AND date <= CURRENT_DATE
       GROUP BY date ORDER BY date`,
      [shopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dashboard/top-services — servicios más vendidos del mes
router.get('/top-services', auth, async (req, res) => {
  const shopId = req.shopId;
  try {
    const result = await pool.query(
      `SELECT service_name AS name,
              COUNT(*) AS count,
              COALESCE(SUM(price), 0) AS revenue
       FROM appointments
       WHERE shop_id=$1 AND status='completed'
         AND date >= date_trunc('month', CURRENT_DATE)
         AND service_name IS NOT NULL
       GROUP BY service_name
       ORDER BY count DESC
       LIMIT 5`,
      [shopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dashboard/top-clients — clientes más frecuentes del mes
router.get('/top-clients', auth, async (req, res) => {
  const shopId = req.shopId;
  try {
    const result = await pool.query(
      `SELECT c.name, COUNT(*) AS visits, COALESCE(SUM(a.price), 0) AS spent
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
       WHERE a.shop_id=$1 AND a.status='completed'
         AND a.date >= date_trunc('month', CURRENT_DATE)
       GROUP BY c.id, c.name
       ORDER BY visits DESC
       LIMIT 5`,
      [shopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
