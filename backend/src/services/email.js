const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
// RESEND_FROM debe apuntar a un dominio verificado en Resend.
// Mientras no esté verificado filocrm.com.ar, usar onboarding@resend.dev (funciona sin verificación).
const FROM   = process.env.RESEND_FROM || 'onboarding@resend.dev';

function verificationHtml(name, code) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Verificá tu cuenta FILO</title>
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
            Tu cuenta FILO fue creada. Para activarla ingresá el siguiente código de verificación:
          </p>

          <!-- Code box -->
          <div style="background:#050d18;border:1px solid rgba(255,209,0,.25);border-radius:12px;padding:28px;text-align:center;margin-bottom:32px;">
            <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#5a7090;margin-bottom:12px;">Código de verificación</div>
            <div style="font-family:'Courier New',monospace;font-size:48px;font-weight:900;letter-spacing:10px;color:#FFD100;">${code}</div>
            <div style="font-size:12px;color:#3a5070;margin-top:12px;">Válido por 15 minutos</div>
          </div>

          <p style="margin:0;font-size:13px;color:#3a5070;line-height:1.6;">
            Si no creaste esta cuenta podés ignorar este email.
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
    await resend.emails.send({
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

module.exports = { sendVerificationEmail };
