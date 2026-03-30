const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');
const crypto = require('crypto');

// Middleware: solo dueños (no barberos)
function ownerOnly(req, res, next) {
  if (req.isBarber) return res.status(403).json({ error: 'Solo el dueño puede hacer esto' });
  next();
}

// GET /api/barbers — listar barberos del equipo
router.get('/', auth, ownerOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, barber_commission_pct, barber_color, created_at,
         (SELECT COUNT(*) FROM appointments WHERE barber_id=s.id AND date=CURRENT_DATE AND status NOT IN ('cancelled','noshow')) AS turnos_hoy
       FROM shops s WHERE parent_shop_id=$1 AND is_barber=TRUE ORDER BY name`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/barbers/invite — generar código de invitación
router.post('/invite', auth, ownerOnly, async (req, res) => {
  const { barber_name } = req.body;

  // Verificar límite de 10 barberos
  const count = await pool.query(
    'SELECT COUNT(*) FROM shops WHERE parent_shop_id=$1 AND is_barber=TRUE',
    [req.shopId]
  );
  if (parseInt(count.rows[0].count) >= 10) {
    return res.status(400).json({ error: 'Límite de 10 barberos alcanzado' });
  }

  try {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase(); // ej: A3F2B1C4
    await pool.query(
      'INSERT INTO staff_invites (shop_id, code, barber_name) VALUES ($1, $2, $3)',
      [req.shopId, code, barber_name || null]
    );

    const baseUrl = process.env.APP_URL || 'https://filocrm1-production.up.railway.app';
    const link = `${baseUrl}/app?invite=${code}`;
    res.json({ ok: true, code, link, expires_in: '7 días' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/barbers/:id — editar barbero (comisión, color)
router.put('/:id', auth, ownerOnly, async (req, res) => {
  const { barber_commission_pct, barber_color, name } = req.body;
  try {
    const result = await pool.query(
      `UPDATE shops SET
         barber_commission_pct = COALESCE($1, barber_commission_pct),
         barber_color = COALESCE($2, barber_color),
         name = COALESCE($3, name)
       WHERE id=$4 AND parent_shop_id=$5
       RETURNING id, name, barber_commission_pct, barber_color`,
      [barber_commission_pct || null, barber_color || null, name || null, req.params.id, req.shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Barbero no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/barbers/:id — eliminar barbero del equipo
router.delete('/:id', auth, ownerOnly, async (req, res) => {
  try {
    await pool.query(
      'UPDATE shops SET parent_shop_id=NULL, is_barber=FALSE WHERE id=$1 AND parent_shop_id=$2',
      [req.params.id, req.shopId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/barbers/stats — stats del equipo para el dashboard del dueño
router.get('/stats', auth, ownerOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.name, s.barber_color, s.barber_commission_pct,
         COUNT(a.id) FILTER (WHERE a.date = CURRENT_DATE AND a.status NOT IN ('cancelled','noshow')) AS turnos_hoy,
         COUNT(a.id) FILTER (WHERE a.status = 'completed' AND date_trunc('month', a.date::timestamptz) = date_trunc('month', NOW())) AS completados_mes,
         COALESCE(SUM(a.price) FILTER (WHERE a.status = 'completed' AND date_trunc('month', a.date::timestamptz) = date_trunc('month', NOW())), 0) AS facturado_mes,
         COALESCE(SUM(a.price * s.barber_commission_pct / 100.0) FILTER (WHERE a.status = 'completed' AND date_trunc('month', a.date::timestamptz) = date_trunc('month', NOW())), 0) AS comision_mes
       FROM shops s
       LEFT JOIN appointments a ON a.barber_id = s.id AND a.shop_id = $1
       WHERE s.parent_shop_id = $1 AND s.is_barber = TRUE
       GROUP BY s.id, s.name, s.barber_color, s.barber_commission_pct
       ORDER BY s.name`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/barbers/assign — asignar turno al barbero con menos turnos hoy
router.post('/assign', auth, async (req, res) => {
  const { appointment_id } = req.body;
  const ownerShopId = req.isBarber ? req.parentShopId : req.shopId;

  try {
    // Obtener barbero con menos turnos hoy
    const result = await pool.query(
      `SELECT s.id, s.name,
         COUNT(a.id) FILTER (WHERE a.date = CURRENT_DATE AND a.status NOT IN ('cancelled','noshow')) AS turnos_hoy
       FROM shops s
       LEFT JOIN appointments a ON a.barber_id = s.id AND a.shop_id = $1
       WHERE s.parent_shop_id = $1 AND s.is_barber = TRUE
       GROUP BY s.id, s.name
       ORDER BY turnos_hoy ASC, RANDOM()
       LIMIT 1`,
      [ownerShopId]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'No hay barberos disponibles' });
    const barber = result.rows[0];

    await pool.query(
      'UPDATE appointments SET barber_id=$1, barber_name=$2 WHERE id=$3 AND shop_id=$4',
      [barber.id, barber.name, appointment_id, ownerShopId]
    );

    res.json({ ok: true, barber });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
