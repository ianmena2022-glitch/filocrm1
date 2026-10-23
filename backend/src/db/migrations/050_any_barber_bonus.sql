-- Bonus de puntos por elegir "cualquier profesional" (lo activa el dueño y elige el %)
ALTER TABLE shops ADD COLUMN IF NOT EXISTS any_barber_bonus_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS any_barber_bonus_pct INTEGER NOT NULL DEFAULT 20;
-- El turno / lugar en la fila se pidió con "cualquier profesional"
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS any_barber BOOLEAN NOT NULL DEFAULT FALSE;
-- Puntos extra que se dieron por el bonus (para poder descontarlos si se anula el cobro)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS bonus_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS any_barber BOOLEAN NOT NULL DEFAULT FALSE;
