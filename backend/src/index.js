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

// ── Rutas API ──────────────────────────────────────────
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/dashboard',    require('./routes/dashboard'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/clients',      require('./routes/clients'));
app.use('/api/settings',     require('./routes/settings'));
app.use('/api/yield',        require('./routes/yield'));
app.use('/api/memberships',  require('./routes/memberships'));
app.use('/api/booking',      require('./routes/booking'));

// ── Health check ───────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV }));

// ── Frontend estático ──────────────────────────────────
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Reservas públicas
app.get('/reservar/:slug', (req, res) => {
  res.sendFile(path.join(publicDir, 'reservar.html'));
});

// Landing en la raíz
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'landing.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(publicDir, 'crm.html'));  // ← crm.html
});

app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'crm.html'));  // ← crm.html
});

// ── Init DB + arrancar servidor ────────────────────────
async function initDB() {
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');
  const schema     = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schema);
  console.log('✅ Base de datos sincronizada');
}

async function start() {
  try {
    await initDB();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 FILO CRM corriendo en puerto ${PORT}`);
      console.log(`   NODE_ENV: ${process.env.NODE_ENV}`);
      console.log(`   WPPCONNECT_URL: ${process.env.WPPCONNECT_URL || '(no configurado)'}`);
    });
  } catch (e) {
    console.error('❌ Error al iniciar:', e.message);
    process.exit(1);
  }
}

start();
