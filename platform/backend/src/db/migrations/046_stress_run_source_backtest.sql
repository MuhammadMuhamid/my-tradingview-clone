-- Which finished run's settings a stress run stressed.
--
-- `/stress?from=<backtestId>` copies a finished run's parameters, capital and
-- cost model into the stress request so the windows run the configuration the
-- reader was looking at. The copy was stored — `params`, `initial_capital`,
-- the costs — and where it CAME FROM was not, so a stress result could not say
-- whose settings it was, and a history row read "explicit parameters" for a
-- run that was in fact "the settings of run 3f1c2a9e". Two stress runs of two
-- different source runs were told apart only by reading their parameters.
--
-- One nullable column, set when the run is created from a source. NULL means
-- the strategy's defaults or a hand-filled form, which is what every existing
-- row is: no historical row is relabelled.
--
-- It records PROVENANCE ONLY. The windows are still chosen from benchmark
-- market data alone, before the strategy is named; nothing about the source
-- run reaches discovery.
--
-- ON DELETE SET NULL: a deleted source run takes its name off the stress run,
-- never the stress run itself.
ALTER TABLE stress_runs
  ADD COLUMN source_backtest_id uuid REFERENCES backtests(id) ON DELETE SET NULL;

COMMENT ON COLUMN stress_runs.source_backtest_id IS
  'The finished backtest whose settings this stress run copied, when it was started from one. NULL for defaults or a hand-filled form. Provenance only; never an input to window discovery.';
