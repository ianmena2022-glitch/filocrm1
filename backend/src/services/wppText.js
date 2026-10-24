// Utilidades de texto de WhatsApp que no necesitan la conexión (las usa la app principal y el
// servicio de WhatsApp).

// Normaliza un teléfono AR al formato E.164 sin '+' (549 + area + número).
// Acepta variantes comunes y devuelve string con solo dígitos.
function normalizePhoneAR(phone) {
  if (phone == null) return '';
  let p = String(phone).replace(/\D/g, '');
  if (!p) return '';
  if (p.length === 10) p = '549' + p;                               // 1123456789 → 5491123456789
  else if (p.length === 11 && p.startsWith('15')) p = '54911' + p.slice(2);
  else if (p.length === 12 && p.startsWith('54')) p = '549' + p.slice(2); // 54XXXXXXXXXX → 549XXXXXXXXXX
  return p;
}

// Renderiza un template "Hola {nombre}, tu turno {fecha}" reemplazando case-insensitive
// y globalmente las claves. Toda {variable} que no haya sido pasada se elimina del texto
// para no mostrar "{clientname}" literal al cliente.
function renderTemplate(tpl, vars) {
  if (!tpl) return '';
  let out = String(tpl);
  for (const k of Object.keys(vars || {})) {
    const re = new RegExp('\\{' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\}', 'gi');
    out = out.replace(re, vars[k] == null ? '' : String(vars[k]));
  }
  // Limpiar variables sin resolver + espacios dobles / salto de línea triple
  out = out.replace(/\{[^{}]{1,40}\}/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

module.exports = { normalizePhoneAR, renderTemplate };
