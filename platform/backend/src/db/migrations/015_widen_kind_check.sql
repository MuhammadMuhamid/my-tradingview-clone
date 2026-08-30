-- Admit the two condition kinds added in 013 to the `condition_kind` CHECK.
--
-- 010 wrote that CHECK when three kinds existed. Adding columns for `sr_zone`
-- and `pivot_level` without widening it would have let a row be built that the
-- database then refused — the alert would look saved in the UI and never exist.
-- `tests/alertMigration.test.ts` compares the effective vocabulary against
-- `CONDITION_KINDS`, which is what caught this.
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_kind_ck;
ALTER TABLE ma_alerts
  ADD CONSTRAINT ma_alerts_kind_ck
  CHECK (condition_kind IN ('price','ma','ma_vs_ma','sr_zone','pivot_level'));

-- `ma_alerts_shape_ck` from 010 enumerates the three original kinds and would
-- reject the new ones outright. The per-kind completeness rule for those lives
-- in `ma_alerts_kind_complete` (013), so this widens the old constraint to
-- leave kinds it does not know about to that one.
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
  );
