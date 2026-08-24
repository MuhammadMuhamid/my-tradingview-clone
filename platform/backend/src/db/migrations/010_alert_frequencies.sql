-- Price/indicator alerts: four frequency modes, and conditions beyond a single
-- moving average.
--
-- This EXTENDS ma_alerts rather than introducing a second alert table. The
-- existing rows, their Web Push subscriptions, their event history and the
-- runner that serves them all keep working; a row simply gains a
-- `condition_kind` and a `frequency`, and both defaults describe exactly what
-- the table already did.
--
-- The migration guarantee that matters: every alert that exists today becomes
-- `condition_kind = 'ma'`, `frequency = 'once_per_bar_close'`, which is the
-- behaviour it already had. Nothing starts notifying more often because of
-- this migration.

-- ── How often a true condition may notify ──────────────────────────────────
--
--   once_only          fire once, ever, then retire (completed_at)
--   once_per_bar       evaluate intrabar, at most one fire per candle
--   once_per_bar_close evaluate only closed candles  ← the default, unchanged
--   once_per_minute    evaluate intrabar, at most one fire per minute
ALTER TABLE ma_alerts
  ADD COLUMN IF NOT EXISTS frequency text NOT NULL DEFAULT 'once_per_bar_close';

-- ── What the alert watches ─────────────────────────────────────────────────
ALTER TABLE ma_alerts
  ADD COLUMN IF NOT EXISTS condition_kind text NOT NULL DEFAULT 'ma',
  -- price kind
  ADD COLUMN IF NOT EXISTS target_price numeric,
  ADD COLUMN IF NOT EXISTS price_direction text,
  -- ma_vs_ma kind: the SLOW line the primary MA is compared against
  ADD COLUMN IF NOT EXISTS ma2_type text,
  ADD COLUMN IF NOT EXISTS ma2_length integer;

-- ── Firing state that must survive a restart ───────────────────────────────
--
-- `last_fired_bar_time` is what caps once_per_bar to one notification per
-- candle, and it is also what makes a websocket reconnect safe: a replayed
-- frame carries the same bar open time, so it is recognised rather than
-- re-notified. `last_bar_time` is the staleness watermark — a late frame for an
-- older bar must not rewrite cross state that has already moved on.
ALTER TABLE ma_alerts
  ADD COLUMN IF NOT EXISTS last_fired_bar_time timestamptz,
  ADD COLUMN IF NOT EXISTS last_bar_time timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- A price alert names no moving average, so the MA columns can no longer be
-- mandatory. Existing rows keep their values; the per-kind CHECK below is what
-- now guarantees each row is fully specified for its own kind.
ALTER TABLE ma_alerts
  ALTER COLUMN ma_type DROP NOT NULL,
  ALTER COLUMN ma_length DROP NOT NULL,
  ALTER COLUMN mode DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ma_alerts_frequency_ck') THEN
    ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_frequency_ck
      CHECK (frequency IN ('once_only','once_per_bar','once_per_bar_close','once_per_minute'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ma_alerts_kind_ck') THEN
    ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_kind_ck
      CHECK (condition_kind IN ('price','ma','ma_vs_ma'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ma_alerts_ma2_type_ck') THEN
    ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_ma2_type_ck
      CHECK (ma2_type IS NULL OR ma2_type IN ('sma','ema'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ma_alerts_ma2_length_ck') THEN
    ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_ma2_length_ck
      CHECK (ma2_length IS NULL OR ma2_length BETWEEN 1 AND 1000);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ma_alerts_price_dir_ck') THEN
    ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_price_dir_ck
      CHECK (price_direction IS NULL OR price_direction IN ('cross_up','cross_down','either'));
  END IF;

  -- Each kind must carry the columns it needs and no half-filled shape. A row
  -- that satisfies none of these branches is one the runner could not evaluate,
  -- and an alert that silently never fires is worse than one refused at write.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ma_alerts_shape_ck') THEN
    ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_shape_ck CHECK (
      (condition_kind = 'ma'
         AND ma_type IS NOT NULL AND ma_length IS NOT NULL AND mode IS NOT NULL)
      OR (condition_kind = 'price'
         AND target_price IS NOT NULL AND target_price > 0 AND price_direction IS NOT NULL)
      OR (condition_kind = 'ma_vs_ma'
         AND ma_type IS NOT NULL AND ma_length IS NOT NULL
         AND ma2_type IS NOT NULL AND ma2_length IS NOT NULL
         AND mode IN ('cross_up','cross_down')
         -- Two identical lines never cross, so such an alert could never fire.
         AND NOT (ma_type = ma2_type AND ma_length = ma2_length))
    );
  END IF;
END
$$;

-- ── Uniqueness, now per kind ───────────────────────────────────────────────
--
-- The rule is unchanged in spirit: re-arming the same thing is an EDIT, never a
-- silent duplicate that would double every notification. What "the same thing"
-- means simply depends on the kind. Frequency is deliberately not part of any
-- key — changing how often an alert notifies edits that alert.
DROP INDEX IF EXISTS ma_alerts_unique;

CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_ma_unique
  ON ma_alerts (symbol, timeframe, ma_type, ma_length, mode)
  WHERE condition_kind = 'ma';

CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_price_unique
  ON ma_alerts (symbol, timeframe, target_price, price_direction)
  WHERE condition_kind = 'price';

CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_ma2_unique
  ON ma_alerts (symbol, timeframe, ma_type, ma_length, ma2_type, ma2_length, mode)
  WHERE condition_kind = 'ma_vs_ma';

-- A retired once_only alert must stop being watched, so it leaves the feed set
-- the same way a disabled one does.
DROP INDEX IF EXISTS ma_alerts_feed_idx;
CREATE INDEX IF NOT EXISTS ma_alerts_feed_idx
  ON ma_alerts (symbol, timeframe) WHERE enabled AND completed_at IS NULL;

-- ── Event log ──────────────────────────────────────────────────────────────
--
-- `ma_value` is now the REFERENCE the sample was compared against: the moving
-- average for an MA alert, the slow line for a cross, the target for a price
-- alert. It stays NOT NULL because every kind has one.
--
-- `intrabar` records whether the notification fired on a forming candle. It is
-- the honest half of the intrabar promise: when a user asks why an alert fired
-- at a price the finished candle never closed at, the log says so.
ALTER TABLE ma_alert_events
  ADD COLUMN IF NOT EXISTS intrabar boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS frequency text;

COMMENT ON COLUMN ma_alert_events.ma_value IS
  'Reference value compared against: the MA, the slow MA, or the price target.';
