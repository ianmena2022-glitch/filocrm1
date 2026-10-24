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

  // Si la cuenta cambió de rol (p.ej. la sede del dueño pasó a ser sucursal), las sesiones
  // abiertas con el rol viejo se cierran para que vuelvan a entrar con los permisos correctos.
  if (payload.isEnterpriseOwner || payload.isBranch) {
    try {
      // to_jsonb: funciona aunque la columna password_changed_at todavía no exista
      const r = await pool.query(
        `SELECT is_enterprise_owner, is_branch, to_jsonb(s)->>'password_changed_at' AS pca FROM shops s WHERE id=$1`,
        [payload.shopId]
      );
      const s = r.rows[0];
      if (!s || !!s.is_enterprise_owner !== !!payload.isEnterpriseOwner || !!s.is_branch !== !!payload.isBranch) {
        return res.status(401).json({ error: 'Tu sesión cambió. Volvé a iniciar sesión.' });
      }
      // El dueño enterprise le cambió la contraseña a la sucursal: las sesiones abiertas antes se cierran
      if (payload.isBranch && s.pca && payload.iat && payload.iat * 1000 < new Date(s.pca).getTime() - 1000) {
        return res.status(401).json({ error: 'La contraseña de la sucursal cambió. Volvé a iniciar sesión.' });
      }
    } catch (e) {
      console.error('[auth] no se pudo verificar la cuenta enterprise:', e.message);
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
