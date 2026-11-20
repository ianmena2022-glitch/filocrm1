-- Turnos con más de un servicio. service_id sigue siendo el primero (para lo que ya lo usa);
-- service_ids guarda todos, en el orden elegido. service_name, price, cost y la duración ya
-- vienen sumados en el turno.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_ids INT[];
