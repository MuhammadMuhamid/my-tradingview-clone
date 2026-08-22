-- ════════════════════════════════════════════════════════════════════════════
-- Stage 1 schema — TradingView-lite platform (Binance spot only)
-- All timestamps are UTC (timestamptz). Prices/quantities are NUMERIC in
-- storage to avoid float drift; the app layer parses them to JS numbers.
-- ════════════════════════════════════════════════════════════════════════════

-- ── symbols: Binance spot pairs tracked by the platform ──────────────────────
CREATE TABLE symbols (
  symbol       text PRIMARY KEY,               -- 'BTCUSDT'
  base_asset   text NOT NULL,                  -- 'BTC'
  quote_asset  text NOT NULL,                  -- 'USDT'
  price_tick   numeric,                        -- PRICE_FILTER tickSize (synced from exchangeInfo in Stage 3)
  qty_step     numeric,                        -- LOT_SIZE stepSize
  min_notional numeric,                        -- NOTIONAL minNotional
  is_active    boolean NOT NULL DEFAULT true,  -- shown in UI / eligible for live streams
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── candles: OHLCV cache (REST /api/v3/klines backfill + kline WebSocket) ────
-- The strategy is MTF: one symbol needs several intervals (1m/5m/15m/1h/4h).
CREATE TABLE candles (
  symbol       text        NOT NULL REFERENCES symbols(symbol) ON DELETE CASCADE,
  interval     text        NOT NULL,           -- '1m','5m','15m','1h','4h','1d',…
  open_time    timestamptz NOT NULL,
  open         numeric     NOT NULL,
  high         numeric     NOT NULL,
  low          numeric     NOT NULL,
  close        numeric     NOT NULL,
  volume       numeric     NOT NULL,           -- base-asset volume
  quote_volume numeric,
  trade_count  integer,
  close_time   timestamptz NOT NULL,
  PRIMARY KEY (symbol, interval, open_time)
);

-- TimescaleDB is optional: when the extension is available, convert candles
-- into a hypertable for fast time-range scans. Plain Postgres works fine too.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM public.create_hypertable(
      'candles', 'open_time',
      chunk_time_interval => INTERVAL '7 days',
      if_not_exists => TRUE, migrate_data => TRUE);
  END IF;
END $$;

-- ── strategies: strategy modules ported into the engine ──────────────────────
CREATE TABLE strategies (
  id          serial PRIMARY KEY,
  key         text NOT NULL UNIQUE,            -- engine module key, e.g. 'ma_rr_v9'
  name        text NOT NULL,
  description text,
  pine_source text,                            -- original Pine file this module was ported from
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── strategy_configs: named parameter presets (typically one per coin) ───────
-- params is the full Pine-inputs object (~150 keys for ma_rr_v9); the engine
-- fills any missing key from the module's defaults, so presets stay sparse.
CREATE TABLE strategy_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id integer NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  symbol      text REFERENCES symbols(symbol) ON DELETE SET NULL,  -- NULL = generic preset
  timeframe   text NOT NULL DEFAULT '5m',      -- chart TF the strategy runs on
  params      jsonb NOT NULL DEFAULT '{}',
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (strategy_id, name)
);

-- ── backtests: one row per run; params snapshotted so later preset edits ─────
-- never rewrite historical results.
CREATE TABLE backtests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id     integer NOT NULL REFERENCES strategies(id),
  config_id       uuid REFERENCES strategy_configs(id) ON DELETE SET NULL,
  symbol          text NOT NULL REFERENCES symbols(symbol),
  timeframe       text NOT NULL,
  start_time      timestamptz NOT NULL,
  end_time        timestamptz NOT NULL,
  params          jsonb NOT NULL,
  initial_capital numeric NOT NULL DEFAULT 1000,
  commission_pct  numeric NOT NULL DEFAULT 0.05,  -- % per fill (Pine commission_value)
  slippage_ticks  integer NOT NULL DEFAULT 2,     -- Pine slippage, in min-ticks
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','done','error')),
  error           text,
  metrics         jsonb,   -- BacktestMetrics: netProfit, winRate, profitFactor, maxDrawdownPct, …
  equity_curve    jsonb,   -- [{t, equity, drawdownPct}] downsampled for charting
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX backtests_by_symbol ON backtests (symbol, created_at DESC);
CREATE INDEX backtests_by_status ON backtests (status) WHERE status IN ('queued','running');

-- ── backtest_trades: TradingView-style "List of Trades" ──────────────────────
CREATE TABLE backtest_trades (
  id           bigserial PRIMARY KEY,
  backtest_id  uuid NOT NULL REFERENCES backtests(id) ON DELETE CASCADE,
  trade_no     integer NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('long','short')),
  entry_time   timestamptz NOT NULL,
  entry_price  numeric NOT NULL,
  exit_time    timestamptz,                     -- NULL = still open at end of test
  exit_price   numeric,
  qty          numeric NOT NULL,
  pnl          numeric,
  pnl_pct      numeric,
  exit_reason  text,   -- 'tp','tp1','tp2','sl','trail','break_even','ma_cross','hl_break','vol_exhaust','rsi_exit','session_end','choppy_pause','end_of_test',…
  run_up_pct   numeric,
  drawdown_pct numeric,
  cum_profit   numeric,
  UNIQUE (backtest_id, trade_no)
);

-- ── deployments: a strategy instance running LIVE on one pair (Stage 3) ──────
CREATE TABLE deployments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id   integer NOT NULL REFERENCES strategies(id),
  config_id     uuid REFERENCES strategy_configs(id) ON DELETE SET NULL,
  symbol        text NOT NULL REFERENCES symbols(symbol),
  timeframe     text NOT NULL,
  params        jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'paused'
                CHECK (status IN ('active','paused','stopped')),
  -- Signal delivery, mirroring the Pine 'signal_delivery' input:
  --   '3commas' → POST 3Commas Signal-bot JSON to webhook_url (needs bot_uuid)
  --   'custom'  → POST the FastAPI-bot JSON {secret, action, symbol, quote_order_qty, dedupe_key}
  --   'off'     → evaluate + log signals, send nothing (dry run)
  delivery      text NOT NULL DEFAULT 'custom' CHECK (delivery IN ('3commas','custom','off')),
  webhook_url   text,
  secret        text,
  bot_uuid      text,                            -- 3Commas signal-bot uuid
  buy_quote_qty numeric,                         -- custom bot BUY sizing (quote_order_qty USDT)
  runtime_state jsonb NOT NULL DEFAULT '{}',     -- position, stops, loss/win streaks — survives restarts
  last_bar_time timestamptz,                     -- last confirmed bar processed (gap detection)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── alerts: every fired signal + its delivery outcome ────────────────────────
CREATE TABLE alerts (
  id              bigserial PRIMARY KEY,
  deployment_id   uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  bar_time        timestamptz NOT NULL,          -- open time of the bar that produced the signal
  fired_at        timestamptz NOT NULL DEFAULT now(),
  action          text NOT NULL CHECK (action IN ('buy','sell')),
  market_position text NOT NULL,                 -- position AFTER the signal: 'long' | 'flat'
  position_size   numeric NOT NULL DEFAULT 0,
  trigger_price   numeric NOT NULL,
  reason          text,                          -- which rule fired ('entry','tp','sl','hl_break',…)
  payload         jsonb NOT NULL,                -- exact JSON POSTed to the bot
  dedupe_key      text,                          -- 'L-<bar>-<time>' / 'X-<bar>-<time>' (custom bot format)
  delivery_status text NOT NULL DEFAULT 'pending'
                  CHECK (delivery_status IN ('pending','sent','failed','skipped')),
  http_status     integer,
  response_body   text,
  attempts        integer NOT NULL DEFAULT 0,
  sent_at         timestamptz
);
CREATE INDEX alerts_by_deployment ON alerts (deployment_id, fired_at DESC);

-- ── executions: order audit trail reported back by the bot / Binance ─────────
CREATE TABLE executions (
  id                bigserial PRIMARY KEY,
  alert_id          bigint REFERENCES alerts(id) ON DELETE SET NULL,
  deployment_id     uuid REFERENCES deployments(id) ON DELETE SET NULL,
  exchange_order_id text,
  side              text CHECK (side IN ('BUY','SELL')),
  order_type        text,                        -- 'MARKET' | 'LIMIT'
  qty               numeric,
  price             numeric,
  status            text,                        -- Binance order status (FILLED, …)
  raw               jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ── seeds ─────────────────────────────────────────────────────────────────────
INSERT INTO strategies (key, name, description, pine_source) VALUES
  ('ma_rr_v9',
   'MA + R:R Strategy (SR+Trend v9)',
   'MTF MA trend + SuperTrend + LinReg + volume/structure filters; swing-low R:R bracket with partial TPs, trailing and break-even stops; choppy-market circuit breaker.',
   'ma_riskreward_strategy.pine');

INSERT INTO symbols (symbol, base_asset, quote_asset) VALUES
  ('BTCUSDT', 'BTC', 'USDT'),
  ('ETHUSDT', 'ETH', 'USDT'),
  ('SOLUSDT', 'SOL', 'USDT');
