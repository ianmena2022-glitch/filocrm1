-- Insumos: se cargan en la misma pantalla que los productos, pero no se venden
-- (sin precio de venta). Se descuentan del stock al completar un turno.
ALTER TABLE products ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'producto';

-- Qué turno consumió el insumo (para el historial de movimientos)
ALTER TABLE product_stock_movements ADD COLUMN IF NOT EXISTS appointment_id INT REFERENCES appointments(id) ON DELETE SET NULL;

-- Interruptor: preguntar qué insumos se usaron cada vez que se completa un turno
ALTER TABLE shops ADD COLUMN IF NOT EXISTS supplies_per_appt BOOLEAN NOT NULL DEFAULT FALSE;
