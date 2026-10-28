-- Cuántas horas antes del turno sale el recordatorio por WhatsApp (configurable por local)
ALTER TABLE shops ADD COLUMN IF NOT EXISTS reminder_hours NUMERIC(4,1) DEFAULT 2;
