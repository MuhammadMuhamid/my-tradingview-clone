-- 057: pause new entries (owner decision OD-3, Platform half).
--
-- A second, narrower switch beside the operator halt. While it is on, the
-- Platform refuses every NEW entry it would otherwise emit or forward: strategy
-- BUY emissions from the live runner (every delivery), the deployment test
-- signal's BUY and the Platform manual BUY. Exits, SELLs, cancels and
-- protection edits are never refused by it. It is independent of the halt
-- (which still stops entries AND exits of automated emissions) and lives in
-- the database, so a restart does not forget it.
--
-- Added without IF NOT EXISTS on purpose, as 052 explains.

ALTER TABLE risk_controls ADD COLUMN entries_paused boolean NOT NULL DEFAULT false;
ALTER TABLE risk_controls ADD COLUMN entries_paused_at timestamptz;
-- The account that paused (its uuid), never a name.
ALTER TABLE risk_controls ADD COLUMN entries_paused_by text;
ALTER TABLE risk_controls ADD COLUMN entries_paused_reason text;
