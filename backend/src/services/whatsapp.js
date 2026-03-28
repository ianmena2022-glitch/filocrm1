const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const BASE_URL = process.env.WPPCONNECT_URL || 'http://localhost:21465';
const SECRET   = process.env.WPPCONNECT_SECRET_KEY || 'filoCRM_secret';

// WPPConnect usa un nombre de sesión por barbería
function sessionName(shopId) {
  return `filo_shop_${shopId}`;
}

async function generateToken(shopId) {
  const session = sessionName(shopId);
  const url = `${BASE_URL}/api/${session}/${SECRET}/generate-token`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`WPPConnect generate-token error: ${res.status}`);
  const data = await res.json();
  return data.token;
}

async function startSession(shopId) {
  const session = sessionName(shopId);
  const token   = await generateToken(shopId);

  const url = `${BASE_URL}/api/${session}/start-session`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ webhook: null, waitQrCode: true }),
  });

  if (!res.ok) throw new Error(`WPPConnect start-session error: ${res.status}`);
  return res.json(); // contiene { qrcode, status }
}

async function getStatus(shopId) {
  const session = sessionName(shopId);
  const token   = await generateToken(shopId);

  const url = `${BASE_URL}/api/${session}/status-session`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { connected: false };
  const data = await res.json();
  // status puede ser: 'CONNECTED', 'QRCODE', 'INITIALIZING', etc.
  return { connected: data.status === 'CONNECTED', status: data.status };
}

async function sendText(shopId, phone, message) {
  const session = sessionName(shopId);
  const token   = await generateToken(shopId);

  // WPPConnect necesita el número en formato internacional sin + ni espacios, con @c.us
  const chatId = phone.replace(/\D/g, '') + '@c.us';

  const url = `${BASE_URL}/api/${session}/send-message`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ phone: chatId, message }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WPPConnect send-message error: ${res.status} — ${err}`);
  }
  return res.json();
}

async function closeSession(shopId) {
  const session = sessionName(shopId);
  const token   = await generateToken(shopId);

  const url = `${BASE_URL}/api/${session}/close-session`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}

module.exports = { startSession, getStatus, sendText, closeSession, sessionName };
