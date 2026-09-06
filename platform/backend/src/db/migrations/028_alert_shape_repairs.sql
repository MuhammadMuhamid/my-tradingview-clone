-- ════════════════════════════════════════════════════════════════════════════
-- Alert shape repairs: uniqueness that matches the question, bounded numerics
-- ════════════════════════════════════════════════════════════════════════════
--
-- Three corrections to 027, none of which change how an alert is evaluated,
-- gated, throttled or delivered.
--
-- 1. A Stochastic alert against its own %D does not have a level, but 027 both
--    persisted the dialog's leftover default and keyed the uniqueness index on
--    it. So arming "%K crosses above %D" after touching the level field, and
--    arming the same alert later without touching it, produced TWO rows that
--    evaluate identically and both notify — the exact duplicate the index was
--    written to prevent. 016 got the same shape right for RSI by declaring
--    NULLS NOT DISTINCT; this does the same, and nulls the levels that should
--    never have been stored.
--
-- 2. `bb_mult`, `stoch_level` and `adx_level` were added as unbounded `numeric`
--    where every prior family uses `numeric(10,4)`. Two Bollinger alerts at
--    2.00001 and 2.00002 draw the same band to any precision a chart can show,
--    and were nevertheless distinct rows.
--
-- 3. `ma_alerts_check` bounds the approach band unconditionally, but the band
--    is only meaningful for the two `near_*` modes, and no validator bounds it
--    for the others. A `touch` alert carrying a reversed band reached the
--    insert and returned a 500. The band is now normalised to the defaults for
--    every mode that does not use it, which is what the runner already assumes.

-- ── 1. Stochastic uniqueness ───────────────────────────────────────────────

-- A level that belongs to no question. Narrow and idempotent: it touches only
-- rows whose target is not 'level', where the column is unread by definition.
UPDATE ma_alerts
   SET stoch_level = NULL
 WHERE condition_kind = 'stochastic'
   AND indicator_target IS DISTINCT FROM 'level'
   AND stoch_level IS NOT NULL;

DROP INDEX IF EXISTS ma_alerts_stochastic_uniq;

-- NULLS NOT DISTINCT: two %D-target alerts with no level are the same alert.
-- Without it Postgres treats every NULL as unique and the index admits both.
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_stochastic_uniq
  ON ma_alerts (
    symbol, timeframe, stoch_k_length, stoch_k_smooth, stoch_d_smooth,
    indicator_target, stoch_level, mode
  )
  NULLS NOT DISTINCT
  WHERE condition_kind = 'stochastic';

-- ── 2. Bounded numerics ────────────────────────────────────────────────────

-- Widening a `numeric` to a constrained one rewrites nothing that fits, and
-- every value these columns can legally hold does: the CHECKs bound the
-- multiplier at 100 and the two levels inside 0..100.
ALTER TABLE ma_alerts
  ALTER COLUMN bb_mult     TYPE numeric(10,4),
  ALTER COLUMN stoch_level TYPE numeric(10,4),
  ALTER COLUMN adx_level   TYPE numeric(10,4);

-- ── 3. The approach band on modes that do not use one ──────────────────────

-- Reversed bands on rows that never read them. Same narrowness as above: only
-- rows already violating the ordering, and only where the mode ignores it.
UPDATE ma_alerts
   SET near_min_pct = 0.2, near_max_pct = 0.5
 WHERE mode IS NOT NULL
   AND mode NOT IN ('near_above', 'near_below')
   AND NOT (near_max_pct > near_min_pct);
