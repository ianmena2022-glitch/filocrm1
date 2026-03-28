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

// Esperar y reintentar hasta obtener el QR
async function waitForQR(instance, maxAttempts = 10, delayMs = 3000) {
  for (let i = 1; i <= maxAttempts; i++) {
    console.log(`Evolution waitForQR → intento ${i}/${maxAttempts}`);
    await new Promise(r => setTimeout(r, delayMs));

    const res = await fetch(`${BASE_URL}/instance/connect/${instance}`, {
      method: 'GET',
      headers: headers(),
    });

    if (!res.ok) continue;

    const data = await res.json();
    console.log(`Evolution QR response → ${JSON.stringify(data).slice(0, 200)}`);

    if (data.base64) return { qrcode: data.base64 };
    if (data.code)   return { qrcode: data.code };
    if (data.instance?.state === 'open') return { status: 'CONNECTED' };
    if (data.count && data.count > 0 && data.base64) return { qrcode: data.base64 };
  }
  throw new Error('Timeout esperando QR de Evolution API');
}

async function startSession(shopId) {
  const instance = instanceName(shopId);

  // 1. Eliminar instancia previa
  try {
    await fetch(`${BASE_URL}/instance/delete/${instance}`, {
      method: 'DELETE',
      headers: headers(),
    });
    console.log(`Evolution: instancia previa eliminada`);
    await new Promise(r => setTimeout(r, 1500));
  } catch (e) {
    console.log('No había instancia previa:', e.message);
  }

  // 2. Crear nueva instancia
  const createRes = await fetch(`${BASE_URL}/instance/create`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      instanceName: instance,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    }),
  });

  const createText = await createRes.text();
  console.log(`Evolution createInstance → ${createRes.status}: ${createText.slice(0, 300)}`);

  if (!createRes.ok) {
    throw new Error(`Evolution create instance error: ${createRes.status} — ${createText}`);
  }

  // 3. Esperar y reintentar hasta conseguir el QR
  return await waitForQR(instance);
}

async function getStatus(shopId) {
  try {
    const instance = instanceName(shopId);
    const res = await fetch(`${BASE_URL}/instance/connectionState/${instance}`, {
      method: 'GET',
      headers: headers(),
    });

    if (!res.ok) return { connected: false };

    const data = await res.json();
    console.log(`Evolution getStatus → ${JSON.stringify(data)}`);

    const connected = data?.instance?.state === 'open';
    return { connected, status: data?.instance?.state };
  } catch (e) {
    console.error('Evolution getStatus error:', e.message);
    return { connected: false };
  }
}

async function sendText(shopId, phone, message) {
  const instance   = instanceName(shopId);
  const phoneClean = phone.replace(/\D/g, '');

  console.log(`Evolution sendText → instance: ${instance}, phone: ${phoneClean}`);

  const res = await fetch(`${BASE_URL}/message/sendText/${instance}`, {
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

  if (!res.ok) throw new Error(`Evolution send-message error: ${res.status} — ${text}`);
  return JSON.parse(text);
}

async function closeSession(shopId) {
  try {
    const instance = instanceName(shopId);
    const res = await fetch(`${BASE_URL}/instance/delete/${instance}`, {
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
