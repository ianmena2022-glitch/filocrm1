const pool = require('../db/pool');

// Rutas que NO requieren suscripción activa (siempre accesibles)
const PUBLIC_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/register-barber',
  '/api/auth/status',
  '/api/auth/me',           // necesario para el polling de verificación de pago
  '/api/auth/complete-registration',
  '/api/payments/filo-subscription', // necesario para que cuentas expiradas puedan re-suscribirse
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
    const shopId = payload.parentShopId || payload.shopId;

    const result = await pool.query(
      'SELECT subscription_status, trial_ends_at, is_test, plan FROM shops WHERE id=$1',
      [shopId]
    );

    if (!result.rows.length) return next();
    const shop = result.rows[0];

    // Cuentas test siempre tienen acceso
    if (shop.is_test || shop.plan === 'test') return next();

    // Barberos heredan el acceso del dueño
    if (payload.isBarber) return next();

    // Verificar trial
    if (shop.subscription_status === 'trial') {
      if (shop.trial_ends_at && new Date(shop.trial_ends_at) < new Date()) {
        // Trial expirado
        await pool.query("UPDATE shops SET subscription_status='expired' WHERE id=$1", [shopId]);
        return res.status(402).json({
          error: 'Tu período de prueba ha vencido',
          code: 'TRIAL_EXPIRED',
          message: 'Suscribite para continuar usando FILO'
        });
      }
      return next(); // Trial activo
    }

    // Suscripción activa
    if (shop.subscription_status === 'active') return next();

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