// Avisos a cuentas en prueba que no arrancan: qué aviso le toca a cada cuenta y cómo se arma el texto.
// Correr: `node --test backend/tests/trialNudges.test.js`
const test   = require('node:test');
const assert = require('node:assert/strict');
const { pickNudge, adminAlerts, render } = require('../src/services/trialNudges');

const DAY = 86400000;
const NOW = Date.parse('2026-11-23T15:00:00Z');
const base = (o = {}) => ({
  name: 'Barbería X', subscription_status: 'trial',
  created_at: new Date(NOW - 2 * DAY).toISOString(),
  trial_ends_at: new Date(NOW + 5 * DAY).toISOString(),
  expired_at: null, first_payment_at: null,
  own_services: 0, has_schedule: false, online_booking: false, appts_count: 0,
  booking_slug: 'barberia-x', ...o,
});

test('cuenta recién creada (menos de 1 día): nada', () => {
  assert.equal(pickNudge(base({ created_at: new Date(NOW - 5 * 3600000).toISOString() }), NOW), null);
});

test('día 1 sin servicios ni horarios: setup', () => {
  assert.equal(pickNudge(base(), NOW), 'setup');
});

test('día 1 con servicios y horarios: nada', () => {
  assert.equal(pickNudge(base({ own_services: 3, has_schedule: true }), NOW), null);
});

test('día 3 sin turnos online: no_bookings (y alerta al admin)', () => {
  const r = base({ created_at: new Date(NOW - 3.2 * DAY).toISOString(), own_services: 2, has_schedule: true });
  assert.equal(pickNudge(r, NOW), 'no_bookings');
  assert.deepEqual(adminAlerts(r, NOW), ['no_bookings']);
});

test('día 3 con turnos online: nada', () => {
  const r = base({ created_at: new Date(NOW - 4 * DAY).toISOString(), own_services: 2, has_schedule: true, online_booking: true });
  assert.equal(pickNudge(r, NOW), null);
  assert.deepEqual(adminAlerts(r, NOW), []);
});

test('faltan 2 días: ending tiene prioridad', () => {
  const r = base({ created_at: new Date(NOW - 6 * DAY).toISOString(), trial_ends_at: new Date(NOW + 1.5 * DAY).toISOString() });
  assert.equal(pickNudge(r, NOW), 'ending');
  assert.deepEqual(adminAlerts(r, NOW), ['ending']);
});

test('prueba vencida hace 1 día sin haber pagado: expired', () => {
  const r = base({ subscription_status: 'expired', expired_at: new Date(NOW - DAY).toISOString() });
  assert.equal(pickNudge(r, NOW), 'expired');
  assert.deepEqual(adminAlerts(r, NOW), []);
});

test('vencida hace más de 3 días o que ya pagó alguna vez: nada', () => {
  assert.equal(pickNudge(base({ subscription_status: 'expired', expired_at: new Date(NOW - 4 * DAY).toISOString() }), NOW), null);
  assert.equal(pickNudge(base({ subscription_status: 'expired', expired_at: new Date(NOW - DAY).toISOString(), first_payment_at: '2026-10-01' }), NOW), null);
});

test('cuenta activa (pagando): nada', () => {
  assert.equal(pickNudge(base({ subscription_status: 'active' }), NOW), null);
});

test('{resumen} cambia si no cargó ningún turno', () => {
  assert.equal(render('{resumen}', base({ appts_count: 7 }), NOW), 'Hasta ahora cargaste 7 turnos.');
  assert.equal(render('{resumen}', base({ appts_count: 1 }), NOW), 'Hasta ahora cargaste 1 turno.');
  const cero = render('{resumen}', base({ appts_count: 0 }), NOW);
  assert.doesNotMatch(cero, /0 turnos/);
  assert.match(cero, /configuramos juntos/);
  assert.match(cero, /días más de prueba/);
});

test('render reemplaza las variables', () => {
  const r = base({ appts_count: 7, trial_ends_at: new Date(NOW + 1.2 * DAY).toISOString() });
  const t = render('Hola {nombre}: {turnos} turnos, termina {cuando}. {link_reservas} · {link}', r, NOW);
  assert.match(t, /^Hola Barbería X: 7 turnos, termina en 2 días\. https?:\/\/\S+\/reservar\/barberia-x · https?:\/\/\S+\/app$/);
  assert.match(render('{cuando}', base({ trial_ends_at: new Date(NOW + 0.5 * DAY).toISOString() }), NOW), /^mañana$/);
});
