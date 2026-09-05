-- ════════════════════════════════════════════════════════════════════════════
-- Three more alert families: Bollinger band, Stochastic, ADX
-- ════════════════════════════════════════════════════════════════════════════
--
-- The same table, the same runner, the same Web Push path and the same
-- bar-close truth as every family before them. What is added is columns for
-- their inputs and the rules that decide which rows are complete and which
-- count as "the same alert" — nothing about how an alert is evaluated, gated,
-- throttled or delivered changes.
--
-- These evaluate on the SERVER, on closed bars by default, like every other
-- family. The browser draws the same lines from the same canonical maths
-- (`src/ta/core.ts`, mirrored to `frontend/lib/ta/core.ts` byte for byte), so
-- the band an alert watches is the band on the chart — but the browser never
-- decides whether an alert fired.

ALTER TABLE ma_alerts
  -- Bollinger: which of the three lines, and the inputs that shape them.
  ADD COLUMN IF NOT EXISTS bb_length      integer,
  ADD COLUMN IF NOT EXISTS bb_mult        numeric,
  ADD COLUMN IF NOT EXISTS bb_band        text,
  ADD COLUMN IF NOT EXISTS bb_ma_type     text,
  -- Stochastic: %K length and the two smoothings. The target — its own %D, or
  -- a level — reuses `indicator_target`, which already answers exactly that
  -- question for the RSI and MACD families.
  ADD COLUMN IF NOT EXISTS stoch_k_length integer,
  ADD COLUMN IF NOT EXISTS stoch_k_smooth integer,
  ADD COLUMN IF NOT EXISTS stoch_d_smooth integer,
  ADD COLUMN IF NOT EXISTS stoch_level    numeric,
  -- ADX: the DI length, the ADX smoothing, and the strength threshold.
  ADD COLUMN IF NOT EXISTS adx_di_length  integer,
  ADD COLUMN IF NOT EXISTS adx_smoothing  integer,
  ADD COLUMN IF NOT EXISTS adx_level      numeric;

-- Admit the new kinds. Same reasoning as 015, 016 and 025: columns without a
-- widened CHECK produce a row the UI believes it saved and the database
-- refuses.
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_kind_ck;
ALTER TABLE ma_alerts
  ADD CONSTRAINT ma_alerts_kind_ck
  CHECK (condition_kind IN
    ('price','ma','ma_vs_ma','sr_zone','pivot_level','rsi','macd','supertrend',
     'bollinger','stochastic','adx'));

-- `ma_alerts_shape_ck` enumerates kinds explicitly, so an unlisted one is
-- rejected outright rather than falling through. Restated in full here, with
-- the three new branches, so this file defines the whole constraint rather
-- than a fragment of it.
--
-- Every `mode IS NOT NULL` is load-bearing for the reason 025 documents at
-- length: a CHECK passes when it evaluates to NULL, so a branch written as
-- `condition_kind = 'x' AND mode IN (...)` ACCEPTS a row with a null mode —
-- and such a row is an alert that looks armed in the UI and can never fire,
-- because `conditionFromRow` refuses to build a condition from it.
--
-- A Bollinger alert watches price against a moving line, so it takes the full
-- touch / cross / near vocabulary the MA and level families use. The two
-- oscillator families watch a value crossing a reference, which has exactly
-- two directions.
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_shape_ck;
ALTER TABLE ma_alerts
  ADD CONSTRAINT ma_alerts_shape_ck CHECK (
    (condition_kind = 'ma'
      AND ma_type IS NOT NULL AND ma_length IS NOT NULL AND mode IS NOT NULL)
    OR (condition_kind = 'price'
      AND target_price IS NOT NULL AND target_price > 0 AND price_direction IS NOT NULL)
    OR (condition_kind = 'ma_vs_ma'
      AND ma_type IS NOT NULL AND ma_length IS NOT NULL
      AND ma2_type IS NOT NULL AND ma2_length IS NOT NULL
      AND mode IS NOT NULL AND mode IN ('cross_up','cross_down')
      AND NOT (ma_type = ma2_type AND ma_length = ma2_length))
    OR (condition_kind = 'sr_zone' AND mode IS NOT NULL)
    OR (condition_kind = 'pivot_level' AND mode IS NOT NULL)
    OR (condition_kind = 'rsi'
      AND mode IS NOT NULL AND mode IN ('cross_up','cross_down'))
    OR (condition_kind = 'macd'
      AND mode IS NOT NULL AND mode IN ('cross_up','cross_down'))
    OR (condition_kind = 'supertrend'
      AND mode IS NOT NULL AND mode IN ('cross_up','cross_down'))
    OR (condition_kind = 'bollinger' AND mode IS NOT NULL)
    OR (condition_kind = 'stochastic'
      AND mode IS NOT NULL AND mode IN ('cross_up','cross_down'))
    OR (condition_kind = 'adx'
      AND mode IS NOT NULL AND mode IN ('cross_up','cross_down'))
  ) NOT VALID;

DO $$
BEGIN
  ALTER TABLE ma_alerts VALIDATE CONSTRAINT ma_alerts_shape_ck;
  RAISE NOTICE 'ma_alerts_shape_ck validated: every existing row satisfies it.';
EXCEPTION WHEN check_violation THEN
  -- A WARNING rather than an exception, for the reason 025 gives: the rows
  -- this names are already inert, and the migration runner applies migrations
  -- on boot, so an aborted one is a backend that will not start.
  RAISE WARNING 'ma_alerts_shape_ck could not be validated against existing rows. %',
    'These rows predate the fix, cannot be evaluated by the runner, and should be '
    'inspected: SELECT id, symbol, timeframe, condition_kind FROM ma_alerts '
    'WHERE mode IS NULL AND condition_kind <> ''price'';';
END $$;

-- Per-kind completeness, restating 025's clauses so this file defines the
-- whole constraint rather than a fragment of it.
--
-- The bounds are load-bearing in the same way 025's multiplier bounds are:
--
--   a Bollinger window of one has no deviation, so both bands sit exactly on
--   the basis and every "touch" is a touch;
--
--   a level at or outside 0..100 can never be crossed by a bounded
--   oscillator, so a Stochastic or ADX alert armed at it is armed at nothing.
--
-- Both are alerts that look armed and cannot fire, which from the outside is
-- indistinguishable from a market that never met the condition.
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_kind_complete;
ALTER TABLE ma_alerts
  ADD CONSTRAINT ma_alerts_kind_complete CHECK (
    CASE condition_kind
      WHEN 'sr_zone' THEN
        sr_side IN ('support', 'resistance', 'either')
      WHEN 'pivot_level' THEN
        pivot_type IS NOT NULL AND pivot_level_name IS NOT NULL AND pivot_anchor IS NOT NULL
      WHEN 'rsi' THEN
        rsi_length IS NOT NULL AND rsi_length > 0
        AND indicator_target IN ('level', 'sma')
        AND (indicator_target <> 'level'
             OR (rsi_level IS NOT NULL AND rsi_level > 0 AND rsi_level < 100))
        AND (indicator_target <> 'sma'
             OR (rsi_ma_length IS NOT NULL AND rsi_ma_length > 0))
      WHEN 'macd' THEN
        macd_fast IS NOT NULL AND macd_slow IS NOT NULL AND macd_signal IS NOT NULL
        AND macd_fast > 0 AND macd_signal > 0
        AND macd_fast < macd_slow
        AND indicator_target IN ('signal', 'zero')
      WHEN 'supertrend' THEN
        st_period IS NOT NULL AND st_period > 0
        AND st_multiplier IS NOT NULL
        AND st_multiplier > 0 AND st_multiplier <= 100
        AND st_atr_method IN ('rma', 'sma')
      WHEN 'bollinger' THEN
        bb_length IS NOT NULL AND bb_length >= 2
        AND bb_mult IS NOT NULL AND bb_mult > 0 AND bb_mult <= 100
        AND bb_band IN ('upper', 'basis', 'lower')
        AND bb_ma_type IN ('sma', 'ema')
      WHEN 'stochastic' THEN
        stoch_k_length IS NOT NULL AND stoch_k_length > 0
        AND stoch_k_smooth IS NOT NULL AND stoch_k_smooth > 0
        AND stoch_d_smooth IS NOT NULL AND stoch_d_smooth > 0
        AND indicator_target IN ('signal', 'level')
        AND (indicator_target <> 'level'
             OR (stoch_level IS NOT NULL AND stoch_level > 0 AND stoch_level < 100))
      WHEN 'adx' THEN
        adx_di_length IS NOT NULL AND adx_di_length > 0
        AND adx_smoothing IS NOT NULL AND adx_smoothing > 0
        AND adx_level IS NOT NULL AND adx_level > 0 AND adx_level < 100
      ELSE true
    END
  );

-- What "the same alert" means for each family, so re-arming one edits it
-- rather than creating a duplicate that would double-notify.
--
-- Every input is part of the key. An upper-band touch and a lower-band touch
-- are two different alerts; a 20/2 band and a 20/3 band are two different
-- lines; a Stochastic against its %D and one against 20 are two different
-- questions. Collapsing any of those would make re-arming silently overwrite
-- an alert the operator still wanted.
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_bollinger_uniq
  ON ma_alerts (symbol, timeframe, bb_length, bb_mult, bb_band, bb_ma_type, mode)
  WHERE condition_kind = 'bollinger';

CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_stochastic_uniq
  ON ma_alerts (
    symbol, timeframe, stoch_k_length, stoch_k_smooth, stoch_d_smooth,
    indicator_target, stoch_level, mode
  )
  WHERE condition_kind = 'stochastic';

CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_adx_uniq
  ON ma_alerts (symbol, timeframe, adx_di_length, adx_smoothing, adx_level, mode)
  WHERE condition_kind = 'adx';
