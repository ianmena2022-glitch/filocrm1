CREATE TABLE IF NOT EXISTS app_settings (key VARCHAR(100) PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
INSERT INTO app_settings (key, value) VALUES ('welcome_wpp_enabled', 'false') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('welcome_wpp_shop_id', '') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('welcome_wpp_message', E'¡Hola {nombre}! 👋\n\nBienvenido a *FILO CRM* ✂️\n\nTu cuenta ya está activa. Empezá a usar FILO acá:\n{link}\n\nCualquier duda, respondé este mensaje.') ON CONFLICT (key) DO NOTHING;
