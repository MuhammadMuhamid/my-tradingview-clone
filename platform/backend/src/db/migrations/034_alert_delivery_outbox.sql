-- FC1-H1: durable occurrence claim before irreversible Web Push submission.
CREATE TABLE IF NOT EXISTS ma_alert_delivery_outbox (
  occurrence_key text PRIMARY KEY,
  alert_id uuid NOT NULL REFERENCES ma_alerts(id) ON DELETE CASCADE,
  bar_time timestamptz NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'dispatching'
    CHECK (status IN ('dispatching','delivered','partial_failure','failed','no_devices','unknown')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS ma_alert_delivery_outbox_status_idx
  ON ma_alert_delivery_outbox (status, claimed_at);

COMMENT ON COLUMN ma_alert_delivery_outbox.status IS
  'dispatching is deliberately not retried automatically: after a process death the provider outcome is unknown, and retry could duplicate an externally submitted notification.';
