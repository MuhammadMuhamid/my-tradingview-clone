-- 059: Bot execution push notifications (P-81, Platform half).
--
-- The Platform polls the Bot's signed, read-only feed of CONFIRMED executions
-- (Bot capability `executions.v1`, GET /api/manual-trading/control/executions)
-- and sends a push notification to every ADMIN who opted in. The Bot never
-- depends on this: push is an observer, not an execution dependency.
--
--   bot_execution_feed     the single feed cursor (the last Bot seq stored here);
--   bot_execution_events   one row per Bot event id (the source-event identity,
--                          so a re-read page can never be announced twice);
--   bot_execution_deliveries  one row per (event, recipient) pushed successfully
--                          (the delivery idempotency, separate from the event's);
--   bot_execution_notification_prefs  the per-admin opt-in (off by default).
--
-- Additive only; nothing existing is altered. Rollback (Platform build before
-- this release): the tables are simply unused. To remove them:
--   DROP TABLE bot_execution_deliveries, bot_execution_events,
--              bot_execution_feed, bot_execution_notification_prefs;
-- Added without IF NOT EXISTS on purpose, as 052 explains.

CREATE TABLE bot_execution_feed (
  id          smallint    PRIMARY KEY CHECK (id = 1),
  last_seq    bigint      NOT NULL CHECK (last_seq >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bot_execution_events (
  event_id        text        PRIMARY KEY,
  seq             bigint      NOT NULL,
  side            text        NOT NULL CHECK (side IN ('BUY', 'SELL')),
  symbol          text        NOT NULL,
  environment     text        NOT NULL CHECK (environment IN ('DRY_RUN', 'TESTNET', 'MAINNET', 'UNKNOWN')),
  executed_at     timestamptz NOT NULL,
  -- The validated event as received (no secrets: the contract carries none).
  payload         jsonb       NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  notify_attempts integer     NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  -- Set once the event needs no more delivery work: `sent`, `no_recipients`,
  -- `expired` (too old to be useful when first seen) or `gave_up`.
  notified_at     timestamptz,
  notify_outcome  text
);
CREATE INDEX bot_execution_events_pending_ix ON bot_execution_events (received_at) WHERE notified_at IS NULL;
CREATE INDEX bot_execution_events_recent_ix ON bot_execution_events (executed_at DESC);

CREATE TABLE bot_execution_deliveries (
  event_id      text        NOT NULL REFERENCES bot_execution_events (event_id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  delivered_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE bot_execution_notification_prefs (
  user_id     uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  enabled     boolean     NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
