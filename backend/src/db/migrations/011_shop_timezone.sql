-- Timezone por local: permite que el sistema use la hora correcta según el país del negocio
ALTER TABLE shops ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) DEFAULT 'America/Argentina/Buenos_Aires';
