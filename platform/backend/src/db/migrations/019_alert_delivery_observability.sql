-- Delivery outcomes for notification-alert events.
--
-- `pushed_to = 0` previously meant three different things: no browser had
-- subscribed, every send failed, or every stored subscription was pruned.
-- Keep the existing count and add bounded, secret-free outcome fields so the
-- alert history can distinguish those cases without persisting endpoints or
-- raw transport errors.

ALTER TABLE ma_alert_events
  ADD COLUMN IF NOT EXISTS push_failed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS push_pruned integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'no_devices';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ma_alert_events_delivery_counts_ck'
  ) THEN
    ALTER TABLE ma_alert_events
      ADD CONSTRAINT ma_alert_events_delivery_counts_ck
      CHECK (push_failed >= 0 AND push_pruned >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ma_alert_events_delivery_status_ck'
  ) THEN
    ALTER TABLE ma_alert_events
      ADD CONSTRAINT ma_alert_events_delivery_status_ck
      CHECK (delivery_status IN ('delivered','partial_failure','failed','no_devices'));
  END IF;
END
$$;

-- Existing rows can only prove delivery when at least one device received the
-- notification. A zero count remains truthfully unknown/no-device rather than
-- being rewritten as a failure that was never recorded.
UPDATE ma_alert_events
SET delivery_status = 'delivered'
WHERE pushed_to > 0 AND delivery_status = 'no_devices'
  AND push_failed = 0 AND push_pruned = 0;
