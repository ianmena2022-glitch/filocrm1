-- FILO CRM — Schema PostgreSQL

CREATE TABLE IF NOT EXISTS shops (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  email             VARCHAR(255) UNIQUE NOT NULL,
  password          VARCHAR(255) NOT NULL,
  phone             VARCHAR(50),
  city              VARCHAR(100),
  address           VARCHAR(255),
  calendly_url      TEXT,
  service_radius_km INT DEFAULT 3,
  churn_days        INT DEFAULT 20,
  wpp_session       VARCHAR(100),
  wpp_connected     BOOLEAN DEFAULT FALSE,
  logo_url          TEXT,
  msg_templates     TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id           SERIAL PRIMARY KEY,
  shop_id      INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  phone        VARCHAR(50),
  notes        TEXT,
  total_visits INT DEFAULT 0,
  total_spent  NUMERIC(10,2) DEFAULT 0,
  last_visit   DATE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS services (
  id               SERIAL PRIMARY KEY,
  shop_id          INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name             VARCHAR(255) NOT NULL,
  price            NUMERIC(10,2) NOT NULL DEFAULT 0,
  cost             NUMERIC(10,2) DEFAULT 0,
  duration_minutes INT DEFAULT 30,
  active           BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS appointments (
  id             SERIAL PRIMARY KEY,
  shop_id        INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  client_id      INT REFERENCES clients(id) ON DELETE SET NULL,
  client_name    VARCHAR(255),
  service_id     INT REFERENCES services(id) ON DELETE SET NULL,
  service_name   VARCHAR(255),
  price          NUMERIC(10,2) DEFAULT 0,
  cost           NUMERIC(10,2) DEFAULT 0,
  date           DATE NOT NULL,
  time_start     TIME NOT NULL,
  time_end       TIME,
  barber_name    VARCHAR(100),
  commission_pct INT DEFAULT 50,
  status         VARCHAR(20) DEFAULT 'pending'
                 CHECK (status IN ('pending','confirmed','completed','noshow','cancelled')),
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memberships (
  id              SERIAL PRIMARY KEY,
  shop_id         INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  client_id       INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  plan            VARCHAR(20) NOT NULL CHECK (plan IN ('basic','premium')),
  price_monthly   NUMERIC(10,2) DEFAULT 0,
  credits_total   INT DEFAULT 2,
  credits_used    INT DEFAULT 0,
  active          BOOLEAN DEFAULT TRUE,
  started_at      DATE DEFAULT CURRENT_DATE,
  renews_at       DATE,
  cancelled_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_logs (
  id         SERIAL PRIMARY KEY,
  shop_id    INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  client_id  INT REFERENCES clients(id) ON DELETE SET NULL,
  phone      VARCHAR(50),
  message    TEXT,
  type       VARCHAR(50),
  status     VARCHAR(20) DEFAULT 'sent',
  sent_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_shop_date ON appointments(shop_id, date);
CREATE INDEX IF NOT EXISTS idx_clients_shop             ON clients(shop_id);
CREATE INDEX IF NOT EXISTS idx_memberships_shop         ON memberships(shop_id, active);

ALTER TABLE shops ADD COLUMN IF NOT EXISTS msg_templates TEXT;

ALTER TABLE shops ADD COLUMN IF NOT EXISTS booking_slug VARCHAR(100) UNIQUE;

-- Sistema de Puntos FILO
ALTER TABLE clients ADD COLUMN IF NOT EXISTS points INT DEFAULT 0;

CREATE TABLE IF NOT EXISTS points_store (
  id          SERIAL PRIMARY KEY,
  shop_id     INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  points_cost INT NOT NULL DEFAULT 100,
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS points_redemptions (
  id          SERIAL PRIMARY KEY,
  shop_id     INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  client_id   INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  item_id     INT REFERENCES points_store(id) ON DELETE SET NULL,
  item_name   VARCHAR(255),
  points_used INT NOT NULL,
  status      VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','used','cancelled')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE shops ADD COLUMN IF NOT EXISTS points_per_peso NUMERIC(6,4) DEFAULT 0.01;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS store_name VARCHAR(255) DEFAULT 'Tienda FILO';

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS redeem_info VARCHAR(255);
