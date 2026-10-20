-- Panel de Promociones (admin): descuentos aplicables a signups/renovaciones

CREATE TABLE IF NOT EXISTS promotions (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(120) NOT NULL,
  code              VARCHAR(60) UNIQUE,
  discount_type     VARCHAR(20) NOT NULL CHECK (discount_type IN ('percent','fixed')),
  discount_value    NUMERIC(12,2) NOT NULL CHECK (discount_value >= 0),
  applies_to        VARCHAR(20) NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all','specific')),
  shop_ids          INTEGER[],                      -- solo si applies_to='specific'
  plans             TEXT[],                         -- NULL = cualquier plan
  renewable         BOOLEAN NOT NULL DEFAULT TRUE,  -- false = solo primera vez
  starts_at         TIMESTAMPTZ,
  ends_at           TIMESTAMPTZ,
  max_total_uses    INTEGER,                        -- NULL = ilimitado
  max_uses_per_shop INTEGER DEFAULT 1,
  status            VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promotions_status ON promotions (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_promotions_code   ON promotions (code) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS promotion_uses (
  id              SERIAL PRIMARY KEY,
  promotion_id    INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  shop_id         INTEGER NOT NULL REFERENCES shops(id)      ON DELETE CASCADE,
  payment_id      TEXT,
  plan            TEXT,
  original_amount NUMERIC(12,2),
  discount_amount NUMERIC(12,2),
  final_amount    NUMERIC(12,2),
  used_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_uses_promo ON promotion_uses (promotion_id);
CREATE INDEX IF NOT EXISTS idx_promo_uses_shop  ON promotion_uses (shop_id);

-- pending_transfers necesita conocer la promo para registrar uso al matchear
ALTER TABLE pending_transfers ADD COLUMN IF NOT EXISTS promotion_id INTEGER REFERENCES promotions(id) ON DELETE SET NULL;
