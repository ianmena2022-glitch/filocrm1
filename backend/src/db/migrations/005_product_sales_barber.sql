-- Comisión de barbero en ventas de productos
ALTER TABLE product_sales ADD COLUMN IF NOT EXISTS barber_id INTEGER REFERENCES shops(id) ON DELETE SET NULL;
ALTER TABLE product_sales ADD COLUMN IF NOT EXISTS barber_commission_pct NUMERIC(5,2) DEFAULT 0;
ALTER TABLE product_sales ADD COLUMN IF NOT EXISTS barber_commission_amount NUMERIC(10,2) DEFAULT 0;
ALTER TABLE product_sales ADD COLUMN IF NOT EXISTS commission_settled BOOLEAN DEFAULT FALSE;
ALTER TABLE product_sales ADD COLUMN IF NOT EXISTS settlement_id INTEGER;
-- Fix the VARCHAR(20) constraint on payment_method (same as migration 003 did for appointments)
ALTER TABLE product_sales ALTER COLUMN payment_method TYPE VARCHAR(100);
