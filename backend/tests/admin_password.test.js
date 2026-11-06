// Admin: poner una contraseña nueva a una barbería desde "Editar".
// Correr: `node --test backend/tests/admin_password.test.js`
const test   = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://dummy@localhost:1/x';
process.env.JWT_SECRET = 'jwt-test';
process.env.ADMIN_PASSWORD = 'admin-test';

const pool = require('../src/db/pool');
const queries = [];
pool.query = async (text, params) => { queries.push({ text, params }); return { rows: [] }; };

const express = require('express');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const router  = require('../src/routes/admin');

let server, base;
const token = jwt.sign({ isAdmin: true, v: 0 }, 'jwt-test');
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', router);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}/api/admin/accounts/911`;
});
test.after(() => server?.close());

const put = (body) => fetch(base, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
});
const lastUpdate = () => queries.filter(q => /^\s*UPDATE shops SET/.test(q.text)).pop();

test('la contraseña nueva se guarda cifrada y marca el cambio', async () => {
  queries.length = 0;
  const r = await put({ name: 'FILO Demo Barbería', new_password: 'nueva-clave-1' });
  assert.equal(r.status, 200, await r.text());
  const q = lastUpdate();
  assert.match(q.text, /password=\$1/);
  assert.match(q.text, /password_changed_at=NOW\(\)/);
  assert.notEqual(q.params[0], 'nueva-clave-1');                    // nunca en texto plano
  assert.ok(await bcrypt.compare('nueva-clave-1', q.params[0]));     // es el hash de la contraseña
});

test('sin contraseña nueva no se toca la contraseña', async () => {
  queries.length = 0;
  const r = await put({ name: 'FILO Demo Barbería' });
  assert.equal(r.status, 200);
  assert.doesNotMatch(lastUpdate().text, /password/);
});

test('una contraseña de menos de 6 caracteres se rechaza', async () => {
  queries.length = 0;
  const r = await put({ name: 'X', new_password: '123' });
  assert.equal(r.status, 400);
  assert.equal(lastUpdate(), undefined);
});
