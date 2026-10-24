// ─── Servicio de WhatsApp (corre aparte de la app) ───────────────────────────
// Mantiene las conexiones de WhatsApp de todas las barberías, responde con el bot y manda los
// mensajes que le pide la app principal. Se despliega muy de vez en cuando, así los deploys de
// la app no desconectan ni reconectan ningún número.
//
// Se activa con WPP_IS_WORKER=1 (index.js lo arranca en vez de la app).
// Variables: DATABASE_URL, WPP_WORKER_SECRET (la misma que en la app), MAIN_APP_URL (URL interna
// de la app, para avisar en vivo al CRM), GROQ_API_KEY (bot), VAPID_* (avisos push), APP_URL.
process.env.WPP_IS_WORKER = '1';

const express = require('express');
const core = require('./services/whatsapp-core');

const PORT = process.env.PORT || 3001;
const SECRET = process.env.WPP_WORKER_SECRET || '';
const START_DELAY_MS = parseInt(process.env.WPP_START_DELAY_MS) || 45000;

if (!SECRET) console.error('❌ [WPP worker] falta WPP_WORKER_SECRET: el servicio no va a aceptar pedidos');

// Lo que la app le puede pedir a este servicio (nada más)
const ALLOWED = new Set([
  'sendText', 'startSession', 'getStatus', 'closeSession', 'clearSession', 'requestPairingCode',
  'resolveWppShopId', 'hasWhatsApp', 'isOptedOut', 'addOptOut', 'autoEnabled', 'getAutoPrefs',
  'setAutoPrefs', 'setCareful', 'ensureWppSafetyCols', 'wppStats', 'sweepIdle',
]);

// Lo que se devuelve tiene que poder viajar como JSON (los mensajes de Baileys traen Buffers)
function plain(fn, result) {
  if (fn === 'sendText') return { ok: true, id: result?.key?.id || null };
  if (result === undefined) return null;
  try { return JSON.parse(JSON.stringify(result, (k, v) => (v && v.type === 'Buffer' ? undefined : v))); }
  catch (_) { return null; }
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  let stats = null;
  try { stats = core.wppStats(); } catch (_) {}
  res.json({ ok: true, service: 'wpp-worker', sessions: stats?.active_sessions ?? null });
});

app.post('/rpc', async (req, res) => {
  if (!SECRET || req.headers['x-wpp-secret'] !== SECRET) return res.status(401).json({ error: 'No autorizado' });
  const { fn, args } = req.body || {};
  if (!ALLOWED.has(fn) || typeof core[fn] !== 'function') return res.status(400).json({ error: `Función no disponible: ${fn}` });
  try {
    const result = await core[fn](...(Array.isArray(args) ? args : []));
    res.json({ result: plain(fn, result) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Error', code: e.code || null });
  }
});

process.on('unhandledRejection', (r) => console.error('⚠️  [WPP worker] unhandledRejection:', r?.message || r));
process.on('uncaughtException', (e) => console.error('⚠️  [WPP worker] uncaughtException:', e.message));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📱 Servicio de WhatsApp escuchando en el puerto ${PORT}`);
  // Esperar antes de conectar: si este arranque es un reemplazo, el servicio anterior tiene
  // tiempo de guardar y cerrar sus sesiones (nunca dos conexiones del mismo número a la vez).
  setTimeout(() => {
    core.reconnectAllShops()
      .then(() => console.log('📱 WhatsApp: reconexión iniciada'))
      .catch(e => console.error('WhatsApp reconnect error:', e.message));
  }, START_DELAY_MS);
  console.log(`📱 Las sesiones se conectan en ${Math.round(START_DELAY_MS / 1000)} s`);
});

// Railway avisa con SIGTERM antes de apagar: guardar y cerrar las sesiones prolijamente
let _stopping = false;
async function stop(sig) {
  if (_stopping) return;
  _stopping = true;
  console.log(`📱 [WPP worker] ${sig}: guardando y cerrando sesiones...`);
  try { await Promise.race([core.shutdownAll(), new Promise(r => setTimeout(r, 15000))]); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
