const pool = require('../db/pool');

// Palabras clave de barbería para filtrar mensajes relevantes
const KEYWORDS = [
  'turno', 'turno', 'reserva', 'reservar', 'sacar', 'agendar', 'cita',
  'precio', 'precios', 'cuánto', 'cuanto', 'vale', 'cuesta', 'cobran',
  'corte', 'barba', 'pelo', 'cabello', 'lavado', 'tintura', 'degrade',
  'horario', 'horarios', 'atienden', 'abren', 'cierran', 'dias', 'días',
  'disponible', 'disponibilidad', 'libre', 'hay lugar', 'lugar',
  'barbero', 'barbería', 'barberia', 'servicio', 'servicios',
  'hola', 'buenas', 'buen dia', 'buen día', 'hello', 'hi',
  'info', 'información', 'informacion', 'consulta',
  'puntos', 'premio', 'descuento', 'promo',
  'cancelar', 'cancel', 'cambiar turno',
];

function isBarberiaRelated(text) {
  const lower = text.toLowerCase();
  return KEYWORDS.some(kw => lower.includes(kw));
}

async function getShopContext(shopId) {
  try {
    const shop = await pool.query(
      'SELECT name, city, address, phone FROM shops WHERE id=$1',
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

    return `
Sos el asistente virtual de ${shopData.name}, una barbería${shopData.city ? ` en ${shopData.city}` : ''}.
${shopData.address ? `Dirección: ${shopData.address}` : ''}

Servicios y precios:
${servicesList || '- Consultá con nosotros'}

Tu trabajo es responder consultas de clientes sobre servicios, precios, turnos y horarios.
Respondé en español rioplatense, de forma amigable, breve y directa (máximo 3 líneas).
Si el cliente quiere reservar un turno, decile que puede hacerlo desde el link de reservas o llamando directamente.
Si no sabés algo (como horarios exactos), decí que consulten directamente con la barbería.
No inventes información. No hables de nada que no sea la barbería.
`.trim();
  } catch (e) {
    console.error('getShopContext error:', e.message);
    return null;
  }
}

// Historial de conversaciones en memoria (últimos 10 mensajes por número)
const conversations = {};

async function getAIResponse(shopId, phone, userMessage) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('GROQ_API_KEY no configurada');
    return null;
  }

  // Verificar que el mensaje sea relevante
  if (!isBarberiaRelated(userMessage)) {
    console.log(`[AI] Mensaje ignorado (no relacionado a barbería): "${userMessage}"`);
    return null;
  }

  const context = await getShopContext(shopId);
  if (!context) return null;

  // Mantener historial por número de teléfono
  const key = `${shopId}:${phone}`;
  if (!conversations[key]) conversations[key] = [];

  conversations[key].push({ role: 'user', content: userMessage });

  // Mantener solo los últimos 10 mensajes
  if (conversations[key].length > 10) {
    conversations[key] = conversations[key].slice(-10);
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: context },
          ...conversations[key]
        ],
        max_tokens: 200,
        temperature: 0.7,
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Groq error:', err);
      return null;
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();

    if (reply) {
      conversations[key].push({ role: 'assistant', content: reply });
    }

    return reply || null;
  } catch (e) {
    console.error('AI request error:', e.message);
    return null;
  }
}

module.exports = { getAIResponse, isBarberiaRelated };
