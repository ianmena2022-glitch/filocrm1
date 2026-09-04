UPDATE shops s1 SET is_barber = TRUE WHERE s1.parent_shop_id IS NULL AND s1.is_barber = FALSE AND EXISTS (SELECT 1 FROM appointments a WHERE a.barber_id = s1.id AND a.shop_id != s1.id);
