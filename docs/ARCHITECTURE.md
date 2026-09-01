# Architecture

**Status:** current. Three systems, three repositories, explicit ownership boundaries.

## The three systems

| | Platform (`my-tradingview-clone`, this repository) | Research (`pythoncryptobacktesingsystems`) | Execution bot (`3commabotclone`) |
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

A second, independent path exists: TradingView can POST the same payload shape
to the same bot endpoint directly, from a Pine `alert()` call. Both paths can be
active at once, and they do **not** share dedupe state
(see `X-02` in the remediation ledger).

Position state flows the other way on a 30-second poll: the platform asks
`POST /api/webhooks/signal_bots/status` which symbols the bot currently holds.

## Platform components

| Module | Responsibility |
|---|---|
| `platform/backend/src/api` | HTTP surface: charts, backtests, deployments, optimizer views, Pine execution, MA alerts, push, auth. |
| `platform/backend/src/engine` | Strategy implementations, the backtest broker, metrics, the multi-timeframe merge, and the live evaluators. |
| `platform/backend/src/data` | Binance REST backfill and the kline websocket. |
| `platform/backend/src/alerts` | Payload construction, delivery with retries, notification-alert evaluation across all seven condition families, Web Push. |
| `platform/backend/src/repositories` | All SQL. Nothing else talks to the database. |
| `platform/backend/src/pine` | Lexer, parser and interpreter for user-supplied Pine scripts. |
| `platform/backend/src/security` | Session signing, secret encryption, payload redaction. |
| `platform/backend/src/optimizer` | The tree registry each research tree owns an entry in, the shared GA driver and objective, bounded result reading, and the walk-forward selection helper. |

Two independent runners exist in one process:

- **`LiveRunner`** — strategy deployments that can move money.
- **`MaAlertRunner`** — notifications that cannot. Its only output is a Web Push
  notification.

  The name is now narrower than the job: it evaluates seven condition families
  (`ma`, `price`, `ma_vs_ma`, `sr_zone`, `pivot_level`, `rsi`, `macd`), the two
  level families accept optional trend gates, and it evaluates forming candles
  as well as closed ones for the intrabar frequencies. See
  [ALERTS.md](ALERTS.md).

Nothing in the notification path can create a deployment, send a webhook, or reach
Binance's order endpoints. That separation is an invariant, asserted over the
runner's entire transitive import graph in `platform/backend/tests/alertIsolation.test.ts`.

A third path exists and moves no money either: a deployment with
`delivery: "paper"` evaluates the same strategy on the same bars and **simulates
the fill** instead of sending it. `platform/backend/src/engine/paperBroker.ts`
is a pure module importing nothing at all, and
`platform/backend/tests/paperIsolation.test.ts` asserts the same graph property
for it. See [OPERATIONS.md](OPERATIONS.md).

User-supplied Pine runs on a **worker thread**, not this one
(`platform/backend/src/pine/runInWorker.ts`): its own heap, a wall clock backed
by terminating the thread, and a bounded number of concurrent runs. A heavy
script can no longer stall live evaluation.

## Research trees

Optimizer, walk-forward, holdout and analysis trees live only in the separate
[`pythoncryptobacktesingsystems`](https://github.com/MuhammadMuhamid/pythoncryptobacktesingsystems)
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
- **The backtest fills a stop intrabar at the trigger price; the live path
  cannot** (`BE-02`). Blocked on Binance testnet credentials for the
  exchange-side stop, and on `BE-08` for the backtest-side correction.
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
