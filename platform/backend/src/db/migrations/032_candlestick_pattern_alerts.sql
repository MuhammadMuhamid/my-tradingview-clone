-- Canonical candlestick alerts: stable catalog id, server evaluation, bar close only.
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS pattern_id text;

ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_kind_ck;
ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_kind_ck CHECK (condition_kind IN
  ('price','ma','ma_vs_ma','sr_zone','pivot_level','rsi','macd','supertrend',
   'bollinger','stochastic','adx','candlestick_pattern'));

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
  OR (condition_kind = 'candlestick_pattern' AND pattern_id IS NOT NULL
      AND pattern_id ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
      AND frequency = 'once_per_bar_close')
) NOT VALID;

DO $$
BEGIN
  ALTER TABLE ma_alerts VALIDATE CONSTRAINT ma_alerts_shape_ck;
  RAISE NOTICE 'ma_alerts_shape_ck validated: every existing row satisfies it.';
EXCEPTION WHEN check_violation THEN
  RAISE WARNING 'ma_alerts_shape_ck could not be validated against existing rows. %',
    'Existing invalid alerts remain blocked by application validation and should be inspected.';
END $$;

ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_kind_complete;
ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_kind_complete CHECK (
  CASE condition_kind
    WHEN 'sr_zone' THEN sr_side IN ('support','resistance','either')
    WHEN 'pivot_level' THEN pivot_type IS NOT NULL AND pivot_level_name IS NOT NULL AND pivot_anchor IS NOT NULL
    WHEN 'rsi' THEN rsi_length > 0 AND indicator_target IN ('level','sma')
      AND (indicator_target <> 'level' OR (rsi_level > 0 AND rsi_level < 100))
      AND (indicator_target <> 'sma' OR rsi_ma_length > 0)
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
);

CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_candlestick_pattern_uniq
  ON ma_alerts (symbol, timeframe, pattern_id)
  WHERE condition_kind = 'candlestick_pattern';
