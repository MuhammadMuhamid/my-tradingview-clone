-- Optional trend gates on the two level alert families.
--
-- "Tell me when price approaches 1h support, but only while 1h RSI 50 is above
-- 50" is one alert with a precondition, not two alerts to correlate by hand.
-- The gate never fires anything on its own; it only decides whether the level
-- event is worth notifying about.
--
-- Both gates are evaluated on the alert's OWN symbol and timeframe, against the
-- same bar as the level test, so a 1h alert is gated by 1h RSI and the 1h EMA.
-- There is deliberately no column for a gate timeframe: allowing one would make
-- every alert a multi-timeframe query, and the alert's own timeframe is what
-- was asked for.

ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS filter_rsi_length INT;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS filter_rsi_level  NUMERIC(10,4);
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS filter_rsi_side   TEXT;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS filter_ma_type    TEXT;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS filter_ma_length  INT;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS filter_ma_side    TEXT;

-- A gate must be complete or absent. A length with no side is a rule the runner
-- cannot evaluate, and the alert would look armed while silently never firing —
-- which is indistinguishable, from the outside, from a market that never met
-- the condition.
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_filter_ck;
--
-- The IS NOT NULL tests are load-bearing, not belt-and-braces. A CHECK passes
-- when it evaluates to NULL, and `filter_rsi_length > 0 AND filter_rsi_level > 0`
-- with a NULL level is `TRUE AND NULL` = NULL — so without them a half-written
-- gate (a length, no side) was accepted by exactly the constraint written to
-- reject it. Verified against a real Postgres, where it inserted happily.
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
  );

-- Gates belong to the level families only. Attaching one to an RSI alert would
-- read as "RSI crosses 50 while RSI is above 50", which is not a rule anyone
-- means; leaving it unconstrained would let the UI store one that is silently
-- ignored by the evaluator.
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_filter_kind_ck;
--
-- Written as two equality tests rather than as a membership list, on purpose.
-- A membership list over the kind column is how the VOCABULARY is declared,
-- and `tests/alertMigration.test.ts` reads the last such clause to check the
-- database and `CONDITION_KINDS` agree. Phrasing this different question the
-- same way made the test read the two level families as the whole vocabulary
-- and fail. One syntax, one meaning — including in comments, which the test
-- scans too.
ALTER TABLE ma_alerts
  ADD CONSTRAINT ma_alerts_filter_kind_ck CHECK (
    condition_kind = 'sr_zone' OR condition_kind = 'pivot_level'
    OR (filter_rsi_length IS NULL AND filter_ma_length IS NULL)
  );

-- Note on uniqueness: the filter columns are deliberately NOT part of any
-- unique index. "The same alert" is still the same symbol, timeframe, side and
-- mode, so changing a gate EDITS the existing alert rather than creating a
-- second one. Two alerts on the same zone differing only by gate would both
-- fire on the same approach whenever both gates happened to be open, which is
-- the double-notification the upsert exists to prevent.
