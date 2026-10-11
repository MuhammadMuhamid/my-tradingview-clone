-- The backtest request/engine support fractional ticks. Preserve that same
-- cost model in ordinary runs and their linked Stress coordinators rather
-- than rejecting a valid 1.5-tick request at PostgreSQL's integer cast.
ALTER TABLE backtests ALTER COLUMN slippage_ticks TYPE numeric USING slippage_ticks::numeric;
ALTER TABLE stress_runs ALTER COLUMN slippage_ticks TYPE numeric USING slippage_ticks::numeric;
