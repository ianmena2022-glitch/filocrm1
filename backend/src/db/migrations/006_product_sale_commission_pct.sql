-- Comisión separada para ventas de productos por barbero
ALTER TABLE shops ADD COLUMN IF NOT EXISTS product_sale_commission_pct NUMERIC(5,2) DEFAULT NULL;
