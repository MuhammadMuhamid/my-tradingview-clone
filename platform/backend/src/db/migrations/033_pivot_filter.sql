-- A fourth gate kind: price near a pivot level.
--
-- ── Why the shape constraint has to change ─────────────────────────────────
--
-- `032` pinned two things about every gate: its `kind` is one of three, and its
-- `side` is above or below. A pivot gate breaks both.
--
--   * `kind` is now also `pivot`.
--   * `side` is now also `either`, because a pivot gate asks a DISTANCE
--     question — "is price within 0.2–0.5% of S1" — and "near it from
--     whichever direction" is the common case. The other three gates ask which
--     side of a line price is on, where `either` would be meaningless: "RSI is
--     either 50" is not a rule.
--
-- `either` is therefore admitted at the column level and refused per kind in
-- `filterError`, which is where the per-kind vocabulary already lives. The
-- CHECK stays the coarse structural floor it was; the fine rule stays in code.

ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_filters_shape_ck;
ALTER TABLE ma_alerts
  ADD CONSTRAINT ma_alerts_filters_shape_ck CHECK (
    filters IS NULL
    OR (
      jsonb_typeof(filters) = 'array'
      AND jsonb_array_length(filters) <= 6
      AND NOT jsonb_path_exists(filters, '$[*] ? (@.type() != "object")')
      AND NOT jsonb_path_exists(filters, '$[*] ? (!exists(@.kind))')
      AND NOT jsonb_path_exists(filters, '$[*] ? (!exists(@.side))')
      -- One literal, not a concatenation: `||` yields `text`, and
      -- jsonb_path_exists takes `jsonpath`, so the concatenated form fails to
      -- resolve the function at all rather than misbehaving subtly.
      AND NOT jsonb_path_exists(filters, '$[*] ? (@.kind != "rsi" && @.kind != "ma" && @.kind != "supertrend" && @.kind != "pivot")')
      AND NOT jsonb_path_exists(
            filters,
            '$[*] ? (@.side != "above" && @.side != "below" && @.side != "either")')
    )
  ) NOT VALID;

-- Validated separately rather than inline, for the reason 025 records: this
-- runner applies migrations on boot, so a constraint that any existing row
-- failed would be a backend that will not start. Nothing here can fail — the
-- rule is strictly wider than 032's — but the habit is what makes the next
-- tightening safe, and a widening that silently skipped validation would leave
-- the constraint marked unvalidated forever.
DO $$
BEGIN
  ALTER TABLE ma_alerts VALIDATE CONSTRAINT ma_alerts_filters_shape_ck;
  RAISE NOTICE 'ma_alerts_filters_shape_ck validated against every existing row.';
EXCEPTION WHEN check_violation THEN
  RAISE WARNING 'ma_alerts_filters_shape_ck could not be validated. %',
    'Inspect with: SELECT id, symbol, filters FROM ma_alerts WHERE filters IS NOT NULL;';
END $$;
