-- Aviso "faltan 2 días de prueba": con {resumen} el texto se adapta si la cuenta no cargó ningún turno.
-- Solo reemplaza el texto original; si ya se editó desde el admin, no se toca.
UPDATE app_settings
   SET value = E'¡Hola {nombre}! Tu prueba de FILO termina {cuando}.\n\n{resumen}\n\nPara seguir sin cortes, elegí tu plan acá: {link}\n\nCualquier duda, escribime por acá.',
       updated_at = NOW()
 WHERE key = 'trial_nudge_ending'
   AND value = E'¡Hola {nombre}! Tu prueba de FILO termina {cuando}.\n\nHasta ahora cargaste {turnos} turnos. Para seguir sin cortes, elegí tu plan acá: {link}\n\nCualquier duda, escribime por acá.';
