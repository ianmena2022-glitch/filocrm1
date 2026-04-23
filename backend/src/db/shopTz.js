const pool = require('./pool');

const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';

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
    return rows[0]?.timezone || DEFAULT_TZ;
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

module.exports = { getShopTz, shopDate, shopTime, DEFAULT_TZ };
