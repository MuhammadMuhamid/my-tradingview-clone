-- 051: alerts for Market Structure Break & Order Block (EmreKb "MSB-OB") and
-- Liquidity Swings [LuxAlgo]. Three families:
--   msb              a market structure break (bullish, bearish or either)
--   order_block      price entering an order / breaker block zone
--   liquidity_swing  price against the live swing high / low liquidity level
--
-- kind_ck, shape_ck and kind_complete are recreated from their latest text
-- (049) with only the three families added, NOT VALID, then validated. The
-- unique indexes begin with user_id, as every family's has since 050.

ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS msb_zigzag_length INTEGER;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS msb_fib_factor NUMERIC;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS ob_zone TEXT;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS ls_length INTEGER;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS ls_area TEXT;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS ls_side TEXT;

ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_kind_ck;
ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_kind_ck CHECK (condition_kind IN
  ('price','ma','ma_vs_ma','sr_zone','pivot_level','rsi','macd','supertrend',
   'bollinger','stochastic','adx','candlestick_pattern','fib_level',
   'msb','order_block','liquidity_swing')) NOT VALID;

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
  OR (condition_kind = 'msb' AND mode IS NOT NULL AND mode IN ('cross_up','cross_down','touch'))
  OR (condition_kind = 'order_block' AND mode IS NOT NULL AND mode = 'touch')
  OR (condition_kind = 'liquidity_swing' AND mode IS NOT NULL)
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
    WHEN 'msb' THEN msb_zigzag_length IS NOT NULL AND msb_zigzag_length >= 1
      AND msb_fib_factor IS NOT NULL AND msb_fib_factor >= 0 AND msb_fib_factor <= 1
    WHEN 'order_block' THEN msb_zigzag_length IS NOT NULL AND msb_zigzag_length >= 1
      AND msb_fib_factor IS NOT NULL AND msb_fib_factor >= 0 AND msb_fib_factor <= 1
      AND ob_zone IN ('bu_ob','be_ob','bu_bb','be_bb','bullish','bearish','any')
    WHEN 'liquidity_swing' THEN ls_length IS NOT NULL AND ls_length >= 1
      AND ls_area IN ('wick','full') AND ls_side IN ('high','low','either')
    WHEN 'candlestick_pattern' THEN pattern_id IS NOT NULL
    ELSE true
  END
) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_msb_uniq
  ON ma_alerts (user_id, symbol, timeframe, msb_zigzag_length, msb_fib_factor, mode, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'msb';

CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_order_block_uniq
  ON ma_alerts (user_id, symbol, timeframe, msb_zigzag_length, msb_fib_factor, ob_zone, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'order_block';

CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_liquidity_swing_uniq
  ON ma_alerts (user_id, symbol, timeframe, ls_length, ls_area, ls_side, mode, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'liquidity_swing';

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
