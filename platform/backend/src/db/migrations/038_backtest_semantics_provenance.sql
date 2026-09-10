-- X6 result meaning. Additive by design: pre-X6 rows retain
-- their historical engine-only or unversioned identity and are never relabeled.
ALTER TABLE backtests
  ADD COLUMN result_provenance jsonb;

COMMENT ON COLUMN backtests.result_provenance IS
  'Complete versioned market/data/cost/session methodology for X6+ results; NULL means historical semantics and is surfaced as such.';
