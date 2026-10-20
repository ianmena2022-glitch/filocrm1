-- Fix sistema de puntos:
-- 1. Columna stock faltante en points_store (código ya la usa)
-- 2. Link appointment_id en points_redemptions para rollback al cancelar
-- 3. Índices para queries recurrentes

ALTER TABLE points_store
  ADD COLUMN IF NOT EXISTS stock INTEGER;

ALTER TABLE points_redemptions
  ADD COLUMN IF NOT EXISTS appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_points_redemptions_appt
  ON points_redemptions (appointment_id)
  WHERE appointment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_points_redemptions_client
  ON points_redemptions (client_id, shop_id, created_at DESC);
