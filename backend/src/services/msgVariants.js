// Variantes de redacción para los mensajes automáticos: mandar el mismo texto idéntico a
// muchos clientes se parece a spam. Cada mensaje sale con una redacción distinta.
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function reminderText({ nombre, hora, shop }) {
  const greet = pick([`¡Hola ${nombre}! 👋`, `Hola ${nombre} 👋`, `¡Buenas ${nombre}! 👋`, `Hola ${nombre}, ¿cómo andás? 👋`]);
  const body  = pick([
    `Te recordamos tu turno de hoy a las *${hora}* en ${shop}.`,
    `Te escribimos para recordarte tu turno de hoy a las *${hora}* en ${shop}.`,
    `Hoy a las *${hora}* tenés turno en ${shop}.`,
    `Un recordatorio de tu turno de hoy a las *${hora}* en ${shop}.`,
  ]);
  const close = pick(['¡Te esperamos! ✂️', '¡Nos vemos! ✂️', 'Te esperamos. 💈', '¡Los esperamos! ✂️']);
  return `${greet}\n\n${body} ${close}`;
}

function bookingText({ nombre, shop, fecha, hora, servicio }) {
  const svc = servicio ? ` (${servicio})` : '';
  return pick([
    `✅ ¡Hola ${nombre}! Tu turno en ${shop} está confirmado para el ${fecha} a las ${hora}${svc}. ¡Te esperamos! ✂️`,
    `✅ Listo ${nombre}, quedó reservado tu turno en ${shop}: ${fecha} a las ${hora}${svc}. ¡Nos vemos! ✂️`,
    `¡Hola ${nombre}! 👋 Confirmamos tu turno en ${shop} el ${fecha} a las ${hora}${svc}. ¡Te esperamos! 💈`,
    `✅ ${nombre}, tu turno en ${shop} quedó agendado para el ${fecha} a las ${hora}${svc}. ¡Hasta pronto! ✂️`,
  ]);
}

module.exports = { pick, reminderText, bookingText };
