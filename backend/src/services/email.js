const { Resend } = require('resend');

// Lazy init para no crashear al cargar si falta RESEND_API_KEY (p.ej. en tests o builds locales)
let _resend = null;
function resend() {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY no configurada — no se pueden enviar emails');
    }
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}
// RESEND_FROM debe apuntar a un dominio verificado en Resend.
// Mientras no esté verificado filocrm.com.ar, usar onboarding@resend.dev (funciona sin verificación).
const FROM   = process.env.RESEND_FROM || 'onboarding@resend.dev';

// Mail con un código de 6 dígitos. Por defecto es el de verificación de cuenta; `opts` cambia
// los textos (p.ej. recuperación de contraseña).
function verificationHtml(name, code, opts = {}) {
  const title  = opts.title  || 'Verificá tu cuenta FILO';
  const intro  = opts.intro  || 'Tu cuenta FILO fue creada. Para activarla ingresá el siguiente código de verificación:';
  const label  = opts.label  || 'Código de verificación';
  const footer = opts.footer || 'Si no creaste esta cuenta podés ignorar este email.';
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#050d18;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#050d18;padding:40px 20px;">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:#0a1828;border:1px solid rgba(255,209,0,.15);border-radius:16px;overflow:hidden;">

      <!-- Header -->
      <tr>
        <td style="background:linear-gradient(135deg,#0d2040,#060f20);padding:32px 40px;text-align:center;border-bottom:1px solid rgba(255,209,0,.1);">
          <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-weight:900;font-size:28px;letter-spacing:3px;color:#FFD100;">FILO</div>
          <div style="font-size:10px;letter-spacing:4px;color:rgba(255,209,0,.5);margin-top:2px;">CRM</div>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="padding:40px 40px 32px;">
          <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#f0f6ff;">Hola, ${name} 👋</p>
          <p style="margin:0 0 32px;font-size:15px;color:#6a8aa8;line-height:1.6;">
            ${intro}
          </p>

          <!-- Code box -->
          <div style="background:#050d18;border:1px solid rgba(255,209,0,.25);border-radius:12px;padding:28px;text-align:center;margin-bottom:32px;">
            <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#5a7090;margin-bottom:12px;">${label}</div>
            <div style="font-family:'Courier New',monospace;font-size:48px;font-weight:900;letter-spacing:10px;color:#FFD100;">${code}</div>
            <div style="font-size:12px;color:#3a5070;margin-top:12px;">Válido por 15 minutos</div>
          </div>

          <p style="margin:0;font-size:13px;color:#3a5070;line-height:1.6;">
            ${footer}
          </p>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,.05);text-align:center;">
          <p style="margin:0;font-size:12px;color:#2a4060;letter-spacing:1px;">FILO CRM · filocrm.com.ar</p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

async function sendVerificationEmail(email, name, code) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(`[EMAIL] RESEND_API_KEY no configurada — código ${code} para ${email}`);
    return;
  }
  try {
    await resend().emails.send({
      from:    FROM,
      to:      email,
      subject: `${code} — Tu código de verificación FILO`,
      html:    verificationHtml(name, code),
    });
    console.log(`[EMAIL] Verificación enviada a ${email}`);
  } catch (e) {
    console.error(`[EMAIL] Error enviando a ${email}:`, e.message);
    throw e;
  }
}

async function sendPasswordResetEmail(email, name, code) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(`[EMAIL] RESEND_API_KEY no configurada — código de recuperación para ${email} no enviado`);
    return;
  }
  await resend().emails.send({
    from:    FROM,
    to:      email,
    subject: `${code} — Código para cambiar tu contraseña de FILO`,
    html:    verificationHtml(name, code, {
      title:  'Cambiá tu contraseña de FILO',
      intro:  'Pediste cambiar la contraseña de tu cuenta FILO. Ingresá este código en la pantalla de recuperación y elegí una contraseña nueva:',
      label:  'Código para cambiar la contraseña',
      footer: 'Si no lo pediste vos, ignorá este email: tu contraseña sigue siendo la misma.',
    }),
  });
  console.log(`[EMAIL] Código de recuperación enviado a ${email}`);
}

// Botón de arrepentimiento: constancia para quien lo pidió + aviso al equipo de FILO
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'serviciosfilocrm@gmail.com';
const esc = (s) => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function sendRevocationEmails({ code, name, email, phone, reason, shopId, createdAt }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(`[EMAIL] RESEND_API_KEY no configurada — constancia ${code} no enviada`);
    return;
  }
  const when = new Date(createdAt || Date.now()).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  await resend().emails.send({
    from: FROM, to: email,
    subject: `Recibimos tu pedido de arrepentimiento · ${code}`,
    html: verificationHtml(esc(name), esc(code), {
      title:  'Pedido de arrepentimiento recibido',
      intro:  `Recibimos tu pedido para revocar la contratación de FILO (${esc(when)}). Este es tu código de constancia. Te vamos a contactar a este email para completar la devolución.`,
      label:  'Código de constancia',
      footer: 'Si no hiciste este pedido, respondé este email y lo anulamos.',
    }),
  });
  await resend().emails.send({
    from: FROM, to: SUPPORT_EMAIL, replyTo: email,
    subject: `↩️ Arrepentimiento ${code} — ${name}`,
    html: `<p><strong>Pedido de arrepentimiento</strong> ${esc(code)} · ${esc(when)}</p>
      <p>Nombre: ${esc(name)}<br>Email: ${esc(email)}<br>Teléfono: ${esc(phone) || '—'}<br>Cuenta FILO: ${shopId ? '#' + shopId : 'no encontrada con ese email'}</p>
      <p>Motivo: ${esc(reason) || '—'}</p>
      <p>Plazo legal: revocar y devolver lo pagado si el pedido está dentro de los 10 días corridos desde el pago.</p>`,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendRevocationEmails };
