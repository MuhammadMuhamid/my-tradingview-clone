-- The per-alert gate cap rises from 8 to 10.
--
-- Nothing else changes: the kind vocabulary, the side vocabulary and the
-- structural rules are exactly those `034` left behind.
--
-- ── Why it moves again ────────────────────────────────────────────────────
--
-- The cap has tracked how many gates one question costs. Six was set when
-- three kinds existed and a multi-timeframe question meant two of them; eight
-- when six kinds existed. The request behind this one — "1h MACD bearish AND
-- 4h MACD bullish, on a 15m support alert" — is a single idea that spends two
-- slots, and a trader who also wants an RSI and a moving average behind it is
-- at four before the interesting part starts.
--
-- It is a bound on what a PERSON can reason about, not a cost bound. The
-- runner fetches one candle series per DISTINCT timeframe and shares it across
-- every alert on the symbol, so ten gates spread over two timeframes cost the
-- same two fetches that two gates would.
--
-- Every move so far has been a WIDENING, which is what makes the validation
-- below incapable of failing. A future tightening would not have that
-- property, and would need the row-inspection path the DO block prints.

ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_filters_shape_ck;
ALTER TABLE ma_alerts
  ADD CONSTRAINT ma_alerts_filters_shape_ck CHECK (
    filters IS NULL
    OR (
      jsonb_typeof(filters) = 'array'
      AND jsonb_array_length(filters) <= 10
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
-- runner applies migrations on boot, so a constraint any existing row failed
-- would be a backend that will not start. Nothing here can fail — the rule is
-- strictly wider than 034's — but the habit is what makes the next tightening
-- safe, and a widening that silently skipped validation would leave the
-- constraint marked unvalidated forever.
DO $$
BEGIN
  ALTER TABLE ma_alerts VALIDATE CONSTRAINT ma_alerts_filters_shape_ck;
  RAISE NOTICE 'ma_alerts_filters_shape_ck validated against every existing row.';
EXCEPTION WHEN check_violation THEN
  RAISE WARNING 'ma_alerts_filters_shape_ck could not be validated. %',
    'Inspect with: SELECT id, symbol, filters FROM ma_alerts WHERE filters IS NOT NULL;';
END $$;
