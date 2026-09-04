-- Liveness for push subscriptions.
--
-- Numbered 024, not 018. This arrived on `main` as 018 while the V1 integration
-- branch independently used 018 for `018_backtest_provenance.sql`; the merge put
-- both in the tree, and `alertMigration.test.ts` refuses two migrations sharing a
-- number. Renumbering THIS one is the safe direction — the V1 migrations were
-- frozen and tested together, so moving one of them would invalidate that.
--
-- Production already recorded `018_push_last_seen.sql` as applied, so it will run
-- this file again under the new name. That is harmless: every statement below is
-- idempotent (ADD COLUMN IF NOT EXISTS, an UPDATE restricted to NULLs, CREATE
-- INDEX IF NOT EXISTS). `schema_migrations` will carry both names, which is an
-- honest record of what actually ran.
--
-- `last_ok_at` cannot answer "is this device still real". It is set when the
-- push SERVICE accepts a notification, and Apple accepts endpoints belonging to
-- apps that were uninstalled weeks ago — it only returns 404/410 much later, if
-- at all. Four dead iPhone subscriptions once sat in this table all reporting a
-- `last_ok_at` of minutes ago while nothing reached the phone, and the fan-out
-- counter reported four successful deliveries every time.
--
-- The one thing a ghost cannot do is come back and say hello. `last_seen_at` is
-- written whenever a browser re-registers its own subscription, which the app
-- does on load, so it is a fact about the DEVICE rather than about the push
-- service's willingness to queue bytes.
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- Existing rows have been seen at least once: when they were created. Using
-- `created_at` rather than now() means an already-dead subscription is eligible
-- for pruning on the normal schedule instead of being granted a fresh lease by
-- the migration itself.
UPDATE push_subscriptions SET last_seen_at = created_at WHERE last_seen_at IS NULL;

CREATE INDEX IF NOT EXISTS push_subscriptions_last_seen_idx
  ON push_subscriptions (last_seen_at);
