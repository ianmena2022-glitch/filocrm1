-- Turnos recurrentes (clientes fijos)
CREATE TABLE IF NOT EXISTS recurring_appointments (
  id            SERIAL PRIMARY KEY,
  shop_id       INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  client_id     INT REFERENCES clients(id) ON DELETE SET NULL,
  client_name   VARCHAR(200) NOT NULL,
  client_phone  VARCHAR(50),
  barber_id     INT REFERENCES shops(id) ON DELETE SET NULL,
  service_id    INT REFERENCES services(id) ON DELETE SET NULL,
  service_name  VARCHAR(200),
  service_price NUMERIC(10,2) DEFAULT 0,
  duration_mins INT DEFAULT 30,
  day_of_week   SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  time_start    VARCHAR(5) NOT NULL,
  every_weeks   SMALLINT NOT NULL DEFAULT 1 CHECK (every_weeks BETWEEN 1 AND 8),
  active        BOOLEAN DEFAULT TRUE,
  notes         VARCHAR(500),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Vincular turnos generados con su regla de recurrencia
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS recurring_id INT REFERENCES recurring_appointments(id) ON DELETE SET NULL;
