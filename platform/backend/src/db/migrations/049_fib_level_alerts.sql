-- A thirteenth alert family: price against an Auto Fib Retracement level.
--
-- "Tell me when price reaches the 0.618" — of the latest zig-zag swing, on
-- the alert's own timeframe. The level is resolved by the runner with
-- `autoFib` from `ta/core`, the same function the chart's Auto Fib study
-- draws with, so the line on the chart is the line an alert fires on.
--
-- Four columns carry the inputs: the zig-zag's deviation and depth, whether 0
-- and 1 are swapped, and the ratio watched.
--
-- The three constraints below are copied MECHANICALLY from their latest
-- definitions — kind and shape from 032, completeness from 048 — and checked,
-- when this file was generated, to differ only by added fib lines. Retyping a
-- thirteen-family CHECK is how another family's rule gets silently loosened.
--
-- Strictly a WIDENING for every existing row: no row can be a fib_level row
-- yet, and nothing else changed. Still NOT VALID + guarded validation, the
-- habit 025 records — this runner migrates on boot.

ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS fib_deviation NUMERIC;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS fib_depth INTEGER;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS fib_reverse BOOLEAN;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS fib_level NUMERIC;

ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_kind_ck;
ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_kind_ck CHECK (condition_kind IN
  ('price','ma','ma_vs_ma','sr_zone','pivot_level','rsi','macd','supertrend',
   'bollinger','stochastic','adx','candlestick_pattern','fib_level')) NOT VALID;

ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_shape_ck;
ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_shape_ck CHECK (
  (condition_kind = 'ma' AND ma_type IS NOT NULL AND ma_length IS NOT NULL AND mode IS NOT NULL)
  OR (condition_kind = 'price' AND target_price IS NOT NULL AND target_price > 0 AND price_direction IS NOT NULL)
  OR (condition_kind = 'ma_vs_ma' AND ma_type IS NOT NULL AND ma_length IS NOT NULL
      AND ma2_type IS NOT NULL AND ma2_length IS NOT NULL
      AND mode IS NOT NULL AND mode IN ('cross_up','cross_down')
      AND NOT (ma_type = ma2_type AND ma_length = ma2_length))
  OR (condition_kind = 'sr_zone' AND mode IS NOT NULL)
  OR (condition_kind = 'pivot_level' AND mode IS NOT NULL)
  OR (condition_kind = 'rsi' AND mode IS NOT NULL AND mode IN ('cross_up','cross_down'))
  OR (condition_kind = 'macd' AND mode IS NOT NULL AND mode IN ('cross_up','cross_down'))
  OR (condition_kind = 'supertrend' AND mode IS NOT NULL AND mode IN ('cross_up','cross_down'))
  OR (condition_kind = 'bollinger' AND mode IS NOT NULL)
  OR (condition_kind = 'stochastic' AND mode IS NOT NULL AND mode IN ('cross_up','cross_down'))
  OR (condition_kind = 'adx' AND mode IS NOT NULL AND mode IN ('cross_up','cross_down'))
  OR (condition_kind = 'fib_level' AND mode IS NOT NULL)
  OR (condition_kind = 'candlestick_pattern' AND pattern_id IS NOT NULL
      AND pattern_id ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
      AND frequency = 'once_per_bar_close')
) NOT VALID;

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
    WHEN 'fib_level' THEN fib_deviation IS NOT NULL AND fib_deviation >= 0
      AND fib_depth IS NOT NULL AND fib_depth >= 2
      AND fib_reverse IS NOT NULL AND fib_level IS NOT NULL
    WHEN 'candlestick_pattern' THEN pattern_id IS NOT NULL
    ELSE true
  END
) NOT VALID;

-- Every input moves the level, so every input is part of "the same alert":
-- a 0.5 and a 0.618 alert on one coin and timeframe are two alerts. Gates
-- too, as for every family since 045. NULLS NOT DISTINCT so an ungated alert
-- still cannot be armed twice. Mirrored by CONFLICT_TARGET in
-- repositories/maAlerts.ts; conflictTargets.test.ts compares the two.
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_fib_uniq
  ON ma_alerts (symbol, timeframe, fib_deviation, fib_depth, fib_reverse, fib_level, mode, filters)
  NULLS NOT DISTINCT
  WHERE condition_kind = 'fib_level';

DO $$
BEGIN
  ALTER TABLE ma_alerts VALIDATE CONSTRAINT ma_alerts_kind_ck;
  ALTER TABLE ma_alerts VALIDATE CONSTRAINT ma_alerts_shape_ck;
  ALTER TABLE ma_alerts VALIDATE CONSTRAINT ma_alerts_kind_complete;
  RAISE NOTICE 'ma_alerts kind, shape and completeness validated against every existing row.';
EXCEPTION WHEN check_violation THEN
  RAISE WARNING 'an ma_alerts constraint could not be validated. %',
    'Inspect with: SELECT id, symbol, condition_kind FROM ma_alerts;';
END $$;
