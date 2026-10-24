const router = require('express').Router();
const jwt    = require('jsonwebtoken');
const sse    = require('../services/sse');

// GET /api/events/stream?token=... — abre una conexión SSE.
// EventSource no permite custom headers, por eso el token va por query.
router.get('/stream', (req, res) => {
  const raw = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!raw) return res.status(401).end();
  let payload;
  try { payload = jwt.verify(raw, process.env.JWT_SECRET); }
  catch(_) { return res.status(401).end(); }
  const shopId = payload.shopId;
  if (!shopId) return res.status(401).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Mensaje inicial para que el cliente sepa que la conexión está lista.
  res.write(`event: hello\ndata: ${JSON.stringify({ shopId, ts: Date.now() })}\n\n`);

  const unsubscribe = sse.join(shopId, res);

  // Heartbeat cada 20s para que proxies (Railway/Cloudflare) no cierren la
  // conexión por idle. Es un comment line, no dispara onmessage en el client.
  // Es un evento ("ping") y no un comentario: así el navegador sabe que la conexión sigue viva.
  const heartbeat = setInterval(() => {
    try { res.write(`event: ping\ndata: ${Date.now()}\n\n`); }
    catch(_) { /* el close handler se encarga */ }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

module.exports = router;
