CREATE TABLE IF NOT EXISTS prospects (
  id           SERIAL PRIMARY KEY,
  shop_id      INT REFERENCES shops(id) ON DELETE CASCADE,
  phone        VARCHAR(30)  NOT NULL,
  name         VARCHAR(255),
  city         VARCHAR(255),
  message_sent TEXT,
  sent_at      TIMESTAMPTZ  DEFAULT NOW(),
  replied_at   TIMESTAMPTZ,
  reply_count  INT          DEFAULT 0,
  converted    BOOLEAN      DEFAULT FALSE,
  conversation JSONB        DEFAULT '[]'::jsonb,
  UNIQUE(shop_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_prospects_shop_phone ON prospects(shop_id, phone);
