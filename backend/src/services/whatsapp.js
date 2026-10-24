// Puerta de entrada a WhatsApp para toda la app.
//
// • Sin WPP_WORKER_URL (desarrollo, o para volver atrás): WhatsApp corre dentro de este mismo
//   servidor, como siempre (services/whatsapp-core.js).
// • Con WPP_WORKER_URL: WhatsApp corre en un servicio aparte de Railway (src/wpp-worker.js) que
//   se conecta una vez y queda prendido. Esta app le pide las cosas por la red interna. Así un
//   deploy de la app no desconecta ni reconecta ningún WhatsApp.
const REMOTE = !!process.env.WPP_WORKER_URL && process.env.WPP_IS_WORKER !== '1';

if (!REMOTE) {
  module.exports = require('./whatsapp-core');
} else {
  const { normalizePhoneAR, renderTemplate } = require('./wppText');
  const BASE = String(process.env.WPP_WORKER_URL).replace(/\/+$/, '');
  const SECRET = process.env.WPP_WORKER_SECRET || '';

  // Llama a una función del servicio de WhatsApp. Los errores conservan su mensaje y su código
  // (OPTED_OUT, DAILY_CAP, CAREFUL_MODE, AUTO_DISABLED, …) para que la app los trate igual que antes.
  async function rpc(fn, args, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(BASE + '/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wpp-secret': SECRET },
        body: JSON.stringify({ fn, args }),
        signal: ctrl.signal,
      });
    } catch (e) {
      const err = new Error(e.name === 'AbortError'
        ? 'El servicio de WhatsApp no respondió a tiempo'
        : 'El servicio de WhatsApp no está disponible en este momento');
      err.code = e.name === 'AbortError' ? 'WPP_TIMEOUT' : 'WPP_WORKER_DOWN';
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const err = new Error(data.error || `Servicio de WhatsApp: error ${res.status}`);
      if (data.code) err.code = data.code;
      throw err;
    }
    return data.result;
  }
  const remote = (fn, timeoutMs = 30000) => (...args) => rpc(fn, args, timeoutMs);

  module.exports = {
    // Enviar puede tardar: el ritmo anti-baneo espacia los mensajes y simula que se escribe
    sendText:           remote('sendText', 180000),
    startSession:       remote('startSession', 60000),
    getStatus:          remote('getStatus', 15000),
    closeSession:       remote('closeSession'),
    clearSession:       remote('clearSession'),
    requestPairingCode: remote('requestPairingCode', 60000),
    resolveWppShopId:   remote('resolveWppShopId', 10000),
    hasWhatsApp:        remote('hasWhatsApp', 10000),
    isOptedOut:         remote('isOptedOut', 10000),
    addOptOut:          remote('addOptOut', 10000),
    autoEnabled:        remote('autoEnabled', 10000),
    getAutoPrefs:       remote('getAutoPrefs', 10000),
    setAutoPrefs:       remote('setAutoPrefs', 10000),
    setCareful:         remote('setCareful', 10000),
    ensureWppSafetyCols: remote('ensureWppSafetyCols', 10000),
    wppStats:           remote('wppStats', 10000),
    sweepIdle:          remote('sweepIdle', 60000),
    // La app principal no conecta sesiones: lo hace el servicio de WhatsApp al arrancar
    reconnectAllShops:  async () => { console.log('📱 WhatsApp corre en un servicio aparte (WPP_WORKER_URL): este servidor no conecta sesiones'); },
    shutdownAll:        async () => {},
    renderTemplate,
    normalizePhoneAR,
    qrCodes: {},
    REMOTE: true,
  };
}
