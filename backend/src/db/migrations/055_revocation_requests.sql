-- Botón de arrepentimiento (Res. SCI 424/2020): pedidos de revocación de la contratación.
-- Se puede pedir sin iniciar sesión; cada pedido recibe un código de constancia.
CREATE TABLE IF NOT EXISTS revocation_requests (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(20) UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT,
  reason      TEXT,
  shop_id     INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
