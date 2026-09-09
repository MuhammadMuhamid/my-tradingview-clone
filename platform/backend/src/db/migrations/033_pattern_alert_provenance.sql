-- Durable detector and occurrence provenance for exact candlestick alerts.
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS pattern_detector_id text;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS pattern_detector_version text;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS pattern_settings_hash text;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS pattern_settings jsonb;

ALTER TABLE ma_alert_events ADD COLUMN IF NOT EXISTS pattern_detector_id text;
ALTER TABLE ma_alert_events ADD COLUMN IF NOT EXISTS pattern_detector_version text;
ALTER TABLE ma_alert_events ADD COLUMN IF NOT EXISTS pattern_settings_hash text;
ALTER TABLE ma_alert_events ADD COLUMN IF NOT EXISTS pattern_occurrence_id text;
ALTER TABLE ma_alert_events ADD COLUMN IF NOT EXISTS pattern_occurrence jsonb;

-- NOT VALID preserves legacy rows for explicit re-arm while enforcing complete
-- provenance on every newly armed or edited candlestick alert.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ma_alerts_pattern_provenance_ck'
  ) THEN
    ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_pattern_provenance_ck CHECK (
      condition_kind <> 'candlestick_pattern' OR NOT enabled OR (
        pattern_detector_id IS NOT NULL
        AND pattern_detector_version IS NOT NULL
        AND pattern_settings_hash ~ '^[0-9a-f]{16}$'
        AND pattern_settings IS NOT NULL
      )
    ) NOT VALID;
  END IF;
END $$;
