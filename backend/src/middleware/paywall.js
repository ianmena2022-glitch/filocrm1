const pool = require('../db/pool');

// Rutas que NO requieren suscripción activa (siempre accesibles)
const PUBLIC_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/register-barber',
  '/api/auth/register-enterprise',
  '/api/auth/status',
  '/api/auth/me',           // necesario para el polling de verificación de pago
  '/api/auth/complete-registration',
  '/api/payments/filo-subscription', // necesario para que cuentas expiradas puedan re-suscribirse
  '/api/payments/qr-order',          // cuentas expiradas necesitan pagar
  '/api/payments/transfer-order',    // pago por transferencia (cuentas expiradas)
  '/api/payments/transfer-status',   // polling del pago por transferencia
  '/api/payments/subscription',      // estado de la suscripción
  '/api/payments/price',             // precio con promo en el paywall
  '/api/payments/webhook-qr',        // webhook MP (sin auth)
  '/api/auth/setup-test',
  '/api/payments/webhook',
  '/api/booking',
  '/api/points',
  '/health',
];

module.exports = async function paywall(req, res, next) {
  // Saltar rutas públicas
  const isPublic = PUBLIC_PATHS.some(p => req.path.startsWith(p));
  if (isPublic) return next();

  // Solo aplicar a rutas /api/
  if (!req.path.startsWith('/api/')) return next();

  // Necesita token para verificar
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(); // el middleware auth ya maneja esto

  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Quién paga: el barbero hereda del local; la sucursal, del dueño enterprise.
    // (Antes las cuentas enterprise y sus sucursales pasaban siempre, aunque no pagaran.)
    const SQL = 'SELECT id, subscription_status, trial_ends_at, is_test, plan, is_branch, parent_enterprise_id FROM shops WHERE id=$1';
    let result = await pool.query(SQL, [payload.parentShopId || payload.shopId]);
    if (!result.rows.length) return next();
    let shop = result.rows[0];
    if (shop.is_branch && shop.parent_enterprise_id) {
      const owner = await pool.query(SQL, [shop.parent_enterprise_id]);
      if (owner.rows.length) shop = owner.rows[0];
    }
    const shopId = shop.id;

    // Cuentas test siempre tienen acceso
    if (shop.is_test || shop.plan === 'test') return next();

    // Gracia de 3 días solo para suscripciones pagas (dar tiempo a renovar). El trial no tiene
    // gracia: termina el día que dice.
    const GRACE_DAYS = 3;

    // Verificar trial
    if (shop.subscription_status === 'trial') {
      if (shop.trial_ends_at) {
        if (new Date(shop.trial_ends_at) < new Date()) {
          // Trial terminado
          await pool.query("UPDATE shops SET subscription_status='expired', expired_at=COALESCE(expired_at, NOW()) WHERE id=$1", [shopId]);
          return res.status(402).json({
            error: 'Tu período de prueba ha vencido',
            code: 'TRIAL_EXPIRED',
            message: 'Suscribite para continuar usando FILO'
          });
        }
      }
      return next(); // Trial activo
    }

    // Suscripción activa — verificar que no venció (QR paga 30 días)
    if (shop.subscription_status === 'active') {
      if (shop.trial_ends_at) {
        const graceLine = new Date(shop.trial_ends_at);
        graceLine.setDate(graceLine.getDate() + GRACE_DAYS);
        if (graceLine < new Date()) {
          await pool.query("UPDATE shops SET subscription_status='expired', expired_at=COALESCE(expired_at, NOW()) WHERE id=$1", [shopId]);
          return res.status(402).json({ error: 'Tu suscripción venció', code: 'SUBSCRIPTION_EXPIRED', message: 'Renovar tu plan para continuar usando FILO' });
        }
      }
      return next();
    }

    // Expirado o cancelado
    return res.status(402).json({
      error: 'Suscripción inactiva',
      code: 'SUBSCRIPTION_EXPIRED',
      message: 'Renovar tu suscripción para continuar usando FILO'
    });

  } catch (e) {
    // Error de token → el middleware auth lo maneja
    return next();
  }
};