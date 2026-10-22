-- Promociones que dan días de prueba gratis (total de días de trial al registrarse con el código)
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS trial_days INTEGER;
ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS promo_code VARCHAR(60);
