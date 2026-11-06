# FILO en la API oficial de WhatsApp (Meta Tech Provider)

Mismos pasos que la guía de FiloCars (`filocars/docs/whatsapp-meta.md`), con los datos de FILO. La verificación del negocio se hace una sola vez en el portfolio: la app de FiloCars se crea después en el mismo portfolio y no hay que volver a verificar.

## Datos para cargar en Meta

| Campo | Valor |
|---|---|
| Nombre de la app | FILO |
| Email de contacto | serviciosfilocrm@gmail.com |
| Portfolio comercial | FILO |
| Dominio de la app | `filocrm.com.ar` |
| Política de privacidad | `https://filocrm.com.ar/privacidad` |
| Condiciones del servicio | `https://filocrm.com.ar/terminos` |
| Instrucciones para eliminar datos | `https://filocrm.com.ar/eliminar-datos` |
| Ícono (1024×1024) | `backend/src/public/icon-1024.png` (también en `https://filocrm.com.ar/icon-1024.png`) |
| Categoría | Negocios y páginas |
| Webhook | `https://filocrm.com.ar/api/whatsapp/webhook` (campo: **messages**) |

## Verificación del negocio

- **Nombre legal:** Ian Mena (tiene que coincidir con la constancia de ARCA y con `/legal`, sección Contacto).
- **Dirección:** Ruta Provincial 58 km 14, San Vicente, Provincia de Buenos Aires (la de `/legal`; tiene que coincidir con la constancia o con el comprobante de dirección).
- **Sitio web:** `https://filocrm.com.ar`.
- **Documentos:** constancia de CUIT de ARCA y un comprobante con la dirección.
- **Confirmación de contacto:** como FILO tiene dominio propio, además del teléfono Meta puede ofrecer verificar el dominio (registro DNS o etiqueta meta en la web). Si elegís eso, pasame el código que te da Meta y lo agrego.

## Variables en Railway (servicio filocrm1)

| Variable | Valor |
|---|---|
| `META_APP_SECRET` | Clave secreta de la app (Configuración → Básica). Cargala vos, no la pases por chat. |
| `WHATSAPP_VERIFY_TOKEN` | Una contraseña larga inventada; la misma que ponés al configurar el webhook. |

## Videos y App Review

Igual que en la guía de FiloCars. Textos para los permisos:

**whatsapp_business_messaging**

> FILO is a management software for barbershops in Argentina (appointments, online booking, customers and cash). Barbershops connect their own WhatsApp Business number to FILO so they can answer customer inquiries and bookings from FILO, optionally with an automated assistant configured by the barbershop, and send notifications customers expect, such as appointment confirmations and reminders. Messages are only sent to the barbershop's own customers. The video shows a message sent through the API arriving on WhatsApp.

**whatsapp_business_management**

> Barbershops onboard their WhatsApp Business Account to FILO through Embedded Signup. FILO needs this permission to read the connected phone numbers and manage the barbershop's message templates (appointment reminders and confirmations) from inside the app, so barbershops don't need to use WhatsApp Manager directly. The video shows a utility message template being created.

Plantilla de ejemplo para el video 2 (categoría **Utilidad**, Español ARG): `recordatorio_turno` — `Hola {{1}}, te recordamos tu turno en {{2}} el {{3}} a las {{4}}. Si no podés venir, respondé este mensaje.`

## Qué hay en el código

- `src/routes/whatsappOfficial.js`: verificación del webhook y firma `X-Hub-Signature-256`; guarda cada evento en `whatsapp_official_events` (migración 058).
- La vinculación por QR (`services/whatsapp.js`) sigue igual: las barberías conectadas no se tocan.
