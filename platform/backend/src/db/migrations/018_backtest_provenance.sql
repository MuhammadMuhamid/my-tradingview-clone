-- Historical result rows predate durable engine provenance and remain readable
-- as NULL. Newly completed runs store correctionsFingerprint(ACTIVE_CORRECTIONS).
ALTER TABLE backtests
  ADD COLUMN engine_fingerprint text;

COMMENT ON COLUMN backtests.engine_fingerprint IS
  'Stable engine/correction-set identity that produced this result; NULL for historical rows.';
