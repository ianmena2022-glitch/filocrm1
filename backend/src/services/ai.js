const pool = require('../db/pool');

// Historial de conversaciones en memoria
const conversations  = {};
const lastActivity   = {};
const CONVERSATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos

// Rate limiting: máx mensajes por ventana de tiempo
const rateLimiter = {};
const RATE_LIMIT_MAX = 6;     // máx respuestas
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // por 5 minutos

function checkRateLimit(shopId, phone) {
  const key = `${shopId}:${phone}`;
  const now = Date.now();
  if (!rateLimiter[key]) rateLimiter[key] = [];
  // limpiar entradas viejas
  rateLimiter[key] = rateLimiter[key].filter(t => now - t < RATE_LIMIT_WINDOW);
  if (rateLimiter[key].length >= RATE_LIMIT_MAX) return false;
  rateLimiter[key].push(now);
  return true;
}

function hasActiveConversation(shopId, phone) {
  const key = `${shopId}:${phone}`;
  if (!conversations[key] || conversations[key].length === 0) return false;
  if (Date.now() - (lastActivity[key] || 0) > CONVERSATION_TIMEOUT_MS) {
    delete conversations[key];
    delete lastActivity[key];
    return false;
  }
  return true;
}

// [D] fetch con timeout vía AbortController
async function fetchWithTimeout(url, options, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timeout Groq (>${timeoutMs / 1000}s)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Clasificación contextual con IA
// strict=true: solo responder si intención clara (primer mensaje)
// strict=false: también responder si hay contexto activo (follow-up dentro conversación)
async function isBarberiaRelated(text, apiKey, strict = true) {
  // Filtros rápidos sin LLM — casos obvios que nunca deben disparar el bot
  const t = text.trim();
  if (t.length <= 3) return false; // "ok", "👍", "si"
  // Solo emojis
  if (/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s]+$/u.test(t)) return false;
  // Números solos (que no sean precios ni horarios)
  if (/^\d{1,4}$/.test(t)) return false;

  try {
    const systemPrompt = strict
      ? `Sos un clasificador ESTRICTO para una barbería. Respondé "true" SOLO si el mensaje tiene una intención EXPLÍCITA Y CLARA de: pedir o consultar turno, preguntar precios/servicios/horarios/ubicación, cancelar turno, consultar puntos/premios.

SIEMPRE respondé "false" para: saludos solos ("hola", "buenas", "hey", "buen día"), "ok", "gracias", "jaja", conversación casual, mensajes cortos sin contexto, preguntas o temas que no son de barbería, mensajes ambiguos.

Ante la duda: "false". Respondé ÚNICAMENTE "true" o "false".`
      : `Sos un clasificador para una barbería. Ya hay una conversación activa. Respondé "false" SOLO si el mensaje claramente NO tiene nada que ver con una barbería ni con una conversación sobre turnos/servicios (ej: chistes, noticias, temas políticos, insultos, mensajes a otra persona).

En conversaciones activas, saludos y respuestas cortas como "ok", "gracias" o preguntas de seguimiento son "true".

Respondé ÚNICAMENTE "true" o "false".`;

    const response = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Mensaje: "${text}"` }
          ],
          max_tokens: 5,
          temperature: 0,
        })
      },
      8000
    );
    if (!response.ok) return false;
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim().toLowerCase();
    return answer === 'true';
  } catch (e) {
    console.error('[AI] Error clasificando mensaje:', e.message);
    return false;
  }
}

async function getShopContext(shopId) {
  try {
    const shop = await pool.query(
      'SELECT name, city, address, phone, booking_slug FROM shops WHERE id=$1',
      [shopId]
    );
    const services = await pool.query(
      'SELECT name, price, duration_minutes FROM services WHERE shop_id=$1 AND active=TRUE ORDER BY price',
      [shopId]
    );
    const shopData = shop.rows[0];
    const servicesList = services.rows
      .map(s => `- ${s.name}: $${parseFloat(s.price).toLocaleString('es-AR')} (${s.duration_minutes} min)`)
      .join('\n');
    const baseUrl = process.env.APP_URL || 'https://filocrm1-production.up.railway.app';
    const reservasLink = shopData.booking_slug ? `${baseUrl}/reservar/${shopData.booking_slug}` : null;
    const tiendaLink   = shopData.booking_slug ? `${baseUrl}/tienda/${shopData.booking_slug}`   : null;
    return { shopData, servicesList, reservasLink, tiendaLink };
  } catch (e) {
    console.error('getShopContext error:', e.message);
    return null;
  }
}

async function getClientContext(shopId, phone) {
  try {
    const phoneClean = phone.replace(/[^0-9]/g, '').slice(-10);
    const result = await pool.query(
      "SELECT name, points FROM clients WHERE shop_id=$1 AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE $2",
      [shopId, '%' + phoneClean]
    );
    return result.rows.length ? result.rows[0] : null;
  } catch (e) {
    console.error('getClientContext error:', e.message);
    return null;
  }
}

function buildSystemPrompt(shopCtx, client) {
  const { shopData, servicesList, reservasLink, tiendaLink } = shopCtx;
  const clientSection = client
    ? `\nCliente identificado: ${client.name} — tiene ${client.points} puntos ⭐${tiendaLink ? `\nLink tienda de premios: ${tiendaLink}` : ''}`
    : tiendaLink ? `\nSi pregunta por puntos: ${tiendaLink}` : '';

  return `Sos el asistente de ${shopData.name}, una barbería${shopData.city ? ` en ${shopData.city}` : ''}.
${shopData.address ? `📍 ${shopData.address}` : ''}${shopData.phone ? `\n📞 ${shopData.phone}` : ''}
${reservasLink ? `🔗 Reservas: ${reservasLink}` : ''}

✂️ Servicios:
${servicesList || '- Consultá con nosotros'}
${clientSection}

Sos amigable, cercano y usás emojis con criterio. Respondé en español, máximo 3 líneas, sin formalismos.
Si quiere turno → mandá el link. Si pregunta puntos → informá saldo y mandá link tienda.
Si no sabés algo → decí que consulte directo 📲. No inventes. Solo temas de la barbería.`.trim();
}

async function getProspectResponse(shopId, phone, userMessage, apiKey) {
  const prospectRes = await pool.query(
    'SELECT name, city, message_sent, conversation, reply_count FROM prospects WHERE shop_id=$1 AND phone=$2',
    [shopId, phone]
  );
  if (!prospectRes.rows.length) return null;
  const prospect = prospectRes.rows[0];

  const now = new Date().toISOString();
  const conv = Array.isArray(prospect.conversation) ? prospect.conversation : [];
  conv.push({ role: 'user', content: userMessage, ts: now });

  const systemPrompt = `Sos un representante comercial de FILO CRM (filocrm.com.ar), un sistema de gestión para barberías argentinas. Este prospecto respondió a tu mensaje de prospección. Tu objetivo es entender su negocio, recomendar el plan correcto y cerrar la prueba gratuita.

== PLANES ==
- Starter ($40.000/mes): para barberos que trabajan solos. Incluye agenda online con reservas automáticas, cobros con QR, fidelización de clientes con puntos y WhatsApp integrado.
- Staff ($80.000/mes): para barberías con 2 o más barberos. Todo lo de Starter más panel de barberos con comisiones automáticas, fila virtual, membresías y múltiples agendas.
- Enterprise ($130.000/mes): para cadenas o franquicias con varias sucursales. Todo lo de Staff más reportes avanzados, multi-sucursal y panel de vendedor.

== VENTAJAS CLAVE ==
- 7 días de prueba gratis, sin tarjeta de crédito
- Se paga con QR, sin complicaciones
- WhatsApp integrado para confirmar turnos y fidelizar clientes automáticamente
- Reservas online con link propio que pueden compartir en Instagram o Google
- Los clientes acumulan puntos y vuelven solos

== CÓMO VENDER ==
1. Si no sabés si trabaja solo o tiene equipo → preguntalo de forma natural antes de recomendar un plan
2. Si trabaja solo → recomendá Starter
3. Si tiene 2+ barberos → recomendá Staff
4. Si tiene varias sucursales → recomendá Enterprise
5. Siempre cerrá invitando a arrancar la prueba gratis: filocrm.com.ar
6. Si preguntan por descuento o precio especial → deciles que por ahora el precio ya incluye todo sin costo extra de setup

== PSICOLOGÍA DE VENTAS — APLICÁ ESTAS TÉCNICAS ==
- Dolor antes que solución: antes de hablar de FILO, hacé que el prospecto sienta el problema (turnos sin confirmar, clientes que no vuelven, no saber cuánto ganó el mes). Una pregunta bien hecha vale más que un argumento.
- Pérdida > ganancia: "cada turno que no se confirma es plata que perdés" impacta más que "vas a ganar más".
- Prueba social: si el contexto lo permite, mencioná que ya hay barberías usando FILO en su ciudad o en Argentina.
- Escasez suave: la prueba gratuita es por tiempo limitado (7 días), usalo para generar urgencia sin presionar.
- Micro-compromisos: hacé preguntas fáciles primero ("¿cuántos barberos tienen?", "¿usás algo para gestionar los turnos?"). Cada "sí" chico acerca al "sí" grande.
- Espejo: si el prospecto dice "me interesa pero estoy ocupado", respondé validando ("entiendo, es un momento complicado") y dejá una puerta abierta sin presionar.
- Objeciones comunes y cómo manejarlas:
  * "Ya uso Instagram/WhatsApp para los turnos" → "Está bien, pero ¿cuánto tiempo perdés confirmando cada uno? FILO lo hace solo."
  * "Es caro" → "Son 7 días gratis para ver si te rinde. Si no recuperás lo que cuesta en turnos extras, no te cobro nada."
  * "No tengo tiempo para aprenderlo" → "En 10 minutos ya está funcionando, no hace falta saber nada técnico."
  * "Lo veo después" → "Dale, te dejo el link para cuando quieras: filocrm.com.ar. ¿Querés que te mande un recordatorio?"

== TONO ==
Profesional y cercano. Usá "vos". Máximo 3 líneas por mensaje. Sin markdown, sin asteriscos, texto plano como WhatsApp. No inventes funciones ni precios distintos a los listados. Nunca seas agresivo ni insistente — si el prospecto dice que no le interesa, agradecé y cerrá la conversación con buena onda.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conv.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
  ];

  try {
    const response = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, max_tokens: 200, temperature: 0.7 })
      },
      12000
    );
    if (!response.ok) return null;
    const data  = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (reply) {
      conv.push({ role: 'assistant', content: reply, ts: new Date().toISOString() });
      pool.query(
        `UPDATE prospects SET reply_count=reply_count+1, replied_at=COALESCE(replied_at,$1), conversation=$2 WHERE shop_id=$3 AND phone=$4`,
        [now, JSON.stringify(conv), shopId, phone]
      ).catch(e => console.error('[Prospect] update error:', e.message));
    }
    console.log(`[Prospect] Auto-reply a ${phone}: "${reply}"`);
    return reply || null;
  } catch (e) {
    console.error('[Prospect] AI error:', e.message);
    return null;
  }
}

async function getAIResponse(shopId, phone, userMessage) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) { console.error('GROQ_API_KEY no configurada'); return null; }

  // Si el que escribe es un prospecto, usar el responder de ventas
  try {
    const isProspect = await pool.query(
      'SELECT id FROM prospects WHERE shop_id=$1 AND phone=$2 LIMIT 1',
      [shopId, phone]
    );
    if (isProspect.rows.length) {
      return getProspectResponse(shopId, phone, userMessage, apiKey);
    }
  } catch (e) {
    console.error('[AI] prospect check error:', e.message);
  }

  // Rate limiting
  if (!checkRateLimit(shopId, phone)) {
    console.log(`[AI] Rate limit alcanzado para ${phone} — ignorando`);
    return null;
  }

  const activeConv = hasActiveConversation(shopId, phone);
  if (activeConv) {
    // Dentro de conversación activa: clasificación laxa — solo bloquear temas totalmente ajenos
    const related = await isBarberiaRelated(userMessage, apiKey, false);
    if (!related) {
      console.log(`[AI] Ignorado dentro de conversación activa (off-topic): "${userMessage}"`);
      return null;
    }
  } else {
    // Primer mensaje: clasificación estricta
    const related = await isBarberiaRelated(userMessage, apiKey, true);
    if (!related) {
      console.log(`[AI] Ignorado (no relacionado con barbería): "${userMessage}"`);
      return null;
    }
  }

  const [shopCtx, client] = await Promise.all([getShopContext(shopId), getClientContext(shopId, phone)]);
  if (!shopCtx) return null;

  const context = buildSystemPrompt(shopCtx, client);
  const key = `${shopId}:${phone}`;
  if (!conversations[key]) conversations[key] = [];
  conversations[key].push({ role: 'user', content: userMessage });
  lastActivity[key] = Date.now();
  if (conversations[key].length > 10) conversations[key] = conversations[key].slice(-10);

  try {
    const response = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'system', content: context }, ...conversations[key]],
          max_tokens: 200,
          temperature: 0.7,
        })
      },
      12000 // 12s timeout para respuesta principal
    );

    if (!response.ok) { console.error('Groq error:', await response.text()); return null; }

    const data  = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (reply) conversations[key].push({ role: 'assistant', content: reply });
    console.log(`[AI] ${client ? client.name : phone} → "${reply}"`);
    return reply || null;
  } catch (e) {
    console.error('AI request error:', e.message);
    return null;
  }
}

const TONE = `Escribí en español rioplatense profesional. Usá "vos", sé cálido pero directo. Nada de "che" ni lunfardo exagerado. Emojis con criterio. IMPORTANTE: este mensaje se envía DIRECTAMENTE al cliente por WhatsApp — escribilo en segunda persona, hablándole a él/ella. Solo el mensaje final, sin comillas ni aclaraciones.`;

async function generateMessage(shopId, type, context) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const prompts = {
    sillon_libre: `${TONE}\n\nEscribile a ${context.clientName} avisándole que hay un sillón libre hoy a las ${context.slot} en ${context.shopName}.${context.incentivo ? ` Mencioná este incentivo: ${context.incentivo}.` : ''} Máximo 3 líneas.`,
    rescate: `${TONE}\n\nEscribile a ${context.clientName}, que no visita ${context.shopName} hace ${context.daysSince} días. Invitalo a que vuelva a reservar. Máximo 3 líneas.`,
    rescate_auto: `${TONE}\n\nEscribile a ${context.clientName}, que hace ${context.daysSince} días que no viene a ${context.shopName}. Invitalo a reservar su próximo turno.${context.bookingLink ? ` Link: ${context.bookingLink}` : ''} Máximo 3 líneas.`,
    turno_completado: `${TONE}\n\nEscribile a ${context.clientName} avisándole que su servicio fue completado. Ganó ${context.pointsEarned} puntos (total: ${context.totalPoints}).${context.tiendaLink ? ` Link de premios: ${context.tiendaLink}` : ''} Máximo 3 líneas.`,
    turno_confirmado: `${TONE}\n\nEscribile a ${context.clientName} confirmándole su turno en ${context.shopName} para el ${context.fecha} a las ${context.hora}${context.serviceName ? ` (${context.serviceName})` : ''}. Máximo 2 líneas.`,
    reserva_recibida: `${TONE}\n\nEscribile a ${context.clientName} confirmándole que su turno en ${context.shopName} quedó agendado para el ${context.fecha} a las ${context.hora}${context.serviceName ? ` (${context.serviceName})` : ''}. Máximo 3 líneas.`,
    recordatorio: `${TONE}\n\nEscribile a ${context.clientName} recordándole su turno en ${context.shopName} el ${context.fecha} a las ${context.hora}${context.serviceName ? ` para ${context.serviceName}` : ''}. Máximo 2 líneas.`,
    sena_instrucciones: `${TONE}\n\nEscribile a ${context.clientName} indicándole que para confirmar su turno en ${context.shopName} debe abonar una seña de $${context.senaAmount} en los próximos ${context.minutesLimit} minutos.\n\nPaso a paso:\n1. Transferí $${context.senaAmount} al alias: *${context.alias}*\n2. Mandá el comprobante por este chat\n\nSi no recibimos el pago en ese tiempo, el turno queda libre. Máximo 6 líneas.`,
    sena_vencida: `${TONE}\n\nEscribile a ${context.clientName} avisándole que la seña para su turno en ${context.shopName} venció sin recibir el pago y el turno fue liberado. Invitalo a reservar nuevamente cuando quiera. Máximo 3 líneas.`,
    membresia_bienvenida: `${TONE}\n\nEscribile a ${context.clientName} dándole la bienvenida a la membresía de ${context.shopName} (${context.planName || 'plan mensual'}, ${context.credits} créditos).\n\nPaso a paso para activarla:\n1. Transferí $${context.price} al alias: *${context.alias}*\n2. Mandá el comprobante por este chat\n\nUna vez confirmado el pago, los créditos quedan activos. Máximo 6 líneas.`,
    membresia_recordatorio: `${TONE}\n\nEscribile a ${context.clientName} recordándole que su membresía en ${context.shopName} vence el ${context.fechaVencimiento}.\n\nPara renovarla:\n1. Transferí $${context.price} al alias: *${context.alias}*\n2. Mandá el comprobante por este chat\n\nMáximo 5 líneas.`,
    membresia_pago_confirmado: `${TONE}\n\nEscribile a ${context.clientName} confirmándole que el pago de su membresía en ${context.shopName} fue recibido. Ya tiene ${context.credits} créditos disponibles hasta el ${context.fechaVencimiento}. Máximo 2 líneas.`,
  };

  const prompt = prompts[type];
  if (!prompt) return null;

  try {
    const response = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 200,
          temperature: 0.8,
        })
      },
      10000
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('generateMessage error:', e.message);
    return null;
  }
}

// Verificar comprobante de pago desde imagen (base64)
async function verifyComprobante(imageBase64, mimeType, expected) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const prompt = `Analizá esta imagen de comprobante de transferencia bancaria y respondé ÚNICAMENTE con un JSON con este formato exacto:
{
  "amount": <número o null>,
  "date": "<YYYY-MM-DD o null>",
  "cbu_cvu": "<CBU o CVU del destinatario (22 dígitos) o null>",
  "valid": <true o false>
}

Reglas:
- "amount": el monto transferido como número (sin símbolos)
- "date": la fecha de la transferencia en formato YYYY-MM-DD
- "cbu_cvu": el CBU o CVU del destinatario (número de 22 dígitos). Si no aparece explícitamente, devolvé null.
- "valid": true si parece un comprobante real y legible

Solo el JSON, sin texto extra.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
          ]
        }],
        max_tokens: 200,
        temperature: 0,
      })
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error(`[AI] verifyComprobante API error ${response.status}: ${errBody}`);
      return null;
    }
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    console.log(`[AI] verifyComprobante respuesta: ${text}`);
    const match = text?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('verifyComprobante error:', e.message);
    return null;
  }
}

// Verificar comprobante desde texto extraído de PDF
async function verifyComprobanteFromText(pdfText, expected) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const prompt = `Analizá este texto extraído de un comprobante de transferencia bancaria y respondé ÚNICAMENTE con un JSON con este formato exacto:
{
  "amount": <número o null>,
  "date": "<YYYY-MM-DD o null>",
  "cbu_cvu": "<CBU o CVU del destinatario (22 dígitos) o null>",
  "valid": <true o false>
}

Reglas:
- "amount": el monto transferido como número (sin símbolos)
- "date": la fecha de la transferencia en formato YYYY-MM-DD
- "cbu_cvu": el CBU o CVU del destinatario (número de 22 dígitos). Si no aparece explícitamente, devolvé null.
- "valid": true si parece un comprobante real y legible

Texto del comprobante:
${pdfText.slice(0, 2000)}

Solo el JSON, sin texto extra.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0,
      })
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error(`[AI] verifyComprobanteFromText API error ${response.status}: ${errBody}`);
      return null;
    }
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    console.log(`[AI] verifyComprobanteFromText respuesta: ${text}`);
    const match = text?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('verifyComprobanteFromText error:', e.message);
    return null;
  }
}

// Limpiar rateLimiter y conversaciones expiradas cada 30 min
setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(rateLimiter)) {
    rateLimiter[k] = rateLimiter[k].filter(t => now - t < RATE_LIMIT_WINDOW);
    if (rateLimiter[k].length === 0) delete rateLimiter[k];
  }
  for (const k of Object.keys(conversations)) {
    if (now - (lastActivity[k] || 0) > CONVERSATION_TIMEOUT_MS) {
      delete conversations[k];
      delete lastActivity[k];
    }
  }
}, 30 * 60 * 1000);

module.exports = { getAIResponse, isBarberiaRelated, generateMessage, verifyComprobante, verifyComprobanteFromText };
