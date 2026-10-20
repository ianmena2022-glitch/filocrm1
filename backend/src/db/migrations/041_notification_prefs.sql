-- Preferencias de notificaciones por shop (toasts, campana, push, banners de upsell).
-- '{}' = todo habilitado por default (comportamiento actual).
ALTER TABLE shops ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
