-- Avisos automáticos a cuentas en prueba que no arrancan (WhatsApp desde el número de FILO)
-- y alertas al admin. Cada aviso sale una sola vez por cuenta y canal.
CREATE TABLE IF NOT EXISTS trial_nudges (
  shop_id  INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  kind     VARCHAR(20) NOT NULL,   -- setup | no_bookings | ending | expired
  channel  VARCHAR(10) NOT NULL,   -- wpp | admin
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (shop_id, kind, channel)
);

INSERT INTO app_settings (key, value) VALUES ('trial_nudges_enabled', 'true') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('trial_alerts_enabled', 'true') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('trial_nudge_setup', E'¡Hola {nombre}! Soy Ian, de FILO 👋\n\nVi que todavía no terminaste de armar tu agenda (servicios y horarios). ¿Lo hacemos juntos? En 10 minutos te queda lista.\n\nSi preferís hacerlo solo, al entrar vas a ver los *Primeros pasos*: {link}') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('trial_nudge_no_bookings', E'¡Hola {nombre}! ¿Cómo venís con FILO?\n\nTodavía no te entró ningún turno online. Lo que mejor funciona: poné tu link de reservas en la bio de Instagram y pasáselo a tus clientes por WhatsApp:\n{link_reservas}\n\nSi querés, te ayudo a dejarlo andando 🙌') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('trial_nudge_ending', E'¡Hola {nombre}! Tu prueba de FILO termina {cuando}.\n\nHasta ahora cargaste {turnos} turnos. Para seguir sin cortes, elegí tu plan acá: {link}\n\nCualquier duda, escribime por acá.') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('trial_nudge_expired', E'¡Hola {nombre}! Tu prueba de FILO terminó.\n\nSi no llegaste a probarlo bien, te doy unos días más y lo configuramos juntos. ¿Te sirve? Respondeme por acá 🙌') ON CONFLICT (key) DO NOTHING;
