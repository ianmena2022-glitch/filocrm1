-- Recuperación de contraseña por mail: un código de 6 dígitos (guardado hasheado), vence en
-- 15 minutos, 5 intentos como máximo y se usa una sola vez.
CREATE TABLE IF NOT EXISTS password_resets (
  id          SERIAL PRIMARY KEY,
  shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_resets_shop ON password_resets (shop_id, created_at DESC);
