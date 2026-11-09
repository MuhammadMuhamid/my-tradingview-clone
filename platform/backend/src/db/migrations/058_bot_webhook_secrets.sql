-- 058: the Bot's webhook secrets, held by the Platform only (B-SLICE2, Platform side).
--
-- When the administrator creates a bot or rotates its secret from Trading
-- Scene (C10, C14), the Bot's live answer carries the new webhook secret once.
-- The Platform stores it here, encrypted with the existing secrets helper
-- (`security/secrets.ts`, AES-256-GCM, `enc:` prefix), BEFORE it answers the
-- browser, and removes it from everything the browser or the replay cache
-- sees. It never leaves this table except server-side, into
-- `deployments.secret`, when a deployment is linked to the bot
-- (`POST /api/deployments/:id/link-bot`).
--
-- `bot_id` is the Bot's SignalBot id (a uuid, kept as text: it is another
-- service's identifier, not a key of this database).
--
-- Added without IF NOT EXISTS on purpose, as 052 explains.

CREATE TABLE bot_webhook_secrets (
  bot_id     text PRIMARY KEY,
  secret_enc text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Which Bot bot a deployment's secret was copied from (null: pasted by hand,
-- 3Commas, or not linked). Not a foreign key, for the same reason.
ALTER TABLE deployments ADD COLUMN bot_id text NULL;
