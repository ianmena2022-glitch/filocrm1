-- Archivado manual desde el admin: NULL = automático (vencida hace más de 30 días), TRUE = archivada a mano, FALSE = forzada a la lista principal
ALTER TABLE shops ADD COLUMN IF NOT EXISTS archived_manual BOOLEAN;
