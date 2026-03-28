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

// Crear instancia si no existe, o reconectar si ya existe
async function startSession(shopId) {
  const instance = instanceName(shopId);

  // 1. Intentar eliminar instancia previa para empezar limpio
  try {
    await fetch(`${BASE_URL}/instance/delete/${instance}`, {
      method: 'DELETE',
      headers: headers(),
    });
    console.log(`Evolution: instancia previa eliminada`);
    await new Promise(r => setTimeout(r, 1000));
  } catch (e) {
    console.log('No había instancia previa o error al eliminar:', e.message);
  }

  // 2. Crear nueva instancia con QR
  const createUrl = `${BASE_URL}/instance/create`;
  console.log(`Evolution API createInstance → ${createUrl}`);

  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      instanceName: instance,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    }),
  });

  const createText = await createRes.text();
  console.log(`Evolution createInstance response → ${createRes.status}: ${createText.slice(0, 500)}`);

  if (!createRes.ok) {
    throw new Error(`Evolution create instance error: ${createRes.status} — ${createText}`);
  }

  const createData = JSON.parse(createText);

  // El QR puede venir directo en la respuesta de create
  if (createData.qrcode?.base64) {
    return { qrcode: createData.qrcode.base64 };
  }

  // 3. Si no vino en create, esperar un poco y pedir el QR
  await new Promise(r => setTimeout(r, 2000));

  const qrUrl = `${BASE_URL}/instance/connect/${instance}`;
  console.log(`Evolution API getQR → ${qrUrl}`);

  const qrRes = await fetch(qrUrl, {
    method: 'GET',
    headers: headers(),
  });

  const qrText = await qrRes.text();
  console.log(`Evolution getQR response → ${qrRes.status}: ${qrText.slice(0, 500)}`);

  if (!qrRes.ok) throw new Error(`Evolution connect error: ${qrRes.status} — ${qrText}`);

  const qrData = JSON.parse(qrText);

  if (qrData.base64) return { qrcode: qrData.base64 };
  if (qrData.code)   return { qrcode: qrData.code }; // a veces viene como string raw
  if (qrData.instance?.state === 'open') return { status: 'CONNECTED' };

  throw new Error('No se pudo obtener el QR de Evolution API');
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

    const connected = data?.instance?.state === 'open';
    return { connected, status: data?.instance?.state };
  } catch (e) {
    console.error('Evolution getStatus error:', e.message);
    return { connected: false };
  }
}

// Enviar mensaje de texto
async function sendText(shopId, phone, message) {
  const instance  = instanceName(shopId);
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

  if (!res.ok) throw new Error(`Evolution send-message error: ${res.status} — ${text}`);
  return JSON.parse(text);
}

// Cerrar/eliminar instancia
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
