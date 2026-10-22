-- Cuentas que no cuentan en los KPIs del panel admin (tests o locales de socios)
ALTER TABLE shops ADD COLUMN IF NOT EXISTS exclude_from_kpis BOOLEAN NOT NULL DEFAULT FALSE;
