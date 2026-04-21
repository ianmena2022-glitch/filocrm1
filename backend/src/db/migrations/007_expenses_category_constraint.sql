-- Eliminar restricción CHECK de categoría en expenses para permitir 'ventas', 'comisiones', etc.
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_category_check;
-- Ampliar también cualquier variante de nombre que pueda tener la constraint
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'expenses'::regclass AND contype = 'c' AND conname ILIKE '%category%'
  LOOP
    EXECUTE 'ALTER TABLE expenses DROP CONSTRAINT IF EXISTS ' || quote_ident(r.conname);
  END LOOP;
END$$;
