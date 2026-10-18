-- Links sociales mostrados en la página de reserva pública
ALTER TABLE shops ADD COLUMN IF NOT EXISTS social_links JSONB NOT NULL DEFAULT '{}'::jsonb;
