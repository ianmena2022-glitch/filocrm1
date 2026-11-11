'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { buildXlsx, __test: { crc32, colName, excelDate, esc } } = require('../src/services/xlsx');

// Lee el ZIP a mano (directorio central) y devuelve { nombre: contenido }
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const comp = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lName = buf.readUInt16LE(off + 26), lExtra = buf.readUInt16LE(off + 28);
    const data = zlib.inflateRawSync(buf.slice(off + 30 + lName + lExtra, off + 30 + lName + lExtra + comp));
    assert.strictEqual(crc32(data), buf.readUInt32LE(p + 16), 'CRC de ' + name);
    out[name] = data.toString('utf8');
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

test('crc32 y nombres de columna', () => {
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.deepStrictEqual([0, 25, 26, 27, 701, 702].map(colName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
});

test('fechas en formato Excel', () => {
  assert.strictEqual(excelDate('2000-01-01'), 36526);
  assert.strictEqual(excelDate('2000-01-01 12:00:00', true), 36526.5);
  assert.strictEqual(excelDate('cualquier cosa'), null);
});

test('arma el archivo con las hojas y escapa los textos', () => {
  const buf = buildXlsx([
    { name: 'Clientes', columns: [{ header: 'Nombre' }, { header: 'Gastado', type: 'money' }, { header: 'Alta', type: 'date' }],
      rows: [['Ana <José> & "Cía"', 1500.5, '2026-11-10'], ['=HYPERLINK("x")', null, null], ['con\u0007control', '12', 'mal']] },
    { name: 'Hoja/rara:con*caracteres?[que no van]', columns: [{ header: 'X' }], rows: [] },
  ]);
  const files = unzip(buf);
  assert.ok(files['xl/workbook.xml'].includes('name="Clientes"'));
  assert.ok(!/name="[^"]*[:\\/?*[\]]/.test(files['xl/workbook.xml']), 'nombre de hoja sin caracteres prohibidos');
  const s1 = files['xl/worksheets/sheet1.xml'];
  assert.ok(s1.includes('Ana &lt;José&gt; &amp; &quot;Cía&quot;'));
  assert.ok(!s1.includes('<f>'), 'nunca escribe fórmulas');
  assert.ok(s1.includes('=HYPERLINK(&quot;x&quot;)'), 'el "=" queda como texto');
  assert.ok(!s1.includes('\u0007'));
  assert.ok(s1.includes('<c r="B2" s="4"><v>1500.5</v></c>'));
  assert.ok(s1.includes('<c r="C2" s="2"><v>46336</v></c>'));
  assert.ok(s1.includes('<c r="B4" s="4"><v>12</v></c>'));
  assert.ok(s1.includes('<c r="C4" t="inlineStr"><is><t xml:space="preserve">mal</t></is></c>'), 'fecha inválida queda como texto');
  assert.strictEqual(esc('a\u0000b'), 'ab');
});
