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

module.exports = { phoneKey, phoneMatchSql };
