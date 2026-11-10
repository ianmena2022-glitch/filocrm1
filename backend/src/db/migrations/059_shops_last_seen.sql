-- Última vez que la cuenta usó FILO (cualquier pedido con sesión iniciada). Se ve en el admin
-- para saber si las cuentas de prueba realmente usan la app.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
