-- A stress window's run must not be read as an ordinary backtest.
--
-- `engine/stress.ts` states the rule it exists to protect: "The product must
-- never present a stress score beside a holdout score as though the two were
-- the same kind of number." A stress window is chosen with hindsight; a holdout
-- is frozen and never selected on. They are opposite kinds of evidence.
--
-- But a stress window executes as an ORDINARY backtest — deliberately, so its
-- numbers are comparable — and `backtests` carried nothing to say so. The
-- result page therefore rendered its in-sample / out-of-sample / FROZEN HOLDOUT
-- table over a four-day slice of a hand-picked crash, and the research list
-- showed it under the same headers as a real run.
--
-- One nullable column, set by the stress coordinator when it queues the child.
-- NULL means an ordinary backtest, which is what every existing row is.
ALTER TABLE backtests
  ADD COLUMN stress_run_id uuid REFERENCES stress_runs(id);

CREATE INDEX backtests_stress_run_idx ON backtests (stress_run_id)
  WHERE stress_run_id IS NOT NULL;

COMMENT ON COLUMN backtests.stress_run_id IS
  'The stress run this backtest answers one window of. NULL for an ordinary backtest. A stress window is selected with hindsight and must never be presented with a frozen-holdout split.';
