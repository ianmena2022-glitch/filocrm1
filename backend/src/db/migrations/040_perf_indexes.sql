-- Índices nuevos para evitar full-table scans en queries de alto volumen.
-- Idempotentes.

-- Scheduler: runTrialExpiration / runActiveExpiration filtran por status + trial_ends_at
CREATE INDEX IF NOT EXISTS idx_shops_sub_status_trial
  ON shops (subscription_status, trial_ends_at)
  WHERE subscription_status IN ('trial','active','expired');

-- Notifications: query principal filtra por recipient + orden por created_at
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created
  ON notifications (recipient_shop_id, created_at DESC);

-- Notifications: count unread por recipient (badge)
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread
  ON notifications (recipient_shop_id)
  WHERE read = FALSE;

-- Pending transfers: poll cada 10s hace early-return con este filtro
CREATE INDEX IF NOT EXISTS idx_pending_transfers_active
  ON pending_transfers (expires_at)
  WHERE matched = FALSE;
