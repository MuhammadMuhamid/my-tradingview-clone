-- Gates become an ordered list, and each one names its own timeframe.
--
-- ── Why the flat columns could not be extended ─────────────────────────────
--
-- The `filter_*` columns hold at most one gate per kind, on the alert's own
-- timeframe. The question this migration exists for is "15m RSI above 50 AND
-- 1h RSI above 50" — two gates of the SAME kind on DIFFERENT timeframes. No
-- amount of adding columns expresses that without inventing filter_rsi2_*,
-- filter_rsi3_*, and a new column every time someone wants one more.
--
-- So the gates move to a JSONB list, in order, each element carrying its own
-- timeframe. A null timeframe means the alert's own, which is exactly what
-- every gate written before this did — so the backfill below is lossless and
-- changes no alert's behaviour.

ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS filters JSONB;

-- Backfill: every existing gate becomes a list entry on its own timeframe.
-- Idempotent — it only writes rows whose `filters` is still NULL, so a re-run
-- cannot double-append, and a row edited after this migration is never
-- overwritten by it.
UPDATE ma_alerts
   SET filters = (
     SELECT coalesce(jsonb_agg(entry ORDER BY ord), '[]'::jsonb)
       FROM (
         SELECT 1 AS ord, jsonb_build_object(
                  'kind', 'rsi', 'timeframe', NULL,
                  'length', filter_rsi_length,
                  'level', filter_rsi_level::float8,
                  'side', filter_rsi_side) AS entry
          WHERE filter_rsi_length IS NOT NULL
            AND filter_rsi_level IS NOT NULL
            AND filter_rsi_side IS NOT NULL
         UNION ALL
         SELECT 2, jsonb_build_object(
                  'kind', 'ma', 'timeframe', NULL,
                  'type', filter_ma_type,
                  'length', filter_ma_length,
                  'side', filter_ma_side)
          WHERE filter_ma_type IS NOT NULL
            AND filter_ma_length IS NOT NULL
            AND filter_ma_side IS NOT NULL
         UNION ALL
         SELECT 3, jsonb_build_object(
                  'kind', 'supertrend', 'timeframe', NULL,
                  'period', filter_st_period,
                  'multiplier', filter_st_multiplier::float8,
                  'atrMethod', filter_st_atr_method,
                  'side', filter_st_side)
          WHERE filter_st_period IS NOT NULL
            AND filter_st_multiplier IS NOT NULL
            AND filter_st_atr_method IS NOT NULL
            AND filter_st_side IS NOT NULL
       ) AS gates
   )
 WHERE filters IS NULL;

-- Every row now has a list, so the reader never has to guess whether a NULL
-- means "no gates" or "written before 032". A row inserted by older code after
-- this point still gets NULL, and `filtersFromRow` falls back to the flat
-- columns for exactly that case.
ALTER TABLE ma_alerts ALTER COLUMN filters SET DEFAULT '[]'::jsonb;

-- The shape rule.
--
-- Expressed with jsonpath rather than `NOT EXISTS (SELECT …)`, because
-- Postgres refuses a subquery in a CHECK — "cannot use subquery in check
-- constraint". `jsonb_path_exists` is an ordinary function call and is allowed.
--
-- What this DOES catch: a value that is not an array, more gates than the
-- runner will evaluate, an element that is not an object, an element with no
-- `kind`, and an element whose `kind` or `side` is not one of the known values.
--
-- What it does NOT catch, deliberately: a gate missing its numeric parameters,
-- such as an RSI entry with no `level`. Expressing per-kind field requirements
-- in jsonpath would be long and hard to read, and it is already covered twice
-- in code — `readOneFilter` refuses it on the way in, and `parseStoredFilters`
-- drops it on the way out rather than evaluating against NaN. This constraint
-- is the coarse structural floor, not the whole rule, and saying so here is
-- better than implying a guarantee it does not give.
--
-- Added NOT VALID and validated separately, for the reason 025 records: this
-- runner applies migrations on boot, so a constraint that any legacy row failed
-- would be a backend that will not start.
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_filters_shape_ck;
ALTER TABLE ma_alerts
  ADD CONSTRAINT ma_alerts_filters_shape_ck CHECK (
    filters IS NULL
    OR (
      jsonb_typeof(filters) = 'array'
      AND jsonb_array_length(filters) <= 6
      AND NOT jsonb_path_exists(filters, '$[*] ? (@.type() != "object")')
      AND NOT jsonb_path_exists(filters, '$[*] ? (!exists(@.kind))')
      AND NOT jsonb_path_exists(filters, '$[*] ? (!exists(@.side))')
      AND NOT jsonb_path_exists(
            filters,
            '$[*] ? (@.kind != "rsi" && @.kind != "ma" && @.kind != "supertrend")')
      AND NOT jsonb_path_exists(
            filters, '$[*] ? (@.side != "above" && @.side != "below")')
    )
  ) NOT VALID;

DO $$
BEGIN
  ALTER TABLE ma_alerts VALIDATE CONSTRAINT ma_alerts_filters_shape_ck;
  RAISE NOTICE 'ma_alerts_filters_shape_ck validated against every existing row.';
EXCEPTION WHEN check_violation THEN
  RAISE WARNING 'ma_alerts_filters_shape_ck could not be validated. %',
    'Inspect with: SELECT id, symbol, filters FROM ma_alerts '
    'WHERE filters IS NOT NULL AND jsonb_typeof(filters) <> ''array'';';
END $$;

-- Note on uniqueness: `filters` is deliberately NOT part of any unique index,
-- for the same reason 017 gave. "The same alert" is still the same symbol,
-- timeframe, side and mode, so changing a gate EDITS the existing alert rather
-- than creating a second one. Two alerts on the same zone differing only by
-- gate would both fire on the same approach whenever both gates happened to be
-- open, which is the double-notification the upsert exists to prevent.
