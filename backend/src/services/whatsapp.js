const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const BASE_URL = process.env.WPPCONNECT_URL || 'http://localhost:21465';
const SECRET   = process.env.WPPCONNECT_SECRET_KEY || 'filoCRM_secret';

function sessionName(shopId) {
  return `filo_shop_${shopId}`;
}

async function generateToken(shopId) {
  const session = sessionName(shopId);
  const url = `${BASE_URL}/api/${session}/${SECRET}/generate-token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WPPConnect generate-token error: ${res.status} — ${text}`);
  const data = JSON.parse(text);
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
  const text = await res.text();
  if (!res.ok) throw new Error(`WPPConnect start-session error: ${res.status} — ${text}`);
  return JSON.parse(text);
}

async function getStatus(shopId) {
  try {
    const session = sessionName(shopId);
    const token   = await generateToken(shopId);
    const url = `${BASE_URL}/api/${session}/status-session`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { connected: false };
    const data = await res.json();
    return { connected: data.status === 'CONNECTED', status: data.status };
  } catch {
    return { connected: false };
  }
}

async function sendText(shopId, phone, message) {
  const session = sessionName(shopId);
  const token   = await generateToken(shopId);
  const chatId  = phone.replace(/\D/g, '') + '@c.us';

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

module.exports = { startSession, getStatus, sendText, sessionName };