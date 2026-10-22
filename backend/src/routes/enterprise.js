const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getShopTz, shopDate } = require('../db/shopTz');
const { methodTotalsForDay, dayCommissions, computeNet, methodMovementsForDay } = require('../services/cashMath');

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

// ── GET /api/enterprise/branches — listar sucursales (incluye sede principal) ─
router.get('/branches', auth, enterpriseOnly, async (req, res) => {
  try {
    const cols = `id, name, email, branch_label, city, address, wpp_connected, subscription_status, created_at`;
    const [ownerRes, branchRes] = await Promise.all([
      pool.query(`SELECT ${cols} FROM shops WHERE id=$1`, [req.shopId]),
      pool.query(`SELECT ${cols} FROM shops WHERE parent_enterprise_id=$1 AND is_branch=TRUE ORDER BY name`, [req.shopId])
    ]);
    // El dueño enterprise solo figura como "Sede Principal" si opera una sede propia
    // (datos propios). Si no, es solo la cuenta de gestión y no se lista como sede.
    const ownerHasSite = (await pool.query(`SELECT ${OWNER_HAS_SITE_DATA_SQL} AS has_data`, [req.shopId])).rows[0].has_data;
    const main = { ...ownerRes.rows[0], is_main: true, branch_label: ownerRes.rows[0]?.branch_label || 'Sede Principal' };
    res.json(ownerHasSite ? [main, ...branchRes.rows] : branchRes.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/enterprise/branches — crear sucursal ───────────────────────────
router.post('/branches', auth, enterpriseOnly, async (req, res) => {
  const { name, branch_label, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });

  const emailNorm = email.toLowerCase().trim();

  try {
    // Verificar que no exista cuenta con ese email (ni confirmada ni pendiente)
    const exists = await pool.query('SELECT id FROM shops WHERE email=$1', [emailNorm]);
    if (exists.rows.length)
      return res.status(400).json({ error: 'Ya existe una cuenta con ese email' });

    const pending = await pool.query('SELECT email FROM pending_registrations WHERE email=$1', [emailNorm]);
    if (pending.rows.length)
      return res.status(400).json({ error: 'Hay un registro pendiente de verificación con ese email' });

    const hash = await bcrypt.hash(password, 12);

    // email_verified=TRUE: la sucursal la crea el enterprise owner, no necesita verificación por mail
    const result = await pool.query(
      `INSERT INTO shops
         (name, email, password, plan, filo_plan,
          is_branch, parent_enterprise_id, branch_label,
          subscription_status, trial_ends_at, email_verified)
       VALUES ($1,$2,$3,'staff','enterprise',TRUE,$4,$5,'active','2099-12-31',TRUE)
       RETURNING *`,
      [name.trim(), emailNorm, hash, req.shopId, branch_label || null]
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

// ── Sede propia del dueño enterprise ─────────────────────────────────────────
// Una cuenta que pasa de Staff a Enterprise conserva en su shop todo el historial
// (turnos, clientes, caja, equipo). El dueño enterprise no opera una sede: por eso
// ese shop se convierte en una SUCURSAL con su propio email/contraseña (para el
// empleado), y el dueño pasa a una cuenta nueva que hereda la suscripción.
const OWNER_HAS_SITE_DATA_SQL = `(
  EXISTS (SELECT 1 FROM appointments WHERE shop_id = $1)
  OR EXISTS (SELECT 1 FROM clients WHERE shop_id = $1)
  OR EXISTS (SELECT 1 FROM services WHERE shop_id = $1)
  OR EXISTS (SELECT 1 FROM shops WHERE parent_shop_id = $1 AND is_barber = TRUE)
)`;

async function ownerNeedsSiteSplit(db, shopId) {
  const r = await db.query(
    `SELECT is_enterprise_owner, is_branch, is_barber, is_test, plan,
            ${OWNER_HAS_SITE_DATA_SQL} AS has_data
       FROM shops WHERE id = $1`,
    [shopId]
  );
  const s = r.rows[0];
  if (!s) return { needs: false };
  if (!s.is_enterprise_owner || s.is_branch || s.is_barber) return { needs: false };
  if (s.is_test || s.plan === 'test') return { needs: false }; // cuentas de prueba: se mantienen como están
  return { needs: !!s.has_data };
}

// ── GET /api/enterprise/main-site-status — ¿hay que separar la sede del dueño? ─
router.get('/main-site-status', auth, enterpriseOnly, async (req, res) => {
  try {
    const { needs } = await ownerNeedsSiteSplit(pool, req.shopId);
    const r = await pool.query('SELECT name, city FROM shops WHERE id=$1', [req.shopId]);
    res.json({ needs_split: needs, name: r.rows[0]?.name || '', city: r.rows[0]?.city || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/enterprise/split-main-site ─────────────────────────────────────
// Body: { email, password, name?, city?, branch_label? }  (acceso para la sede existente)
router.post('/split-main-site', auth, enterpriseOnly, async (req, res) => {
  const { email, password, name, city, branch_label } = req.body || {};
  const emailNorm = String(email || '').toLowerCase().trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(emailNorm))
    return res.status(400).json({ error: 'Ingresá un email válido para la sede' });
  if (typeof password !== 'string' || password.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  const oldId = req.shopId;
  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN'); began = true;

    // Bloquear la fila del shop para que dos pedidos simultáneos no lo separen dos veces
    const lock = await client.query('SELECT * FROM shops WHERE id=$1 FOR UPDATE', [oldId]);
    const old = lock.rows[0];
    if (!old) { await client.query('ROLLBACK'); began = false; return res.status(404).json({ error: 'Cuenta no encontrada' }); }
    const chk = await ownerNeedsSiteSplit(client, oldId);
    if (!chk.needs) {
      await client.query('ROLLBACK'); began = false;
      return res.status(409).json({ error: 'Esta cuenta no necesita separar su sede' });
    }

    const dupe = await client.query('SELECT 1 FROM shops WHERE email=$1', [emailNorm]);
    if (dupe.rows.length) { await client.query('ROLLBACK'); began = false; return res.status(400).json({ error: 'Ya existe una cuenta con ese email' }); }
    const pend = await client.query('SELECT 1 FROM pending_registrations WHERE email=$1', [emailNorm]);
    if (pend.rows.length) { await client.query('ROLLBACK'); began = false; return res.status(400).json({ error: 'Hay un registro pendiente de verificación con ese email' }); }

    const hash = await bcrypt.hash(password, 12);

    // Columnas "de dueño" que se pasan a la cuenta enterprise nueva (solo las que existan)
    const OWNER_COLS = [
      'name','phone','password','plan','filo_plan','subscription_status','trial_ends_at',
      'expired_at','first_payment_at','last_payment_at','mp_shop_subscription_id','mp_shop_status',
      'mp_shop_payment_url','mp_payer_email','is_test','vendor_id','referral_code',
      'referred_by_shop_id','ref_bonus_granted','free_months','affiliate_id','timezone',
      'email_verified','created_at','enterprise_currency','enterprise_timezone','enterprise_notes',
      'enterprise_logo_url','enterprise_shared_wpp','notification_prefs'
    ];
    const colsQ = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='shops'`
    );
    const have = new Set(colsQ.rows.map(r => r.column_name));
    const copyCols = OWNER_COLS.filter(c => have.has(c) && old[c] !== undefined);

    // 1) La sede existente toma el email/contraseña del empleado y deja los datos de cobro
    const clear = ['vendor_id','referral_code','referred_by_shop_id','affiliate_id',
                   'mp_shop_subscription_id','mp_shop_status','mp_shop_payment_url','mp_payer_email',
                   'first_payment_at','last_payment_at','expired_at']
      .filter(c => have.has(c)).map(c => `${c}=NULL`);
    const siteName = (name && String(name).trim()) || old.name;
    await client.query(
      `UPDATE shops SET email=$1, password=$2, name=$3, city=COALESCE($4, city),
              branch_label=$5, email_verified=TRUE
              ${have.has('free_months') ? ', free_months=0' : ''}
              ${have.has('ref_bonus_granted') ? ', ref_bonus_granted=FALSE' : ''}
              ${clear.length ? ', ' + clear.join(', ') : ''}
        WHERE id=$6`,
      [emailNorm, hash, siteName, city ? String(city).trim() : null,
       (branch_label && String(branch_label).trim()) || null, oldId]
    );

    // 2) Cuenta nueva de dueño enterprise con el email/contraseña/suscripción de siempre
    const vals = copyCols.map(c => old[c]);
    const ins = await client.query(
      `INSERT INTO shops (email, is_enterprise_owner, is_branch, is_barber, ${copyCols.join(', ')})
       VALUES ($1, TRUE, FALSE, FALSE, ${copyCols.map((_, i) => '$' + (i + 2)).join(', ')})
       RETURNING id, email`,
      [old.email, ...vals]
    );
    const newId = ins.rows[0].id;

    // 3) La sede existente pasa a ser sucursal del dueño nuevo
    await client.query(
      `UPDATE shops SET is_enterprise_owner=FALSE, is_branch=TRUE, parent_enterprise_id=$1,
              filo_plan='enterprise', subscription_status='active', trial_ends_at='2099-12-31'
        WHERE id=$2`,
      [newId, oldId]
    );

    // 4) Re-apuntar lo que colgaba del dueño viejo. SAVEPOINT por cada tabla: si alguna
    //    no existe en este entorno no aborta la transacción.
    const repoint = [
      'UPDATE shops SET parent_enterprise_id=$1 WHERE parent_enterprise_id=$2 AND is_branch=TRUE AND id<>$2',
      'UPDATE shops SET referred_by_shop_id=$1 WHERE referred_by_shop_id=$2 AND id<>$1',
      'UPDATE mp_processed_payments SET shop_id=$1 WHERE shop_id=$2',
      'UPDATE pending_transfers SET shop_id=$1 WHERE shop_id=$2',
      'UPDATE promotion_uses SET shop_id=$1 WHERE shop_id=$2',
      'UPDATE affiliate_commissions SET shop_id=$1 WHERE shop_id=$2',
    ];
    for (const sql of repoint) {
      await client.query('SAVEPOINT rp');
      try { await client.query(sql, [newId, oldId]); await client.query('RELEASE SAVEPOINT rp'); }
      catch (e) { await client.query('ROLLBACK TO SAVEPOINT rp'); console.warn('[split-main-site] omitido:', e.message); }
    }

    await client.query('COMMIT'); began = false;
    console.log(`[ENTERPRISE] sede ${oldId} separada → sucursal; nuevo dueño enterprise ${newId}`);

    const jwt = require('jsonwebtoken');
    const token = jwt.sign({
      shopId: newId, email: old.email, isBarber: false, parentShopId: null,
      isEnterpriseOwner: true, isBranch: false, parentEnterpriseId: null,
    }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, owner_id: newId, branch_id: oldId, branch_email: emailNorm });
  } catch (e) {
    if (began) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('[split-main-site] error:', e.message);
    res.status(500).json({ error: 'No se pudo separar la sede. No se hicieron cambios.' });
  } finally {
    client.release();
  }
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
         s.id, s.name, s.branch_label, s.wpp_connected, s.subscription_status,
         s.city, s.address, s.created_at,
         -- Hoy
         COUNT(a.id) FILTER (WHERE a.date = CURRENT_DATE AND a.status='completed') AS cuts_today,
         COALESCE(SUM(a.price) FILTER (WHERE a.date = CURRENT_DATE AND a.status='completed'), 0) AS revenue_today,
         -- Este mes
         COUNT(a.id) FILTER (
           WHERE LEFT(a.date::text,7) = TO_CHAR(CURRENT_DATE AT TIME ZONE 'America/Argentina/Buenos_Aires','YYYY-MM') AND a.status='completed'
         ) AS cuts_month,
         COALESCE(SUM(a.price) FILTER (
           WHERE LEFT(a.date::text,7) = TO_CHAR(CURRENT_DATE AT TIME ZONE 'America/Argentina/Buenos_Aires','YYYY-MM') AND a.status='completed'
         ), 0) AS revenue_month,
         -- Comisiones mes
         COALESCE(SUM(a.price * a.commission_pct / 100.0) FILTER (
           WHERE LEFT(a.date::text,7) = TO_CHAR(CURRENT_DATE AT TIME ZONE 'America/Argentina/Buenos_Aires','YYYY-MM') AND a.status='completed'
         ), 0) AS commissions_month,
         -- Gastos mes (egresos reales)
         COALESCE((SELECT SUM(e.amount) FROM expenses e
           WHERE e.shop_id=s.id AND (e.is_income IS NULL OR e.is_income=FALSE)
             AND LEFT(e.date::text,7) = TO_CHAR(CURRENT_DATE AT TIME ZONE 'America/Argentina/Buenos_Aires','YYYY-MM')
         ), 0) AS expenses_month,
         -- Última semana (7 días)
         COUNT(a.id) FILTER (WHERE a.date >= CURRENT_DATE-6 AND a.status='completed') AS cuts_week,
         COALESCE(SUM(a.price) FILTER (WHERE a.date >= CURRENT_DATE-6 AND a.status='completed'), 0) AS revenue_week,
         -- Ticket promedio del mes
         COALESCE(AVG(a.price) FILTER (
           WHERE LEFT(a.date::text,7) = TO_CHAR(CURRENT_DATE AT TIME ZONE 'America/Argentina/Buenos_Aires','YYYY-MM') AND a.status='completed'
         ), 0) AS avg_ticket_month,
         -- Barberos activos
         (SELECT COUNT(*) FROM shops b WHERE b.parent_shop_id=s.id AND b.is_barber=TRUE) AS barber_count,
         -- Clientes totales y nuevos este mes
         (SELECT COUNT(*) FROM clients c WHERE c.shop_id=s.id) AS client_count,
         (SELECT COUNT(*) FROM clients c WHERE c.shop_id=s.id
           AND date_trunc('month',c.created_at)=date_trunc('month',NOW())) AS new_clients_month,
         -- Turnos pendientes hoy
         (SELECT COUNT(*) FROM appointments a2 WHERE a2.shop_id=s.id AND a2.date=CURRENT_DATE
           AND a2.status IN ('pending','confirmed')) AS pending_today,
         -- Turno próximo
         (SELECT MIN(a2.time_start::text) FROM appointments a2
           WHERE a2.shop_id=s.id AND a2.date=CURRENT_DATE AND a2.status IN ('pending','confirmed')) AS next_appt
       FROM shops s
       LEFT JOIN appointments a ON a.shop_id=s.id
       WHERE (s.id=$1 AND ${OWNER_HAS_SITE_DATA_SQL}) OR (s.parent_enterprise_id=$1 AND s.is_branch=TRUE)
       GROUP BY s.id,s.name,s.branch_label,s.wpp_connected,s.subscription_status,s.city,s.address,s.created_at
       ORDER BY revenue_month DESC`,
      [req.shopId]
    );

    const branches = result.rows;
    const totals = {
      revenue_today:     branches.reduce((s,b) => s + parseFloat(b.revenue_today||0), 0),
      revenue_week:      branches.reduce((s,b) => s + parseFloat(b.revenue_week||0), 0),
      revenue_month:     branches.reduce((s,b) => s + parseFloat(b.revenue_month||0), 0),
      cuts_today:        branches.reduce((s,b) => s + parseInt(b.cuts_today||0), 0),
      cuts_week:         branches.reduce((s,b) => s + parseInt(b.cuts_week||0), 0),
      cuts_month:        branches.reduce((s,b) => s + parseInt(b.cuts_month||0), 0),
      barber_count:      branches.reduce((s,b) => s + parseInt(b.barber_count||0), 0),
      client_count:      branches.reduce((s,b) => s + parseInt(b.client_count||0), 0),
      new_clients_month: branches.reduce((s,b) => s + parseInt(b.new_clients_month||0), 0),
      commissions_month: branches.reduce((s,b) => s + parseFloat(b.commissions_month||0), 0),
      expenses_month:    branches.reduce((s,b) => s + parseFloat(b.expenses_month||0), 0),
      pending_today:     branches.reduce((s,b) => s + parseInt(b.pending_today||0), 0),
    };
    totals.profit_month = totals.revenue_month - totals.commissions_month - totals.expenses_month;
    totals.avg_ticket   = totals.cuts_month > 0 ? totals.revenue_month / totals.cuts_month : 0;

    res.json({ branches, totals });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/config — configuración del owner ─────────────────────
router.get('/config', auth, enterpriseOnly, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT name, email, phone, city, enterprise_currency, enterprise_timezone,
              enterprise_logo_url, enterprise_notes, enterprise_shared_wpp, booking_slug
       FROM shops WHERE id=$1`,
      [req.shopId]
    );
    res.json(r.rows[0] || {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/enterprise/config — guardar configuración ───────────────────────
router.put('/config', auth, enterpriseOnly, async (req, res) => {
  const { name, phone, city, enterprise_currency, enterprise_timezone, enterprise_notes, enterprise_shared_wpp } = req.body;
  try {
    // Para booleans, null = no tocar; true/false = actualizar
    const sharedWpp = typeof enterprise_shared_wpp === 'boolean' ? enterprise_shared_wpp : null;
    const r = await pool.query(
      `UPDATE shops SET
         name                  = COALESCE($1, name),
         phone                 = COALESCE($2, phone),
         city                  = COALESCE($3, city),
         enterprise_currency   = COALESCE($4, enterprise_currency),
         enterprise_timezone   = COALESCE($5, enterprise_timezone),
         enterprise_notes      = COALESCE($6, enterprise_notes),
         enterprise_shared_wpp = CASE WHEN $7::boolean IS NOT NULL THEN $7::boolean ELSE enterprise_shared_wpp END
       WHERE id=$8
       RETURNING name, phone, city, enterprise_currency, enterprise_timezone, enterprise_notes, enterprise_shared_wpp`,
      [name||null, phone||null, city||null,
       enterprise_currency||null, enterprise_timezone||null, enterprise_notes||null,
       sharedWpp, req.shopId]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/shared-wpp — para sucursales: saber si el owner usa WPP compartido ──
router.get('/shared-wpp', auth, async (req, res) => {
  try {
    const shop = await pool.query('SELECT parent_enterprise_id, is_branch FROM shops WHERE id=$1', [req.shopId]);
    const s = shop.rows[0];
    if (!s?.is_branch || !s?.parent_enterprise_id) return res.json({ shared_wpp: false });
    const parent = await pool.query('SELECT enterprise_shared_wpp FROM shops WHERE id=$1', [s.parent_enterprise_id]);
    res.json({ shared_wpp: parent.rows[0]?.enterprise_shared_wpp || false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/branches-wpp-status — estado WPP del owner y sus sucursales ──
router.get('/branches-wpp-status', auth, enterpriseOnly, async (req, res) => {
  try {
    const ownerQ = await pool.query(
      'SELECT enterprise_shared_wpp, wpp_connected, (wpp_session IS NOT NULL) AS wpp_had_session FROM shops WHERE id=$1',
      [req.shopId]
    );
    const owner = ownerQ.rows[0] || {};

    const branchQ = await pool.query(
      `SELECT id, name, wpp_connected, (wpp_session IS NOT NULL) AS wpp_had_session
       FROM shops WHERE parent_enterprise_id=$1 AND is_branch=TRUE ORDER BY name`,
      [req.shopId]
    );
    res.json({
      shared_wpp:      owner.enterprise_shared_wpp || false,
      owner_connected: owner.wpp_connected || false,
      owner_had_session: owner.wpp_had_session || false,
      branches:        branchQ.rows
    });
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

// ── Helper: verificar que la sucursal pertenece al enterprise owner ────────────
async function verifyBranch(req, res) {
  const r = await pool.query(
    'SELECT id FROM shops WHERE id=$1 AND parent_enterprise_id=$2 AND is_branch=TRUE',
    [req.params.id, req.shopId]
  );
  if (!r.rows.length) { res.status(404).json({ error: 'Sucursal no encontrada' }); return null; }
  return req.params.id;
}

// ── GET /api/enterprise/branches/:id/cash?date= ───────────────────────────────
router.get('/branches/:id/cash', auth, enterpriseOnly, async (req, res) => {
  const branchId = await verifyBranch(req, res);
  if (!branchId) return;
  const date = req.query.date || shopDate(await getShopTz(branchId));
  try {
    const appts = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN payment_method='cash' THEN price ELSE 0 END),0)     AS cash_total,
         COALESCE(SUM(CASE WHEN payment_method='debit' THEN price ELSE 0 END),0)    AS debit_total,
         COALESCE(SUM(CASE WHEN payment_method='credit' THEN price ELSE 0 END),0)   AS credit_total,
         COALESCE(SUM(CASE WHEN payment_method='transfer' THEN price ELSE 0 END),0) AS transfer_total,
         COALESCE(SUM(CASE WHEN payment_method='debt' THEN price ELSE 0 END),0)     AS debt_total,
         COALESCE(SUM(CASE WHEN payment_method IS NULL THEN price ELSE 0 END),0)    AS no_method_total,
         COALESCE(SUM(tip),0) AS tips_total,
         COALESCE(SUM(CASE WHEN payment_method IS DISTINCT FROM 'debt' THEN price ELSE 0 END),0) AS revenue_total,
         COUNT(*) FILTER (WHERE status='completed') AS cuts_count
       FROM appointments
       WHERE shop_id=$1 AND date=$2 AND status='completed'`,
      [branchId, date]
    );
    const exps = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN (is_income IS NULL OR is_income=FALSE) THEN amount ELSE 0 END),0) AS expenses_total,
         COALESCE(SUM(CASE WHEN is_income=TRUE THEN amount ELSE 0 END),0) AS all_income,
         COALESCE(SUM(CASE WHEN is_income=TRUE AND source_type='sena' THEN amount ELSE 0 END),0) AS sena_income,
         COALESCE(SUM(CASE WHEN is_income=TRUE AND (source_type IS DISTINCT FROM 'debt_payment') THEN amount ELSE 0 END),0) AS extra_income,
         json_agg(json_build_object('id',id,'amount',amount,'category',category,'description',description,'source_type',source_type,'payment_method',payment_method) ORDER BY created_at DESC)
           FILTER (WHERE is_income IS NULL OR is_income=FALSE) AS items,
         json_agg(json_build_object('id',id,'amount',amount,'category',category,'description',description,'source_type',source_type,'payment_method',payment_method) ORDER BY created_at DESC)
           FILTER (WHERE is_income=TRUE AND source_type IS DISTINCT FROM 'debt_payment') AS income_items
       FROM expenses WHERE shop_id=$1 AND date=$2`,
      [branchId, date]
    );
    const dc = (await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN payment_method='cash'     THEN amount ELSE 0 END),0) AS cash_col,
         COALESCE(SUM(CASE WHEN payment_method='debit'    THEN amount ELSE 0 END),0) AS debit_col,
         COALESCE(SUM(CASE WHEN payment_method='credit'   THEN amount ELSE 0 END),0) AS credit_col,
         COALESCE(SUM(CASE WHEN payment_method='transfer' THEN amount ELSE 0 END),0) AS transfer_col,
         COALESCE(SUM(amount),0) AS total_col
       FROM expenses WHERE shop_id=$1 AND date=$2 AND source_type='debt_payment'`,
      [branchId, date]
    )).rows[0];
    const dayComm = await dayCommissions(branchId, date);
    const mt = await methodTotalsForDay(branchId, date);
    const a = appts.rows[0]; const e = exps.rows[0];
    // Totales por método splits-aware (mismos que la caja de la sucursal)
    a.cash_total = mt.cash_total; a.debit_total = mt.debit_total; a.credit_total = mt.credit_total;
    a.transfer_total = mt.transfer_total; a.debt_total = mt.debt_total;
    const revenue = parseFloat(a.revenue_total);
    // all_income SIN la seña (el turno ya cuenta el precio completo)
    const allIncome = parseFloat(e.all_income || 0) - parseFloat(e.sena_income || 0);
    const extraIncome = parseFloat(e.extra_income || 0);
    const expenses = parseFloat(e.expenses_total);
    const tips = parseFloat(a.tips_total);
    const commissions = dayComm.appt + dayComm.product;
    res.json({
      date,
      cash_total:        parseFloat(a.cash_total)     + parseFloat(dc.cash_col),
      debit_total:       parseFloat(a.debit_total)    + parseFloat(dc.debit_col),
      credit_total:      parseFloat(a.credit_total)   + parseFloat(dc.credit_col),
      transfer_total:    parseFloat(a.transfer_total) + parseFloat(dc.transfer_col),
      debt_total:        Math.max(0, parseFloat(a.debt_total) - parseFloat(dc.total_col)),
      no_method_total:   parseFloat(a.no_method_total),
      tips_total:        tips,
      revenue_total:     revenue,
      extra_income:      extraIncome,
      expenses_total:    expenses,
      commissions_total: commissions,
      net_total:         await computeNet(branchId, date, { revenue, allIncome, expenses, apptCommissions: dayComm.appt, productCommissions: dayComm.product }),
      cuts_count:        parseInt(a.cuts_count),
      expenses_items:    e.items || [],
      income_items:      e.income_items || [],
      // Saldo de cada cuenta del local (ingresos − egresos), igual que en la caja del propio local
      methods:           await branchMethodBalances(branchId, date, parseFloat(a.debt_total) - parseFloat(dc.total_col)),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cuentas (métodos de pago) de una sucursal con su saldo del día. Cada saldo sale del mismo
// cálculo que el detalle de la cuenta, así que lo que se ve al abrirla siempre coincide.
async function branchMethodBalances(branchId, date, debtOutstanding) {
  const tz = await getShopTz(branchId);
  let methods = [];
  try {
    const r = await pool.query(
      `SELECT key, label, icon, is_debt FROM payment_methods WHERE shop_id=$1 AND active=TRUE ORDER BY sort_order, id`, [branchId]);
    methods = r.rows;
  } catch (_) {}
  if (!methods.length) methods = [
    { key: 'cash', label: 'Efectivo', icon: '💵', is_debt: false }, { key: 'debit', label: 'Débito', icon: '💳', is_debt: false },
    { key: 'credit', label: 'Crédito', icon: '💳', is_debt: false }, { key: 'transfer', label: 'Transferencia', icon: '📲', is_debt: false },
    { key: 'debt', label: 'Fiado', icon: '🤝', is_debt: true },
  ];
  // Cuentas que aparecen en los movimientos del día aunque ya no estén activas
  const known = new Set(methods.map(m => m.key));
  let used = [];
  try {
    used = (await pool.query(
      `SELECT DISTINCT m FROM (
         SELECT payment_method AS m FROM appointments WHERE shop_id=$1 AND date=$2 AND status='completed'
         UNION SELECT payment_method FROM expenses WHERE shop_id=$1 AND date=$2
       ) t WHERE m IS NOT NULL AND m NOT IN ('debt','mixed')`, [branchId, date])).rows.map(r => r.m);
  } catch (_) {}
  for (const k of used) if (!known.has(k)) { methods.push({ key: k, label: k, icon: '💳', is_debt: false }); known.add(k); }

  const out = [];
  for (const m of methods) {
    if (m.is_debt) { out.push({ ...m, total: Math.max(0, debtOutstanding || 0) }); continue; }
    const d = await methodMovementsForDay(branchId, date, m.key, tz);
    out.push({ ...m, total: d.grand_total });
  }
  return out;
}

// ── GET /api/enterprise/branches/:id/cash/method-detail?date=&method= ─────────
// Mismo detalle completo que ve cada local (ingresos y egresos de la cuenta).
router.get('/branches/:id/cash/method-detail', auth, enterpriseOnly, async (req, res) => {
  const branchId = await verifyBranch(req, res);
  if (!branchId) return;
  const { method } = req.query;
  const tz = await getShopTz(branchId);
  const date = req.query.date || shopDate(tz);
  if (!method) return res.status(400).json({ error: 'Se requiere method' });
  try {
    res.json(await methodMovementsForDay(branchId, date, method, tz));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/branches/:id/cash/history ─────────────────────────────
router.get('/branches/:id/cash/history', auth, enterpriseOnly, async (req, res) => {
  const branchId = await verifyBranch(req, res);
  if (!branchId) return;
  try {
    const result = await pool.query(
      `SELECT * FROM cash_registers WHERE shop_id=$1 ORDER BY date DESC LIMIT 30`,
      [branchId]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/branches/:id/cash/day-detail?date= ───────────────────
router.get('/branches/:id/cash/day-detail', auth, enterpriseOnly, async (req, res) => {
  const branchId = await verifyBranch(req, res);
  if (!branchId) return;
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'Se requiere date' });
  try {
    const reg = await pool.query(
      `SELECT * FROM cash_registers WHERE shop_id=$1 AND date::date = $2::date`,
      [branchId, date]
    );
    const appts = await pool.query(
      `SELECT a.time_start, a.client_name, a.service_name, a.price, a.cost,
              a.commission_pct, a.tip, a.payment_method,
              ROUND(a.price * a.commission_pct / 100.0, 2) AS commission_amount,
              ROUND(a.price - COALESCE(a.cost,0) - (a.price * a.commission_pct / 100.0), 2) AS profit,
              s.name AS barber_name
       FROM appointments a
       LEFT JOIN shops s ON s.id = a.barber_id
       WHERE a.shop_id=$1 AND a.date=$2 AND a.status='completed'
       ORDER BY a.time_start ASC`,
      [branchId, date]
    );
    const expenses = await pool.query(
      `SELECT id, amount, category, description, is_income, source_type, payment_method, created_at
       FROM expenses WHERE shop_id=$1 AND date=$2
       ORDER BY created_at ASC`,
      [branchId, date]
    );
    res.json({
      register:     reg.rows[0] || null,
      appointments: appts.rows,
      expenses:     expenses.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/branches/:id/month-report?year=&month= ───────────────
router.get('/branches/:id/month-report', auth, enterpriseOnly, async (req, res) => {
  const branchId = await verifyBranch(req, res);
  if (!branchId) return;
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const from  = `${year}-${String(month).padStart(2,'0')}-01`;
  const to    = new Date(year, month, 0).toISOString().split('T')[0];
  try {
    const metricsQ = await pool.query(
      `SELECT
         COALESCE(SUM(price),0)                                                     AS revenue,
         COALESCE(SUM(tip),0)                                                        AS tips_total,
         COALESCE(SUM(price * commission_pct / 100.0),0)                            AS commissions_total,
         COUNT(*) FILTER (WHERE status='completed')                                  AS completed,
         COALESCE(SUM(CASE WHEN payment_method='cash'     THEN price ELSE 0 END),0) AS cash,
         COALESCE(SUM(CASE WHEN payment_method='debit'    THEN price ELSE 0 END),0) AS debit,
         COALESCE(SUM(CASE WHEN payment_method='credit'   THEN price ELSE 0 END),0) AS credit,
         COALESCE(SUM(CASE WHEN payment_method='transfer' THEN price ELSE 0 END),0) AS transfer,
         COALESCE(SUM(CASE WHEN payment_method='debt'     THEN price ELSE 0 END),0) AS debt
       FROM appointments
       WHERE shop_id=$1 AND date >= $2 AND date <= $3 AND status='completed'`,
      [branchId, from, to]
    );
    const expensesQ = await pool.query(
      `SELECT * FROM expenses WHERE shop_id=$1 AND date >= $2 AND date <= $3 ORDER BY date`,
      [branchId, from, to]
    );
    const cashQ = await pool.query(
      `SELECT * FROM cash_registers WHERE shop_id=$1 AND date >= $2 AND date <= $3 ORDER BY date`,
      [branchId, from, to]
    );
    const m = metricsQ.rows[0];
    const expTotal = expensesQ.rows.reduce((s,e) => s + parseFloat(e.amount), 0);
    const revenue = parseFloat(m.revenue);
    const tips = parseFloat(m.tips_total);
    const commissions = parseFloat(m.commissions_total);
    res.json({
      revenue, tips_total: tips, commissions_total: commissions,
      expenses_total: expTotal,
      net_total: revenue + tips - commissions - expTotal,
      completed: parseInt(m.completed),
      by_payment: { cash: parseFloat(m.cash), debit: parseFloat(m.debit), credit: parseFloat(m.credit), transfer: parseFloat(m.transfer), debt: parseFloat(m.debt) },
      expenses:       expensesQ.rows,
      cash_registers: cashQ.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/enterprise/branches/:id/debts ────────────────────────────────────
router.get('/branches/:id/debts', auth, enterpriseOnly, async (req, res) => {
  const branchId = await verifyBranch(req, res);
  if (!branchId) return;
  try {
    const result = await pool.query(
      `SELECT d.*, c.phone AS client_phone
       FROM client_debts d
       LEFT JOIN clients c ON c.id = d.client_id
       WHERE d.shop_id=$1 AND d.paid=FALSE
       ORDER BY d.created_at DESC`,
      [branchId]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
