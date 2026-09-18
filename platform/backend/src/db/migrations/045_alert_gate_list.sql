-- 045_alert_gate_list.sql
--
-- Gates become a LIST, and two alerts may differ by their gates alone.
--
-- ── What changed ──────────────────────────────────────────────────────────
--
-- Gates were three fixed slots — one RSI, one moving average, one Supertrend,
-- all measured on the alert's own timeframe — held in ten `filter_*` columns.
-- That shape cannot express two gates of the same kind, and it cannot express
-- a gate measured somewhere else, so "the 1h RSI above its EMA 14 AND the 4h
-- RSI above its EMA 21" had no representation at all.
--
-- `filters` is a JSONB array of gates, each `{kind, side, timeframe?, ...}`.
-- The old columns are KEPT and still written whenever the list happens to fit
-- them, so a rollback to a build that predates this reads a coherent, if
-- lesser, alert rather than an ungated one. `filtersFromRow` prefers `filters`
-- and falls back to the columns.
--
-- ── Why the unique indexes are rebuilt ────────────────────────────────────
--
-- Every per-kind index keyed on the condition and stopped there, so two alerts
-- differing only in their gates looked like one alert and the second was
-- rejected as a duplicate. That was correct before gates existed.
--
-- NULLS NOT DISTINCT matters and is not decoration: an ungated alert has
-- `filters = NULL`, and under the default rule two NULLs never conflict — so
-- without it these indexes would stop matching ungated alerts entirely and
-- re-arming one would insert a duplicate instead of updating it.
--
-- The column lists here are mirrored by CONFLICT_TARGET in
-- `repositories/maAlerts.ts`. Postgres infers the ON CONFLICT arbiter from
-- that list with no fallback, so drift between the two is a 42P10 on every
-- insert of the affected kind. `conflictTargets.test.ts` reads this file and
-- compares them.

ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS filters JSONB;

COMMENT ON COLUMN ma_alerts.filters IS
  'Ordered list of gates. NULL means ungated; the legacy filter_* columns are read only when this is NULL.';

-- Backfill the list from whichever legacy gates a row carries, preserving the
-- order the editor showed them in: RSI, then moving average, then Supertrend.
-- A half-written gate (a length with no side) is skipped rather than guessed
-- at, matching what `filtersFromRow` has always done with these columns.
UPDATE ma_alerts SET filters = gates.list
FROM (
  SELECT id,
    (
      CASE WHEN filter_rsi_length IS NOT NULL
             AND filter_rsi_level IS NOT NULL
             AND filter_rsi_side IN ('above','below')
           THEN jsonb_build_array(jsonb_build_object(
             'kind','rsi','length',filter_rsi_length,
             'level',filter_rsi_level,'side',filter_rsi_side))
           ELSE '[]'::jsonb END
      ||
      CASE WHEN filter_ma_type IS NOT NULL
             AND filter_ma_length IS NOT NULL
             AND filter_ma_side IN ('above','below')
           THEN jsonb_build_array(jsonb_build_object(
             'kind','ma','type',filter_ma_type,
             'length',filter_ma_length,'side',filter_ma_side))
           ELSE '[]'::jsonb END
      ||
      CASE WHEN filter_st_period IS NOT NULL
             AND filter_st_multiplier IS NOT NULL
             AND filter_st_atr_method IN ('rma','sma')
             AND filter_st_side IN ('above','below')
           THEN jsonb_build_array(jsonb_build_object(
             'kind','supertrend','period',filter_st_period,
             'multiplier',filter_st_multiplier,
             'atrMethod',filter_st_atr_method,'side',filter_st_side))
           ELSE '[]'::jsonb END
    ) AS list
  FROM ma_alerts
) AS gates
WHERE ma_alerts.id = gates.id
  AND ma_alerts.filters IS NULL
  AND jsonb_array_length(gates.list) > 0;

-- The cap is a bound on what a person can reason about, not on cost: the
-- runner fetches one candle series per DISTINCT timeframe and shares it across
-- every alert on the symbol.
--
-- Added NOT VALID and validated separately so a boot-time migration cannot
-- abort a deploy on a row it has not finished checking. Raising the cap later
-- is a WIDENING, so this can never fail against a row that already exists.
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_filters_shape;
ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_filters_shape
  CHECK (
    filters IS NULL
    OR (jsonb_typeof(filters) = 'array' AND jsonb_array_length(filters) BETWEEN 1 AND 10)
  ) NOT VALID;
ALTER TABLE ma_alerts VALIDATE CONSTRAINT ma_alerts_filters_shape;

DROP INDEX IF EXISTS ma_alerts_candlestick_pattern_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_candlestick_pattern_uniq
  ON ma_alerts (symbol, timeframe, pattern_id, filters)
  NULLS NOT DISTINCT
  WHERE condition_kind = 'candlestick_pattern';

DROP INDEX IF EXISTS ma_alerts_ma_unique;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_ma_unique
  ON ma_alerts (symbol, timeframe, ma_type, ma_length, mode, filters)
  NULLS NOT DISTINCT
  WHERE condition_kind = 'ma';

DROP INDEX IF EXISTS ma_alerts_price_unique;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_price_unique
  ON ma_alerts (symbol, timeframe, target_price, price_direction, filters)
  NULLS NOT DISTINCT
  WHERE condition_kind = 'price';

DROP INDEX IF EXISTS ma_alerts_ma2_unique;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_ma2_unique
  ON ma_alerts (symbol, timeframe, ma_type, ma_length, ma2_type, ma2_length, mode, filters)
  NULLS NOT DISTINCT
  WHERE condition_kind = 'ma_vs_ma';

DROP INDEX IF EXISTS ma_alerts_sr_unique;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_sr_unique
  ON ma_alerts (symbol, timeframe, sr_side, mode, filters)
  NULLS NOT DISTINCT
  WHERE condition_kind = 'sr_zone';

DROP INDEX IF EXISTS ma_alerts_pivot_unique;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_pivot_unique
  ON ma_alerts (symbol, timeframe, pivot_type, pivot_level_name, pivot_anchor, mode, filters)
  NULLS NOT DISTINCT
  WHERE condition_kind = 'pivot_level';

DROP INDEX IF EXISTS ma_alerts_rsi_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_rsi_uniq
  ON ma_alerts (symbol, timeframe, rsi_length, indicator_target, rsi_level, rsi_ma_length, mode, filters)
  NULLS NOT DISTINCT
  WHERE condition_kind = 'rsi';

DROP INDEX IF EXISTS ma_alerts_macd_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_macd_uniq
  ON ma_alerts (symbol, timeframe, macd_fast, macd_slow, macd_signal, indicator_target, mode, filters)
  NULLS NOT DISTINCT
  WHERE condition_kind = 'macd';

DROP INDEX IF EXISTS ma_alerts_supertrend_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_supertrend_uniq
  ON ma_alerts (symbol, timeframe, st_period, st_multiplier, st_atr_method, mode, filters)
  NULLS NOT DISTINCT
  WHERE condition_kind = 'supertrend';

DROP INDEX IF EXISTS ma_alerts_bollinger_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_bollinger_uniq
  ON ma_alerts (symbol, timeframe, bb_length, bb_mult, bb_band, bb_ma_type, mode, filters)
  NULLS NOT DISTINCT
  WHERE condition_kind = 'bollinger';

DROP INDEX IF EXISTS ma_alerts_stochastic_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_stochastic_uniq
  ON ma_alerts (symbol, timeframe, stoch_k_length, stoch_k_smooth, stoch_d_smooth, indicator_target, stoch_level, mode, filters)
  NULLS NOT DISTINCT
  WHERE condition_kind = 'stochastic';

DROP INDEX IF EXISTS ma_alerts_adx_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_adx_uniq
  ON ma_alerts (symbol, timeframe, adx_di_length, adx_smoothing, adx_level, mode, filters)
  NULLS NOT DISTINCT
  WHERE condition_kind = 'adx';
