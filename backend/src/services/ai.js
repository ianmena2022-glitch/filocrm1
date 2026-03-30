const pool = require('../db/pool');

// Palabras clave de barbería para filtrar mensajes relevantes
const KEYWORDS = [
  'turno', 'reserva', 'reservar', 'sacar', 'agendar', 'cita',
  'precio', 'precios', 'cuánto', 'cuanto', 'vale', 'cuesta', 'cobran',
  'corte', 'barba', 'pelo', 'cabello', 'lavado', 'tintura', 'degrade',
  'horario', 'horarios', 'atienden', 'abren', 'cierran', 'dias', 'días',
  'disponible', 'disponibilidad', 'libre', 'hay lugar', 'lugar',
  'barbero', 'barbería', 'barberia', 'servicio', 'servicios',
  'hola', 'buenas', 'buen dia', 'buen día', 'hello', 'hi',
  'info', 'información', 'informacion', 'consulta',
  'puntos', 'premio', 'descuento', 'promo',
  'cancelar', 'cancel', 'cambiar turno',
  'dirección', 'direccion', 'donde están', 'dónde están', 'ubicación', 'ubicacion',
];

// Historial de conversaciones en memoria
const conversations = {};
const lastActivity = {};
const CONVERSATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

function isBarberiaRelated(text) {
  const lower = text.toLowerCase();
  return KEYWORDS.some(kw => lower.includes(kw));
}

function hasActiveConversation(shopId, phone) {
  const key = `${shopId}:${phone}`;
  if (!conversations[key] || conversations[key].length === 0) return false;
  // Limpiar si pasaron más de 30 minutos sin actividad
  if (Date.now() - (lastActivity[key] || 0) > CONVERSATION_TIMEOUT_MS) {
    delete conversations[key];
    delete lastActivity[key];
    return false;
  }
  return true;
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
    const tiendaLink = shopData.booking_slug ? `${baseUrl}/tienda/${shopData.booking_slug}` : null;
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

async function getAIResponse(shopId, phone, userMessage) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) { console.error('GROQ_API_KEY no configurada'); return null; }

  if (!isBarberiaRelated(userMessage) && !hasActiveConversation(shopId, phone)) {
    console.log(`[AI] Ignorado: "${userMessage}"`);
    return null;
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
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: context }, ...conversations[key]],
        max_tokens: 200,
        temperature: 0.7,
      })
    });

    if (!response.ok) { console.error('Groq error:', await response.text()); return null; }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (reply) conversations[key].push({ role: 'assistant', content: reply });
    console.log(`[AI] ${client ? client.name : phone} → "${reply}"`);
    return reply || null;
  } catch (e) {
    console.error('AI request error:', e.message);
    return null;
  }
}

async function generateMessage(shopId, type, context) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const prompts = {
    sillon_libre: `Escribí un mensaje de WhatsApp corto y amigable para avisarle a ${context.clientName} que hay un sillón libre hoy a las ${context.slot} en ${context.shopName}. ${context.incentivo ? `Mencioná este incentivo: ${context.incentivo}.` : ''} Máximo 3 líneas, usá emojis con criterio. Solo el mensaje, sin comillas ni explicaciones.`,

    rescate: `Escribí un mensaje de WhatsApp corto y amigable para ${context.clientName}, un cliente que no visita ${context.shopName} hace ${context.daysSince} días. El objetivo es que vuelva a reservar un turno. Máximo 3 líneas, usá emojis con criterio. Solo el mensaje, sin comillas ni explicaciones.`,

    turno_completado: `Escribí un mensaje de WhatsApp corto para ${context.clientName} avisándole que su servicio fue completado. Ganó ${context.pointsEarned} puntos (total: ${context.totalPoints}).${context.tiendaLink ? ` Incluí este link para ver sus premios: ${context.tiendaLink}` : ''} Máximo 3 líneas, usá emojis con criterio. Solo el mensaje, sin comillas ni explicaciones.`
  };

  const prompt = prompts[type];
  if (!prompt) return null;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.8,
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('generateMessage error:', e.message);
    return null;
  }
}

module.exports = { getAIResponse, isBarberiaRelated, generateMessage };
