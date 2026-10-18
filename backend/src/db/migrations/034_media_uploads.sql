-- ============================================================
-- 034: Media uploads (Cloudinary) para branding de la barbería
--      y portfolio de barberos.
-- ============================================================

-- Branding del shop (dueño). Aplica a filas con parent_shop_id IS NULL.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS profile_photo_url  TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS banner_photo_url   TEXT;

-- Permiso para que los barberos suban/editen sus propias fotos
ALTER TABLE shops ADD COLUMN IF NOT EXISTS barber_self_upload_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Portfolio de cada barbero (filas con is_barber=TRUE):
--   - profile_photo_url ya aplica también (misma columna)
--   - work_photos: array JSONB de URLs, orden preserva posición en el grid.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS work_photos JSONB NOT NULL DEFAULT '[]'::jsonb;
