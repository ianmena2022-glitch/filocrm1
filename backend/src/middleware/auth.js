const jwt  = require('jsonwebtoken');
const pool = require('../db/pool');

module.exports = function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
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
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
};
