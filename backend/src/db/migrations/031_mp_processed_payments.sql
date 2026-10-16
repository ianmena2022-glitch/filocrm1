CREATE TABLE IF NOT EXISTS mp_processed_payments (payment_id TEXT PRIMARY KEY, shop_id INT, plan TEXT, amount NUMERIC(12,2), processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_mp_processed_payments_shop ON mp_processed_payments(shop_id);
