// Un mismo cliente puede tener el teléfono guardado de varias formas (+54 9 11 2345-6789,
// 5491123456789, 541123456789, 1123456789). Para reconocerlo se comparan los últimos 10 dígitos
// (código de área + número en Argentina), sin espacios, guiones ni prefijos.
function phoneKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-10) : null;
}

// Condición SQL: la columna `col` corresponde al teléfono cuya clave (phoneKey) va en `param`.
// Si la clave tiene menos de 10 dígitos (número cargado sin código de área) se comparan esos.
function phoneMatchSql(col, param) {
  return `right(regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g'), length(${param}::text)) = ${param}::text`;
}

// Varias personas pueden compartir un número (ej: Pablo Lescano y su hijo Santino usan el del papá).
// Para saber si una ficha con ese número es la misma persona se compara el nombre: sin mayúsculas,
// tildes ni espacios de más, y alcanza con que las palabras del nombre más corto estén en el otro
// ("Pablo" = "Pablo Lescano", pero "Santino Lescano" ≠ "Pablo Lescano").
function nameWords(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9ñ ]/g, ' ')
    .split(/\s+/).filter(Boolean);
}
function sameName(a, b) {
  const wa = nameWords(a), wb = nameWords(b);
  if (!wa.length || !wb.length) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const set = new Set(long);
  return short.every(w => set.has(w));
}
// De las fichas que comparten número, la que corresponde a ese nombre (o null si es otra persona)
function pickByName(rows, name) {
  return rows.find(r => sameName(r.name, name)) || null;
}

// ── Páginas públicas (reservar / fila): "¿Quién sos?" ────────────────────────
// Si el número ya está en una o más fichas, la página pregunta a quién es el turno y manda
// `client_choice`: el id de una de esas fichas o 'new' (otra persona, ficha nueva con ese número).

// Fichas del local con ese número
async function clientsByPhone(db, shopId, phone) {
  const key = phoneKey(phone);
  if (!key) return [];
  const r = await db.query(
    `SELECT id, name FROM clients WHERE shop_id=$1 AND ${phoneMatchSql('phone', '$2')}
      ORDER BY total_visits DESC NULLS LAST, id`,
    [shopId, key]
  );
  return r.rows;
}

// Con un número ajeno no se tiene que poder ver el nombre completo: nombre de pila + inicial ("Pablo L.")
function shortName(name) {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return 'Sin nombre';
  return w[0] + (w[1] ? ' ' + w[1][0].toUpperCase() + '.' : '');
}

// Respuesta 409 que hace que la página muestre el pop-up
function whoIsResponse(rows) {
  return {
    code: 'WHO_IS',
    error: 'Ese número ya está registrado. Elegí quién sos.',
    options: rows.map(r => ({ id: r.id, name: shortName(r.name) })),
  };
}

// Lo que eligió la página: { pending: true } si todavía no preguntó, { client } si es una ficha
// de ese número, { isNew: true } si es otra persona. Un id que no es de ese número se ignora.
function readChoice(rows, choice) {
  if (!rows.length) return { isNew: true };
  if (choice === 'new') return { isNew: true };
  const id = parseInt(choice);
  if (id) {
    const client = rows.find(r => r.id === id);
    if (client) return { client };
  }
  return { pending: true };
}

module.exports = {
  phoneKey, phoneMatchSql, sameName, pickByName,
  clientsByPhone, shortName, whoIsResponse, readChoice,
};
