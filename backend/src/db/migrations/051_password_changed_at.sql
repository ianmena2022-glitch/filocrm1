-- Fecha del último cambio de contraseña (las sesiones abiertas antes del cambio se cierran)
ALTER TABLE shops ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
