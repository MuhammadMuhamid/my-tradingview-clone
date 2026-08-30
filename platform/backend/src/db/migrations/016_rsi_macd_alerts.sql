-- RSI and MACD alert families.
--
-- Both are oscillator crosses rather than price crosses, so they store their
-- own lengths instead of borrowing ma_type/ma_length: an RSI length in a column
-- named `ma_length` would read as a moving average to anyone querying this
-- table by hand, and the shape constraints below could no longer tell the two
-- families apart.
--
-- `indicator_target` is shared because it answers the same question for both
-- ("what is being crossed"), with a per-kind vocabulary enforced in
-- `ma_alerts_kind_complete`: 'level'/'sma' for rsi, 'signal'/'zero' for macd.

ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS rsi_length       INT;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS rsi_level        NUMERIC(10,4);
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS rsi_ma_length    INT;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS macd_fast        INT;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS macd_slow        INT;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS macd_signal      INT;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS indicator_target TEXT;

-- Admit the two new kinds. Same reasoning as 015: columns without a widened
-- CHECK produce a row the UI believes it saved and the database refuses.
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_kind_ck;
ALTER TABLE ma_alerts
  ADD CONSTRAINT ma_alerts_kind_ck
  CHECK (condition_kind IN
    ('price','ma','ma_vs_ma','sr_zone','pivot_level','rsi','macd'));

-- `ma_alerts_shape_ck` enumerates kinds explicitly, so an unlisted one is
-- rejected outright rather than falling through. Both new kinds cross, so both
-- require a directional mode.
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
  );

-- Per-kind completeness. An RSI alert against the midline needs no MA length,
-- and one against its MA needs no level, so each target requires only the
-- column it actually reads — requiring both would force the UI to send a value
-- the alert can never use.
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
      ELSE true
    END
  );

-- Re-arming the same oscillator edits it rather than creating a duplicate that
-- would double-notify, matching every other family's uniqueness rule.
--
-- The level and the MA length are BOTH part of the key: "RSI 50 crosses above
-- 50" and "RSI 50 crosses above 70" are different alerts, and a key that
-- stopped at `indicator_target` would silently overwrite one with the other.
--
-- NULLS NOT DISTINCT (Postgres 15+) is what makes that safe. Only one of the
-- two columns is populated for a given target, and under the default rule two
-- NULLs never conflict — so the index would never match, ON CONFLICT would
-- never fire, and re-arming would insert duplicates instead of updating.
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_rsi_uniq
  ON ma_alerts (symbol, timeframe, rsi_length, indicator_target, rsi_level, rsi_ma_length, mode)
  NULLS NOT DISTINCT
  WHERE condition_kind = 'rsi';

CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_macd_uniq
  ON ma_alerts (symbol, timeframe, macd_fast, macd_slow, macd_signal, indicator_target, mode)
  WHERE condition_kind = 'macd';
