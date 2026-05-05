-- Verificación de email por código de 6 dígitos
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS email_verified       BOOLEAN   NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_verify_code    VARCHAR(6),
  ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMPTZ;

-- Cuentas ya existentes: marcadas como verificadas para no bloquearlas
UPDATE shops SET email_verified = TRUE WHERE email_verified = FALSE;
