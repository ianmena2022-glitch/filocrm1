const jwt  = require('jsonwebtoken');
const pool = require('../db/pool');

module.exports = async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  // Un barbero dado de baja (o movido a otro local) no debe conservar acceso
  // mientras su token siga vigente: se verifica que siga vinculado al mismo local.
  if (payload.isBarber && payload.parentShopId) {
    try {
      const r = await pool.query('SELECT parent_shop_id FROM shops WHERE id=$1', [payload.shopId]);
      if (!r.rows.length || r.rows[0].parent_shop_id !== payload.parentShopId) {
        return res.status(401).json({ error: 'Token inválido o expirado' });
      }
    } catch (e) {
      console.error('[auth] no se pudo verificar al barbero:', e.message);
      return res.status(503).json({ error: 'Error temporal, reintentá' });
    }
  }

  req.shopId             = payload.shopId;
  req.shopEmail          = payload.email;
  req.isBarber           = payload.isBarber           || false;
  req.parentShopId       = payload.parentShopId       || null;
  req.isEnterpriseOwner  = payload.isEnterpriseOwner  || false;
  req.isBranch           = payload.isBranch           || false;
  req.parentEnterpriseId = payload.parentEnterpriseId || null;

  // Run the rest of the request inside the RLS shop context.
  // pool.query() will automatically set app.shop_id = shopId
  // on every connection it borrows, so PostgreSQL RLS policies
  // (based on current_shop_id()) are enforced at the DB level.
  pool.shopContext.run(payload.shopId, next);
};
