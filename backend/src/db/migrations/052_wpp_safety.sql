-- WhatsApp: número bloqueado por WhatsApp, modo cuidado y qué mensajes automáticos manda cada local
ALTER TABLE shops ADD COLUMN IF NOT EXISTS wpp_banned_at TIMESTAMPTZ;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS wpp_careful_until TIMESTAMPTZ;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS wpp_auto_prefs JSONB;
