const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const fs        = require('fs');
const pool      = require('./db/pool');

// ── Prevenir crash de Node.js 20 por unhandledRejection ────────────────────
// Baileys / WhatsApp emite rechazos en segundo plano. Sin este handler,
// Node.js 20 crashea el proceso y Railway devuelve su propia página HTML 502.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  unhandledRejection (no crash):', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  uncaughtException (no crash):', err.message);
});

// ── Startup: env vars críticas ──
// Fail-loud en producción si faltan. En dev, warning no bloqueante.
const REQUIRED_ENV = ['JWT_SECRET', 'DATABASE_URL'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  const msg = `❌ Faltan env vars críticas: ${missing.join(', ')}`;
  console.error(msg);
  if (process.env.NODE_ENV === 'production') { process.exit(1); }
}
// Env vars opcionales que silenciosamente apagan features — las logueamos para no sorprenderse después
const OPTIONAL_FEATURES = {
  CLOUDINARY_API_SECRET: 'uploads de fotos (branding + portfolio)',
  GROQ_API_KEY:          'bot de WhatsApp con IA',
  MP_WEBHOOK_SECRET:     'firma de webhooks de Mercado Pago',
};
for (const [k, feat] of Object.entries(OPTIONAL_FEATURES)) {
  if (!process.env[k]) console.warn(`⚠️  ${k} no seteada — feature deshabilitada: ${feat}`);
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware de seguridad ────────────────────────────
// Helmet: headers de seguridad (XSS, clickjacking, MIME-sniff, etc.)
app.use(helmet({
  contentSecurityPolicy: false, // Desactivado para no romper los HTML inline del CRM
  crossOriginEmbedderPolicy: false,
}));

// CORS: solo orígenes conocidos
const allowedOrigins = [
  'https://filocrm1-production.up.railway.app',
  'https://filocrm.com.ar',
  'http://localhost:3000',
  'http://localhost:5173',
];
// Railway y otros proxies envían X-Forwarded-For — necesario para rate limiting correcto
app.set('trust proxy', 1);

allowedOrigins.push('https://www.filocrm.com.ar');
app.use(cors((req, cb) => {
  const origin = req.headers.origin;
  // Mismo origen (la página y la API se sirven desde el mismo host) siempre permitido;
  // sin origin (apps móviles, Postman, n8n interno) también.
  const sameOrigin = origin && origin === `${req.protocol}://${req.get('host')}`;
  if (!origin || sameOrigin || allowedOrigins.includes(origin)) {
    return cb(null, { origin: true, credentials: true });
  }
  cb(new Error('CORS no permitido'));
}));

// Rate limiting global: 300 requests por minuto por IP
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intentá en un momento.' },
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── Sanea errores 500 que leakean internals de DB/sistema ──
// Patches res.json/res.send para que si status=5xx y el body expone info sensible
// (nombres de columnas, SQL state, stack traces), se loguee server-side y se devuelva
// un mensaje genérico al cliente. En desarrollo (NODE_ENV!=production) se preserva.
const IS_PROD = process.env.NODE_ENV === 'production';
const DB_LEAK_PATTERNS = /(does not exist|relation ".*" does not exist|column ".*"|invalid input syntax|violates (not-null|foreign key|unique|check) constraint|duplicate key value|ECONN|getaddrinfo|at Object\.|at async |\n\s*at )/i;
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = function (body) {
    try {
      if (IS_PROD && res.statusCode >= 500 && body && typeof body.error === 'string' && DB_LEAK_PATTERNS.test(body.error)) {
        console.error(`[500-SANITIZED] ${req.method} ${req.path} →`, body.error);
        body = { error: 'Error interno del servidor. Intentá de nuevo en un momento.' };
      }
    } catch (_) {}
    return origJson(body);
  };
  next();
});

// ── Middleware Paywall ────────────────────────────────
app.use(require('./middleware/paywall'));

// ── Rutas API ──────────────────────────────────────────
app.use('/api/payment-methods', require('./routes/paymentMethods'));
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/dashboard',    require('./routes/dashboard'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/clients',      require('./routes/clients'));
app.use('/api/settings',     require('./routes/settings'));
app.use('/api/yield',        require('./routes/yield'));
app.use('/api/memberships',  require('./routes/memberships'));
app.use('/api/booking',      require('./routes/booking'));
app.use('/api/points',       require('./routes/points'));
app.use('/api/barbers',      require('./routes/barbers'));
app.use('/api/products',     require('./routes/products'));
app.use('/api/enterprise',   require('./routes/enterprise'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/vendor',        require('./routes/vendor'));
app.use('/api/queue',         require('./routes/queue'));
app.use('/api/media',         require('./routes/media'));
app.use('/api/referrals',     require('./routes/referrals'));
app.use('/api/affiliates',    require('./routes/affiliates'));
app.use('/api/copilot',       require('./routes/copilot'));
app.use('/api/events',        require('./routes/events'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/push',          require('./routes/push'));
app.use('/api/payments/webhook',     require('./routes/payments'));
app.use('/api/payments/webhook-filo', require('./routes/payments'));
app.use('/api/payments/webhook-qr',   require('./routes/payments'));
app.use('/api/payments/filo-cancel',  require('./routes/payments'));
app.use('/api/payments',              require('./routes/payments'));
const recurringRouter = require('./routes/recurring');
app.use('/api/recurring', recurringRouter);

// Test WhatsApp bot
app.get('/test', (req, res) => {
  res.sendFile(path.join(publicDir, 'test-wpp.html'));
});
app.post('/api/test-wpp/chat', require('./middleware/auth'), async (req, res) => {
  try {
    const { phone, text } = req.body;
    // Siempre el local del usuario logueado: ignora cualquier shop_id enviado
    const shop_id = req.shopId;
    if (!phone || !text) return res.status(400).json({ error: 'phone y text son requeridos' });
    const { getAIResponse } = require('./services/ai');
    const reply = await getAIResponse(parseInt(shop_id), phone, text);
    res.json({ reply: reply || null });
  } catch(e) {
    console.error('[test-wpp]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Panel admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

// Dashboard vendedor
app.get('/vendor', (req, res) => {
  res.sendFile(path.join(publicDir, 'vendor.html'));
});

// Centro de afiliados
app.get('/afiliados', (req, res) => {
  res.sendFile(path.join(publicDir, 'afiliados.html'));
});

// Video onboarding afiliados
app.get('/afiliados/onboarding', (req, res) => {
  res.sendFile(path.join(publicDir, 'onboarding-afiliados.html'));
});

// Fila digital pública
app.get('/fila/:slug', (req, res) => {
  res.sendFile(path.join(publicDir, 'fila.html'));
});

// Dashboard barbero
app.get('/barber', (req, res) => {
  res.sendFile(path.join(publicDir, 'barber.html'));
});

// ── Health check ───────────────────────────────────────
// IMPORTANTE: no hacer queries a la DB aquí — si la DB está lenta el healthcheck falla
app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV, v: '2025-04-23-r' }));

// ── DB ping diagnóstico ────────────────────────────────
app.get('/healthdb', async (req, res) => {
  const net = require('net');
  const dbUrl = process.env.DATABASE_URL || '';
  const dbHost = dbUrl.match(/@([^/:]+)/)?.[1] || 'NO_HOST';
  const dbPort = parseInt(dbUrl.match(/:(\d+)\//)?.[1] || '5432');

  // Test 1: TCP connectivity (sin PostgreSQL)
  const tcpMs = await new Promise(resolve => {
    const t = Date.now();
    const sock = net.createConnection({ host: dbHost, port: dbPort });
    sock.setTimeout(5000);
    sock.on('connect', () => { sock.destroy(); resolve(Date.now() - t); });
    sock.on('error', (e) => resolve(`TCP_ERR:${e.message}`));
    sock.on('timeout', () => { sock.destroy(); resolve('TCP_TIMEOUT'); });
  });

  // Test 2: PostgreSQL query (solo si TCP OK)
  let pgResult = 'skipped';
  if (typeof tcpMs === 'number') {
    const t2 = Date.now();
    try {
      await pool.query('SELECT 1 AS ok');
      pgResult = `ok(${Date.now()-t2}ms)`;
    } catch(e) {
      pgResult = `err(${Date.now()-t2}ms):${e.message.slice(0,80)}`;
    }
  }

  // No se expone host/puerto de la base de datos
  res.json({ tcp: typeof tcpMs === 'number' ? 'ok' : 'error', pg: pgResult.startsWith('ok') ? 'ok' : (pgResult === 'skipped' ? 'skipped' : 'error') });
});

// ── Frontend estático ──────────────────────────────────
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Escapa texto controlado por usuarios antes de meterlo en HTML / JSON-LD del SSR
const escHtmlAttr = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeJsonLd = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

// Tienda pública de puntos — SSR para SEO
app.get('/tienda/:slug', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT name, city, address, logo_url, store_name FROM shops WHERE booking_slug=$1',
      [req.params.slug]
    );
    let html = fs.readFileSync(path.join(publicDir, 'tienda.html'), 'utf8');
    if (result.rows.length) {
      const shop      = result.rows[0];
      const storeName = shop.store_name || shop.name;
      const location  = [shop.address, shop.city].filter(Boolean).join(', ');
      const title     = `${storeName} — Tienda de puntos | FILO`;
      const desc      = `Canjea tus puntos en ${storeName}${location ? ` · ${location}` : ''}. Programa de fidelidad digital para barberíasargentinas.`;
      const canonical = `https://filocrm.com.ar/tienda/${req.params.slug}`;
      const image     = shop.logo_url || 'https://filocrm.com.ar/logo_filo.png';
      const jsonLd = safeJsonLd({
        '@context': 'https://schema.org',
        '@type': 'Store',
        'name': storeName,
        'description': desc,
        'url': canonical,
        'image': image
      });
      const seoTags = `
  <meta name="description" content="${escHtmlAttr(desc)}">
  <link rel="canonical" href="${escHtmlAttr(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escHtmlAttr(title)}">
  <meta property="og:description" content="${escHtmlAttr(desc)}">
  <meta property="og:url" content="${escHtmlAttr(canonical)}">
  <meta property="og:image" content="${escHtmlAttr(image)}">
  <meta property="og:site_name" content="FILO">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escHtmlAttr(title)}">
  <meta name="twitter:description" content="${escHtmlAttr(desc)}">
  <meta name="robots" content="index, follow">
  <script type="application/ld+json">${jsonLd}</script>`;
      html = html
        .replace('<title>Tienda de Puntos FILO</title>', `<title>${escHtmlAttr(title)}</title>`)
        .replace('</head>', seoTags + '\n</head>');
    }
    res.send(html);
  } catch (e) {
    res.sendFile(path.join(publicDir, 'tienda.html'));
  }
});

// Reservas públicas — SSR para SEO
app.get('/reservar/:slug', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT name, city, address, phone, logo_url FROM shops WHERE booking_slug=$1',
      [req.params.slug]
    );

    let html = fs.readFileSync(path.join(publicDir, 'reservar.html'), 'utf8');

    if (result.rows.length) {
      const shop     = result.rows[0];
      const siteName = 'FILO CRM';
      const location = [shop.address, shop.city].filter(Boolean).join(', ');
      const title    = `${shop.name} — Reservar turno online | ${escHtmlAttr(siteName)}`;
      const desc     = `Reservá tu turno en ${shop.name}${location ? ` · ${location}` : ''}. Sin llamadas, sin esperas, disponible 24/7.`;
      const canonical = `https://filocrm.com.ar/reservar/${req.params.slug}`;
      const image     = shop.logo_url || 'https://filocrm.com.ar/logo_filo.png';

      const jsonLd = safeJsonLd({
        '@context': 'https://schema.org',
        '@type': 'HairSalon',
        'name': shop.name,
        ...(location && { 'address': {
          '@type': 'PostalAddress',
          'streetAddress': shop.address || '',
          'addressLocality': shop.city || '',
          'addressCountry': 'AR'
        }}),
        ...(shop.phone && { 'telephone': shop.phone }),
        'url': canonical,
        'image': image,
        'makesOffer': {
          '@type': 'Offer',
          'description': 'Turno de barbería online'
        }
      });

      const seoTags = `
  <meta name="description" content="${escHtmlAttr(desc)}">
  <link rel="canonical" href="${escHtmlAttr(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escHtmlAttr(title)}">
  <meta property="og:description" content="${escHtmlAttr(desc)}">
  <meta property="og:url" content="${escHtmlAttr(canonical)}">
  <meta property="og:image" content="${escHtmlAttr(image)}">
  <meta property="og:site_name" content="${escHtmlAttr(siteName)}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escHtmlAttr(title)}">
  <meta name="twitter:description" content="${escHtmlAttr(desc)}">
  <meta name="robots" content="index, follow">
  <script type="application/ld+json">${jsonLd}</script>`;

      html = html
        .replace('<title>Reservar turno — FILO</title>', `<title>${escHtmlAttr(title)}</title>`)
        .replace('</head>', seoTags + '\n</head>');
    }

    res.send(html);
  } catch (e) {
    console.error('SEO reservar error:', e.message);
    res.sendFile(path.join(publicDir, 'reservar.html'));
  }
});

// ── Sitemap dinámico ─────────────────────────────────────────────────────────
app.get('/sitemap.xml', async (req, res) => {
  const BASE = 'https://filocrm.com.ar';
  const now  = new Date().toISOString().split('T')[0];

  // Páginas estáticas
  const staticPages = [
    { url: '/',          priority: '1.0', changefreq: 'weekly'  },
    { url: '/funciones', priority: '0.8', changefreq: 'monthly' },
  ];

  // Páginas dinámicas de reservas y tiendas (barberías activas con booking_slug)
  let dynamicPages = [];
  try {
    const result = await pool.query(
      `SELECT booking_slug, created_at, points_enabled FROM shops
       WHERE booking_slug IS NOT NULL AND booking_slug != ''
         AND subscription_status IN ('active','trial')
       ORDER BY created_at DESC LIMIT 500`
    );
    result.rows.forEach(r => {
      const lastmod = r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : now;
      dynamicPages.push({
        url: `/reservar/${r.booking_slug}`,
        priority: '0.7',
        changefreq: 'weekly',
        lastmod
      });
      // Solo incluir tienda si el local tiene el sistema de puntos activo
      if (r.points_enabled) {
        dynamicPages.push({
          url: `/tienda/${r.booking_slug}`,
          priority: '0.5',
          changefreq: 'monthly',
          lastmod
        });
      }
    });
  } catch(e) { /* continuar sin páginas dinámicas */ }

  const urlTags = [...staticPages.map(p => `
  <url>
    <loc>${BASE}${p.url}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`),
  ...dynamicPages.map(p => `
  <url>
    <loc>${BASE}${p.url}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`)].join('');

  res.setHeader('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urlTags}
</urlset>`);
});

// Landing en la raíz — con prerender estático para SEO
app.get('/', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(publicDir, 'landing.html'), 'utf8');

    // Bloque HTML estático que Google indexa en la primera pasada (antes del render de React).
    // Se oculta vía JS cuando la app carga. No es cloaking: el contenido es idéntico al visible.
    const prerender = `
<div id="seo-prerender" style="position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden" aria-hidden="true">
  <h1>Software para barberías en Argentina — FILO CRM</h1>
  <p>FILO es el sistema todo-en-uno para barberías y peluquerías en Argentina. Gestión de turnos online, recordatorios automáticos por WhatsApp, fila digital, caja y estadísticas en tiempo real.</p>
  <h2>Funciones de FILO para tu barbería</h2>
  <ul>
    <li>Turnos online: reservas las 24 horas desde el link de tu barbería, sin llamadas</li>
    <li>Recordatorios por WhatsApp: mensajes automáticos para reducir ausencias</li>
    <li>Fila digital: tus clientes se anotan y esperan sin estar parados</li>
    <li>CRM de clientes: historial de cortes, preferencias y cumpleaños</li>
    <li>Caja y estadísticas: ingresos, servicios más pedidos y rendimiento por barbero</li>
    <li>Gestión de barberos: agenda individual para cada profesional del equipo</li>
    <li>Plan Enterprise: manejo de múltiples sucursales desde un solo panel</li>
  </ul>
  <h2>¿Por qué elegir FILO?</h2>
  <p>FILO fue creado específicamente para barberías argentinas. A diferencia de otros sistemas genéricos, FILO incluye fila digital, integración con WhatsApp, programa de puntos para fidelizar clientes y soporte en español.</p>
  <h2>Precios y planes</h2>
  <p>FILO tiene 7 días de prueba gratis sin necesidad de tarjeta de crédito. Planes para barberías chicas (Starter), medianas (Staff) y cadenas con múltiples sucursales (Enterprise).</p>
  <p>Software para barbería · Sistema de turnos barbería · App para barberos · Gestión de barbería Argentina · Turnos online barbería · CRM barbería</p>
</div>
<script>window.addEventListener('DOMContentLoaded',function(){var el=document.getElementById('seo-prerender');if(el)el.remove();})</script>`;

    html = html.replace('<div id="root">', prerender + '\n<div id="root">');
    res.send(html);
  } catch(e) {
    res.sendFile(path.join(publicDir, 'landing.html'));
  }
});

// CRM en /app
app.get('/app', (req, res) => {
  res.sendFile(path.join(publicDir, 'crm.html'));
});

// Página de conversión post-pago
app.get('/gracias', (req, res) => {
  res.sendFile(path.join(publicDir, 'gracias.html'));
});

// Página de funciones
app.get('/funciones', (req, res) => {
  res.sendFile(path.join(publicDir, 'funciones.html'));
});

// API 404 explícito: evita que /api/foo inexistente caiga en el catch-all y devuelva HTML
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' });
});

// Cualquier otra ruta → CRM
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'crm.html'));
});

// ── Error handler global (SIEMPRE después de las rutas) ────────────────────
// Evita que Express devuelva HTML <!DOCTYPE> en errores — siempre JSON
// En producción, nunca expone err.message al cliente para no leakear internals.
app.use((err, req, res, next) => {
  console.error('❌ Express error:', err.status || 500, err.message, err.stack);
  const status = err.status || err.statusCode || 500;
  const safe = status < 500 ? (err.message || 'Error') : 'Error interno del servidor';
  res.status(status).json({ error: IS_PROD ? safe : (err.message || safe) });
});

// ── Init DB ────────────────────────────────────────────
// Estrategia:
//   • DB existente → saltar schema.sql (evita ALTER TABLE locks), solo
//     sincronizar migraciones nuevas vía _migrations tracking.
//     Resultado: < 1 segundo en cada reinicio.
//   • DB nueva     → correr schema.sql completo + todas las migraciones.
async function initDB() {
  const migrationsDir  = path.join(__dirname, 'db', 'migrations');
  const migrationFiles = fs.readdirSync(migrationsDir)
                           .filter(f => f.endsWith('.sql')).sort();

  // ── 1. ¿Existe la tabla shops? ────────────────────────
  const { rows: shopsCheck } = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='shops' LIMIT 1
  `);
  const isFreshDB = shopsCheck.length === 0;

  if (isFreshDB) {
    // DB vacía: crear esquema completo
    const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('📦 Schema inicial aplicado');
  }

  // ── 2. Tabla de tracking ──────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── 3. Leer qué migraciones ya están aplicadas ────────
  const { rows: applied } = await pool.query('SELECT filename FROM _migrations');
  const appliedSet = new Set(applied.map(r => r.filename));

  if (!isFreshDB && appliedSet.size === 0) {
    // Primera vez con tracking en DB existente:
    // asumir que todas las migraciones actuales ya corrieron
    // (venían corriéndose en cada restart antes de este commit).
    for (const file of migrationFiles) {
      await pool.query(
        'INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [file]
      );
    }
    console.log('✅ DB existente: migraciones marcadas como aplicadas');
    return;
  }

  // ── 4. Correr solo migraciones nuevas ─────────────────
  // Ejecutar cada statement por separado para soportar migraciones multi-statement
  let ran = 0;
  for (const file of migrationFiles) {
    if (appliedSet.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // Se quitan las líneas de comentario ANTES de filtrar: antes, una sentencia que
    // venía precedida por un comentario se descartaba entera (ej: CREATE TABLE).
    const statements = sql
      .split(/;\s*\n/)
      .map(s => s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim())
      .filter(s => s.length > 0);
    for (const stmt of statements) {
      await pool.query(stmt);
    }
    await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
    console.log(`  ✔ migración: ${file}`);
    ran++;
  }
  console.log(`✅ DB sincronizada (${ran} migracion${ran !== 1 ? 'es' : ''} nueva${ran !== 1 ? 's' : ''})`);
}

async function start() {
  // ── 1. Escuchar puerto PRIMERO — healthcheck de Railway debe pasar rápido ──
  await new Promise((resolve) => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 FILO CRM corriendo en puerto ${PORT}`);
      console.log(`   NODE_ENV: ${process.env.NODE_ENV}`);
      resolve();
    });
  });

  // ── 2. Todo lo demás en background (no bloquea el healthcheck) ────────────
  (async () => {
    // initDB: < 1 segundo en DB existente (salta schema.sql, solo tracking)
    try {
      await initDB();
    } catch (e) {
      console.error('❌ Error en initDB:', e.message);
    }

    try {
      const wpp = require('./services/whatsapp');
      await wpp.reconnectAllShops();
      console.log('📱 WhatsApp: reconexión iniciada');
    } catch(e) {
      console.error('WhatsApp reconnect error:', e.message);
    }
    try {
      const { runDailyGeneration } = require('./routes/recurring');
      runDailyGeneration();
      setInterval(runDailyGeneration, 24 * 60 * 60 * 1000);
      console.log('🔄 Turnos recurrentes: generación diaria activa');
    } catch(e) {
      console.error('Recurring generation error:', e.message);
    }
    try {
      const { startScheduler } = require('./services/scheduler');
      startScheduler();
    } catch(e) {
      console.error('Scheduler error:', e.message);
    }
  })();
}

start();
