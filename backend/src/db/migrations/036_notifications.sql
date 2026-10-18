-- Sistema de notificaciones in-app.
-- recipient_shop_id puede ser el dueño o un barbero (los barberos son shops
-- con is_barber=TRUE). shop_id es el shop "contexto" (la barbería/sucursal).

CREATE TABLE IF NOT EXISTS notifications (
  id             SERIAL PRIMARY KEY,
  shop_id        INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  recipient_shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT,
  icon           TEXT,
  link           TEXT,
  read           BOOLEAN NOT NULL DEFAULT FALSE,
  read_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_recipient_unread
  ON notifications (recipient_shop_id, created_at DESC)
  WHERE read = FALSE;

CREATE INDEX IF NOT EXISTS idx_notif_recipient
  ON notifications (recipient_shop_id, created_at DESC);
