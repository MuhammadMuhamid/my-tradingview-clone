-- Stress-regime analysis: a strategy run against the benchmark's worst periods.
--
-- ── Why the per-window runs are ordinary backtests ────────────────────────
--
-- Each discovered window is executed as a normal row in `backtests`, with the
-- normal engine, the normal correction set, the normal provenance and the
-- normal no-lookahead guarantees, claimed by the normal worker. A stress run
-- is therefore a COORDINATOR: it records how the windows were chosen and which
-- runs answered them. Nothing about stress analysis touches how a strategy is
-- simulated, and it must not, or the numbers would not be comparable with the
-- development and holdout numbers they exist to be compared against.
--
-- ── Why `discovery` is stored rather than recomputed ──────────────────────
--
-- Windows are chosen by searching history for the benchmark's worst stretches,
-- which is ex-post by construction. A report of that kind is worth nothing if
-- the selection cannot be repeated, so the benchmark's identity and provider,
-- the period searched, the method, the length, the rank count and the
-- separation rule are all recorded — "BTC's worst week" is a different week on
-- a different venue's series. `discovery` also carries the epistemic note, so
-- a stored result cannot be separated from the statement of what kind of
-- evidence it is.
CREATE TABLE stress_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id   integer NOT NULL REFERENCES strategies(id),
  config_id     uuid,
  -- The instrument the STRATEGY trades.
  symbol        text NOT NULL,
  timeframe     text NOT NULL,
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  initial_capital numeric NOT NULL,
  commission_pct  numeric NOT NULL,
  slippage_ticks  integer NOT NULL,
  -- The instrument whose stress defines the windows. Often NOT the traded one:
  -- "how does my SOL strategy behave when BTC falls apart" is the question.
  benchmark_symbol   text NOT NULL,
  benchmark_interval text NOT NULL,
  -- `StressProvenance` — everything needed to regenerate the same windows.
  discovery     jsonb NOT NULL,
  -- `StressWindow[]`, each with the id of the backtest that answered it.
  windows       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'done', 'error')),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE INDEX stress_runs_created_idx ON stress_runs (created_at DESC);

COMMENT ON TABLE stress_runs IS
  'Adversarial robustness analysis. Windows are selected from BENCHMARK MARKET DATA ONLY and with hindsight; results here are not out-of-sample evidence.';
COMMENT ON COLUMN stress_runs.discovery IS
  'stress-discovery.v1: benchmark identity and provider, period searched, method, window length, rank count, separation rule, and the epistemic note.';
