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
app.use(cors({
  origin: (origin, cb) => {
    // Permitir requests sin origin (apps móviles, Postman, n8n interno)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS no permitido'));
  },
  credentials: true,
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
app.use('/api/prospector',    require('./routes/prospector'));
app.use('/api/referrals',     require('./routes/referrals'));
app.use('/api/affiliates',    require('./routes/affiliates'));
app.use('/api/payments/webhook',     require('./routes/payments'));
app.use('/api/payments/webhook-filo', require('./routes/payments'));
app.use('/api/payments/webhook-qr',   require('./routes/payments'));
app.use('/api/payments/filo-cancel',  require('./routes/payments'));
app.use('/api/payments',              require('./routes/payments'));
const recurringRouter = require('./routes/recurring');
app.use('/api/recurring', recurringRouter);

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

  res.json({ host: dbHost, port: dbPort, tcp: tcpMs, pg: pgResult });
});

// ── Frontend estático ──────────────────────────────────
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

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
      const title     = `${storeName} — Tienda de puntos | FILO CRM`;
      const desc      = `Canjea tus puntos en ${storeName}${location ? ` · ${location}` : ''}. Programa de fidelidad digital.`;
      const canonical = `https://filocrm.com.ar/tienda/${req.params.slug}`;
      const seoTags   = `\n  <meta name="description" content="${desc}">\n  <link rel="canonical" href="${canonical}">\n  <meta property="og:title" content="${title}">\n  <meta property="og:description" content="${desc}">\n  <meta property="og:url" content="${canonical}">\n  <meta name="robots" content="index, follow">`;
      html = html.replace('</head>', seoTags + '\n</head>');
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
      const title    = `${shop.name} — Reservar turno online | ${siteName}`;
      const desc     = `Reservá tu turno en ${shop.name}${location ? ` · ${location}` : ''}. Sin llamadas, sin esperas, disponible 24/7.`;
      const canonical = `https://filocrm.com.ar/reservar/${req.params.slug}`;
      const image     = shop.logo_url || 'https://filocrm.com.ar/logo_filo.png';

      const jsonLd = JSON.stringify({
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
  <meta name="description" content="${desc}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${image}">
  <meta property="og:site_name" content="${siteName}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${desc}">
  <meta name="robots" content="index, follow">
  <script type="application/ld+json">${jsonLd}</script>`;

      html = html
        .replace('<title>Reservar turno — FILO</title>', `<title>${title}</title>`)
        .replace('</head>', seoTags + '\n</head>');
    }

    res.send(html);
  } catch (e) {
    console.error('SEO reservar error:', e.message);
    res.sendFile(path.join(publicDir, 'reservar.html'));
  }
});

// Landing en la raíz
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'landing.html'));
});

// CRM en /app
app.get('/app', (req, res) => {
  res.sendFile(path.join(publicDir, 'crm.html'));
});

// Página de funciones
app.get('/funciones', (req, res) => {
  res.sendFile(path.join(publicDir, 'funciones.html'));
});

// Cualquier otra ruta → CRM
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'crm.html'));
});

// ── Error handler global (SIEMPRE después de las rutas) ────────────────────
// Evita que Express devuelva HTML <!DOCTYPE> en errores — siempre JSON
app.use((err, req, res, next) => {
  console.error('❌ Express error:', err.status || 500, err.message);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Error interno del servidor' });
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
  let ran = 0;
  for (const file of migrationFiles) {
    if (appliedSet.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
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
