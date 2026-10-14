-- An RSI alert may cross its own EMA, not only its own SMA.
--
-- The RSI-vs-its-own-MA FILTER has always offered an EMA or an SMA. The RSI
-- alert FAMILY offered only the SMA, so "RSI 50 crosses its EMA 14" could gate
-- an alert but could not be one. `indicator_target` now admits 'ema' for the
-- rsi family, and an 'ema' target requires `rsi_ma_length` exactly as 'sma'
-- does.
--
-- The constraint below is `ma_alerts_kind_complete` as 032 left it, copied
-- verbatim except for those two rsi lines. Every other family's rule is
-- unchanged; the copy was made mechanically and checked to differ in exactly
-- two lines, because retyping a ten-family CHECK is how a family's rule gets
-- silently loosened.
--
-- One line is new rather than edited: `rsi_ma_length IS NOT NULL` for 'ema'.
-- A CHECK PASSES when it evaluates to NULL, and `NULL > 0` is NULL, so the
-- length rule alone admits an 'ema' row with no length at all. The 'sma' rule
-- has that same hole and is deliberately left as it was — tightening it could
-- reject an existing row on boot — but no 'ema' row can exist before this
-- migration, so closing it for 'ema' costs nothing.
--
-- Otherwise strictly a WIDENING: every row that satisfied the old constraint
-- satisfies this one. It is still added NOT VALID and validated in a guarded block, the
-- habit 025 records — this runner migrates on boot, and a constraint an
-- existing row failed would be a backend that does not start.

ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_kind_complete;
ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_kind_complete CHECK (
  CASE condition_kind
    WHEN 'sr_zone' THEN sr_side IN ('support','resistance','either')
    WHEN 'pivot_level' THEN pivot_type IS NOT NULL AND pivot_level_name IS NOT NULL AND pivot_anchor IS NOT NULL
    WHEN 'rsi' THEN rsi_length > 0 AND indicator_target IN ('level','sma','ema')
      AND (indicator_target <> 'level' OR (rsi_level > 0 AND rsi_level < 100))
      AND (indicator_target NOT IN ('sma','ema') OR rsi_ma_length > 0)
      AND (indicator_target <> 'ema' OR rsi_ma_length IS NOT NULL)
    WHEN 'macd' THEN macd_fast > 0 AND macd_signal > 0 AND macd_fast < macd_slow
      AND indicator_target IN ('signal','zero')
    WHEN 'supertrend' THEN st_period > 0 AND st_multiplier > 0 AND st_multiplier <= 100
      AND st_atr_method IN ('rma','sma')
    WHEN 'bollinger' THEN bb_length >= 2 AND bb_mult > 0 AND bb_mult <= 100
      AND bb_band IN ('upper','basis','lower') AND bb_ma_type IN ('sma','ema')
    WHEN 'stochastic' THEN stoch_k_length > 0 AND stoch_k_smooth > 0 AND stoch_d_smooth > 0
      AND indicator_target IN ('signal','level')
      AND (indicator_target <> 'level' OR (stoch_level > 0 AND stoch_level < 100))
    WHEN 'adx' THEN adx_di_length > 0 AND adx_smoothing > 0 AND adx_level > 0 AND adx_level < 100
    WHEN 'candlestick_pattern' THEN pattern_id IS NOT NULL
    ELSE true
  END
) NOT VALID;

DO $$
BEGIN
  ALTER TABLE ma_alerts VALIDATE CONSTRAINT ma_alerts_kind_complete;
  RAISE NOTICE 'ma_alerts_kind_complete validated against every existing row.';
EXCEPTION WHEN check_violation THEN
  RAISE WARNING 'ma_alerts_kind_complete could not be validated. %',
    'Inspect with: SELECT id, symbol, condition_kind, indicator_target FROM ma_alerts;';
END $$;
