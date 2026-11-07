// Protecciones del número de WhatsApp: espera tras un bloqueo, modo cuidado escalonado y
// reconexiones espaciadas. Correr: `node --test backend/tests/whatsapp_safety.test.js`
const test   = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://dummy@localhost:1/x';
process.env.NODE_ENV = 'test';

const pool = require('../src/db/pool');
const core = require('../src/services/whatsapp-core');
const { reconnectDelayMs, holdDaysFor, carefulDaysFor } = core.__test;

// La base devuelve la fila que le pasemos (los ALTER TABLE devuelven vacío)
function fakeShop(row) {
  pool.query = async (sql) => (/FROM shops s/.test(sql) ? { rows: [row] } : { rows: [] });
}
const DAY = 86400000;
const now = new Date('2026-11-07T18:00:00Z');

test('espera tras bloqueo: 7 días el primero, 14 el segundo, 30 desde el tercero', () => {
  assert.equal(holdDaysFor(0), 0);
  assert.equal(holdDaysFor(1), 7);
  assert.equal(holdDaysFor(2), 14);
  assert.equal(holdDaysFor(3), 30);
  assert.equal(holdDaysFor(8), 30);
});

test('modo cuidado: 21 días, 45 si ya lo bloquearon 2 veces o más', () => {
  assert.equal(carefulDaysFor(1), 21);
  assert.equal(carefulDaysFor(2), 45);
});

test('banHold: cuenta los bloqueos viejos por las notificaciones (caso Staff Colors)', async () => {
  const lastBan = new Date('2026-11-07T15:14:38Z');
  fakeShop({ wpp_ban_count: 0, wpp_last_ban_at: null, wpp_banned_at: lastBan, wpp_hold_lifted_at: null, notif_count: 3, notif_last: lastBan });
  const h = await core.banHold(1, now);
  assert.equal(h.count, 3);
  assert.equal(h.strict, true);
  assert.equal(h.carefulCap, 15);
  assert.equal(h.until.getTime(), lastBan.getTime() + 30 * DAY);
});

test('banHold: la espera termina sola', async () => {
  const lastBan = new Date(now.getTime() - 8 * DAY);
  fakeShop({ wpp_ban_count: 1, wpp_last_ban_at: lastBan, wpp_banned_at: null, wpp_hold_lifted_at: null, notif_count: 1, notif_last: lastBan });
  const h = await core.banHold(1, now);
  assert.equal(h.count, 1);
  assert.equal(h.until, null);
  assert.equal(h.strict, false);
  assert.equal(h.carefulCap, 40);
});

test('banHold: soporte la liberó después del último bloqueo', async () => {
  const lastBan = new Date(now.getTime() - 1 * DAY);
  fakeShop({ wpp_ban_count: 2, wpp_last_ban_at: lastBan, wpp_banned_at: lastBan, wpp_hold_lifted_at: new Date(now.getTime() - 3600000), notif_count: 2, notif_last: lastBan });
  assert.equal((await core.banHold(1, now)).until, null);
});

test('banHold: una liberación vieja no sirve para un bloqueo nuevo', async () => {
  const lastBan = new Date(now.getTime() - 1 * DAY);
  fakeShop({ wpp_ban_count: 2, wpp_last_ban_at: lastBan, wpp_banned_at: lastBan, wpp_hold_lifted_at: new Date(now.getTime() - 5 * DAY), notif_count: 1, notif_last: lastBan });
  const h = await core.banHold(1, now);
  assert.equal(h.count, 2);
  assert.ok(h.until > now);
});

test('banHold: número nunca bloqueado', async () => {
  fakeShop({ wpp_ban_count: 0, wpp_last_ban_at: null, wpp_banned_at: null, wpp_hold_lifted_at: null, notif_count: 0, notif_last: null });
  const h = await core.banHold(1, now);
  assert.equal(h.count, 0);
  assert.equal(h.until, null);
});

test('startSession: no deja vincular durante la espera y explica hasta cuándo', async () => {
  const lastBan = new Date(Date.now() - 1 * DAY);
  fakeShop({ wpp_ban_count: 3, wpp_last_ban_at: lastBan, wpp_banned_at: lastBan, wpp_hold_lifted_at: null, notif_count: 3, notif_last: lastBan });
  await assert.rejects(core.startSession(1), (e) => {
    assert.equal(e.code, 'WPP_BAN_HOLD');
    assert.match(e.message, /3 veces/);
    assert.match(e.message, /Vas a poder reconectarlo desde el/);
    return true;
  });
});

test('reconexiones: cuantos más cortes en la hora, más espera', () => {
  const mid = () => 0.5; // sin azar
  assert.equal(reconnectDelayMs(1, 1, mid), 20000);
  assert.equal(reconnectDelayMs(2, 1, mid), 2 * 60000);
  assert.equal(reconnectDelayMs(3, 1, mid), 5 * 60000);
  assert.equal(reconnectDelayMs(4, 1, mid), 15 * 60000);
  assert.equal(reconnectDelayMs(5, 1, mid), 30 * 60000);
  assert.equal(reconnectDelayMs(12, 1, mid), 30 * 60000);
});

test('reconexiones: los intentos fallidos seguidos también alargan la espera', () => {
  const mid = () => 0.5;
  assert.equal(reconnectDelayMs(1, 3, mid), 80000);
  assert.equal(reconnectDelayMs(1, 20, mid), 30 * 60000);
});

test('reconexiones: el azar queda en ±20 %', () => {
  assert.equal(reconnectDelayMs(1, 1, () => 0), 16000);
  assert.equal(reconnectDelayMs(1, 1, () => 1), 24000);
});
