# Architecture

**Status:** current. Three systems, three repositories, explicit ownership boundaries.

**V3 capability note.** Platform is the canonical Trading Scene workstation and
owns multi-asset market/provider contracts plus the canonical backtest engine
(crypto spot and derivatives, U.S. stocks/ETFs, FX, dated and continuous
futures). External authenticated/data-entitlement paths are
`UNVERIFIED_DISABLED`; the current live execution and native Scanner workflows
are Binance Spot-only and the Bot remains the sole order-placement owner. See
the [V3 owner handoff](../../evidence/TRADING_SCENE_V3_OWNER_HANDOFF.md) for the
authoritative provider matrix.

## The three systems

| | Platform (`trading-scene-platform`, this repository) | Research (`trading-scene-research`) | Execution bot (`trading-scene-bot`) |
|---|---|---|---|
| Role | live charting, alerts, deployments and canonical backtest engine | offline optimizer/research trees consuming the canonical engine | exchange execution |
| Decides when to trade live | **yes** | no | no |
| Places exchange orders | no | no | **yes** |
| Holds Binance API keys | **never** | **never** | yes, AES-256-GCM encrypted at rest |
| Database | PostgreSQL / TimescaleDB | uses platform market data when a run is explicitly started | SQLite via Prisma |
| Stack | Fastify + TypeScript, Next.js | TypeScript/Python research tools | Express + TypeScript, Vite + React |

The split is deliberate, not an accident of history. The platform's live and
backtest paths share one canonical engine; research consumes it without copying
it; exchange credentials exist in exactly one bot process. **Do not move
credential handling into the platform, duplicate the engine in research, or
merge the repositories.** What remains hand-vendored between platform and bot
is the webhook contract, documented in
[docs/WEBHOOK-CONTRACT.md](WEBHOOK-CONTRACT.md).

## How a signal becomes an order

```
Binance kline websocket
        │  bar close
        ▼
platform/backend/src/engine/liveRunner.ts
        │  loads candles, backfills gaps, evaluates the deployment's strategy
        ▼
platform/backend/src/engine/*LiveEvaluator.ts       ── decision: buy / sell / hold
        │
        ▼
platform/backend/src/alerts/dispatcher.ts           ── builds the payload, POSTs it
        │        (HTTPS, host allowlist, port 443, no embedded credentials)
        ▼
bot:backend/src/routes/webhooks.ts                 ── zod validation, secret lookup
        │
        ▼
bot:backend/src/services/webhook.ts                ── dedupe, sizing, guards
        │
        ▼
bot:backend/src/services/binance.ts                ── MARKET order on Binance Spot
```

A second, deliberately narrower path exists: TradingView can POST a SELL/exit
to the same bot endpoint directly. The Bot rejects every exposure-increasing
action without paired Platform deployment/order-intent correlation and signed,
single-use durable Platform authority.

Position state flows the other way on a 30-second poll: the platform asks
`POST /api/webhooks/signal_bots/status` which symbols the bot currently holds.

The strategy-parity boundary is the output of `*LiveEvaluator.ts`, before
`LiveRunner.fireAlert` applies operator halt/risk controls or performs delivery.
Research adapters call the canonical `strategies/*/runBars` modules through
`PLATFORM_BACKEND`; Research does not carry another strategy implementation.
At this boundary, order prices are normalized with the same stored
`symbols.priceTick` used by the historical broker. MTF source values are visible
only when their source close is at or before the completed target-bar close.

Deterministic cross-path coverage proves the current `mtf_lean` evaluator over
a flat → long → TP1 → TP2 → flat sequence, including carried trail/partial
state. It deliberately does not claim that downstream halt, risk, delivery or
exchange behavior is historical strategy parity. Two production input gaps are
still explicit rather than normalized away: Research workers load fixed deep
warm-up windows while LiveRunner reloads rolling per-feed windows. New
historical runs use the complete corrected fingerprint; legacy histories remain
quarantined until recomputed rather than being silently relabelled.

## Platform components

| Module | Responsibility |
|---|---|
| `platform/backend/src/api` | HTTP surface: charts, backtests, deployments, optimizer views, Pine execution, MA alerts, push, auth. |
| `platform/backend/src/engine` | Strategy implementations, the backtest broker, metrics, the multi-timeframe merge, and the live evaluators. |
| `platform/backend/src/data` | Binance Spot REST backfill over the configurable public market-data host, kline websocket, and bounded candle-integrity contract. |
| `platform/backend/src/alerts` | Payload construction, delivery with retries, notification-alert evaluation across all eleven condition families, Web Push. |
| `platform/backend/src/repositories` | All SQL. Nothing else talks to the database. |
| `platform/backend/src/pine` | Lexer, parser and interpreter for user-supplied Pine scripts. |
| `platform/backend/src/security` | Session signing, secret encryption, payload redaction. |
| `platform/backend/src/optimizer` | The tree registry each research tree owns an entry in, the shared GA driver and objective, bounded result reading, and the walk-forward selection helper. |

The candle-integrity contract inspects only the batch, requested series, or
backfill/live boundary already in hand. It reports `healthy`, `degraded`, or
`invalid` with machine-readable issue codes for timestamp ordering and
duplicates, completed-interval gaps, OHLC/numeric/identity defects, and
timeframe-derived staleness. Forming and not-yet-closed intervals are not
reported as historical gaps. Closed WebSocket bars validate against the newest
stored/observed open time before the existing idempotent upsert; explicit
backfills return their bounded report. Invalid candles are not persisted, and
gaps are reported rather than filled or interpolated.

All Binance history is acquired from the **public** Spot endpoints
(`/api/v3/klines`, `/api/v3/exchangeInfo`) — no credential exists on this path.
The origin is configuration (`BINANCE_MARKET_DATA_BASE_URL`, validated against
the official Binance public-host allowlist) so a network refused by
`api.binance.com` can use Binance's market-data-only mirror without a source
change. An explicitly bounded window is acquired by `backfillRange`, which
shares one paging authority with `fetchKlines` and upserts each batch as it
arrives, so a multi-year 1m history is persisted incrementally instead of being
held in memory. See `docs/OPERATIONS.md` §8 for the operator command.

`GET /api/ops/status` reads the incremental `feed_health` row and exposes the
Spot symbol/timeframe, integrity state and issue counts, latest completed-bar
time/age, and last check time. The status request does not rescan candle
history.

### Chart resolutions

The candle store holds **thirteen intervals** — `1s 1m 3m 5m 15m 30m 1h 2h 4h 6h
8h 12h 1d` (`platform/backend/src/types/market.ts`). Every one of them is a Binance Spot
kline the venue publishes, verified against the configured market-data host
rather than taken from documentation; `1s` is real and goes back to 2017.

A **chart** may sit on more than those. `platform/backend/src/data/resolution.ts`, mirrored
byte-for-byte into `platform/frontend/lib/resolution.ts` and pinned by
`platform/frontend/tests/resolution.test.ts`, defines a `Resolution` as either a stored
interval or an **exact whole multiple** of one: `30s` is thirty `1s` bars, `45m`
is three `15m` bars, `3h` is three `1h` bars. The source is always the coarsest
native interval that divides the target exactly, so the source bars tile the
bucket with no boundary inside it — and a sub-minute resolution is folded from
`1s` and never from `1m`, which would be a picture of a minute with a smaller
label on it.

Boundaries are `floor(t / ms) * ms` in epoch UTC, closing at `open + ms − 1`.
They come from the grid rather than from the bars present, so a bucket whose
first source bar is missing is a bar with less inside it at the place the grid
says, not a bar somewhere else. The newest bucket is served incomplete on
purpose: that one is the forming bar, and `now > closeTime` remains the single
definition of "closed" for a derived resolution and a native one alike.

A resolution has exactly **one spelling**: `60m` is refused because `1h` already
names it, and an uppercase unit is refused outright because `1M` means a month
everywhere a user has seen an interval written. One spelling is what makes one
identity — the history request, the live stream, the Replay clip, the studies,
the labels and the persisted pane state all name the same thing.

Nothing derived is stored. `readResolvedCandles` reads the source rows and folds
them per request, so there is one row per real venue bar and no possibility of a
stored `45m` series drifting from the `15m` series it is made of. The live half
is the browser's: Binance publishes a stream per native interval, so a `45m`
pane listens to `@kline_15m` and folds the frames, accumulating volume per
source bar rather than per frame. A bucket the feed did not observe from its
first source bar emits nothing at all — the chart keeps the server's own exact
fold of it and the feed starts at the next boundary, which costs one bar of
liveness and never draws a fragment as a bar.

Where a resolution stops: alerts, backtests, deployments and the optimizer read
the candle store, so they run on stored intervals. A chart on `45m` cannot arm a
`45m` alert, and the dialogs **say so** and name the interval they will use
instead (`platform/frontend/components/tv/ResolutionNotice.tsx`) rather than substituting one
quietly. `POST /api/alerts` refuses a timeframe the runner cannot evaluate —
including `1s`, whose two-second intrabar floor cannot honour once-per-bar-close.

### The chart's own study layer

One canonical mathematical layer, `platform/backend/src/ta/core.ts`, mirrored
byte-for-byte into `platform/frontend/lib/ta/core.ts` and re-exported by
`platform/backend/src/engine/ta.ts`,
`platform/backend/src/engine/pivotLevels.ts` and
`platform/backend/src/engine/srZones.ts`. The
re-exports are asserted by **reference equality** in `taParity.test.ts`, so
there is one implementation rather than two that agree today: a pivot alert
fires on the arithmetic the browser drew.

Above it sits a registry of **56 built-in studies** (`frontend/lib/native/`)
covering moving averages, momentum, volatility and channels, volume and flow,
market structure, and the statistical tools — standard deviation with a
variance output, z-score, percentile rank, regression slope and R-squared,
historical volatility. Each entry declares its inputs, plots, precision,
warm-up and compute; the registry drives settings, the legend, search and
persistence, so adding one is a definition rather than a feature.

Studies are computed over the **visible window plus their declared warm-up**,
not the whole loaded history, and the window follows the viewport rather than
the newest bar. Studies whose value depends on every prior bar — running
accumulations, session anchors, ratcheting state machines, adaptive recursions
and market structure — declare `unbounded` and are handed the whole series,
because for them a window is a different indicator rather than a cheaper one.

Anchored VWAP is a **drawing** rather than a study, because its defining input
is a point on the chart. Compare (normalised overlay, rolling correlation,
rolling beta) loads one second series through the same history path a pane
uses; bars are matched by open time and a bar the second instrument lacks is
`na`, never forward-filled.

`chart_drawings` and `chart_pane_studies` (migrations 029 and 031) hold this
state per account. Drawings are keyed by canonical instrument and studies by
pane, which is the existing semantics: a trendline belongs to an instrument,
while a pane's studies stay put when its symbol changes. Every write carries
the version it last read; a stale write is refused with the state that is
actually stored. There is no CRDT and no merge.

### Binance Spot execution scope and native Scanner

The current live execution surfaces are Spot-only: notification alerts, Manual
Trading V1, deployments, Paper and the Scanner represent Binance Spot
instruments. The broader Platform workstation also exposes read-only
multi-market provider capabilities and the canonical multi-asset backtester;
those paths do not authorize orders. The native `/scanner` route is part of the
authenticated Next.js Platform, while the
Python Scanner remains the calculation authority for Mahamid's 1h/15m/5m
checklist, eight indicators, S&R/VWAP/pivots, confluence scoring and empirical
calibration. Browser traffic follows a fixed boundary:

**Bar Replay.** Replay is a chart-local historical evaluation horizon over the
already loaded Spot candle sequence; it does not replace live ingestion. Its
single clock is the current replay chart bar's `closeTime`. Visible candles,
OHLC/current price, moving averages, Pine, script drawings and MTF feeds are
bounded to that close, and `request.security` keeps the established inclusive
completed-source-close rule. Previous/Next move one real bar; Play advances the
same sequence at 1x/2x/5x and stops at the captured history end. A symbol or
timeframe change preserves T and resolves the last completed new-context bar at
or before it.

Persisted drawings have no creation-time provenance, so Replay V1 hides them;
session drawings are isolated in memory and are discarded on exit. Manual
trading, Bot/LiveRunner automation, paper actions and live alert creation/editing
are disabled until Replay exits. Replay Paper Trading is not implemented.

```
browser /scanner
    -> authenticated Platform /api/scanner/*
    -> explicit bounded Scanner-service operations
    -> Python cached snapshot/calculation
```

There is no browser-visible Scanner service URL and no generic proxy. Scanner
reads do not refresh market data. Its explicit refresh, symbol and calibration
operations retain the Platform route allowlist and bounded timeouts.

The Scanner production feed is ccxt `binance` with `defaultType: spot`.
Configured `BASE/QUOTE` symbols resolve only to the exact active Spot market;
`BTC/USDT:USDT`, dated Futures and denominated alternatives are never adopted.
SQLite candles, series metadata and calibrations are keyed by exchange, so
legacy `binanceusdm` rows remain historical and are invisible to `binance`.
Calibration fingerprints additionally include exchange, market type and native
symbol, preventing a USD-M calibration from validating as current Spot work.

Expanded Scanner rows keep normal row clicks as inspection and expose only
prefill navigation:

- **Open Chart** selects the exact compact Platform Spot symbol (`BTC/USDT` ->
  `BTCUSDT`) after exact API provenance is verified.
- **Create Alert** opens the existing Spot level-alert review UI with the symbol
  prefilled; it does not save or arm anything.
- **Trade** opens the existing Manual Spot Trading V1 ticket with only the symbol
  prefilled. Side, quantity, review, confirmation, halt and risk paths are
  unchanged; Scanner cannot submit an order.
- **Backtest** remains unavailable because no existing Platform strategy is an
  exact representation of the Scanner checklist. Calibration is not a backtest.

Two independent runners exist in one process:

- **`LiveRunner`** — strategy deployments that can move money.
- **`MaAlertRunner`** — notifications that cannot. Its only output is a Web Push
  notification.

  The name is now narrower than the job: it evaluates eleven condition families
  (`ma`, `price`, `ma_vs_ma`, `sr_zone`, `pivot_level`, `rsi`, `macd`,
  `supertrend`), every one of which accepts optional RSI / moving-average /
  Supertrend trend gates, and it evaluates forming candles as well as closed
  ones for the intrabar frequencies. See [ALERTS.md](ALERTS.md).

Nothing in the notification path can create a deployment, send a webhook, or reach
Binance's order endpoints. That separation is an invariant, asserted over the
runner's entire transitive import graph in `platform/backend/tests/alertIsolation.test.ts`.

A third path exists and moves no money either: a deployment with
`delivery: "paper"` evaluates the same strategy on the same bars and **simulates
the fill** instead of sending it. `platform/backend/src/engine/paperBroker.ts`
is a pure module importing nothing at all, and
`platform/backend/tests/paperIsolation.test.ts` asserts the same graph property
for it. See [OPERATIONS.md](OPERATIONS.md).

### Trade / Order Timeline read model

The Timeline shown from Manual Trading order rows and deployment rows is a
read-only projection, not another execution ledger. Manual rows use the Bot's
exact signed `ManualOrder` evidence lookup with its bounded state contract as a
fallback. Custom live deployments enrich recent exact Platform source/dedupe
identities from the Bot's `StrategyOrderIntent` evidence lookup. Platform
`order_intents`, `alerts`, explicitly linked `executions`, and `paper_fills`
remain the local evidence sources.
Correlation uses stored request/client/exchange/order/alert/deployment keys and
never symbol, side, quantity, or approximate time.

An immutable row with its own occurrence time is rendered as a persisted event.
A mutable order snapshot is rendered as current known state at its explicit
`updatedAt`; it is not expanded into transitions that storage did not retain.
`createdAt` is never reused for submission, fill, cancellation, or completion,
and equal real timestamps remain equal (a stable secondary order affects only
rendering). Bot enrichment is server-side, demand-driven, hard-bounded, and
never persisted into a duplicate Platform ledger. Bot unavailability or an
exact-identity miss does not erase Platform evidence. Individual Bot exchange
fills, commission history, prior cumulative snapshots, and unpersisted
intermediate transitions remain unavailable rather than reconstructed.

The authenticated read boundary is deliberately narrow and bounded:
`GET /api/trading-timeline/manual-orders/:id` performs one exact signed order
lookup plus the existing bounded state fallback, and
`GET /api/trading-timeline/deployments/:id?limit=1..100` returns recent evidence
for one deployment, with Bot reads capped to the newest 10 exact intents.
Neither endpoint writes, reconciles, submits, or contacts an exchange.

### Trade Journal read projection

The Journal answers a different question from Timeline: it projects chronological
activity and accumulated known realized outcomes across sources, while Timeline
explains the lifecycle evidence for one order or deployment. `GET /api/journal`
is authenticated by the Platform's default session gate and accepts a date range
(at most 366 days), source/symbol/strategy/deployment filters, day/week/month
grouping, and page/limit bounds (at most 100 rows and 100 pages). Summary scans
are hard-capped and declare truncation rather than presenting a partial total as
complete.

The projection reads existing truth; it is not another execution ledger. Durable
live `order_intents` and linked `executions` are activity with unknown economics.
Platform `realised_pnl` rows are realization events with their persisted signed
result. New `BOT_CUSTOM_V1` rows originate only from the Bot's authoritative
accounting transaction and carry unique source-event identity, exact Bot intent,
exchange-order identity, Platform dedupe/credential provenance and, for current
commands, direct Platform deployment/order-intent identity, partial/final kind,
authoritative realization time, and accounting metadata. Values cross as
canonical decimal strings; Platform never reconstructs cost basis, fills, fees,
or final-leg P&L. Identical replay is idempotent and conflicting same-ID content
fails closed. Legacy rows stay nullable without guessed identities.

Bot partials are per-slice results and a final event is only the remaining
final-leg delta, never cumulative SmartTrade P&L repeated as another event.
Their sum equals Bot cumulative accounting. The current Bot model adjusts buy
cost and sell revenue by fixed 0.1% rates; it is labeled modeled fee-adjusted,
not exchange-observed net, and absent commission history remains Unknown. Paper sells reuse the
paper engine's persisted net P&L and its no-averaging single-position relationship
to allocate the persisted entry/exit commissions; a final sell is a closed paper
episode and a partial sell remains a realization. ManualOrder state is fetched
once through the existing signed state contract, never once per row, and remains
activity unless a future authoritative cost-basis/disposition relationship exists.
Manual BUY and SELL orders are never paired.

Real and PAPER summaries are returned and rendered separately. Only rows with a
known persisted realized result enter known totals or win/loss counts. Date
buckets use the realization time; activity and any outcome without such a time
cannot enter a fabricated bucket. The Journal performs no automated Bot history
lookups: it reads the durable `realised_pnl` projection once. Individual exchange
fills, commissions, historical cumulative snapshots, and manual realized P&L
remain unavailable rather than inferred.

Delivery is a Bot-owned SQLite outbox of immutable v1 payloads, pushed in
HMAC-authenticated batches of at most 50 with timestamp/nonce replay controls
and bounded backoff. Receipt is one PostgreSQL transaction, including exact
deployment/order-intent correlation. Current Platform commands put direct IDs
in headers an old Bot safely ignores. A new Bot behind an old Platform persists
the event with a one-way credential identity and dedupe key, which the upgraded
Platform resolves uniquely or rejects; it never approximates. Arrival order is irrelevant; Journal and
overlays use authoritative realization time. Migration/reconciliation never
scans old closed trades or PartialClose rows, so cutover is going-forward only.
Ingestion/delivery remain independently opt-in for staged rollout. 3Commas
remains unsupported because it has no equivalent authoritative
durable accounting evidence.

### Spot chart trading overlays

`GET /api/trading-overlays` is the authenticated, read-only chart projection for
one exact tracked Spot symbol and an explicit time range (at most 366 days and
500 returned items). It reuses Journal repository evidence for persisted
automated execution snapshots, Platform realizations and paper fills, plus one
bounded Manual state read outside Replay. Current lines use only the newest
persisted execution observation, explicit ManualPosition state, deployment
runtime position state, or the paper engine's newest persisted accounting row.
There is no generic query surface, per-marker Bot lookup, second ledger, or new
position-accounting policy.

A persisted paper fill is an individual simulated fill. A ManualOrder with
`completedAt`, cumulative executed quantity and average execution price is one
order-completion/executed-activity event; it is never expanded or labelled as
individual exchange fills. Automated `executions` rows likewise remain
cumulative execution snapshots. Intent-only, rejected/failed, missing-price and
missing-time records do not become execution markers. Manual BUY and SELL
orders are never paired: a manual position line exists only for an explicit
current ManualPosition record, and no manual cost basis is reconstructed.

Historical markers retain their original event timestamp and attach only to the
loaded candle whose actual open/close interval contains it. Events in gaps or
outside the loaded range are omitted rather than moved to a nearest or future
bar. Active LIMIT and position lines are current-state observations with their
observation timestamp, not proof of every lifecycle transition or a timeless
exchange guarantee. Real, testnet/dry-run and PAPER labels remain explicit;
PAPER also uses label/shape text so color is not the only distinction.

The browser settles visible-range changes for 300 ms, requests only the buffered
loaded range, caches historical responses by symbol/range/Replay cutoff, aborts
obsolete requests and token-rejects late responses. Historical evidence does
not poll. Current state uses the same endpoint's `scope=current` branch on the
existing 30-second cadence. Display toggles are the only overlay data stored in
`localStorage`; evidence remains server-owned. Truncation is returned and shown.

Replay is enforced before serialization: the server clamps the repository range
and applies a final projection guard at Replay cutoff T. It performs no Manual
state read and no current live order/position queries. Manual history is omitted
in Replay because its present source is a live current-state contract and cannot
prove what was knowable at T. The client additionally keys and rejects results
by exact cutoff, so rewinding cannot reuse a later-T response. Existing Replay
trading restrictions remain unchanged. Overlay selection can open the existing
Journal or deployment Timeline surfaces, but the chart adds no submit, cancel,
amend, replace, drag-to-trade or one-click execution behavior.

User-supplied Pine runs on a **worker thread**, not this one
(`platform/backend/src/pine/runInWorker.ts`): its own heap, a wall clock backed
by terminating the thread, and a bounded number of concurrent runs. A heavy
script can no longer stall live evaluation.

## Research trees

Optimizer, walk-forward, holdout and analysis trees live only in the separate
[`trading-scene-research`](https://github.com/2ms-muzammil/trading-scene-research)
repository. The platform can read their registries and results when
`OPTIMIZER_ROOT` points at that checkout. In the other direction, an explicitly
started research process sets `PLATFORM_BACKEND` to this repository's
`platform/backend`; a Node resolver then loads this canonical engine and its
installed dependencies regardless of checkout location. There is no copied
engine and no symlink contract.

Tree registry, cost-model and search-space checks run in the research
repository's standalone CI. Generated multi-gigabyte results remain absent from
Git. This platform's optimizer API reports an empty registry when
`OPTIMIZER_ROOT` is absent instead of pretending research lives here.

## Known structural problems

Real, and recorded in [docs/REMEDIATION-LEDGER.md](REMEDIATION-LEDGER.md) rather
than described here as if they were resolved:

- **The webhook contract is hand-duplicated across the two repositories.** Each
  side vendors a copy with a fingerprint of its own source, and a test on each
  side fails when they diverge — but nothing makes them one artifact.
- **Binance-native protection is disabled and externally unverified.** The
  canonical corrected backtest/live model therefore decides after a completed
  candle and executes a later MARKET exit, retaining the intended stop/target
  only as provenance. No trigger-price or downtime-protection parity is claimed.
- **The multi-timeframe merge convention is resolved** (`BE-08`). Official Pine
  v6 documentation places new historical `lookahead_off` values at the end of
  each HTF period. Both built-in MTF and the Pine interpreter now use that
  close-time boundary; focused tests retain the no-future-data guard.

Resolved since the audit, and no longer true of this checkout: the optimizer API
routing (`X-04`), the Pine interpreter sharing the live runner's event loop
(`BE-23`), and multi-gigabyte synchronous reads inside request handlers
(`BE-24`).

## What is verified, and how far

Four different kinds of statement appear in this documentation, and they are not
interchangeable:

| Kind | What backs it | Example |
|---|---|---|
| **Current implemented behaviour** | A test that runs in CI on every commit. | The alert runner cannot reach a deployment; a paper deployment cannot place an order; the four alert frequencies. |
| **Historical result** | A number produced by a research run whose generated data is not in Git. | Every optimizer leaderboard figure, every walk-forward fold, every `ANALYSIS_*` document. |
| **Locally implemented, externally unverified** | Code and tests exist; the external system has never been contacted from here. | The exchange-native stop adapter, the holdout deploy gate (no artifact carries a clearance yet), migrations 010 and 011. |
| **Production fact, unconfirmed** | Nothing in this workspace can check it. | What the AWS deployment is running, whether the exposed webhook secret was rotated, what the production database contains. |

[OPERATIONS.md §4](OPERATIONS.md) lists the third and fourth categories
explicitly, because a control that has never been exercised is not a control you
can count on.
