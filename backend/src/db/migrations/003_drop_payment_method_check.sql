-- Eliminar constraints que limitan payment_method a valores hardcodeados
-- Necesario para soportar métodos de pago personalizados por barbería

ALTER TABLE appointments   DROP CONSTRAINT IF EXISTS appointments_payment_method_check;
ALTER TABLE queue_entries  DROP CONSTRAINT IF EXISTS queue_entries_payment_method_check;

-- Ampliar el largo del campo para admitir keys más largos (ej: "mercado_pago")
ALTER TABLE appointments  ALTER COLUMN payment_method TYPE VARCHAR(100);
ALTER TABLE queue_entries ALTER COLUMN payment_method TYPE VARCHAR(100);
