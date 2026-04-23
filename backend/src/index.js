const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const pool    = require('./db/pool');

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
app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV }));

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

// ── Init DB + arrancar servidor ────────────────────────
async function initDB() {
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');
  const schema     = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schema);

  // Crear tabla de tracking de migraciones (si no existe)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Correr solo migraciones que NO se hayan ejecutado antes
  const migrationsDir = path.join(__dirname, 'db', 'migrations');
  const migrationFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of migrationFiles) {
    const { rows } = await pool.query(
      'SELECT 1 FROM _migrations WHERE filename = $1', [file]
    );
    if (rows.length > 0) continue; // ya aplicada

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
    console.log(`  ✔ migración aplicada: ${file}`);
  }
  console.log('✅ Base de datos sincronizada');
}

async function start() {
  // ── 1. Escuchar el puerto PRIMERO para que el healthcheck pase ──────────────
  await new Promise((resolve) => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 FILO CRM corriendo en puerto ${PORT}`);
      console.log(`   NODE_ENV: ${process.env.NODE_ENV}`);
      resolve();
    });
  });

  // ── 2. Migrar DB en background (no bloquea el healthcheck) ─────────────────
  (async () => {
    try {
      await initDB();
    } catch (e) {
      console.error('❌ Error en initDB:', e.message);
      // No hacer process.exit — el servidor ya está levantado y sirviendo
    }

    // Reconectar WhatsApp de todos los shops que estaban conectados
    try {
      const wpp = require('./services/whatsapp');
      await wpp.reconnectAllShops();
      console.log('📱 WhatsApp: reconexión iniciada');
    } catch(e) {
      console.error('WhatsApp reconnect error:', e.message);
    }
    // Generación inicial de turnos recurrentes + job diario (cada 24h)
    try {
      const { runDailyGeneration } = require('./routes/recurring');
      runDailyGeneration();
      setInterval(runDailyGeneration, 24 * 60 * 60 * 1000);
      console.log('🔄 Turnos recurrentes: generación diaria activa');
    } catch(e) {
      console.error('Recurring generation error:', e.message);
    }
    // Arrancar scheduler de tareas periódicas (cierre automático de caja, etc.)
    try {
      const { startScheduler } = require('./services/scheduler');
      startScheduler();
    } catch(e) {
      console.error('Scheduler error:', e.message);
    }
  })();
}

start();
