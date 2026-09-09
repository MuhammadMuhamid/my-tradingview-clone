-- FC1-B1: distinguish the completed-candle decision from its intended bracket.
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS intended_trigger_price numeric,
  ADD COLUMN IF NOT EXISTS decision_time timestamptz;

-- Existing rows predate explicit decision timestamps. Preserve their identity:
-- bar_time is the best available bound and is not rewritten as a claimed fill.
UPDATE alerts SET decision_time = bar_time WHERE decision_time IS NULL;

ALTER TABLE alerts
  ALTER COLUMN decision_time SET NOT NULL,
  ALTER COLUMN decision_time SET DEFAULT now();

COMMENT ON COLUMN alerts.trigger_price IS
  'Executable completed-candle decision price, not an exchange fill.';
COMMENT ON COLUMN alerts.intended_trigger_price IS
  'Bracket threshold that caused the decision; provenance only, not a fill claim.';
COMMENT ON COLUMN alerts.decision_time IS
  'Time at which the completed candle made the order decision eligible.';
