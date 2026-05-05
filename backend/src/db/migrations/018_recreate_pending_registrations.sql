CREATE TABLE IF NOT EXISTS pending_registrations (
  id              SERIAL PRIMARY KEY,
  email           VARCHAR(255) NOT NULL UNIQUE,
  name            VARCHAR(255) NOT NULL DEFAULT '',
  password_hash   VARCHAR(255) NOT NULL DEFAULT '',
  phone           VARCHAR(50),
  filo_plan       VARCHAR(50)  NOT NULL DEFAULT 'starter',
  vendor_id       INTEGER,
  referral_code   VARCHAR(50),
  timezone        VARCHAR(100) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  is_enterprise   BOOLEAN      NOT NULL DEFAULT FALSE,
  verify_code     VARCHAR(6)   NOT NULL DEFAULT '',
  verify_expires  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE pending_registrations
  ADD COLUMN IF NOT EXISTS name          VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone         VARCHAR(50),
  ADD COLUMN IF NOT EXISTS filo_plan     VARCHAR(50)  NOT NULL DEFAULT 'starter',
  ADD COLUMN IF NOT EXISTS vendor_id     INTEGER,
  ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS timezone      VARCHAR(100) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  ADD COLUMN IF NOT EXISTS is_enterprise BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verify_code   VARCHAR(6)   NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS verify_expires TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_pending_reg_email   ON pending_registrations (email);
CREATE INDEX IF NOT EXISTS idx_pending_reg_expires ON pending_registrations (verify_expires);
