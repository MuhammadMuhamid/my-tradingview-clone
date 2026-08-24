# MyTradingView Clone — Claude Handoff

<!-- doc-status -->
> **HISTORICAL — superseded in part.** Written 2026-07-17 as a handover, and
> parts of it no longer describe this checkout. Verified contradictions:
>
> - §2 and §8 give absolute paths under `/Users/muhammadmuhamid/…` and name four
>   optimizer trees (`optimizer/`, `optimizer5m/`, `sr_optimizer15m/`,
>   `sr_optimizer5m/`) **that do not exist**. Thirteen different trees do; see
>   [docs/COST-MODELS.md](docs/COST-MODELS.md). (`OPT-30`, `X-04`)
> - §7 states commission 0.1 % and slippage 0 ticks as the common model. Every
>   tree runs 0.1 % **per side with 2 ticks**, except `optimizer1y1h` which runs
>   0 ticks. (`X-09`, `OPT-03`)
> - §7 names parity artifacts in `platform/backend/parity/`. That directory is
>   gitignored and absent from every clone, so the release gate it describes
>   cannot be run here. (`BE-08` blocker)
> - §3–§4 describe the live AWS stack. Nothing in this programme connected to
>   AWS, so every production statement here is an unverified documentation
>   claim, not an observation.
>
> Where this document and `docs/` disagree, `docs/` is authoritative.

Last updated: 2026-07-17 (Asia/Karachi)

## 1. Objective

This repository contains a custom TradingView-like charting, backtesting,
optimization, and live-alert platform for Binance spot markets. Its primary
purpose is to:

- show Binance candles and strategy markers;
- run Pine-compatible backtests for MA + R:R and SRTrend strategies;
- continuously optimize parameters on 5-minute and 15-minute data;
- save per-coin layouts/configurations;
- run strategies continuously in AWS;
- send confirmed BUY/SELL signals to the user's Signal Bot, which may place
  real Binance Spot orders.

This is a live-trading system. Treat every change to live evaluation, alerts,
deployments, secrets, position state, or AWS as production-sensitive.

## 2. Repository and main application

Repository root:

`/Users/muhammadmuhamid/Projects/supportandresistance strategy`

Main platform:

`/Users/muhammadmuhamid/Projects/supportandresistance strategy/platform`

Important paths:

- `platform/frontend/` — Next.js 16 + React + lightweight-charts UI.
- `platform/backend/` — Fastify + TypeScript API, strategy engines,
  backtesting, Binance data, live runner, alert delivery, and PostgreSQL access.
- `platform/backend/src/engine/strategies/ma_rr_v9/` — MA + R:R implementation.
- `platform/backend/src/engine/strategies/srtrend_v10/` — SRTrend implementation.
- `platform/backend/src/engine/liveRunner.ts` — continuous Binance bar-close
  evaluator and signal dispatcher.
- `platform/backend/src/engine/liveEvaluator.ts` — MA + R:R live state machine.
- `platform/backend/src/engine/srTrendLiveEvaluator.ts` — SRTrend live state machine.
- `platform/backend/src/alerts/dispatcher.ts` — webhook contracts, validation,
  retries, receiver reconciliation.
- `platform/backend/src/repositories/deployments.ts` — deployment/runtime state,
  manual-close reconciliation, encrypted credentials.
- `platform/backend/src/api/routes/deployments.ts` — deployment controls, alerts,
  and guarded live-signal tests.
- `platform/backend/src/api/routes/optimizer.ts` — optimizer leaderboard API.
- `platform/backend/src/db/migrations/` — database migrations.
- `platform/deployment/aws/` — AWS CloudFormation, Caddy, Docker Compose, and
  deployment scripts.
- `platform/README.md` — platform architecture and API summary.
- `platform/deployment/aws/README.md` — production deployment design.

The repository root currently is not a Git repository. Before major future
work, initialize private version control or make a timestamped source backup.
Never commit `.env`, database files, generated passwords, API keys, webhook
secrets, or optimizer databases/results that contain private data.

## 3. Current AWS production deployment

AWS account ID: `683444362522`

Region: `ap-south-1` (Mumbai)

CloudFormation stack: `srtrend-production`

Public domain:

`https://mytradingview.alphawebstudioz.com/`

DNS A record:

`mytradingview.alphawebstudioz.com -> 13.201.244.214`

App EC2:

- instance ID: `i-09888f3320763000f`
- public IP: `13.201.244.214`
- hosts Caddy, frontend, backend/API, backtest worker, and live alert runner.

Compute EC2:

- instance ID: `i-03b12ed8de9a10efe`
- intended for continuous optimizers, isolated from live-alert latency.

Database:

- private encrypted RDS PostgreSQL 16;
- endpoint and credentials are obtained from CloudFormation/Secrets Manager;
- do not hardcode or expose them in prompts or source files.

Administration:

- use AWS Systems Manager / CloudShell;
- port 22 is intentionally closed;
- runtime files are under `/opt/srtrend` on the app server;
- deployment Compose files are under `/opt/srtrend/deployment`;
- generated dashboard password is stored server-side at
  `/opt/srtrend/admin-password.txt` with restricted permissions;
- do not paste passwords, webhook secrets, Binance credentials, database
  passwords, or `ALERT_ENCRYPTION_KEY` into this document or chat.

The website is protected by Caddy HTTPS and HTTP Basic Authentication. The
username is `admin`; retrieve/reset the password securely on the server when
needed rather than storing it here.

## 4. Production runtime status and cutover

At the latest deployment/cutover:

- DNS resolves to the AWS app server.
- The backend and RDS health check passed.
- The cloud live runner was enabled.
- Binance WebSocket subscriptions opened successfully.
- Database migration contained 11 alerts, 15 deployments, and 1 strategy
  configuration at migration time; values may now be higher.
- The local Mac live backend was stopped and its launch agent disabled to
  prevent duplicate signal emitters.
- The existing separate `tradingbot` AWS instance was not modified.

The AWS database is the authoritative source for current deployments, active
statuses, strategy parameters, ranks, webhook destinations, order amounts,
runtime positions, and alert-delivery history. Do not infer current production
state from this handoff or old chat messages—query the API/database first.

The Mac and browser do not need to remain on for AWS live signals. The four
local optimizers/backtest services do not continue with the Mac off unless they
have been explicitly deployed and enabled on the compute EC2 instance.

## 5. Live signal behavior

Live pipeline:

`active deployment -> Binance kline streams -> confirmed closed bar -> strategy evaluation -> persisted runtime state -> webhook delivery -> alert log`

Key guarantees already implemented:

- Confirmed bar-close signals only; intended to be deterministic and
  non-repainting.
- Runtime state persists in PostgreSQL, allowing restart recovery.
- Missed candles are gap-filled after reconnect/restart.
- Dedupe keys prevent duplicate delivery after retries or reconnects.
- Deployment credentials are encrypted at rest using `ALERT_ENCRYPTION_KEY`.
- Webhook URLs are validated.
- Alert dispatcher records delivery status, HTTP response, and retry result.
- Live runner does not overlap evaluations for the same deployment.
- Receiver synchronization detects when a trade was manually closed at the
  Signal Bot/Binance side.
- After a manual close, `manualCloseReentryLock` blocks BUY re-entry until a
  genuinely fresh primary BUY event occurs according to the deployed strategy
  and parameters. It must not re-enter merely because an old long condition
  remains true on the next candle.

Do not remove or weaken the manual-close re-entry lock, dedupe checks,
confirmed-bar requirement, secret encryption, URL validation, or state
persistence without explicit user approval and focused tests.

## 6. Trading and alert configuration

The user's most recently stated desired quote amount was `340.01 USDT` per BUY.
However, always verify the current database and Signal Bot before changing or
deploying anything because the user may have edited it later.

The Signal Bot was configured for up to four concurrent SmartTrades. The
receiver, not the chart UI, performs real Binance execution.

Historical coin layouts/deployments discussed include DEXE, ALLO, RIF, ZEC,
JTO, NEAR, INJ, EIGEN, TIA, JST, KAITO, ALGO, TAO, MORPHO, and 币安人生. Ranks
changed repeatedly during optimization. Never use a rank number alone without
recording all of the following:

- optimizer family (`opt-results`, `opt5-results`, `sr-results`, or
  `sr5-results`);
- strategy key;
- timeframe;
- symbol;
- original result rank/ID versus balanced leaderboard rank;
- complete parameter snapshot;
- net profit, maximum drawdown, win rate, profit factor, and trade count;
- data start/end dates and fee/slippage assumptions.

Old screenshots often showed a balanced leaderboard rank and a separate
`ORIG#`. Production application must resolve the requested original result
record exactly. Do not substitute the row position in a sorted view.

## 7. Strategies and backtesting fidelity

The platform includes two strategy families:

1. MA + R:R (`ma_rr_v9` in code; commonly referred to as MA_RR V5 in the
   user's workflow).
2. SRTrend (`srtrend_v10` / `srtrendfinal` concept), combining MTF pivot
   support/resistance entries with MA + R:R filters and exit logic.

Backtest requirements used by the user:

- chart timeframes: 5m and 15m;
- common date range: 2025-11-01 through current date;
- Binance spot candles;
- initial capital: 1000 USDT;
- position size: 100% equity;
- commission: 0.1%;
- slippage: 0 ticks unless explicitly changed.

TradingView parity is a major requirement. Preserve:

- no-lookahead MTF merges;
- confirmed HTF value timing;
- TradingView broker fill ordering and same-bar SL/TP behavior;
- commission timing and compounding;
- tick/step/min-notional filters;
- partial-exit quantity semantics;
- pivot confirmation delays;
- stateful indicator initialization;
- exact backtest date boundaries and timezone handling (UTC internally).

Parity artifacts are in `platform/backend/parity/` and include DEXE/ZEC raw
TradingView trades and specs. Run parity comparisons whenever engine or broker
logic changes. A green TypeScript test suite is necessary but not sufficient;
trade-by-trade parity must also be checked.

## 8. Optimizers and commands

There are four optimizer trees:

- `platform/backend/optimizer/` — MA + R:R 15m (`opt-results`).
- `platform/backend/optimizer5m/` — MA + R:R 5m (`opt5-results`).
- `platform/backend/sr_optimizer15m/` — SRTrend 15m (`sr-results`).
- `platform/backend/sr_optimizer5m/` — SRTrend 5m (`sr5-results`).

Each contains parameters, seeds, coin list, result history, summary,
leaderboard display script, worker, and optimizer service logs.

The user requested:

- top 500 rows for metric views (DD, WR, PF, NET, trades), not top 200;
- a balanced top-500 command combining minimum DD, maximum NET, maximum WR,
  and maximum PF;
- the visible original result rank/number in every sorted view;
- saved histories for coins removed from active optimization lists;
- self-restarting services for enabled optimizers;
- SR optimizers can be intentionally disabled and must not auto-restart until
  the user explicitly enables them again.

Before modifying optimizer behavior, inspect current launchd/systemd/compute
EC2 status and current `config.json`; old conversational state may be stale.
Never reorder existing discrete parameter value arrays when genomes store value
indexes. Append new values only, or perform an explicit result migration.

## 9. Watchlists and UI features

The UI supports named multiple watchlists rather than a single fixed list.
Future work must preserve existing watchlists and selections through database
migrations. Do not store production-only state solely in browser localStorage
if it needs to survive devices/redeployments.

Expected user-facing areas:

- Chart with Binance candles, indicators, strategy markers, saved layouts, and
  strategy selection.
- Backtests with parameter forms, metric tiles, equity curve, and trade list.
- Optimizer leaderboards sortable by DD, WR, PF, NET, trades, and balanced score.
- Live & Alerts with deployments, pause/resume, delivery status, and alert feed.
- Named watchlists.

## 10. Local development

Local database runs on port 5433. See `platform/README.md` for complete steps.

Backend:

```bash
cd "/Users/muhammadmuhamid/Projects/supportandresistance strategy/platform/backend"
npm install
npm run typecheck
npm test
npm run build
```

Frontend:

```bash
cd "/Users/muhammadmuhamid/Projects/supportandresistance strategy/platform/frontend"
npm install
npm run typecheck
npm run build
```

Local URLs:

- frontend: `http://localhost:3000/chart`
- backend: `http://localhost:4000`

Do not enable the local live runner while the AWS live runner is active for the
same deployments. Local testing should use `LIVE_RUNNER_ENABLED=false` unless a
carefully controlled cutover is being performed.

## 11. Safe change and deployment workflow

For every future feature/change:

1. Inspect current AWS and database state first.
2. Back up the production database and current deployment artifacts.
3. Make changes locally; do not edit generated `dist/` as the source of truth.
4. Add or update focused backend/frontend tests.
5. Run backend typecheck, tests, and build.
6. Run frontend typecheck and production build.
7. If strategy/broker logic changed, run trade-by-trade TradingView parity.
8. If schema changed, write a forward migration and test it on a restored copy.
9. Build immutable Docker images; tag them with a timestamp or content/version
   identifier. Do not rely only on mutable `latest` for rollback.
10. Deploy with the cloud live runner unchanged until the new app is healthy.
11. Verify HTTPS, authentication, frontend, API health, database, Binance
    streams, active deployment count, runtime states, and recent alert history.
12. Verify exactly one live runner is enabled.
13. Monitor CloudWatch logs after deployment.
14. Roll back images/migration when health or signal-parity checks fail.

Never perform a real BUY/SELL test without the user's explicit confirmation at
action time, exact symbol, exact amount, and confirmation that the deployment
is paused/isolated as required by the guarded test endpoint.

## 12. Security rules

- Never expose credentials in source, logs, screenshots, handoff documents, or
  chat summaries.
- Never rotate `ALERT_ENCRYPTION_KEY` casually; existing encrypted deployment
  credentials depend on it.
- Use Secrets Manager/SSM and restrictive file permissions.
- Keep RDS private and EC2 SSH closed.
- Keep Caddy authentication and HTTPS enabled.
- Do not log full webhook payload secrets or Binance keys.
- Treat alert amount or endpoint changes as production trading changes.
- Confirm there is only one signal emitter before re-enabling any local/cloud
  runner.
- Preserve database backups and test restoration periodically.

## 13. First actions for a new Claude session

Claude should begin by reading:

1. this file;
2. `platform/README.md`;
3. `platform/deployment/aws/README.md`;
4. files directly related to the requested feature.

Then it should report:

- what it believes the requested change is;
- which production components are affected;
- how it will test the change;
- whether deployment can happen without interrupting live alerts;
- any action that could place/cancel a real order or change live risk.

Do not start by changing AWS or production state. Implement and test locally
first unless the user explicitly requests an emergency production repair.

## 14. Suggested opening prompt for Claude

```text
You are continuing development of my production MyTradingView clone. The
repository is at:
/Users/muhammadmuhamid/Projects/supportandresistance strategy

First read CLAUDE_HANDOFF.md completely, then read platform/README.md and
platform/deployment/aws/README.md. Treat the AWS PostgreSQL database as the
source of truth for current layouts, deployments, parameters, alert amounts,
and statuses. Never expose secrets and never enable a second live runner.

My requested change is:
[WRITE THE NEW FEATURE OR FIX HERE]

Implement it locally, add tests, verify builds and strategy parity where
relevant, explain the result, and deploy to AWS only after I explicitly say to
deploy—or immediately after testing if I explicitly include “deploy it to AWS
after testing” in this request. Ask for action-time confirmation before any
operation that could intentionally send a real BUY or SELL.
```

