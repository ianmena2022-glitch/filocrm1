-- Orden de los servicios elegido por la barbería (se arrastran en Configuración).
-- NULL = todavía no se ordenó: se muestran por nombre, como hasta ahora.
ALTER TABLE services ADD COLUMN IF NOT EXISTS sort_order INTEGER;
