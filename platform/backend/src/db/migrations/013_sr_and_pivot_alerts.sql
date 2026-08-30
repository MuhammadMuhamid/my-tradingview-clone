-- ── Support/resistance and pivot-level alerts ───────────────────────────────
--
-- Two more `condition_kind` values on the existing alert table, rather than
-- new tables: an alert is still "a symbol, a timeframe, a frequency, and a
-- reference price to compare against". Only the way the reference is derived
-- differs, so the firing state, Web Push fan-out, event log and the runner
-- that serves them are all reused unchanged.
--
--   sr_zone      the nearest live support or resistance on the alert's own
--                timeframe, from swing pivots
--   pivot_level  a named pivot level (P, S1-S5, R1-R5) computed from a
--                completed anchor period
--
-- Every column is nullable and every existing row keeps `condition_kind='ma'`,
-- so nothing already armed changes behaviour.

ALTER TABLE ma_alerts
  -- sr_zone
  ADD COLUMN IF NOT EXISTS sr_side text,
  ADD COLUMN IF NOT EXISTS sr_pivot_length integer,
  ADD COLUMN IF NOT EXISTS sr_invalidation text,
  -- pivot_level
  ADD COLUMN IF NOT EXISTS pivot_type text,
  ADD COLUMN IF NOT EXISTS pivot_level_name text,
  -- The period the levels are computed from: '1d', '4h', … Distinct from
  -- `timeframe`, which is how often the alert is EVALUATED. Daily pivots
  -- watched on a 5m chart is the common case, and needs both.
  ADD COLUMN IF NOT EXISTS pivot_anchor text;

-- Each kind must be fully specified for itself, and must not carry another
-- kind's columns. A half-configured alert would otherwise sit armed and
-- silently never fire.
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_kind_complete;
ALTER TABLE ma_alerts
  ADD CONSTRAINT ma_alerts_kind_complete CHECK (
    CASE condition_kind
      WHEN 'sr_zone' THEN
        sr_side IN ('support', 'resistance', 'either')
      WHEN 'pivot_level' THEN
        pivot_type IS NOT NULL AND pivot_level_name IS NOT NULL AND pivot_anchor IS NOT NULL
      ELSE true
    END
  );

CREATE INDEX IF NOT EXISTS ma_alerts_kind_idx ON ma_alerts (condition_kind) WHERE enabled;
