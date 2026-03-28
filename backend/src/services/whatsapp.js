const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const BASE_URL = process.env.WPPCONNECT_URL || 'http://localhost:8080';
const API_KEY  = process.env.WPPCONNECT_SECRET_KEY || 'filoCRM_secret';

function instanceName(shopId) {
  return `filo_shop_${shopId}`;
}

function headers() {
  return {
    'Content-Type': 'application/json',
    'apikey': API_KEY,
  };
}

// Crear instancia si no existe
async function createInstance(shopId) {
  const instance = instanceName(shopId);
  const url = `${BASE_URL}/instance/create`;
  console.log(`Evolution API createInstance → ${url}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      instanceName: instance,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    }),
  });

  const text = await res.text();
  console.log(`Evolution createInstance response → ${res.status}: ${text.slice(0, 300)}`);

  if (!res.ok && res.status !== 409) {
    throw new Error(`Evolution create instance error: ${res.status} — ${text}`);
  }
  return JSON.parse(text);
}

// Obtener QR para conectar WhatsApp
async function startSession(shopId) {
  const instance = instanceName(shopId);

  // Intentar crear la instancia (si ya existe devuelve 409, lo ignoramos)
  try {
    await createInstance(shopId);
  } catch (e) {
    console.log('createInstance error (puede ser que ya existe):', e.message);
  }

  // Obtener QR
  const url = `${BASE_URL}/instance/connect/${instance}`;
  console.log(`Evolution API connect → ${url}`);

  const res = await fetch(url, {
    method: 'GET',
    headers: headers(),
  });

  const text = await res.text();
  console.log(`Evolution connect response → ${res.status}: ${text.slice(0, 300)}`);

  if (!res.ok) throw new Error(`Evolution connect error: ${res.status} — ${text}`);

  const data = JSON.parse(text);

  // Evolution devuelve el QR como base64 en data.base64
  if (data.base64) {
    return { qrcode: data.base64 };
  }

  if (data.instance?.state === 'open') {
    return { status: 'CONNECTED' };
  }

  return data;
}

// Verificar estado de la conexión
async function getStatus(shopId) {
  try {
    const instance = instanceName(shopId);
    const url = `${BASE_URL}/instance/connectionState/${instance}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: headers(),
    });

    if (!res.ok) return { connected: false };

    const data = await res.json();
    console.log(`Evolution getStatus → ${JSON.stringify(data)}`);

    // state puede ser: 'open', 'connecting', 'close'
    const connected = data?.instance?.state === 'open';
    return { connected, status: data?.instance?.state };
  } catch (e) {
    console.error('Evolution getStatus error:', e.message);
    return { connected: false };
  }
}

// Enviar mensaje de texto
async function sendText(shopId, phone, message) {
  const instance = instanceName(shopId);
  const phoneClean = phone.replace(/\D/g, '');

  console.log(`Evolution sendText → instance: ${instance}, phone: ${phoneClean}`);

  const url = `${BASE_URL}/message/sendText/${instance}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      number: phoneClean,
      text: message,
    }),
    signal: AbortSignal.timeout(30000),
  });

  const text = await res.text();
  console.log(`Evolution sendText response → ${res.status}: ${text.slice(0, 300)}`);

  if (!res.ok) {
    throw new Error(`Evolution send-message error: ${res.status} — ${text}`);
  }
  return JSON.parse(text);
}

// Cerrar/eliminar instancia
async function closeSession(shopId) {
  try {
    const instance = instanceName(shopId);
    const url = `${BASE_URL}/instance/delete/${instance}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: headers(),
    });
    return res.ok;
  } catch (e) {
    console.error('Evolution closeSession error:', e.message);
    return false;
  }
}

module.exports = { startSession, getStatus, sendText, closeSession, instanceName };
