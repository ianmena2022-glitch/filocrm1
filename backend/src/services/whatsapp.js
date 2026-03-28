const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const BASE_URL = process.env.WPPCONNECT_URL || 'http://localhost:21465';
const SECRET   = process.env.WPPCONNECT_SECRET_KEY || 'THISISMYSECURETOKEN';

function sessionName(shopId) {
  return `filo_shop_${shopId}`;
}

async function generateToken(shopId) {
  const session = sessionName(shopId);
  const url = `${BASE_URL}/api/${session}/${SECRET}/generate-token`;
  console.log(`WPP generateToken → ${url}`);
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
  console.log(`WPP startSession → ${url}`);
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
    console.log(`WPP getStatus → ${data.status}`);
    return { connected: data.status === 'CONNECTED', status: data.status };
  } catch (e) {
    console.error('WPP getStatus error:', e.message);
    return { connected: false };
  }
}

async function sendText(shopId, phone, message) {
  const session    = sessionName(shopId);
  const token      = await generateToken(shopId);
  const phoneClean = phone.replace(/\D/g, '');

  console.log(`WPP sendText → session: ${session}, phone: ${phoneClean}`);

  const url = `${BASE_URL}/api/${session}/send-message`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      phone: phoneClean,
      message,
      isGroup: false
    }),
    signal: AbortSignal.timeout(30000)
  });

  const text = await res.text();
  console.log(`WPP sendText response → ${res.status}: ${text.slice(0, 200)}`);

  if (!res.ok) {
    throw new Error(`WPPConnect send-message error: ${res.status} — ${text}`);
  }
  return JSON.parse(text);
}

module.exports = { startSession, getStatus, sendText, sessionName };
