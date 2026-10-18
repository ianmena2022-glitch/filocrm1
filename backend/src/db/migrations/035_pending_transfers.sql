-- Órdenes de pago por transferencia con auto-detección por monto único (cents).
-- Cada orden suma centavos random al precio base para que el monto sea único
-- entre las órdenes pending dentro de un timeframe. Cuando MP notifica un
-- payment entrante por bank_transfer o account_money, matcheamos por monto.

CREATE TABLE IF NOT EXISTS pending_transfers (
  id            SERIAL PRIMARY KEY,
  shop_id       INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  plan          TEXT    NOT NULL,
  amount_cents  INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  matched       BOOLEAN NOT NULL DEFAULT FALSE,
  matched_at    TIMESTAMPTZ,
  mp_payment_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_transfers_match
  ON pending_transfers (amount_cents, matched, expires_at)
  WHERE matched = FALSE;

CREATE INDEX IF NOT EXISTS idx_pending_transfers_shop
  ON pending_transfers (shop_id, created_at DESC);
