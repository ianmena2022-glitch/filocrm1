-- Fix: custom payment methods per barbershop
-- Ejecutar una vez en la base de datos de producción

CREATE TABLE IF NOT EXISTS payment_methods (
  id          SERIAL PRIMARY KEY,
  shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  key         VARCHAR(50)  NOT NULL,
  label       VARCHAR(100) NOT NULL,
  icon        VARCHAR(10)  NOT NULL DEFAULT '💳',
  is_debt     BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(shop_id, key)
);
CREATE INDEX IF NOT EXISTS idx_payment_methods_shop ON payment_methods(shop_id);
