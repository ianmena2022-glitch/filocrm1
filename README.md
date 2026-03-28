# ✂️ FILO CRM

Sistema de gestión para barberías. Backend Node.js + PostgreSQL, deploy en Railway.

---

## 🗂 Estructura

```
filocrm/
├── Dockerfile
├── railway.toml
├── .env.example
└── backend/
    ├── package.json
    └── src/
        ├── index.js              ← servidor principal
        ├── db/
        │   ├── pool.js           ← conexión PostgreSQL
        │   └── schema.sql        ← tablas (se aplica automáticamente al iniciar)
        ├── middleware/
        │   └── auth.js           ← JWT
        ├── services/
        │   └── whatsapp.js       ← WPPConnect
        ├── routes/
        │   ├── auth.js           ← POST /api/auth/register|login
        │   ├── dashboard.js      ← GET  /api/dashboard/today
        │   ├── appointments.js   ← CRUD /api/appointments
        │   ├── clients.js        ← CRUD /api/clients
        │   ├── settings.js       ← GET|PUT /api/settings + servicios + WPP
        │   ├── yield.js          ← Motor Sillón Libre + Churn
        │   └── memberships.js    ← CRUD /api/memberships
        └── public/
            └── index.html        ← frontend
```

---

## 🚀 Deploy en Railway (paso a paso)

### 1. Crear repositorio en GitHub

```bash
git init
git add .
git commit -m "FILO CRM inicial"
git remote add origin https://github.com/TU_USUARIO/filo-crm.git
git push -u origin main
```

### 2. Crear proyecto en Railway

1. Entrá a [railway.app](https://railway.app) → New Project
2. **Deploy from GitHub repo** → seleccioná tu repo
3. Railway detecta el `Dockerfile` automáticamente

### 3. Agregar PostgreSQL

1. En tu proyecto Railway → **+ New** → **Database** → **PostgreSQL**
2. Railway crea la base y agrega `DATABASE_URL` automáticamente al servicio

### 4. Configurar variables de entorno

En tu servicio FILO → **Variables**, agregá:

| Variable | Valor |
|---|---|
| `JWT_SECRET` | string random largo (ver .env.example) |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `WPPCONNECT_URL` | `http://server-cli.railway.internal:21465` |
| `WPPCONNECT_SECRET_KEY` | `filoCRM_secret` |

### 5. Deploy

Railway hace deploy automático al hacer push a `main`. También podés hacer **Redeploy** manual desde el dashboard.

---

## 💬 Configurar WhatsApp (WPPConnect)

El servicio WPPConnect debe estar en el **mismo proyecto** de Railway para usar la URL interna.

**URL interna (recomendada):**
```
WPPCONNECT_URL=http://server-cli.railway.internal:21465
```
> ⚠️ El nombre `server-cli` debe coincidir exactamente con el nombre del servicio en Railway.

**Si WPPConnect está en otro proyecto**, usá la URL pública:
```
WPPCONNECT_URL=https://server-cli-production-xxxx.up.railway.app
```

### Flujo de conexión:
1. Ir a **Configuración** en FILO CRM
2. Clic en **Conectar WhatsApp**
3. Escanear el QR con WhatsApp → Dispositivos vinculados
4. El dot verde confirma que está conectado

---

## 🔌 API Reference

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/auth/register` | Crear cuenta |
| POST | `/api/auth/login` | Iniciar sesión |
| GET | `/api/dashboard/today` | Métricas del día + gráfico semanal |
| GET | `/api/appointments?date=YYYY-MM-DD` | Turnos del día |
| POST | `/api/appointments` | Crear turno |
| PUT | `/api/appointments/:id/status` | Cambiar estado |
| DELETE | `/api/appointments/:id` | Eliminar turno |
| GET | `/api/clients` | Lista de clientes |
| POST | `/api/clients` | Crear cliente |
| DELETE | `/api/clients/:id` | Eliminar cliente |
| GET | `/api/settings` | Config de la barbería |
| PUT | `/api/settings` | Guardar config |
| GET | `/api/settings/services` | Lista de servicios |
| POST | `/api/settings/services` | Crear servicio |
| DELETE | `/api/settings/services/:id` | Eliminar servicio |
| POST | `/api/settings/whatsapp/connect` | Iniciar sesión WPP + QR |
| GET | `/api/settings/whatsapp/status` | Estado de conexión WPP |
| GET | `/api/yield/vacant-slots` | Huecos en la agenda |
| GET | `/api/yield/target-clients` | Clientes para Sillón Libre |
| POST | `/api/yield/send-flash-offer` | Envío masivo WhatsApp |
| GET | `/api/yield/churn/at-risk` | Clientes en fuga |
| POST | `/api/yield/churn/rescue/:id` | Enviar mensaje de rescate |
| GET | `/api/memberships` | Lista de membresías |
| GET | `/api/memberships/stats` | MRR y estadísticas |
| POST | `/api/memberships` | Crear membresía |
| POST | `/api/memberships/:id/checkin` | Usar crédito |
| PUT | `/api/memberships/:id/cancel` | Cancelar membresía |
| GET | `/health` | Health check |

---

## 🛠 Desarrollo local

```bash
cd backend
cp ../.env.example .env
# Editá .env con tus credenciales locales

npm install
npm run dev
```

Requiere PostgreSQL local o túnel a Railway (con `railway run`).
