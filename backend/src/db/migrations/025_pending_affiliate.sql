ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS affiliate_id INT REFERENCES affiliates(id) ON DELETE SET NULL;
