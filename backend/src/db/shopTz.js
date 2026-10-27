const pool = require('./pool');

const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';

// Nombres viejos de zonas argentinas (los manda algún navegador) que Postgres 18 ya no reconoce:
// una sola barbería con uno así hace fallar consultas que recorren todas (p.ej. recordatorios).
const LEGACY_AR = ['Buenos_Aires', 'Cordoba', 'Catamarca', 'Jujuy', 'Mendoza'];
function normalizeTz(tz) {
  if (!tz || typeof tz !== 'string') return null;
  const t = tz.trim();
  const m = t.match(/^America\/(\w+)$/);
  if (m && LEGACY_AR.includes(m[1])) return `America/Argentina/${m[1]}`;
  if (t === 'America/Rosario') return 'America/Argentina/Cordoba';
  try { new Intl.DateTimeFormat('en', { timeZone: t }); } catch { return DEFAULT_TZ; }
  return t;
}

/**
 * Returns the IANA timezone for a shop (e.g. 'America/Argentina/Buenos_Aires').
 * Falls back to DEFAULT_TZ if not set.
 */
async function getShopTz(shopId) {
  if (!shopId) return DEFAULT_TZ;
  try {
    const { rows } = await pool.query(
      'SELECT timezone FROM shops WHERE id=$1',
      [shopId]
    );
    return normalizeTz(rows[0]?.timezone) || DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

/** Current date in shop timezone → 'YYYY-MM-DD' */
function shopDate(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz || DEFAULT_TZ });
}

/** Current time in shop timezone → 'HH:MM' */
function shopTime(tz) {
  return new Date().toLocaleTimeString('en-GB', {
    timeZone: tz || DEFAULT_TZ,
    hour: '2-digit',
    minute: '2-digit',
  });
}

module.exports = { getShopTz, shopDate, shopTime, normalizeTz, DEFAULT_TZ };
