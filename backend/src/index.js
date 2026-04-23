const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const pool    = require('./db/pool');

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

// ── Middleware ─────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

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
app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV, v: '2025-04-23-d' }));

// ── Frontend estático ──────────────────────────────────
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Tienda pública de puntos
app.get('/tienda/:slug', (req, res) => {
  res.sendFile(path.join(publicDir, 'tienda.html'));
});

// Reservas públicas
app.get('/reservar/:slug', (req, res) => {
  res.sendFile(path.join(publicDir, 'reservar.html'));
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
  // ── 1. initDB primero — es instantánea en DB existente (<1s) ──────────────
  try {
    await initDB();
  } catch (e) {
    console.error('❌ Error en initDB:', e.message);
    // No hacer process.exit — seguir aunque falle (DB ya inicializada)
  }

  // ── 2. Escuchar puerto ────────────────────────────────────────────────────
  await new Promise((resolve) => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 FILO CRM corriendo en puerto ${PORT}`);
      console.log(`   NODE_ENV: ${process.env.NODE_ENV}`);
      resolve();
    });
  });

  // ── 3. Tareas en background (no bloquean el healthcheck) ─────────────────
  (async () => {
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
