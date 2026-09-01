-- Machine-readable candle-integrity evidence on the existing feed-health row.
-- Normal writes are one bounded report per symbol/timeframe; status reads do
-- not rescan candle history.
ALTER TABLE feed_health
  ADD COLUMN IF NOT EXISTS integrity_state text,
  ADD COLUMN IF NOT EXISTS issue_codes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS issue_counts jsonb NOT NULL DEFAULT '{}'::jsonb;
