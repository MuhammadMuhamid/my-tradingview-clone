-- Two more gate kinds: RSI against its own moving average, and MACD.
--
-- ── What changes ──────────────────────────────────────────────────────────
--
--   * `kind` admits `rsi_ma` and `macd`.
--   * The per-alert gate cap rises from 6 to 8.
--
-- ── Why the cap moves ─────────────────────────────────────────────────────
--
-- Six was chosen when there were three gate kinds and the multi-timeframe case
-- meant two of them. With six kinds, the request this migration serves — "the
-- same filter on 1h AND 4h" — costs two slots per question, and an alert
-- asking it of both RSI-vs-EMA and MACD already needs four before anything
-- else is added. Eight leaves room for a level gate alongside.
--
-- The cap is a guard against an alert nobody could reason about, not a
-- resource limit: gates on distinct timeframes cost one candle fetch each,
-- shared across every alert on the symbol.
--
-- `side` is unchanged. Both new gates ask which side of a line the indicator
-- sits on, so they take `above`/`below` and refuse `either` — enforced per
-- kind in `filterError`, where the fine-grained vocabulary lives.

ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_filters_shape_ck;
ALTER TABLE ma_alerts
  ADD CONSTRAINT ma_alerts_filters_shape_ck CHECK (
    filters IS NULL
    OR (
      jsonb_typeof(filters) = 'array'
      AND jsonb_array_length(filters) <= 8
      AND NOT jsonb_path_exists(filters, '$[*] ? (@.type() != "object")')
      AND NOT jsonb_path_exists(filters, '$[*] ? (!exists(@.kind))')
      AND NOT jsonb_path_exists(filters, '$[*] ? (!exists(@.side))')
      -- One literal, not a concatenation: `||` yields `text`, and
      -- jsonb_path_exists takes `jsonpath`, so the concatenated form fails to
      -- resolve the function at all rather than misbehaving subtly.
      AND NOT jsonb_path_exists(filters, '$[*] ? (@.kind != "rsi" && @.kind != "ma" && @.kind != "supertrend" && @.kind != "pivot" && @.kind != "rsi_ma" && @.kind != "macd")')
      AND NOT jsonb_path_exists(
            filters,
            '$[*] ? (@.side != "above" && @.side != "below" && @.side != "either")')
    )
  ) NOT VALID;

-- Validated separately rather than inline, for the reason 025 records: this
-- runner applies migrations on boot, so a constraint that any existing row
-- failed would be a backend that will not start. Nothing here can fail — the
-- rule is strictly wider than 033's, in both the kind vocabulary and the cap —
-- but the habit is what makes the next TIGHTENING safe, and a widening that
-- silently skipped validation would leave the constraint unvalidated forever.
DO $$
BEGIN
  ALTER TABLE ma_alerts VALIDATE CONSTRAINT ma_alerts_filters_shape_ck;
  RAISE NOTICE 'ma_alerts_filters_shape_ck validated against every existing row.';
EXCEPTION WHEN check_violation THEN
  RAISE WARNING 'ma_alerts_filters_shape_ck could not be validated. %',
    'Inspect with: SELECT id, symbol, filters FROM ma_alerts WHERE filters IS NOT NULL;';
END $$;
