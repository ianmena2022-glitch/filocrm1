-- Multi-método de pago para cobros (appointments) y liquidaciones (settlements).
-- Si existe al menos 1 fila para un appointment, se asume 'mixed' y la caja
-- usa estas filas en vez de appointments.payment_method.

CREATE TABLE IF NOT EXISTS payment_splits (
  id              SERIAL PRIMARY KEY,
  shop_id         INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  appointment_id  INTEGER REFERENCES appointments(id)   ON DELETE CASCADE,
  settlement_id   INTEGER REFERENCES barber_settlements(id) ON DELETE CASCADE,
  expense_id      INTEGER REFERENCES expenses(id)       ON DELETE CASCADE,
  method          VARCHAR(40) NOT NULL,
  amount          NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Al menos uno de los links debe existir
  CONSTRAINT splits_has_source CHECK (
    appointment_id IS NOT NULL OR settlement_id IS NOT NULL OR expense_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_splits_appt      ON payment_splits (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_splits_settle    ON payment_splits (settlement_id)  WHERE settlement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_splits_expense   ON payment_splits (expense_id)     WHERE expense_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_splits_shop_date ON payment_splits (shop_id, created_at DESC);
