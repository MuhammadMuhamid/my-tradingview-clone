-- What a stored backtest can now say about itself, beyond one headline number.
--
-- `segments` carries the in-sample / out-of-sample / frozen-holdout scores for
-- a run, computed by `engine/holdout.ts` and `engine/metrics.ts` — two modules
-- that existed, were tested, and had no production caller, so no product
-- surface could split a run at all. It also carries the reason when a split is
-- NOT meaningful: under percent-of-equity sizing a later segment depends on how
-- the earlier one performed, and a rebased number would have no interpretation.
--
-- `execution_truth` carries what ACTUALLY ran, as against what was requested:
-- the covered window, the bars processed, the sizing mode in force and when a
-- fill happens. Boundary coverage may legitimately be partial (a newly listed
-- pair, a cache that begins inside the warmup) and the product used to print
-- the REQUESTED window over it, so a confident number could describe a window
-- a third of which had no data.
--
-- Additive. NULL on every historical row and surfaced as unknown, never as a
-- claim that the run had none.
ALTER TABLE backtests
  ADD COLUMN segments jsonb,
  ADD COLUMN execution_truth jsonb,
  -- A research-policy decision, which is why it is a parameter and not a
  -- constant: how much of the run is held back and never selected on.
  ADD COLUMN holdout_fraction real;

COMMENT ON COLUMN backtests.segments IS
  'IS/OOS/holdout metrics for this run, or the reason a split is not meaningful for it. NULL means the run predates the split.';
COMMENT ON COLUMN backtests.execution_truth IS
  'Covered window, bars processed, sizing mode and fill timing as they actually were. NULL means the run predates the record.';

COMMENT ON COLUMN backtests.holdout_fraction IS
  'Fraction of the covered window frozen as the final holdout. NULL uses the engine default.';
