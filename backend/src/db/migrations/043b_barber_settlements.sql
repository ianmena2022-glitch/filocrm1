-- La tabla de liquidaciones nunca tuvo migración (existía solo en producción).
-- IF NOT EXISTS: no cambia nada donde ya existe.
CREATE TABLE IF NOT EXISTS barber_settlements (
  id                 SERIAL PRIMARY KEY,
  shop_id            INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  barber_id          INTEGER,
  barber_name        VARCHAR(200),
  appointments_count INTEGER,
  total_price        NUMERIC(12,2),
  commission_pct_avg NUMERIC,
  commission_amount  NUMERIC(12,2),
  notes              TEXT,
  settled_at         TIMESTAMPTZ DEFAULT NOW()
);
