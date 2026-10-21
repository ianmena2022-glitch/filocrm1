-- Método con el que se entregó la propina (NULL = mismo que el del turno)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS tip_method VARCHAR(40);
