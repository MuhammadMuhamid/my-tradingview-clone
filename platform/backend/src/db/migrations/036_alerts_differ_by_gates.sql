-- Two alerts on one line may differ by their GATES alone.
--
-- ── The bug ───────────────────────────────────────────────────────────────
--
-- "A 15m BTCUSDT support alert that fires when the 1h MACD is bearish, AND
-- another 15m BTCUSDT support alert that fires when the 4h RSI is above 50"
-- was impossible. The second was rejected with a duplicate-key error.
--
-- Every per-kind unique index keyed on the CONDITION — symbol, timeframe, the
-- study's parameters, the mode — and stopped there. `filters` was not part of
-- the key, so two alerts whose only difference was their gates looked like the
-- same alert to the database.
--
-- That was correct when it was written: gates did not exist yet, and an alert
-- WAS its condition. Once a gate could change when an alert fires, two alerts
-- with the same condition and different gates became two different questions,
-- and the schema had no way to say so.
--
-- ── The fix, and what it deliberately keeps ───────────────────────────────
--
-- Each index gains `filters` as a trailing key column. The protection against
-- genuine duplicates is unchanged: two alerts with the same condition AND the
-- same gates still collide, which is what stops a double-click arming the same
-- alert twice.
--
-- `NULLS NOT DISTINCT` is required, not decorative. `filters` is NULL for
-- every alert written before migration 032 and for every alert created with no
-- gates, and under the default NULLS DISTINCT two NULLs compare as different —
-- so an ungated alert could be armed any number of times, silently undoing the
-- duplicate protection for exactly the simplest case. Three of these indexes
-- already carried the clause for the same reason on other nullable columns.
--
-- **Gate ORDER is part of the key.** `[rsi, macd]` and `[macd, rsi]` are
-- distinct to jsonb, so the same two gates listed in the other order can be
-- armed twice. Gates are ANDed, so those two alerts do mean the same thing.
-- Left as-is deliberately: normalising the array would mean rewriting stored
-- rows and inventing a canonical order for a list the user chose the order of,
-- to prevent a duplicate that costs one extra evaluation. (jsonb DOES
-- normalise object key order, so `{kind, side}` and `{side, kind}` are equal —
-- only the array order carries.)
--
-- ── Why this cannot fail on existing rows ─────────────────────────────────
--
-- Each new key is a strict SUPERSET of the key it replaces, so any two rows
-- that do not collide today cannot begin colliding. A superset key admits
-- strictly more rows. The old index is dropped and the new one built in the
-- same statement pair per kind; the table is small enough that a plain build
-- is appropriate (CONCURRENTLY cannot run inside the migration runner's
-- transaction anyway).

DROP INDEX IF EXISTS ma_alerts_ma_unique;
CREATE UNIQUE INDEX ma_alerts_ma_unique ON ma_alerts (symbol, timeframe, ma_type, ma_length, mode, filters)
  NULLS NOT DISTINCT WHERE (condition_kind = 'ma');

DROP INDEX IF EXISTS ma_alerts_price_unique;
CREATE UNIQUE INDEX ma_alerts_price_unique ON ma_alerts (symbol, timeframe, target_price, price_direction, filters)
  NULLS NOT DISTINCT WHERE (condition_kind = 'price');

DROP INDEX IF EXISTS ma_alerts_ma2_unique;
CREATE UNIQUE INDEX ma_alerts_ma2_unique ON ma_alerts (symbol, timeframe, ma_type, ma_length, ma2_type, ma2_length, mode, filters)
  NULLS NOT DISTINCT WHERE (condition_kind = 'ma_vs_ma');

DROP INDEX IF EXISTS ma_alerts_sr_unique;
CREATE UNIQUE INDEX ma_alerts_sr_unique ON ma_alerts (symbol, timeframe, sr_side, mode, filters)
  NULLS NOT DISTINCT WHERE (condition_kind = 'sr_zone');

DROP INDEX IF EXISTS ma_alerts_pivot_unique;
CREATE UNIQUE INDEX ma_alerts_pivot_unique ON ma_alerts (symbol, timeframe, pivot_type, pivot_level_name, pivot_anchor, mode, filters)
  NULLS NOT DISTINCT WHERE (condition_kind = 'pivot_level');

DROP INDEX IF EXISTS ma_alerts_rsi_uniq;
CREATE UNIQUE INDEX ma_alerts_rsi_uniq ON ma_alerts (symbol, timeframe, rsi_length, indicator_target, rsi_level, rsi_ma_length, mode, filters)
  NULLS NOT DISTINCT WHERE (condition_kind = 'rsi');

DROP INDEX IF EXISTS ma_alerts_macd_uniq;
CREATE UNIQUE INDEX ma_alerts_macd_uniq ON ma_alerts (symbol, timeframe, macd_fast, macd_slow, macd_signal, indicator_target, mode, filters)
  NULLS NOT DISTINCT WHERE (condition_kind = 'macd');

DROP INDEX IF EXISTS ma_alerts_supertrend_uniq;
CREATE UNIQUE INDEX ma_alerts_supertrend_uniq ON ma_alerts (symbol, timeframe, st_period, st_multiplier, st_atr_method, mode, filters)
  NULLS NOT DISTINCT WHERE (condition_kind = 'supertrend');

DROP INDEX IF EXISTS ma_alerts_bollinger_uniq;
CREATE UNIQUE INDEX ma_alerts_bollinger_uniq ON ma_alerts (symbol, timeframe, bb_length, bb_mult, bb_band, bb_ma_type, mode, filters)
  NULLS NOT DISTINCT WHERE (condition_kind = 'bollinger');

DROP INDEX IF EXISTS ma_alerts_stochastic_uniq;
CREATE UNIQUE INDEX ma_alerts_stochastic_uniq ON ma_alerts (symbol, timeframe, stoch_k_length, stoch_k_smooth, stoch_d_smooth, indicator_target, stoch_level, mode, filters)
  NULLS NOT DISTINCT WHERE (condition_kind = 'stochastic');

DROP INDEX IF EXISTS ma_alerts_adx_uniq;
CREATE UNIQUE INDEX ma_alerts_adx_uniq ON ma_alerts (symbol, timeframe, adx_di_length, adx_smoothing, adx_level, mode, filters)
  NULLS NOT DISTINCT WHERE (condition_kind = 'adx');

-- A count, so the log says plainly whether all eleven were rebuilt.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'ma_alerts' AND indexdef LIKE '%filters)%'
     AND indexdef LIKE '%UNIQUE%';
  RAISE NOTICE 'per-kind unique indexes now keyed on filters: % of 11', n;
  IF n <> 11 THEN
    RAISE WARNING 'expected 11 gate-aware unique indexes, found %', n;
  END IF;
END $$;
