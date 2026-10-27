-- Reparación: el aplicador de migraciones viejo descartaba una sentencia si venía precedida por
-- un comentario. Por eso 045 (tip_method) y parte de 040 (índices) figuran aplicadas pero no
-- existen en producción. Todo es idempotente.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS tip_method VARCHAR(40);

CREATE INDEX IF NOT EXISTS idx_shops_sub_status_trial
  ON shops (subscription_status, trial_ends_at)
  WHERE subscription_status IN ('trial','active','expired');

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created
  ON notifications (recipient_shop_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread
  ON notifications (recipient_shop_id)
  WHERE read = FALSE;

CREATE INDEX IF NOT EXISTS idx_pending_transfers_active
  ON pending_transfers (expires_at)
  WHERE matched = FALSE;

-- Zonas horarias con nombres viejos que Postgres 18 ya no reconoce ('America/Buenos_Aires',
-- 'America/Cordoba', …). Una sola barbería con un nombre así hacía fallar la consulta de
-- recordatorios de TODAS las barberías.
UPDATE shops SET timezone = 'America/Argentina/' || substring(timezone from 9)
 WHERE timezone IN ('America/Buenos_Aires','America/Cordoba','America/Catamarca','America/Jujuy',
                    'America/Mendoza','America/Rosario','America/ComodRivadavia');

UPDATE shops SET timezone = 'America/Argentina/Cordoba' WHERE timezone = 'America/Argentina/Rosario';

UPDATE shops SET timezone = 'America/Argentina/Buenos_Aires'
 WHERE timezone IS NOT NULL
   AND timezone NOT IN (SELECT name FROM pg_timezone_names);
