const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// GET /api/clients
router.get('/', auth, async (req, res) => {
  try {
    const effectiveShopId = req.parentShopId || req.shopId;
    const isEnterprise = req.isEnterpriseOwner || false;
    const shopFilter = isEnterprise
      ? `(c.shop_id = $1 OR c.shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id = $1 AND is_branch = TRUE))`
      : `c.shop_id = $1`;
    const result = await pool.query(
      `SELECT c.*,
         m.plan  AS membership_plan,
         m.active AS membership_active
       FROM clients c
       LEFT JOIN memberships m ON m.client_id = c.id AND m.active = TRUE
       WHERE ${shopFilter}
       ORDER BY c.name`,
      [effectiveShopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/clients/birthdays/today — clientes que cumplen hoy (zona horaria del shop)
// IMPORTANTE: debe ir ANTES de /:id para que Express no interprete "birthdays" como un id.
router.get('/birthdays/today', auth, async (req, res) => {
  try {
    const effectiveShopId = req.parentShopId || req.shopId;
    const isEnterprise = req.isEnterpriseOwner || false;
    const shopFilter = isEnterprise
      ? `(shop_id = $1 OR shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id = $1 AND is_branch = TRUE))`
      : `shop_id = $1`;
    const result = await pool.query(
      `SELECT id, name, phone, birthday,
              EXTRACT(YEAR FROM AGE(birthday))::int AS age
         FROM clients
        WHERE ${shopFilter}
          AND birthday IS NOT NULL
          AND EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM CURRENT_DATE)
          AND EXTRACT(DAY FROM birthday)   = EXTRACT(DAY FROM CURRENT_DATE)
        ORDER BY name`,
      [effectiveShopId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/clients/by-phone?phone=… — fichas que comparten ese número (para preguntar "¿quién es?")
// IMPORTANTE: antes de /:id, igual que /birthdays/today
router.get('/by-phone', auth, async (req, res) => {
  try {
    const effectiveShopId = req.parentShopId || req.shopId;
    res.json(await clientsWithPhone(effectiveShopId, req.query.phone));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/clients/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const isEnterprise = req.isEnterpriseOwner || false;
    const ownerFilter = isEnterprise
      ? `(shop_id=$2 OR shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id=$2 AND is_branch=TRUE))`
      : `shop_id=$2`;
    const client = await pool.query(
      `SELECT * FROM clients WHERE id=$1 AND ${ownerFilter}`,
      [req.params.id, req.shopId]
    );
    if (!client.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });

    const history = await pool.query(
      `SELECT * FROM appointments WHERE client_id=$1 AND ${ownerFilter} ORDER BY date DESC, time_start DESC LIMIT 20`,
      [req.params.id, req.shopId]
    );
    res.json({ ...client.rows[0], history: history.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Normaliza birthday: null si vacío/inválido, formato YYYY-MM-DD si viene bien
function parseBirthday(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  // Acepta YYYY-MM-DD (el input type="date" devuelve este formato)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t;
}

// Fichas del local con ese número (aunque esté escrito distinto: +54 9 11…, 5411…, 11…).
// Un número lo pueden compartir varias personas (ej: un papá y su hijo), así que puede haber varias.
async function clientsWithPhone(shopId, phone, exceptId = null) {
  const { phoneKey, phoneMatchSql } = require('../services/phoneMatch');
  const key = phoneKey(phone);
  if (!key) return [];
  const r = await pool.query(
    `SELECT id, name, phone, total_visits, last_visit, points FROM clients
      WHERE shop_id=$1 AND ${phoneMatchSql('phone', '$2')}
        AND ($3::int IS NULL OR id <> $3::int)
      ORDER BY total_visits DESC NULLS LAST, id`,
    [shopId, key, exceptId]
  );
  return r.rows;
}

// La misma persona (mismo número y mismo nombre) ya tiene ficha: no se crea otra
async function samePerson(shopId, name, phone, exceptId = null) {
  const { pickByName } = require('../services/phoneMatch');
  return pickByName(await clientsWithPhone(shopId, phone, exceptId), name);
}

// POST /api/clients
router.post('/', auth, async (req, res) => {
  const { name, phone, notes, address, birthday } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });

  try {
    const effectiveShopId = req.parentShopId || req.shopId;
    const existing = await samePerson(effectiveShopId, name, phone);
    if (existing) {
      return res.status(409).json({
        error: `${existing.name} ya tiene ficha con ese número. Usá esa ficha para que sus visitas y puntos queden juntos.`,
        code: 'SAME_CLIENT', client: existing,
      });
    }
    const result = await pool.query(
      'INSERT INTO clients (shop_id, name, phone, notes, address, birthday) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [effectiveShopId, name.trim(), phone?.trim() || null, notes?.trim() || null, address?.trim() || null, parseBirthday(birthday)]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/clients/:id
router.put('/:id', auth, async (req, res) => {
  const { name, phone, notes, birthday, _add_points, _note } = req.body;
  try {
    const effectiveShopId = req.parentShopId || req.shopId;

    // Modo referido: solo sumar puntos sin tocar otros campos (solo dueños, no barberos)
    if (_add_points !== undefined) {
      if (req.isBarber) return res.status(403).json({ error: 'No autorizado' });
      const pts = parseInt(_add_points) || 0;
      const result = await pool.query(
        `UPDATE clients SET points = points + $1 WHERE id=$2 AND shop_id=$3 RETURNING *`,
        [pts, req.params.id, effectiveShopId]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
      console.log(`[REFERIDO] +${pts} puntos a cliente ${req.params.id} — ${_note || ''}`);
      return res.json(result.rows[0]);
    }

    // Modo edición normal: COALESCE para no pisar name/phone con null si no vienen
    const { address } = req.body;
    if (phone || name) {
      // Con el número y el nombre que quedarían después de editar
      const cur = await pool.query('SELECT name, phone FROM clients WHERE id=$1 AND shop_id=$2', [req.params.id, effectiveShopId]);
      if (!cur.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
      const existing = await samePerson(effectiveShopId, name || cur.rows[0].name, phone || cur.rows[0].phone, parseInt(req.params.id));
      if (existing) {
        return res.status(409).json({
          error: `${existing.name} ya tiene ficha con ese número. No puede haber dos fichas de la misma persona.`,
          code: 'SAME_CLIENT', client: existing,
        });
      }
    }
    const result = await pool.query(
      `UPDATE clients SET
         name     = COALESCE($1, name),
         phone    = COALESCE($2, phone),
         notes    = COALESCE($3, notes),
         address  = COALESCE($4, address),
         birthday = COALESCE($5, birthday)
       WHERE id=$6 AND shop_id=$7 RETURNING *`,
      [name || null, phone || null, notes || null, address || null, parseBirthday(birthday), req.params.id, effectiveShopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/clients/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const effectiveShopId = req.parentShopId || req.shopId;
    const isEnterprise = req.isEnterpriseOwner || false;
    const shopFilter = isEnterprise
      ? `(shop_id=$2 OR shop_id IN (SELECT id FROM shops WHERE parent_enterprise_id=$2 AND is_branch=TRUE))`
      : `shop_id=$2`;
    const result = await pool.query(
      `DELETE FROM clients WHERE id=$1 AND ${shopFilter} RETURNING id`,
      [req.params.id, effectiveShopId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
