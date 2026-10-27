// La librería de cifrado de WhatsApp (libsignal, dentro de Baileys) imprime en consola la sesión
// completa cuando la abre o la cierra ("Closing session: SessionEntry {…}"), con las claves
// privadas (privKey, rootKey, chainKey…), y un stack entero por cada "Bad MAC". Eso terminaba en
// los logs de Railway. Acá se reemplazan esos mensajes por una línea corta, sin objetos ni claves.
// Se instala una sola vez, antes de cargar Baileys.

const SIGNAL_MSGS = [
  'Closing session', 'Opening session', 'Removing old closed session', 'Session already closed',
  'Session already open', 'Migrating session', 'Closing open session in favor of incoming prekey bundle',
  'Decrypted message with closed session', 'V1 session storage migration error',
];

function looksLikeSignalObject(v) {
  if (!v || typeof v !== 'object') return false;
  const name = v.constructor && v.constructor.name;
  if (name === 'SessionEntry' || name === 'SessionRecord') return true;
  return 'currentRatchet' in v || 'indexInfo' in v || '_chains' in v || 'privKey' in v || 'rootKey' in v;
}

function install() {
  if (global.__filoQuietSignalLogs) return;
  global.__filoQuietSignalLogs = true;

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      const first = typeof args[0] === 'string' ? args[0] : '';
      // "Session error:Error: Bad MAC" + stack → una línea
      if (first.startsWith('Session error:')) {
        return orig(`[signal] ${first.split('\n')[0].replace(/^Session error:\s*/, 'error de sesión: ')}`);
      }
      const known = SIGNAL_MSGS.find(m => first.startsWith(m));
      if (known || args.some(looksLikeSignalObject)) {
        return orig(`[signal] ${known || 'mensaje interno'} (detalle oculto: contiene claves)`);
      }
      return orig(...args);
    };
  }
}

module.exports = { install, looksLikeSignalObject };
