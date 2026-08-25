# Architecture

**Status:** current. Two systems, two repositories, one direction of travel.

## The two systems

| | Platform (this repository) | Execution bot (`MuhammadMuhamid/3commabotclone`) |
|---|---|---|
| Decides when to trade | **yes** | no |
| Places exchange orders | no | **yes** |
| Holds Binance API keys | **never** | yes, AES-256-GCM encrypted at rest |
| Database | PostgreSQL / TimescaleDB | SQLite via Prisma |
| Stack | Fastify + TypeScript, Next.js | Express + TypeScript, Vite + React |

The split is a safety boundary, not an accident of history. Exchange
credentials exist in exactly one process. **Do not move credential handling
into the platform, and do not merge the repositories.** What is genuinely
missing between them is a shared contract artifact, which is
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
| `platform/backend/src/alerts` | Payload construction, delivery with retries, MA alert evaluation, Web Push. |
| `platform/backend/src/repositories` | All SQL. Nothing else talks to the database. |
| `platform/backend/src/pine` | Lexer, parser and interpreter for user-supplied Pine scripts. |
| `platform/backend/src/security` | Session signing, secret encryption, payload redaction. |
| `platform/backend/src/optimizer` | The tree registry each research tree owns an entry in, the shared GA driver and objective, bounded result reading, and the walk-forward selection helper. |

Two independent runners exist in one process:

- **`LiveRunner`** — strategy deployments that can move money.
- **`MaAlertRunner`** — moving-average notifications that cannot. It evaluates
  closed bars only and its only output is a Web Push notification.

Nothing in the MA alert path can create a deployment, send a webhook, or reach
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

Fourteen optimizer and analysis trees live under `platform/backend`. Their code
and configuration are tracked; their generated result data — the `results`,
`best`, `index` and `archive` directories under each tree — is deliberately not,
because it reaches tens of gigabytes. KNOWN-ABSENT from a fresh clone.

Each tree owns a `tree.json` naming its strategy, timeframe, system, kind and
status, and that registry is what the API, the CLI, the dashboard exporter and
the launchd wrapper all route through. A tree with a `config.json` and no
registry entry fails `scripts/ci/check-docs.sh`, because a tree the application
cannot reach is how `X-04` happened.

The consequence recorded as `OPT-08` is unchanged in one half and fixed in the
other: published numbers still cannot be reproduced from a fresh clone, and
every run from 2026-08-24 onward writes a `runs.jsonl` under the tree's index directory, with the content hash
of each input, so a result can at least be tied to the space that produced it.
Each tree's cost model is in [docs/COST-MODELS.md](COST-MODELS.md).

## Known structural problems

Real, and recorded in [docs/REMEDIATION-LEDGER.md](REMEDIATION-LEDGER.md) rather
than described here as if they were resolved:

- **The research trees sit inside the deployed backend's source root.** They are
  code-only in the image and the generated data is bind-mounted, but the
  boundary is a convention rather than a package split.
- **The webhook contract is hand-duplicated across the two repositories.** Each
  side vendors a copy with a fingerprint of its own source, and a test on each
  side fails when they diverge — but nothing makes them one artifact.
- **The backtest fills a stop intrabar at the trigger price; the live path
  cannot** (`BE-02`). Blocked on Binance testnet credentials for the
  exchange-side stop, and on `BE-08` for the backtest-side correction.
- **The multi-timeframe merge convention is unresolved** (`BE-08`). The code
  does not cheat under either convention — that is proved — but whether
  TradingView delays a higher-timeframe value by one bar is a comparison this
  workspace may not run.

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
| **Historical result** | A number produced by a run whose data is not in the repository. | Every optimizer leaderboard figure, every walk-forward fold, every `ANALYSIS_*` document. |
| **Locally implemented, externally unverified** | Code and tests exist; the external system has never been contacted from here. | The exchange-native stop adapter, the holdout deploy gate (no artifact carries a clearance yet), migrations 010 and 011. |
| **Production fact, unconfirmed** | Nothing in this workspace can check it. | What the AWS deployment is running, whether the exposed webhook secret was rotated, what the production database contains. |

[OPERATIONS.md §4](OPERATIONS.md) lists the third and fourth categories
explicitly, because a control that has never been exercised is not a control you
can count on.
