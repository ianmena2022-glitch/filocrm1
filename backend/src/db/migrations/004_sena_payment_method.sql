-- Método de pago para señas (configurable por barbería)
ALTER TABLE shops ADD COLUMN IF NOT EXISTS sena_payment_method VARCHAR(100) DEFAULT 'transfer';
