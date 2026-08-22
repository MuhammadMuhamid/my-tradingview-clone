# TradingView-Lite Platform

Specialized charting + backtesting + live-alerting platform for the
**MA + R:R Strategy (SR+Trend v9)** on Binance spot pairs, feeding the existing
custom webhook bot (3Commas replica) without any bot changes.

## Architecture

```
platform/
├── docker-compose.yml     TimescaleDB (Postgres 16 + timescaledb extension)
├── backend/               Node.js + TypeScript + Fastify
│   └── src/
│       ├── config.ts          env config
│       ├── index.ts           bootstrap: migrate → serve
│       ├── db/
│       │   ├── pool.ts        pg pool (numeric → float parsing)
│       │   ├── migrate.ts     transactional migration runner
│       │   └── migrations/    001_init.sql — full schema + seeds
│       ├── types/             domain contracts shared by all stages
│       │   ├── market.ts      Candle, Interval, INTERVAL_MS
│       │   ├── strategy.ts    StrategyParams, StrategyModule contract
│       │   ├── backtest.ts    BacktestMetrics, TradeRecord, EquityPoint
│       │   └── alerts.ts      3Commas + custom-bot payloads (exact Pine formats)
│       ├── repositories/      SQL data access (candles, symbols, strategies, backtests)
│       └── api/               Fastify routes
└── frontend/              (Stage 4) Next.js + lightweight-charts
```

### Build stages
1. **Stage 1 ✅** — schema, types, repositories, REST API skeleton.
2. **Stage 2 ✅** — TypeScript port of `ma_riskreward_strategy.pine` + bar-by-bar
   backtest engine (`src/engine`). Pine-exact `ta` lib, MTF `request.security`
   merge, TV broker fill model. TV trade-diff harness in
   `scripts/diff_tv_trades.ts` (parity run deferred — see below).
3. **Stage 3 ✅** — Binance klines backfill + multi-pair kline WebSocket manager +
   live bar-close strategy runner + alert dispatcher (3Commas / custom-bot
   payloads, exact Pine formats) with retry + idempotent dedupe.
4. **Stage 4 ✅** — Next.js + lightweight-charts UI: live candle charts,
   grouped strategy-parameter forms, backtest results (metric tiles + equity
   curve + trade list + chart markers), deployment management + live alert
   telemetry. Proxies `/api` to the backend (no CORS). `frontend/`.
5. **Stage 5 ✅** — TradingView-style charting surface: drawing toolbar,
   symbol search, and a Pine Script editor with its own execution engine
   (see below).

### Stage 5 — charting surface

**Drawing tools** (`frontend/lib/drawings.ts`, `components/tv/Drawing*.tsx`).
A left icon rail with 22 tools grouped like TradingView's — trend line / ray /
extended line / arrow, horizontal + vertical lines, parallel channel,
pitchfork, fib retracement and trend-based extension, rectangle / ellipse /
triangle / path, freehand brush, text / callout / price label, and the
measurement set (measure, price range, date range, long & short position with
a live R:R readout) — plus magnet, lock, hide and delete-all toggles.

Drawings are stored as `{time, price}` anchors, never pixels, so they survive
pan, zoom, timeframe changes and history-depth changes; anchors may sit past
the last bar. Rendering is a canvas overlay synced to the chart's own scales
each frame. Pointer events are handled in the capture phase, so dragging a
drawing never pans the chart while clicks on empty space still do. Persistence
is per symbol in `localStorage`.

**Symbol search** — `GET /api/symbols/search` ranks every Binance spot pair
(exchangeInfo, cached 6 h) exact → prefix → substring, floating already-tracked
pairs and mainstream quotes. Picking an untracked pair registers it first, so
the chart can backfill it immediately. Opens from the symbol chip or `/`.

**Pine editor** (`backend/src/pine/`, `components/tv/PineEditor.tsx`).
Write a Pine v5 script, compile it, and add it to the chart: plots become line
overlays, `plotshape` becomes markers, and a `strategy()` script runs through
the same `Broker` and metrics as the built-in strategies. `input.*`
declarations become an editable settings column that re-runs on change.
Scripts are saved in `pine_scripts`.

The engine is a real interpreter (lexer → parser → bar-by-bar evaluator), not
a translator. **`ta.*` calls are not reimplemented**: window functions slice a
node's history and call `engine/ta.ts` directly, and the recursive ones
(ema/rma/atr/rsi) use small state machines that `tests/pine.test.ts` asserts
equal to the array versions bar-for-bar. A script therefore agrees with the
platform's own strategies by construction.

Supported: `indicator`/`strategy`, `input.*`, `var`/`varip`, `:=`, history
`x[n]`, if/else (statement and expression), bounded `for`/`while`, user
functions (single-line and indented, with per-call-site series state like
Pine), `ta.*`, `math.*`, `str.*`, `plot`/`plotshape`/`hline`, colours, and
`strategy.entry`/`close`/`exit` with `position_size`/`position_avg_price`.

Not supported, and reported as a compile error naming the line rather than
silently ignored: `request.security` and any multi-timeframe access, arrays /
matrices / maps, labels / lines / boxes / tables, user-defined types and
methods, libraries, and `switch`.

**Execution limits.** A Pine script is untrusted input that runs synchronously
on the same event loop as the live alert runner, so every limit below aborts
the run with an ordinary line-numbered script error rather than stalling live
signals (`src/pine/interpreter.ts`, `LIMITS`):

| Limit | Value | Why |
|---|---|---|
| wall clock per run | 10 s (`PINE_TIME_BUDGET_MS`) | backstop for anything slow |
| total loop iterations | 20 M | nested loops otherwise blocked for minutes |
| `ta.*` length | 100 000 | a length sizes an allocation |
| history offset `x[n]` | 100 000 | same |
| `plot()` call sites | 64 | bounds output size |
| expression / block nesting | 200 | recursive descent would hit the JS stack |
| source size | 200 KB, 200 k tokens | bounds parse cost |
| bars per run | 120 000 | bounds the Binance backfill a request can trigger |

The declaration pass used by the editor's compile-on-keystroke gets a tighter
budget still (2 s, 1 M iterations).

### Live pipeline (Stage 3)

```
active deployments ─▶ subscribe kline streams (wss://stream.binance.com:9443)
   bar close ("x":true) ─▶ upsert candle ─▶ evaluate strategy on the closed bar
   ─▶ persist runtime_state ─▶ build payload ─▶ POST to bot (retry) ─▶ log alert
```

- **Signals fire on confirmed bar close** — the mode the strategy header
  recommends for live (`useBarConfirm` + `ordersOnConfirmedBar`); deterministic,
  non-repainting. The bot does the real fills; the platform only decides.
- **Payloads are frozen contracts** — custom-bot
  `{secret, action, symbol, quote_order_qty, dedupe_key:"L-<bar>-<time>"}` /
  `{…, dedupe_key:"X-…"}`, and the 3Commas signal-bot JSON. Your bot is unchanged.
- **Crash-safe** — `runtime_state` (position, stops, streaks) is persisted per
  bar; a restart resumes active deployments and gap-fills missed bars via REST.
- **Idempotent** — a repeated `dedupe_key` is skipped, so a reconnect never
  double-fires an order.

Set `WORKER_ENABLED=false` / `LIVE_RUNNER_ENABLED=false` to run the API alone.

## Run it

```bash
# 1. Database — local Postgres 16 cluster (no Docker on this machine)
cd platform
scripts/db.sh init         # first time only (creates .pgdata, starts on :5433)
scripts/db.sh start        # subsequent starts
# (Docker alternative: `docker compose up -d` — same schema, port 5433)

# 2. Backend
cd backend
cp .env.example .env       # defaults match the local cluster
npm install
npm run dev                # http://localhost:4000 (migrates on boot; runs the
                           #   backtest worker + live runner)

# 3. Frontend
cd ../frontend
npm install
npm run dev                # http://localhost:3000 (proxies /api → :4000)
```

Open http://localhost:3000 — three pages: **Chart** (live Binance candles),
**Backtests** (configure/run, metrics + equity curve + trade list + markers),
**Live & Alerts** (deploy a strategy, watch alert telemetry).

## API (Stage 1 surface)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | server + db liveness |
| GET | `/api/symbols` | list tracked pairs (`?active=true`) |
| GET | `/api/symbols/search?q=zec&quote=USDT` | search every Binance spot pair |
| POST | `/api/symbols` | add a pair `{symbol, baseAsset, quoteAsset}` |
| PATCH | `/api/symbols/:symbol` | enable/disable `{isActive}` |
| GET | `/api/symbols/:symbol/candles?interval=5m&limit=1000` | stored OHLCV |
| GET | `/api/strategies` | list strategy modules (seeded: `ma_rr_v9`) |
| GET/POST | `/api/strategies/:key/configs` | parameter presets per coin |
| GET/PATCH/DELETE | `/api/configs/:id` | manage one preset |
| POST | `/api/backtests` | queue a run (async worker executes it) |
| GET | `/api/backtests` `/:id` `/:id/trades` | results + trade list |
| POST | `/api/data/backfill` | fetch+cache klines `{symbol, interval, start, end}` |
| POST | `/api/data/ensure` | ensure coverage without refetching |
| POST | `/api/data/sync-filters` | sync tick/step/minNotional `{symbols:[]}` |
| GET/POST | `/api/layouts` | server-persisted chart layouts (POST upserts by name) |
| GET/PATCH/DELETE | `/api/layouts/:id` | manage one layout |
| POST | `/api/layouts/sync-deployments` | ensure every coin with a saved alert has a layout named after it |
| POST | `/api/deployments` | create a live deployment (paused) |
| GET | `/api/deployments` `/:id` | list / inspect deployments |
| PATCH | `/api/deployments/:id` | edit an alert (buy amount, webhook, secret, delivery) |
| POST | `/api/deployments/:id/activate` `/pause` | start / stop live streaming |
| DELETE | `/api/deployments/:id` | remove a deployment |
| GET | `/api/deployments/:id/alerts`, `/api/alerts` | fired-signal + delivery log |
| GET/POST | `/api/pine` | saved Pine scripts (POST upserts by name) |
| GET/PATCH/DELETE | `/api/pine/:id` | manage one script |
| POST | `/api/pine/compile` | parse + declarations only → metadata, inputs, errors |
| POST | `/api/pine/run` | execute over real candles → plots, shapes, trades, metrics |

## Notes

- **Timestamps** are UTC everywhere; candles use Binance epoch-ms natively.
- **Params as JSONB**: the v9 strategy has ~150 Pine inputs — presets store
  only overrides; the engine fills defaults.
- **Backtests snapshot params** at queue time, so editing a preset never
  rewrites old results.
- **TimescaleDB optional**: `001_init.sql` converts `candles` to a hypertable
  only when the extension exists; plain Postgres works identically.
- **Alert formats are frozen contracts** copied from the Pine source
  (`f_bot_json_buy` / `f_bot_json_sell_exit`) and
  `3commas_alert_message_template.json` — see `src/types/alerts.ts`.
