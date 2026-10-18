-- Web Push: suscripciones del browser por usuario (shop).
-- Un usuario puede tener múltiples suscripciones (desktop + celular, etc).

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          SERIAL PRIMARY KEY,
  shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_sub_shop ON push_subscriptions (shop_id);
