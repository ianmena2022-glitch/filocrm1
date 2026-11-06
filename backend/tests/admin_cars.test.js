// Pestaña 🚗 Cars del admin: el servidor de FILO entra solo a FiloCars con CARS_ADMIN_PASSWORD
// y reenvía las lecturas y ediciones. Contra un FiloCars de mentira.
// Correr: `node --test backend/tests/admin_cars.test.js`
const test   = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt     = require('jsonwebtoken');

let fake, fakeUrl, server, base;
const calls = [];

test.before(async () => {
  // FiloCars de mentira: login con contraseña, agencias con token
  const f = express();
  f.use(express.json());
  f.post('/api/admin/login', (req, res) => {
    calls.push('login');
    if (req.body.password !== 'cars-secret') return res.status(401).json({ error: 'Contraseña incorrecta' });
    res.json({ token: 'tok-1' });
  });
  const authed = (req, res, next) => (req.headers.authorization === 'Bearer tok-1' ? next() : res.status(401).json({ error: 'No autorizado' }));
  f.get('/api/admin/agencies', authed, (req, res) => { calls.push('list'); res.json([{ id: 7, name: 'Agencia X', slug: 'agencia-x' }]); });
  f.put('/api/admin/agencies/:id', authed, (req, res) => {
    calls.push({ put: req.params.id, body: req.body });
    if (req.body.sample_data && req.params.id === '8') return res.status(400).json({ error: 'La agencia ya tiene autos cargados' });
    res.json({ ok: true });
  });
  await new Promise(r => { fake = f.listen(0, r); });
  fakeUrl = `http://localhost:${fake.address().port}`;

  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://dummy@localhost:1/x';
  process.env.JWT_SECRET = 'jwt-test';
  process.env.ADMIN_PASSWORD = 'admin-test';
  process.env.CARS_URL = fakeUrl;
  process.env.CARS_ADMIN_PASSWORD = 'cars-secret';
  const pool = require('../src/db/pool');
  pool.query = async () => ({ rows: [] }); // sin sesión guardada: obliga a entrar con la variable

  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('../src/routes/admin'));
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}/api/admin/cars`;
});
test.after(() => { server?.close(); fake?.close(); });

const admin = jwt.sign({ isAdmin: true, v: 0 }, 'jwt-test');
const req = (method, path, body, token = admin) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined,
});

test('lista las agencias entrando solo a FiloCars (sin pedir contraseña)', async () => {
  const r = await req('GET', '/agencies');
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).map(a => a.name), ['Agencia X']);
  assert.ok(calls.includes('login'));
});

test('edita una agencia y solo reenvía los campos permitidos', async () => {
  const r = await req('PUT', '/agencies/7', { is_test: true, sample_data: true, add_days: '30', hack: 'x' });
  assert.equal(r.status, 200);
  const put = calls.find(c => c.put === '7');
  assert.deepEqual(put.body, { is_test: true, add_days: 30, sample_data: true });
});

test('los errores de FiloCars llegan con su mensaje', async () => {
  const r = await req('PUT', '/agencies/8', { sample_data: true });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /ya tiene autos/);
});

test('sin sesión de admin de FILO no se puede usar', async () => {
  const r = await req('GET', '/agencies', null, 'token-falso');
  assert.equal(r.status, 401);
});
