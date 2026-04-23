-- ============================================================
-- FILO CRM — Row Level Security (multi-tenant isolation)
-- Run once against the production database.
-- ============================================================
--
-- Strategy
-- --------
-- All shop-scoped tables get RLS enabled.  Policies read the
-- session variable  app.shop_id  (an integer stored as text)
-- that the Node.js pool sets via AsyncLocalStorage before each
-- query in an authenticated request.
--
-- We do NOT use FORCE ROW LEVEL SECURITY here — the DB owner
-- (app service user) still bypasses RLS, so zero code changes
-- are required for existing routes.  Public/booking endpoints
-- that don't go through the auth middleware keep working as-is.
--
-- Once every route is migrated to the AsyncLocalStorage pattern
-- you can flip FORCE on a table with:
--   ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
-- ============================================================

-- ── Helper: safe cast for current_setting ──────────────────
-- Returns NULL if the variable is not set / is empty.
CREATE OR REPLACE FUNCTION current_shop_id() RETURNS INT
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.shop_id', true), '')::INT;
$$;

-- ── clients ────────────────────────────────────────────────
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_clients ON clients;
CREATE POLICY rls_clients ON clients
  USING (shop_id = current_shop_id());

-- ── services ───────────────────────────────────────────────
ALTER TABLE services ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_services ON services;
CREATE POLICY rls_services ON services
  USING (shop_id = current_shop_id());

-- ── appointments ───────────────────────────────────────────
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_appointments ON appointments;
CREATE POLICY rls_appointments ON appointments
  USING (shop_id = current_shop_id());

-- ── memberships ────────────────────────────────────────────
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_memberships ON memberships;
CREATE POLICY rls_memberships ON memberships
  USING (shop_id = current_shop_id());

-- ── whatsapp_logs ──────────────────────────────────────────
ALTER TABLE whatsapp_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_whatsapp_logs ON whatsapp_logs;
CREATE POLICY rls_whatsapp_logs ON whatsapp_logs
  USING (shop_id = current_shop_id());

-- ── points_store ───────────────────────────────────────────
ALTER TABLE points_store ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_points_store ON points_store;
CREATE POLICY rls_points_store ON points_store
  USING (shop_id = current_shop_id());

-- ── points_redemptions ─────────────────────────────────────
ALTER TABLE points_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_points_redemptions ON points_redemptions;
CREATE POLICY rls_points_redemptions ON points_redemptions
  USING (shop_id = current_shop_id());

-- ── staff_invites ──────────────────────────────────────────
ALTER TABLE staff_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_staff_invites ON staff_invites;
CREATE POLICY rls_staff_invites ON staff_invites
  USING (shop_id = current_shop_id());

-- ── commission_splits ──────────────────────────────────────
ALTER TABLE commission_splits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_commission_splits ON commission_splits;
CREATE POLICY rls_commission_splits ON commission_splits
  USING (shop_id = current_shop_id());

-- ── expenses ───────────────────────────────────────────────
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_expenses ON expenses;
CREATE POLICY rls_expenses ON expenses
  USING (shop_id = current_shop_id());

-- ── cash_registers ─────────────────────────────────────────
ALTER TABLE cash_registers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_cash_registers ON cash_registers;
CREATE POLICY rls_cash_registers ON cash_registers
  USING (shop_id = current_shop_id());

-- ── client_debts ───────────────────────────────────────────
ALTER TABLE client_debts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_client_debts ON client_debts;
CREATE POLICY rls_client_debts ON client_debts
  USING (shop_id = current_shop_id());

-- ── products ───────────────────────────────────────────────
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_products ON products;
CREATE POLICY rls_products ON products
  USING (shop_id = current_shop_id());

-- ── product_sales ──────────────────────────────────────────
ALTER TABLE product_sales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_product_sales ON product_sales;
CREATE POLICY rls_product_sales ON product_sales
  USING (shop_id = current_shop_id());

-- ── product_stock_movements ────────────────────────────────
ALTER TABLE product_stock_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_product_stock_movements ON product_stock_movements;
CREATE POLICY rls_product_stock_movements ON product_stock_movements
  USING (shop_id = current_shop_id());

-- ── queue_entries ──────────────────────────────────────────
ALTER TABLE queue_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_queue_entries ON queue_entries;
CREATE POLICY rls_queue_entries ON queue_entries
  USING (shop_id = current_shop_id());

-- ── recurring_appointments ─────────────────────────────────
ALTER TABLE recurring_appointments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_recurring_appointments ON recurring_appointments;
CREATE POLICY rls_recurring_appointments ON recurring_appointments
  USING (shop_id = current_shop_id());

-- ============================================================
-- Done.  Verify with:
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'public' AND rowsecurity = true;
-- ============================================================
