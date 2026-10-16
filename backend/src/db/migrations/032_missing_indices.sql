CREATE INDEX IF NOT EXISTS idx_appointments_shop_date_status ON appointments(shop_id, date, status);
CREATE INDEX IF NOT EXISTS idx_expenses_shop_date ON expenses(shop_id, date);
CREATE INDEX IF NOT EXISTS idx_memberships_shop_payment_created ON memberships(shop_id, payment_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prospects_shop_phone ON prospects(shop_id, phone);
CREATE INDEX IF NOT EXISTS idx_appointments_shop_barber_date ON appointments(shop_id, barber_id, date);
CREATE INDEX IF NOT EXISTS idx_product_sales_shop_settled ON product_sales(shop_id, commission_settled);
