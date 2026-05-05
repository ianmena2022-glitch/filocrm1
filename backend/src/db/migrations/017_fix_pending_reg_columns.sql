-- Agregar columnas faltantes a pending_registrations si no existen
ALTER TABLE pending_registrations
  ADD COLUMN IF NOT EXISTS password_hash  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS phone          VARCHAR(50),
  ADD COLUMN IF NOT EXISTS filo_plan      VARCHAR(50)  NOT NULL DEFAULT 'starter',
  ADD COLUMN IF NOT EXISTS vendor_id      INTEGER,
  ADD COLUMN IF NOT EXISTS referral_code  VARCHAR(50),
  ADD COLUMN IF NOT EXISTS timezone       VARCHAR(100) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  ADD COLUMN IF NOT EXISTS is_enterprise  BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verify_code    VARCHAR(6),
  ADD COLUMN IF NOT EXISTS verify_expires TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW();
