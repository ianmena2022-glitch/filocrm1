const { Pool }              = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

// ── Connection pool ────────────────────────────────────────
// Si se setea DATABASE_PUBLIC_URL o RAILWAY_PUBLIC_DOMAIN en las variables
// del app, usamos la URL pública (proxy externo) que siempre funciona.
// La URL interna postgres.railway.internal requiere private networking habilitado.
const DB_URL = process.env.DATABASE_URL || '';
const isInternal = DB_URL.includes('.railway.internal');
// Interna: no SSL (red privada). Externa/proxy: SSL sin verificar cert.
const sslConfig = isInternal ? false : { rejectUnauthorized: false };
console.log(`[DB] ${isInternal ? 'INTERNAL' : 'EXTERNAL'} | ssl=${isInternal ? 'off' : 'on'} | host=${DB_URL.replace(/:[^@]*@/, ':***@').split('@')[1]?.split('/')[0] || 'unknown'}`);

const pool = new Pool({
  connectionString: DB_URL,
  ssl: sslConfig,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,
  statement_timeout: 10000,
  query_timeout: 10000,
});

// ── Hard query timeout (cubre hangs TCP + lock-wait) ──────
// Promise.race garantiza fallo en ≤ QUERY_TIMEOUT ms sin importar
// el nivel del cuelgue (TCP, PostgreSQL handshake, lock-wait).
const QUERY_TIMEOUT = 10000; // 10 segundos
function withTimeout(promise, label) {
  let tid;
  const timeout = new Promise((_, reject) => {
    tid = setTimeout(() => reject(new Error(`DB timeout (${label || 'query'})`)), QUERY_TIMEOUT);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(tid));
}

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

// ── RLS shop context ───────────────────────────────────────
// AsyncLocalStorage carries the current shopId through the full
// async chain of any request that enters via the auth middleware.
// Both pool.query() and pool.connect() below pick it up so ALL
// DB operations in authenticated requests automatically set the
// app.shop_id Postgres session variable — no route changes needed.
const shopContext = new AsyncLocalStorage();

// Expose so the auth middleware can call shopContext.run(shopId, next)
pool.shopContext = shopContext;

// ── Helpers ────────────────────────────────────────────────
async function setShopId(client, shopId) {
  await client.query(`SELECT set_config('app.shop_id', $1, false)`, [String(shopId)]);
}

async function clearShopId(client) {
  try {
    await client.query(`SELECT set_config('app.shop_id', '', false)`);
  } catch (_) { /* ignore if connection is already broken */ }
}

// ── Wrap pool.query ────────────────────────────────────────
// Handles simple (non-transaction) queries.
const _query = pool.query.bind(pool);

pool.query = async function shopAwareQuery(text, values) {
  const shopId = shopContext.getStore();
  if (!shopId) return withTimeout(_query(text, values), text?.slice?.(0, 40));

  const client = await withTimeout(_connect(), 'connect');
  try {
    await setShopId(client, shopId);
    return await withTimeout(client.query(text, values), text?.slice?.(0, 40));
  } finally {
    await clearShopId(client);
    client.release();
  }
};

// ── Wrap pool.connect ──────────────────────────────────────
// Handles transactions (BEGIN / COMMIT blocks).
// The returned client has app.shop_id already set; release() resets it.
const _connect = pool.connect.bind(pool);

pool.connect = async function shopAwareConnect() {
  const client = await withTimeout(_connect(), 'connect');
  const shopId = shopContext.getStore();

  if (shopId) {
    await setShopId(client, shopId);

    // Wrap release so it clears app.shop_id before returning the
    // connection to the pool — preventing context leaks.
    const _release = client.release.bind(client);
    client.release = async function (err) {
      await clearShopId(client);
      return _release(err);
    };
  }

  return client;
};

// ── pool.connectAs (explicit override) ────────────────────
// Use this in public/webhook routes that know their shopId but
// don't go through the auth middleware (e.g. booking, queue join).
pool.connectAs = async function (shopId) {
  const client = await _connect();
  await setShopId(client, shopId);
  const _release = client.release.bind(client);
  client.release = async function (err) {
    await clearShopId(client);
    return _release(err);
  };
  return client;
};

module.exports = pool;
