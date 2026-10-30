// ¿La cuenta está al día? Misma regla que el paywall (middleware/paywall.js), pero sin token:
// la usan la página de reservas y la fila pública, que no toman turnos de una cuenta vencida.
// La sucursal depende de su dueño enterprise; las cuentas test siempre tienen acceso.
const pool = require('../db/pool');

const GRACE_DAYS = 3; // suscripción paga: 3 días para renovar (el trial no tiene gracia)
const SQL = 'SELECT id, subscription_status, trial_ends_at, is_test, plan, is_branch, parent_enterprise_id FROM shops WHERE id=$1';

async function shopHasAccess(shopId) {
  let shop = (await pool.query(SQL, [shopId])).rows[0];
  if (!shop) return false;
  if (shop.is_branch && shop.parent_enterprise_id) {
    // La sucursal desactivada por la cuenta principal no toma turnos, pague o no el dueño
    if (shop.subscription_status === 'cancelled') return false;
    const owner = (await pool.query(SQL, [shop.parent_enterprise_id])).rows[0];
    if (owner) shop = owner;
  }
  if (shop.is_test || shop.plan === 'test') return true;
  const now = Date.now();
  if (shop.subscription_status === 'trial') {
    return !shop.trial_ends_at || new Date(shop.trial_ends_at).getTime() >= now;
  }
  if (shop.subscription_status === 'active') {
    if (!shop.trial_ends_at) return true;
    return new Date(shop.trial_ends_at).getTime() + GRACE_DAYS * 86400000 >= now;
  }
  return false; // vencida o cancelada
}

const INACTIVE_MSG = 'Esta barbería no está tomando turnos online en este momento. Comunicate directamente con el local.';

module.exports = { shopHasAccess, INACTIVE_MSG };
