'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseServiceIds, __test: { comboFromRows } } = require('../src/services/serviceCombo');

const rows = [
  { id: 1, name: 'Corte', price: '10000', cost: '500', duration_minutes: 30, commission_pct: null },
  { id: 2, name: 'Barba', price: '5000', cost: '200', duration_minutes: 20, commission_pct: null },
  { id: 3, name: 'Color', price: '20000', cost: '3000', duration_minutes: 60, commission_pct: 30 },
];

test('lee los servicios elegidos (lista, texto o uno solo)', () => {
  assert.deepStrictEqual(parseServiceIds({ service_ids: [2, '1', 2, 'x', 0] }), [2, 1]);
  assert.deepStrictEqual(parseServiceIds({ service_ids: '3,1' }), [3, 1]);
  assert.deepStrictEqual(parseServiceIds({ service_id: '5' }), [5]);
  assert.deepStrictEqual(parseServiceIds({}), []);
  assert.strictEqual(parseServiceIds({ service_ids: Array.from({ length: 30 }, (_, i) => i + 1) }).length, 10);
});

test('suma nombre, precio, costo y duración en el orden elegido', () => {
  const c = comboFromRows([2, 1], rows);
  assert.strictEqual(c.name, 'Barba + Corte');
  assert.strictEqual(c.price, 15000);
  assert.strictEqual(c.cost, 700);
  assert.strictEqual(c.duration, 50);
  assert.strictEqual(c.firstId, 2);
  assert.deepStrictEqual(c.ids, [2, 1]);
  assert.strictEqual(c.hasCustom, false);
  assert.strictEqual(c.commissionFor(50), 50);
});

test('comisión ponderada por precio si algún servicio tiene la suya', () => {
  const c = comboFromRows([1, 3], rows);           // 10000 al 50% + 20000 al 30%
  assert.strictEqual(c.hasCustom, true);
  assert.strictEqual(c.commissionFor(50), 37);      // (5000 + 6000) / 30000 = 36,67%
  assert.strictEqual(comboFromRows([3], rows).commissionFor(50), 30);
});

test('ignora servicios que no existen', () => {
  assert.strictEqual(comboFromRows([99], rows), null);
  assert.deepStrictEqual(comboFromRows([1, 99], rows).ids, [1]);
});
