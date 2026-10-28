-- El recordatorio se configura en minutos (de 20 min a 1 día). Reemplaza a reminder_hours.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS reminder_minutes INTEGER DEFAULT 120;

UPDATE shops SET reminder_minutes = LEAST(1440, GREATEST(20, ROUND(reminder_hours * 60)::int))
 WHERE reminder_hours IS NOT NULL;
