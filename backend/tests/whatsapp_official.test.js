// Webhook de la API oficial de WhatsApp (Meta): verificación y firma de los eventos.
// Correr: `node --test backend/tests/whatsapp_official.test.js`
const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://dummy@localhost:1/x';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-test';
process.env.META_APP_SECRET = 'meta-secret-test';

const express = require('express');
const router  = require('../src/routes/whatsappOfficial');

let server, base;
test.before(async () => {
  const app = express();
  // Igual que en index.js: el cuerpo crudo se guarda para verificar la firma
  app.use(express.json({ verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/whatsapp/')) req.rawBody = buf; } }));
  app.use('/api/whatsapp', router);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}/api/whatsapp/webhook`;
});
test.after(() => server?.close());

test('Meta verifica el webhook con el token correcto', async () => {
  const ok = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=verify-test&hub.challenge=98765`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '98765');
  const bad = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1`);
  assert.equal(bad.status, 403);
});

test('solo se aceptan eventos firmados por Meta', async () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const sign = (secret) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const post = (headers) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ 'X-Hub-Signature-256': sign('otra-clave') })).status, 401);
  assert.equal((await post({ 'X-Hub-Signature-256': sign('meta-secret-test') })).status, 200);
});
