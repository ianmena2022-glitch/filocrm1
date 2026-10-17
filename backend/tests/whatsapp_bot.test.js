// Unit tests para los helpers puros del bot de WhatsApp, AI y scheduler.
// Correr: `node --test backend/tests/whatsapp_bot.test.js`
const test   = require('node:test');
const assert = require('node:assert/strict');

// Evitar que modulos que requieren `pool` intenten conectarse a Postgres:
// basta con tener (vacío o no) DATABASE_URL en env — pool.js no abre socket hasta query.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://dummy@localhost:1/x';

const ai        = require('../src/services/ai');
const wpp       = require('../src/services/whatsapp');
const scheduler = require('../src/services/scheduler');

// ─── renderTemplate ────────────────────────────────────────────────────────
test('renderTemplate — reemplaza simple', () => {
  const out = wpp.renderTemplate('Hola {nombre}, tu turno es a las {hora}', { nombre: 'Juan', hora: '15:30' });
  assert.equal(out, 'Hola Juan, tu turno es a las 15:30');
});

test('renderTemplate — case insensitive', () => {
  const out = wpp.renderTemplate('{Nombre} {NOMBRE} {nombre}', { nombre: 'X' });
  assert.equal(out, 'X X X');
});

test('renderTemplate — múltiples ocurrencias (flag g)', () => {
  const out = wpp.renderTemplate('{a} {a} {a}', { a: 'z' });
  assert.equal(out, 'z z z');
});

test('renderTemplate — variables sin resolver se limpian (no quedan literales)', () => {
  // Fix del bug "{clientname}" apareciendo en WhatsApp al cliente
  const out = wpp.renderTemplate('Hola {clientname}, saludos', { nombre: 'Ian' });
  assert.ok(!out.includes('{clientname}'), 'variable sin resolver debería eliminarse');
  assert.ok(out.includes('Hola'));
  assert.ok(out.includes('saludos'));
});

test('renderTemplate — valor null se reemplaza por string vacío (no "null")', () => {
  const out = wpp.renderTemplate('Hola {nombre}!', { nombre: null });
  assert.equal(out, 'Hola !');
});

test('renderTemplate — tpl vacío devuelve string vacío', () => {
  assert.equal(wpp.renderTemplate('', { a: 'b' }), '');
  assert.equal(wpp.renderTemplate(null, { a: 'b' }), '');
});

// ─── normalizePhoneAR ──────────────────────────────────────────────────────
test('normalizePhoneAR — 10 dígitos (sin país) → prepende 549', () => {
  assert.equal(wpp.normalizePhoneAR('1123456789'), '5491123456789');
});

test('normalizePhoneAR — ya tiene 549', () => {
  assert.equal(wpp.normalizePhoneAR('5491123456789'), '5491123456789');
});

test('normalizePhoneAR — 54 sin 9 → inserta 9', () => {
  assert.equal(wpp.normalizePhoneAR('541123456789'), '5491123456789');
});

test('normalizePhoneAR — con guiones y espacios', () => {
  assert.equal(wpp.normalizePhoneAR('11-2345-6789'), '5491123456789');
  assert.equal(wpp.normalizePhoneAR('+54 9 11 2345-6789'), '5491123456789');
});

test('normalizePhoneAR — string vacío o null', () => {
  assert.equal(wpp.normalizePhoneAR(''), '');
  assert.equal(wpp.normalizePhoneAR(null), '');
  assert.equal(wpp.normalizePhoneAR('abc'), '');
});

// ─── looksLikeBarberia ─────────────────────────────────────────────────────
test('looksLikeBarberia — keywords de turno', () => {
  for (const t of ['quiero un turno', 'cuánto sale el corte', 'tienen hora libre?', 'reservar para mañana']) {
    assert.ok(ai.looksLikeBarberia(t), `debería matchear: "${t}"`);
  }
});

test('looksLikeBarberia — pregunta genérica (contiene ?)', () => {
  assert.ok(ai.looksLikeBarberia('tienen estacionamiento?'));
});

test('looksLikeBarberia — hora detectada', () => {
  assert.ok(ai.looksLikeBarberia('15:30?'));
  assert.ok(ai.looksLikeBarberia('a las 18h'));
});

test('looksLikeBarberia — confirmaciones cortas comunes', () => {
  assert.ok(ai.looksLikeBarberia('ok'));
  assert.ok(ai.looksLikeBarberia('dale'));
  assert.ok(ai.looksLikeBarberia('gracias'));
});

test('looksLikeBarberia — chatarra no matchea', () => {
  assert.equal(ai.looksLikeBarberia('jaja xd'), false);
  assert.equal(ai.looksLikeBarberia(''), false);
});

// ─── checkRateLimit (3 estados: ok / warn / silent) ────────────────────────
test('checkRateLimit — permite hasta 15 llamadas, después warn y luego silent', () => {
  ai._testReset();
  const shopId = 999;
  const phone  = '5491199999999';
  for (let i = 0; i < 15; i++) {
    assert.equal(ai.checkRateLimit(shopId, phone), 'ok', `llamada ${i+1} debería ser ok`);
  }
  // 16ª: primera vez que satura → warn
  assert.equal(ai.checkRateLimit(shopId, phone), 'warn');
  // 17ª y siguientes dentro de la misma ventana → silent (no spam)
  assert.equal(ai.checkRateLimit(shopId, phone), 'silent');
  assert.equal(ai.checkRateLimit(shopId, phone), 'silent');
});

test('checkRateLimit — shops diferentes no comparten contador', () => {
  ai._testReset();
  for (let i = 0; i < 15; i++) ai.checkRateLimit(1, 'x');
  assert.equal(ai.checkRateLimit(1, 'x'), 'warn');
  assert.equal(ai.checkRateLimit(2, 'x'), 'ok'); // shop 2 arranca limpio
});

// ─── getLastUserMessage ────────────────────────────────────────────────────
test('getLastUserMessage — devuelve null si no hay conversación', () => {
  ai._testReset();
  assert.equal(ai.getLastUserMessage(1, '549111'), null);
});

test('getLastUserMessage — devuelve último user msg (ignora assistants pushed)', () => {
  ai._testReset();
  ai._testPushUserMessage(5, '5491122334455', 'primer mensaje');
  ai._testPushUserMessage(5, '5491122334455', 'segundo mensaje');
  assert.equal(ai.getLastUserMessage(5, '5491122334455'), 'segundo mensaje');
});

// ─── scheduler timezone ────────────────────────────────────────────────────
test('nowInTz — devuelve fecha en formato YYYY-MM-DD', () => {
  const now = scheduler.nowInTz('America/Argentina/Buenos_Aires');
  assert.match(now.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(now.hours >= 0 && now.hours < 24);
  assert.ok(now.minutes >= 0 && now.minutes < 60);
});

test('nowInTz — tz inválida cae en fallback AR sin romper', () => {
  const now = scheduler.nowInTz('No/Existe/Tz');
  assert.match(now.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('yesterdayInTz — ayer siempre es anterior a hoy', () => {
  const today     = scheduler.nowInTz('America/Argentina/Buenos_Aires').date;
  const yesterday = scheduler.yesterdayInTz('America/Argentina/Buenos_Aires');
  assert.ok(yesterday < today, `${yesterday} debería ser < ${today}`);
});

test('nowInTz — diferentes zonas pueden dar fechas distintas si está cerca de medianoche', () => {
  // Smoke test: ambas devuelven algo válido, no comparten estado
  const ar = scheduler.nowInTz('America/Argentina/Buenos_Aires');
  const mx = scheduler.nowInTz('America/Mexico_City');
  const tk = scheduler.nowInTz('Asia/Tokyo');
  assert.match(ar.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(mx.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(tk.date, /^\d{4}-\d{2}-\d{2}$/);
});

// ─── test de recuperación de last message (para Baileys.getMessage) ───────
test('getLastUserMessage — serviría a Baileys.getMessage para re-descifrar', () => {
  ai._testReset();
  ai._testPushUserMessage(10, '5491188776655', 'hola, quería un turno');
  const last = ai.getLastUserMessage(10, '5491188776655');
  assert.ok(last && last.includes('turno'));
});
