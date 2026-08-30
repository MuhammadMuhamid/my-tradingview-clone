-- Uniqueness for the two alert kinds added in 013.
--
-- Split from that migration rather than appended to it: 013 had already been
-- applied, and an applied migration is a record of what ran. Editing one makes
-- databases that ran the old text silently diverge from ones that ran the new.
-- "The same alert" for each new kind, so re-arming the same line is an update
-- rather than a duplicate that would notify twice for one event.
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_sr_unique
  ON ma_alerts (symbol, timeframe, sr_side, mode)
  WHERE condition_kind = 'sr_zone';

CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_pivot_unique
  ON ma_alerts (symbol, timeframe, pivot_type, pivot_level_name, pivot_anchor, mode)
  WHERE condition_kind = 'pivot_level';
