-- The Supertrend alert family, and the Supertrend gate on every family.
--
-- Two changes that share a migration because they share their columns' meaning:
--
--   1. `supertrend` becomes an alert kind of its own. The event is the
--      indicator changing DIRECTION, which is why it stores its own inputs
--      rather than borrowing ma_length: a Supertrend period is an ATR length,
--      not a moving-average one, and putting it in `ma_length` would make the
--      shape constraints below unable to tell the families apart.
--
--   2. The gates stop being a level-family privilege. Any alert may now carry
--      one, including the new Supertrend gate — "MACD crosses up, but only
--      while price is above the Supertrend" is the same shape of request as the
--      level version, and the old restriction was an artefact of the order the
--      families were built in rather than a rule anybody chose.

ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS st_period     INT;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS st_multiplier NUMERIC(10,4);
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS st_atr_method TEXT;

ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS filter_st_period     INT;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS filter_st_multiplier NUMERIC(10,4);
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS filter_st_atr_method TEXT;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS filter_st_side       TEXT;

-- A note is the user's own reason for arming the alert, and it is appended to
-- the notification body. Bounded because a Web Push payload is capped at 4 KB
-- and a phone shows roughly two lines: an unbounded note would push the market
-- fact off the end of the notification, or fail delivery outright.
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_note_len_ck;
ALTER TABLE ma_alerts
  ADD CONSTRAINT ma_alerts_note_len_ck CHECK (note IS NULL OR length(note) <= 280);

-- Admit the new kind. Same reasoning as 015 and 016: columns without a widened
-- CHECK produce a row the UI believes it saved and the database refuses.
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_kind_ck;
ALTER TABLE ma_alerts
  ADD CONSTRAINT ma_alerts_kind_ck
  CHECK (condition_kind IN
    ('price','ma','ma_vs_ma','sr_zone','pivot_level','rsi','macd','supertrend'));

-- `ma_alerts_shape_ck` enumerates kinds explicitly, so an unlisted one is
-- rejected outright rather than falling through. A Supertrend alert watches a
-- direction change, which has exactly two directions.
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
      AND mode IN ('cross_up','cross_down')
      AND NOT (ma_type = ma2_type AND ma_length = ma2_length))
    OR (condition_kind = 'sr_zone' AND mode IS NOT NULL)
    OR (condition_kind = 'pivot_level' AND mode IS NOT NULL)
    OR (condition_kind = 'rsi'  AND mode IN ('cross_up','cross_down'))
    OR (condition_kind = 'macd' AND mode IN ('cross_up','cross_down'))
    OR (condition_kind = 'supertrend' AND mode IN ('cross_up','cross_down'))
  );

-- Per-kind completeness, restating 016's clauses so this file defines the whole
-- constraint rather than a fragment of it.
--
-- The multiplier's bounds are load-bearing. At or below zero the two bands
-- collapse onto hl2 or swap, so the trend flips on nearly every bar; far above,
-- the band is wider than any move the market makes and the trend never flips at
-- all. Both are alerts that look armed and are useless, in opposite directions.
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
        -- A fast length at or above the slow one inverts the oscillator, so
        -- every "crosses above" would report what a reader sees as a downturn.
        AND macd_fast < macd_slow
        AND indicator_target IN ('signal', 'zero')
      WHEN 'supertrend' THEN
        st_period IS NOT NULL AND st_period > 0
        AND st_multiplier IS NOT NULL
        AND st_multiplier > 0 AND st_multiplier <= 100
        AND st_atr_method IN ('rma', 'sma')
      ELSE true
    END
  );

-- The gate completeness rules, restated with the new gate added.
--
-- The IS NOT NULL tests are load-bearing, not belt-and-braces. A CHECK passes
-- when it evaluates to NULL, so `filter_st_period > 0 AND filter_st_side IN
-- (...)` with a NULL side is `TRUE AND NULL` = NULL — and a half-written gate
-- would be accepted by exactly the constraint written to reject it. That is not
-- hypothetical: it was found in 017 against a real Postgres, where it inserted
-- happily.
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_filter_ck;
ALTER TABLE ma_alerts
  ADD CONSTRAINT ma_alerts_filter_ck CHECK (
    (
      (filter_rsi_length IS NULL AND filter_rsi_level IS NULL AND filter_rsi_side IS NULL)
      OR (
        filter_rsi_length IS NOT NULL
        AND filter_rsi_level IS NOT NULL
        AND filter_rsi_side IS NOT NULL
        AND filter_rsi_length > 0
        AND filter_rsi_level > 0 AND filter_rsi_level < 100
        AND filter_rsi_side IN ('above', 'below')
      )
    )
    AND (
      (filter_ma_type IS NULL AND filter_ma_length IS NULL AND filter_ma_side IS NULL)
      OR (
        filter_ma_type IS NOT NULL
        AND filter_ma_length IS NOT NULL
        AND filter_ma_side IS NOT NULL
        AND filter_ma_type IN ('sma', 'ema')
        AND filter_ma_length > 0
        AND filter_ma_side IN ('above', 'below')
      )
    )
    AND (
      (filter_st_period IS NULL AND filter_st_multiplier IS NULL
        AND filter_st_atr_method IS NULL AND filter_st_side IS NULL)
      OR (
        filter_st_period IS NOT NULL
        AND filter_st_multiplier IS NOT NULL
        AND filter_st_atr_method IS NOT NULL
        AND filter_st_side IS NOT NULL
        AND filter_st_period > 0
        AND filter_st_multiplier > 0 AND filter_st_multiplier <= 100
        AND filter_st_atr_method IN ('rma', 'sma')
        AND filter_st_side IN ('above', 'below')
      )
    )
  );

-- 017 confined gates to the two level families. That restriction is lifted
-- here: every family may now carry one, and the evaluator applies them at a
-- single point shared by all of them, so there is no longer a kind for which a
-- stored gate would be silently ignored.
--
-- Dropped rather than widened. A constraint listing the kinds that MAY have a
-- gate, when the answer is "all of them", is a line that has to be edited every
-- time a family is added and whose only possible failure is a false rejection.
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_filter_kind_ck;

-- Re-arming the same Supertrend edits it rather than creating a duplicate that
-- would double-notify, matching every other family's uniqueness rule. Both
-- inputs are part of the key: 10/3 and 14/2 flip on different bars, so they are
-- genuinely different alerts rather than an edit of one another.
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_supertrend_uniq
  ON ma_alerts (symbol, timeframe, st_period, st_multiplier, st_atr_method, mode)
  WHERE condition_kind = 'supertrend';
