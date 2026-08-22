-- Moving-average price alerts and their Web Push delivery.
--
-- Two distinct alert families share one table, discriminated by `mode`:
--   touch / cross_up / cross_down  — the bar interacted with the MA line
--   near_above / near_below        — close sits inside a percentage BAND next
--                                    to the MA without reaching it, e.g.
--                                    0.20%..0.50% above the 15 SMA on 1h.
-- Every alert names exactly one MA (type + length) on one symbol + timeframe,
-- so the user can arm each line independently, as TradingView does.

CREATE TABLE IF NOT EXISTS ma_alerts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol         text NOT NULL,
  timeframe      text NOT NULL,
  ma_type        text NOT NULL CHECK (ma_type IN ('sma','ema')),
  ma_length      integer NOT NULL CHECK (ma_length BETWEEN 1 AND 1000),
  mode           text NOT NULL CHECK (mode IN
                   ('touch','cross_up','cross_down','near_above','near_below')),
  -- Band edges in PERCENT, only meaningful for the near_* modes.
  near_min_pct   numeric NOT NULL DEFAULT 0.2,
  near_max_pct   numeric NOT NULL DEFAULT 0.5,
  enabled        boolean NOT NULL DEFAULT true,
  -- Silence window after a fire, so one slow approach is not re-announced on
  -- every closing bar. 0 disables the cooldown.
  cooldown_min   integer NOT NULL DEFAULT 60 CHECK (cooldown_min >= 0),
  note           text,
  -- Which side of the MA the previous evaluated close sat on, for cross detection.
  last_side      text CHECK (last_side IN ('above','below')),
  last_fired_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (near_max_pct > near_min_pct)
);

-- One alert per (symbol, timeframe, MA, mode) — re-arming the same line is an
-- update, never a silent duplicate that would double every notification.
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_unique
  ON ma_alerts (symbol, timeframe, ma_type, ma_length, mode);

CREATE INDEX IF NOT EXISTS ma_alerts_feed_idx
  ON ma_alerts (symbol, timeframe) WHERE enabled;

-- Fired-alert log: powers the in-app alert feed and is the audit trail for
-- notifications that did or did not reach the phone.
CREATE TABLE IF NOT EXISTS ma_alert_events (
  id           bigserial PRIMARY KEY,
  alert_id     uuid NOT NULL REFERENCES ma_alerts(id) ON DELETE CASCADE,
  fired_at     timestamptz NOT NULL DEFAULT now(),
  bar_time     timestamptz NOT NULL,
  price        numeric NOT NULL,
  ma_value     numeric NOT NULL,
  distance_pct numeric NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL,
  pushed_to    integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ma_alert_events_recent_idx
  ON ma_alert_events (fired_at DESC);

-- Web Push endpoints, one row per browser/device that granted permission.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz
);

-- Layouts remember which MA lines are drawn, so opening a coin's saved 1h
-- layout restores its moving averages instead of falling back to a global
-- browser-local indicator list.
ALTER TABLE chart_layouts
  ADD COLUMN IF NOT EXISTS moving_averages jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Small key/value store. Holds the VAPID keypair, which must stay STABLE for
-- the lifetime of a push subscription: rotating it silently invalidates every
-- device the user has already granted permission on. Generating it once here
-- rather than from an env var means a fresh deployment works without the user
-- having to hand-manage keys.
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
