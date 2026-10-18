-- ============================================================
-- Fix retroactivo: comisiones custom por servicio en Staff Colors
-- ============================================================
-- Corrige los turnos pasados que quedaron con commission_pct del barbero
-- en vez del commission_pct custom del servicio.
--
-- Pasos:
--   1) Correr PREVIEW primero para ver qué turnos cambiarían.
--   2) Si todo OK, correr el UPDATE (está dentro de BEGIN;).
--   3) Confirmar con COMMIT; o abortar con ROLLBACK;.
-- ============================================================

-- ─── 0) Verificar que el shop existe y tomar su ID ──────────
SELECT id, name, email, parent_shop_id
FROM shops
WHERE LOWER(name) LIKE '%staff colors%'
  AND parent_shop_id IS NULL;
-- → anotá el id devuelto. Debería ser uno solo.


-- ─── 1) PREVIEW: turnos que cambiarían ─────────────────────
-- Reemplazá <SHOP_ID> por el id del paso 0.
SELECT
  a.id,
  a.date,
  a.time_start,
  a.client_name,
  a.service_name,
  s.commission_pct   AS svc_custom_pct,
  a.commission_pct   AS pct_actual,
  a.price,
  ROUND(a.price * a.commission_pct / 100.0, 2) AS comision_actual,
  ROUND(a.price * s.commission_pct / 100.0, 2) AS comision_corregida,
  ROUND(a.price * (s.commission_pct - a.commission_pct) / 100.0, 2) AS diferencia,
  a.status,
  a.barber_name
FROM appointments a
JOIN services s ON s.id = a.service_id AND s.shop_id = a.shop_id
WHERE a.shop_id = <SHOP_ID>
  AND s.commission_pct IS NOT NULL
  AND a.commission_pct IS DISTINCT FROM s.commission_pct
  AND a.barber_id IS NOT NULL
ORDER BY a.date DESC, a.time_start DESC;


-- ─── 1.b) PREVIEW extra: commission_splits (walk-ins) afectados ──
-- Solo los walk-ins guardan snapshot. Los turnos "normales" calculan
-- la comisión on-the-fly con appointments.commission_pct, así que
-- se arreglan solos con el UPDATE del paso 2.
SELECT
  cs.id            AS split_id,
  cs.appointment_id,
  a.date,
  a.service_name,
  cs.total_price,
  cs.barber_pct    AS pct_viejo,
  s.commission_pct AS pct_nuevo,
  cs.barber_amount AS barber_viejo,
  ROUND(cs.total_price * s.commission_pct / 100.0, 2) AS barber_nuevo,
  cs.owner_amount  AS owner_viejo,
  ROUND(cs.total_price * (100 - s.commission_pct) / 100.0, 2) AS owner_nuevo
FROM commission_splits cs
JOIN appointments a ON a.id = cs.appointment_id
JOIN services s     ON s.id = a.service_id AND s.shop_id = a.shop_id
WHERE cs.shop_id = <SHOP_ID>
  AND s.commission_pct IS NOT NULL
  AND cs.barber_pct IS DISTINCT FROM s.commission_pct
ORDER BY a.date DESC;


-- ─── 2) UPDATE transaccional (turnos + splits) ─────────────
BEGIN;

-- 2.a) Corregir commission_pct en appointments
UPDATE appointments a
SET commission_pct = s.commission_pct
FROM services s
WHERE s.id = a.service_id
  AND s.shop_id = a.shop_id
  AND a.shop_id = <SHOP_ID>
  AND s.commission_pct IS NOT NULL
  AND a.commission_pct IS DISTINCT FROM s.commission_pct
  AND a.barber_id IS NOT NULL;

-- 2.b) Recalcular commission_splits (snapshots de walk-ins)
UPDATE commission_splits cs
SET barber_pct    = s.commission_pct,
    barber_amount = ROUND(cs.total_price * s.commission_pct / 100.0, 2),
    owner_amount  = ROUND(cs.total_price * (100 - s.commission_pct) / 100.0, 2)
FROM appointments a
JOIN services s ON s.id = a.service_id AND s.shop_id = a.shop_id
WHERE cs.appointment_id = a.id
  AND cs.shop_id = <SHOP_ID>
  AND s.commission_pct IS NOT NULL
  AND cs.barber_pct IS DISTINCT FROM s.commission_pct;

-- 2.c) Chequeos post-update
SELECT 'turnos_corregidos' AS tipo, COUNT(*) AS total
FROM appointments a
JOIN services s ON s.id = a.service_id AND s.shop_id = a.shop_id
WHERE a.shop_id = <SHOP_ID>
  AND s.commission_pct IS NOT NULL
  AND a.commission_pct = s.commission_pct
  AND a.barber_id IS NOT NULL
UNION ALL
SELECT 'splits_corregidos' AS tipo, COUNT(*) AS total
FROM commission_splits cs
JOIN appointments a ON a.id = cs.appointment_id
JOIN services s     ON s.id = a.service_id AND s.shop_id = a.shop_id
WHERE cs.shop_id = <SHOP_ID>
  AND s.commission_pct IS NOT NULL
  AND cs.barber_pct = s.commission_pct;

-- Si todo OK:
COMMIT;
-- Si algo salió mal:
-- ROLLBACK;


-- ─── NOTA sobre cash_registers ─────────────────────────────
-- La tabla cash_registers NO guarda totales de comisiones:
-- solo revenue_total / net_total / medios de pago. Esos valores
-- dependen del PRECIO, no del commission_pct, así que no hay
-- que recalcularla. Si en algún momento se agrega commission_total
-- al cierre de caja, habrá que extender este script.
