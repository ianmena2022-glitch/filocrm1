-- Suscripciones Web Push para el panel de administración FILO.
-- Separadas de push_subscriptions porque no están asociadas a un shop.

CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
  id          SERIAL PRIMARY KEY,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
