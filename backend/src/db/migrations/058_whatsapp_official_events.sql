-- Eventos del webhook de WhatsApp (API oficial de Meta): se guardan tal cual llegan
CREATE TABLE IF NOT EXISTS whatsapp_official_events (
  id              SERIAL PRIMARY KEY,
  waba_id         VARCHAR(40),
  phone_number_id VARCHAR(40),
  field           VARCHAR(40),
  payload         JSONB,
  received_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_official_events_phone ON whatsapp_official_events(phone_number_id, received_at);
