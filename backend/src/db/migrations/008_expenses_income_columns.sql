-- Agregar columnas faltantes en expenses para registrar ingresos por ventas de productos
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS is_income      BOOLEAN       DEFAULT FALSE;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS source_type   VARCHAR(50)   DEFAULT NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS source_id     INT           DEFAULT NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method VARCHAR(100) DEFAULT NULL;
