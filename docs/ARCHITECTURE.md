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

Two independent runners exist in one process:

- **`LiveRunner`** — strategy deployments that can move money.
- **`MaAlertRunner`** — moving-average notifications that cannot. It evaluates
  closed bars only and its only output is a Web Push notification.

Nothing in the MA alert path can create a deployment, send a webhook, or reach
Binance's order endpoints. That separation is an invariant and is covered by
tests.

## Research trees

Thirteen optimizer and analysis trees live under `platform/backend`. Their code
and configuration are tracked; their generated result data — the `results`,
`best`, `index` and `archive` directories under each tree — is deliberately not,
because it reaches tens of gigabytes. KNOWN-ABSENT from a fresh clone. The
consequence, recorded as `OPT-08`, is that published leaderboard numbers cannot
be reproduced from a fresh clone. Each tree's cost model is in
[docs/COST-MODELS.md](COST-MODELS.md).

## Known structural problems

These are real and recorded in [docs/REMEDIATION-LEDGER.md](REMEDIATION-LEDGER.md)
rather than described here as if they were resolved:

- The research trees sit inside the deployed backend's source root.
- The optimizer API resolves four directory names that do not exist, and nine of
  the thirteen trees present are unreachable from the API (`X-04`).
- The Pine interpreter runs on the same event loop as the live alert runner
  (`BE-23`), as do multi-gigabyte synchronous result reads (`BE-24`).
- The webhook contract is hand-duplicated across the two repositories.
