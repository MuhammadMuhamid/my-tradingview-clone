-- 050: accounts. Every chart, watchlist, layout, script, drawing and alert
-- belongs to one user, and no user can see or change another's.
--
-- ── The owner of everything that exists today ───────────────────────────────
--
-- Until now there was one sign-in (ADMIN_USERNAME / ADMIN_PASSWORD_HASH) and
-- every row was that person's. They become the fixed ADMIN user below, every
-- existing row is assigned to them, and signing in with the old credentials
-- signs in as that user — so nothing anyone had is lost or re-homed.
--
-- ── Uniqueness is per user ──────────────────────────────────────────────────
--
-- Each "the same alert / watchlist / layout" rule gains `user_id` in front.
-- For alerts that is not cosmetic: the upsert is `ON CONFLICT (…) DO UPDATE`,
-- and without the owner in the key one user arming "RSI 14 crosses 70 on
-- BTCUSDT 1h" would have UPDATED the other user's identical alert in place.
--
-- Each index is recreated from its latest definition (045, 049) with only
-- `user_id` added; `tests/conflictTargets.test.ts` holds the repository's
-- ON CONFLICT targets to exactly these column lists.

CREATE TABLE IF NOT EXISTS users (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lowercased on write; the sign-in identifier for password accounts.
  email           text,
  display_name    text        NOT NULL DEFAULT '',
  avatar_url      text,
  -- scrypt$salt$key, as security/session.ts writes it. NULL for a
  -- Google-only account until the user sets one.
  password_hash   text,
  -- Google's stable subject id ("sub"), never the email, which can change.
  google_sub      text,
  role            text        NOT NULL DEFAULT 'user',
  -- Bumped by "sign out everywhere"; every session carries the version it was
  -- issued under, and an older one is refused.
  session_version integer     NOT NULL DEFAULT 1,
  onboarded_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz
);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_ck;
ALTER TABLE users ADD CONSTRAINT users_role_ck CHECK (role IN ('admin', 'user'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_ck;
ALTER TABLE users ADD CONSTRAINT users_email_ck
  CHECK (email IS NULL OR (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_display_name_ck;
ALTER TABLE users ADD CONSTRAINT users_display_name_ck CHECK (length(display_name) <= 80);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_avatar_ck;
ALTER TABLE users ADD CONSTRAINT users_avatar_ck
  CHECK (avatar_url IS NULL OR (avatar_url ~ '^https://' AND length(avatar_url) <= 2048));

CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_key ON users (google_sub) WHERE google_sub IS NOT NULL;

-- The owner of every existing row. Signs in with the configured admin
-- credentials; its id is fixed so code and this migration agree on it.
INSERT INTO users (id, display_name, role, onboarded_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'Admin', 'admin', now())
ON CONFLICT (id) DO NOTHING;

-- ── watchlists ──────────────────────────────────────────────────────────────
ALTER TABLE watchlists ADD COLUMN IF NOT EXISTS user_id uuid;
UPDATE watchlists SET user_id = '00000000-0000-4000-8000-000000000001' WHERE user_id IS NULL;
ALTER TABLE watchlists ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE watchlists DROP CONSTRAINT IF EXISTS watchlists_user_fk;
ALTER TABLE watchlists ADD CONSTRAINT watchlists_user_fk
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
DROP INDEX IF EXISTS watchlists_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS watchlists_user_name_key
  ON watchlists (user_id, upper(btrim(name)));

-- ── chart layouts ───────────────────────────────────────────────────────────
ALTER TABLE chart_layouts ADD COLUMN IF NOT EXISTS user_id uuid;
UPDATE chart_layouts SET user_id = '00000000-0000-4000-8000-000000000001' WHERE user_id IS NULL;
ALTER TABLE chart_layouts ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE chart_layouts DROP CONSTRAINT IF EXISTS chart_layouts_user_fk;
ALTER TABLE chart_layouts ADD CONSTRAINT chart_layouts_user_fk
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
DROP INDEX IF EXISTS chart_layouts_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS chart_layouts_user_name_key
  ON chart_layouts (user_id, upper(btrim(name)));

-- ── Pine scripts ────────────────────────────────────────────────────────────
-- The built-in library is shared: its rows have no owner, and every user sees
-- them. A user's own scripts are theirs alone.
ALTER TABLE pine_scripts ADD COLUMN IF NOT EXISTS user_id uuid;
UPDATE pine_scripts SET user_id = '00000000-0000-4000-8000-000000000001'
  WHERE user_id IS NULL AND origin = 'user';
ALTER TABLE pine_scripts DROP CONSTRAINT IF EXISTS pine_scripts_user_fk;
ALTER TABLE pine_scripts ADD CONSTRAINT pine_scripts_user_fk
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE pine_scripts DROP CONSTRAINT IF EXISTS pine_scripts_owner_ck;
ALTER TABLE pine_scripts ADD CONSTRAINT pine_scripts_owner_ck
  CHECK ((origin = 'builtin') = (user_id IS NULL));
DROP INDEX IF EXISTS pine_scripts_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS pine_scripts_user_name_key
  ON pine_scripts (user_id, lower(name)) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pine_scripts_builtin_name_key
  ON pine_scripts (lower(name)) WHERE user_id IS NULL;

-- ── chart drawings and pane studies ─────────────────────────────────────────
ALTER TABLE chart_drawings ADD COLUMN IF NOT EXISTS user_id uuid;
UPDATE chart_drawings SET user_id = '00000000-0000-4000-8000-000000000001' WHERE user_id IS NULL;
ALTER TABLE chart_drawings ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE chart_drawings DROP CONSTRAINT IF EXISTS chart_drawings_user_fk;
ALTER TABLE chart_drawings ADD CONSTRAINT chart_drawings_user_fk
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE chart_drawings DROP CONSTRAINT IF EXISTS chart_drawings_pkey;
ALTER TABLE chart_drawings ADD CONSTRAINT chart_drawings_pkey PRIMARY KEY (user_id, venue, symbol);

ALTER TABLE chart_pane_studies ADD COLUMN IF NOT EXISTS user_id uuid;
UPDATE chart_pane_studies SET user_id = '00000000-0000-4000-8000-000000000001' WHERE user_id IS NULL;
ALTER TABLE chart_pane_studies ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE chart_pane_studies DROP CONSTRAINT IF EXISTS chart_pane_studies_user_fk;
ALTER TABLE chart_pane_studies ADD CONSTRAINT chart_pane_studies_user_fk
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE chart_pane_studies DROP CONSTRAINT IF EXISTS chart_pane_studies_pkey;
ALTER TABLE chart_pane_studies ADD CONSTRAINT chart_pane_studies_pkey PRIMARY KEY (user_id, scope);

-- ── push subscriptions ──────────────────────────────────────────────────────
-- A device is subscribed FOR a user: an alert's notification goes to its
-- owner's devices only. One browser shared by two accounts holds one row per
-- account.
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_id uuid;
UPDATE push_subscriptions SET user_id = '00000000-0000-4000-8000-000000000001' WHERE user_id IS NULL;
ALTER TABLE push_subscriptions ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_user_fk;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_user_fk
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_endpoint_key;
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_user_endpoint_key
  ON push_subscriptions (user_id, endpoint);

-- ── alerts ──────────────────────────────────────────────────────────────────
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS user_id uuid;
UPDATE ma_alerts SET user_id = '00000000-0000-4000-8000-000000000001' WHERE user_id IS NULL;
ALTER TABLE ma_alerts ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_user_fk;
ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_user_fk
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS ma_alerts_user_idx ON ma_alerts (user_id);

DROP INDEX IF EXISTS ma_alerts_ma_unique;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_ma_unique
  ON ma_alerts (user_id, symbol, timeframe, ma_type, ma_length, mode, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'ma';

DROP INDEX IF EXISTS ma_alerts_price_unique;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_price_unique
  ON ma_alerts (user_id, symbol, timeframe, target_price, price_direction, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'price';

DROP INDEX IF EXISTS ma_alerts_ma2_unique;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_ma2_unique
  ON ma_alerts (user_id, symbol, timeframe, ma_type, ma_length, ma2_type, ma2_length, mode, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'ma_vs_ma';

DROP INDEX IF EXISTS ma_alerts_sr_unique;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_sr_unique
  ON ma_alerts (user_id, symbol, timeframe, sr_side, mode, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'sr_zone';

DROP INDEX IF EXISTS ma_alerts_pivot_unique;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_pivot_unique
  ON ma_alerts (user_id, symbol, timeframe, pivot_type, pivot_level_name, pivot_anchor, mode, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'pivot_level';

DROP INDEX IF EXISTS ma_alerts_rsi_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_rsi_uniq
  ON ma_alerts (user_id, symbol, timeframe, rsi_length, indicator_target, rsi_level, rsi_ma_length, mode, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'rsi';

DROP INDEX IF EXISTS ma_alerts_macd_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_macd_uniq
  ON ma_alerts (user_id, symbol, timeframe, macd_fast, macd_slow, macd_signal, indicator_target, mode, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'macd';

DROP INDEX IF EXISTS ma_alerts_supertrend_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_supertrend_uniq
  ON ma_alerts (user_id, symbol, timeframe, st_period, st_multiplier, st_atr_method, mode, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'supertrend';

DROP INDEX IF EXISTS ma_alerts_bollinger_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_bollinger_uniq
  ON ma_alerts (user_id, symbol, timeframe, bb_length, bb_mult, bb_band, bb_ma_type, mode, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'bollinger';

DROP INDEX IF EXISTS ma_alerts_stochastic_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_stochastic_uniq
  ON ma_alerts (user_id, symbol, timeframe, stoch_k_length, stoch_k_smooth, stoch_d_smooth, indicator_target, stoch_level, mode, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'stochastic';

DROP INDEX IF EXISTS ma_alerts_adx_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_adx_uniq
  ON ma_alerts (user_id, symbol, timeframe, adx_di_length, adx_smoothing, adx_level, mode, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'adx';

DROP INDEX IF EXISTS ma_alerts_candlestick_pattern_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_candlestick_pattern_uniq
  ON ma_alerts (user_id, symbol, timeframe, pattern_id, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'candlestick_pattern';

DROP INDEX IF EXISTS ma_alerts_fib_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_fib_uniq
  ON ma_alerts (user_id, symbol, timeframe, fib_deviation, fib_depth, fib_reverse, fib_level, mode, filters)
  NULLS NOT DISTINCT WHERE condition_kind = 'fib_level';
