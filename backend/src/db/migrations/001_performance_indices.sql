-- Fix #16: índices de performance para queries frecuentes
-- Ejecutar una vez en la base de datos de producción

-- Turnos por shop y fecha (query más frecuente del sistema)
CREATE INDEX IF NOT EXISTS idx_appointments_shop_date
  ON appointments (shop_id, date);

-- Turnos waiting_sena (para verificación de comprobantes y expiración en scheduler)
CREATE INDEX IF NOT EXISTS idx_appointments_waiting_sena
  ON appointments (shop_id, status)
  WHERE status = 'waiting_sena';

-- Turnos por barbero y fecha
CREATE INDEX IF NOT EXISTS idx_appointments_barber_date
  ON appointments (barber_id, date)
  WHERE barber_id IS NOT NULL;

-- Turnos pendientes de recordatorio
CREATE INDEX IF NOT EXISTS idx_appointments_reminder
  ON appointments (date, time_start)
  WHERE reminder_sent_at IS NULL AND status IN ('pending', 'confirmed');

-- Clientes por shop y teléfono (búsqueda frecuente en booking y WPP)
CREATE INDEX IF NOT EXISTS idx_clients_shop_phone
  ON clients (shop_id, phone);

-- Membresías activas por shop
CREATE INDEX IF NOT EXISTS idx_memberships_shop_active
  ON memberships (shop_id, payment_status)
  WHERE active = TRUE;

-- Shops por parent_enterprise_id (queries de sucursales)
CREATE INDEX IF NOT EXISTS idx_shops_parent_enterprise
  ON shops (parent_enterprise_id)
  WHERE parent_enterprise_id IS NOT NULL;

-- Shops por booking_slug (lookup en cada request de booking)
CREATE INDEX IF NOT EXISTS idx_shops_booking_slug
  ON shops (booking_slug)
  WHERE booking_slug IS NOT NULL;
