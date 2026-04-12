const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Solo enterprise owners pueden acceder
// Verifica JWT primero; si el flag no está en el token (cuenta creada antes del fix),
// hace fallback a DB chequeando filo_plan='enterprise' y no es branch ni barbero
async function enterpriseOnly(req, res, next) {
  if (req.isEnterpriseOwner) return next();
  try {
    const r = await pool.query(
      `SELECT filo_plan, is_branch, is_barber, is_enterprise_owner
       FROM shops WHERE id=$1`,
      [req.shopId]
    );
    const s = r.rows[0];
    if (!s) return res.status(403).json({ error: 'Solo el owner enterprise puede hacer esto' });
    const isOwner = s.is_enterprise_owner ||
      (s.filo_plan === 'enterprise' && !s.is_branch && !s.is_barber);
    if (!isOwner) return res.status(403).json({ error: 'Solo el owner enterprise puede hacer esto' });
    // Actualizar flag en DB para que el próximo token ya lo traiga
    if (!s.is_enterprise_owner) {
      await pool.query('UPDATE shops SET is_enterprise_owner=TRUE WHERE id=$1', [req.shopId]);
    }
    next();
  } catch(e) { res.status(500).json({ error: e.message }); }
}

// ── GET /api/enterprise/branches — listar sucursales ─────────────────────────
router.get('/branches', auth, enterpriseOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, branch_label, city, address, wpp_connected,
              subscription_status, created_at
       FROM shops
       WHERE parent_enterprise_id = $1 AND is_branch = TRUE
       ORDER BY name`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/enterprise/branches — crear sucursal ───────────────────────────
router.post('/branches', auth, enterpriseOnly, async (req, res) => {
  const { name, branch_label, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });

  try {
    // Verificar que no exista cuenta con ese email
    const exists = await pool.query('SELECT id FROM shops WHERE email=$1', [email.toLowerCase()]);
    if (exists.rows.length)
      return res.status(400).json({ error: 'Ya existe una cuenta con ese email' });

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO shops
         (name, email, password, plan, filo_plan,
          is_branch, parent_enterprise_id, branch_label,
          subscription_status, trial_ends_at)
       VALUES ($1,$2,$3,'staff','enterprise',TRUE,$4,$5,'active','2099-12-31')
       RETURNING *`,
      [name.trim(), email.toLowerCase().trim(), hash, req.shopId, branch_label || null]
    );

    const branch = result.rows[0];

    // Servicios por defecto para la sucursal
    await pool.query(
      `INSERT INTO services (shop_id, name, price, duration_minutes) VALUES
         ($1,'Corte de cabello',3500,30),
         ($1,'Corte + Barba',5500,45),
         ($1,'Arreglo de barba',2500,20)`,
      [branch.id]
    );

    res.status(201).json({ ok: true, branch, generated_password: password });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/enterprise/branches/:id — editar sucursal ───────────────────────
router.put('/branches/:id', auth, enterpriseOnly, async (req, res) => {
  const { name, branch_label, city, address } = req.body;
  try {
    const result = await pool.query(
      `UPDATE shops SET
         name         = COALESCE($1, name),
         branch_label = COALESCE($2, branch_label),
         city         = COALESCE($3, city),
         address      = COALESCE($4, address)
       WHERE id=$5 AND parent_enterprise_id=$6 AND is_branch=TRUE
       RETURNING id, name, branch_label, city, address`,
      [name||null, branch_label||null, city||null, address||null, req.params.id, req.shopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Sucursal no encontrada' });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/enterprise/branches/:id — desactivar sucursal ────────────────
router.delete('/branches/:id', auth, enterpriseOnly, async (req, res) => {
  try {
    await pool.query(
      `UPDATE shops SET subscription_status='cancelled'
       WHERE id=$1 AND parent_enterprise_id=$2 AND is_branch=TRUE`,
      [req.params.id, req.shopId]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/stats — stats consolidadas de todas las sucursales ────
router.get('/stats', auth, enterpriseOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         s.id,
         s.name,
         s.branch_label,
         s.wpp_connected,
         s.subscription_status,
         s.created_at,
         -- Hoy
         COUNT(a.id) FILTER (
           WHERE a.date = CURRENT_DATE AND a.status = 'completed'
         ) AS cuts_today,
         COALESCE(SUM(a.price) FILTER (
           WHERE a.date = CURRENT_DATE AND a.status = 'completed'
         ), 0) AS revenue_today,
         -- Este mes
         COUNT(a.id) FILTER (
           WHERE date_trunc('month', a.date::timestamptz) = date_trunc('month', NOW())
           AND a.status = 'completed'
         ) AS cuts_month,
         COALESCE(SUM(a.price) FILTER (
           WHERE date_trunc('month', a.date::timestamptz) = date_trunc('month', NOW())
           AND a.status = 'completed'
         ), 0) AS revenue_month,
         -- Comisiones mes (ganancia real del dueño = revenue - comisiones)
         COALESCE(SUM(a.price * a.commission_pct / 100.0) FILTER (
           WHERE date_trunc('month', a.date::timestamptz) = date_trunc('month', NOW())
           AND a.status = 'completed'
         ), 0) AS commissions_month,
         -- Barberos activos
         (SELECT COUNT(*) FROM shops b
          WHERE b.parent_shop_id = s.id AND b.is_barber = TRUE) AS barber_count,
         -- Clientes totales
         (SELECT COUNT(*) FROM clients c WHERE c.shop_id = s.id) AS client_count,
         -- Turno próximo
         (SELECT MIN(a2.time_start::text)
          FROM appointments a2
          WHERE a2.shop_id = s.id AND a2.date = CURRENT_DATE
            AND a2.status IN ('pending','confirmed')) AS next_appt
       FROM shops s
       LEFT JOIN appointments a ON a.shop_id = s.id
       WHERE s.parent_enterprise_id = $1 AND s.is_branch = TRUE
       GROUP BY s.id, s.name, s.branch_label, s.wpp_connected, s.subscription_status, s.created_at
       ORDER BY s.name`,
      [req.shopId]
    );

    const branches = result.rows;
    const totals = {
      revenue_today:    branches.reduce((s,b) => s + parseFloat(b.revenue_today||0), 0),
      revenue_month:    branches.reduce((s,b) => s + parseFloat(b.revenue_month||0), 0),
      cuts_today:       branches.reduce((s,b) => s + parseInt(b.cuts_today||0), 0),
      cuts_month:       branches.reduce((s,b) => s + parseInt(b.cuts_month||0), 0),
      barber_count:     branches.reduce((s,b) => s + parseInt(b.barber_count||0), 0),
      client_count:     branches.reduce((s,b) => s + parseInt(b.client_count||0), 0),
      commissions_month: branches.reduce((s,b) => s + parseFloat(b.commissions_month||0), 0),
    };
    totals.profit_month = totals.revenue_month - totals.commissions_month;

    res.json({ branches, totals });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/stats/history?days=30 — serie temporal por sucursal ──
router.get('/stats/history', auth, enterpriseOnly, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  try {
    const result = await pool.query(
      `SELECT
         s.id AS branch_id,
         s.name AS branch_name,
         s.branch_label,
         a.date::text AS date,
         COALESCE(SUM(a.price) FILTER (WHERE a.status='completed'), 0) AS revenue,
         COUNT(a.id)  FILTER (WHERE a.status='completed') AS cuts
       FROM shops s
       LEFT JOIN appointments a
         ON a.shop_id = s.id
         AND a.date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
       WHERE s.parent_enterprise_id = $1 AND s.is_branch = TRUE
       GROUP BY s.id, s.name, s.branch_label, a.date
       ORDER BY a.date DESC, s.name`,
      [req.shopId, days]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
