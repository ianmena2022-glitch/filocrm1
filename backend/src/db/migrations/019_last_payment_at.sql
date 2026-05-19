-- Fecha del último pago recibido (se actualiza en cada webhook de MP aprobado).
-- Backfill desde first_payment_at para no dejar vacío el dato de cuentas existentes.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS last_payment_at TIMESTAMPTZ DEFAULT NULL;
UPDATE shops SET last_payment_at = first_payment_at WHERE last_payment_at IS NULL AND first_payment_at IS NOT NULL;
