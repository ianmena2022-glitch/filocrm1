-- Registros pendientes de verificación de email
-- La cuenta real se crea SOLO después de verificar el código
CREATE TABLE IF NOT EXISTS pending_registrations (
  id              SERIAL PRIMARY KEY,
  email           VARCHAR(255) NOT NULL UNIQUE,
  name            VARCHAR(255) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  phone           VARCHAR(50),
  filo_plan       VARCHAR(50)  NOT NULL DEFAULT 'starter',
  vendor_id       INTEGER,
  referral_code   VARCHAR(50),
  timezone        VARCHAR(100) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  is_enterprise   BOOLEAN      NOT NULL DEFAULT FALSE,
  verify_code     VARCHAR(6)   NOT NULL,
  verify_expires  TIMESTAMPTZ  NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Limpiar pendientes expirados automáticamente (más de 30 min)
CREATE INDEX IF NOT EXISTS idx_pending_reg_email   ON pending_registrations (email);
CREATE INDEX IF NOT EXISTS idx_pending_reg_expires ON pending_registrations (verify_expires);
