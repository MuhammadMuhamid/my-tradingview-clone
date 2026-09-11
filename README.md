# Trading Scene Platform — canonical workstation and decision authority

This is the current Trading Scene workstation: charting, watchlists, screener,
alerts, research integration and the canonical multi-asset backtesting engine.
**Platform decides; it does not place exchange orders.** The Bot repository is
the separate execution boundary.

## V3 market and capability status

The canonical V3 engine covers crypto spot, crypto derivatives, U.S.
stocks/ETFs, FX, dated futures and continuous futures rolls. Read-only provider
adapters and fixture contracts are present for the providers listed in the
[owner handoff](../evidence/TRADING_SCENE_V3_OWNER_HANDOFF.md). Alpaca, OANDA,
IBKR and other external authenticated/data-entitlement boundaries are
`UNVERIFIED_DISABLED` in this local workspace; no credentials, subscriptions,
paper/demo/testnet handshakes or production execution are claimed.

The current live deployment and Scanner workflows remain Binance Spot-scoped.
The canonical engine and provider capability model must not be read as an
assertion that non-Binance markets can place orders.

Orders are placed by a separate service, the execution bot
(`MuhammadMuhamid/3commabotclone`), which is the only component that holds
exchange credentials. Keeping the two apart is deliberate and is not to be
merged — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

> **This is a live-trading system.** Any change to live evaluation, alerting,
> deployments, secrets, position state or the webhook contract is
> production-sensitive. Read [docs/WEBHOOK-CONTRACT.md](docs/WEBHOOK-CONTRACT.md)
> before touching either side of it.

## Repository architecture

| | |
|---|---|
| Live platform + canonical backtest engine | `MuhammadMuhamid/my-tradingview-clone` — **this repository** |
| Separate research + optimizers | `MuhammadMuhamid/pythoncryptobacktesingsystems` — consumes this repository's canonical engine through `PLATFORM_BACKEND` |
| Exchange execution + Binance credential owner | `MuhammadMuhamid/3commabotclone` — receives webhooks and places orders |

## Layout

| Path | What it is |
|---|---|
| `platform/frontend` | Next.js chart application: candles, 25 drawing tools, indicators, a Pine editor, layouts, alerts. |
| `platform/backend` | Fastify API, strategy engines, backtester, Binance data pipeline, live runner, alert dispatch, Postgres access. |
| `platform/deployment` | AWS deployment scripts. Run by the owner only; nothing here is executed by CI. |
| `docs` | Source-of-truth documentation. Machine-checked by `scripts/ci/check-docs.sh`. |
| `scripts` | Repository tooling, including the CI hygiene checks. |
| the optimizer trees | Live in the [research repository](https://github.com/MuhammadMuhamid/pythoncryptobacktesingsystems) under `research:trees/`. Each owns a `tree.json` the application routes through. Point `OPTIMIZER_ROOT` at that checkout to serve them; with no trees present the optimizer API reports an empty registry rather than failing. |
| the retired research archive | Also in the research repository, under `research:legacy/`. Nothing there runs, and no live code path may depend on it. |

## Local development

Requires Node 22+ and a PostgreSQL/TimescaleDB instance for anything that
touches the database. The quality gates below need neither.

```bash
# backend
cd platform/backend
npm ci
npm run lint        # eslint, zero warnings tolerated
npm run typecheck   # tsc --noEmit
npm test            # node:test, fixture-only, no network and no database
npm run build       # tsc
npm run verify      # all four, in order

# frontend
cd platform/frontend
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run verify
```

`npm test` loads `platform/backend/tests/test.env`, which holds non-secret
fixture values only. Never point it at a real database or a real key.

Bringing up the database and running migrations:

```bash
cd platform
docker compose up -d          # Postgres/TimescaleDB on :5433
cd backend && npm run migrate
```

## Configuration

Copy `platform/backend/.env.example` and fill it in. Every variable is described
there. Authentication fails closed: with `AUTH_ENABLED` unset or `true`, the
backend refuses to start unless `ADMIN_PASSWORD_HASH` and a 32-character
`SESSION_SECRET` are present. Generate the hash with `npm run hash-password`.

No credential value belongs in this repository. `scripts/ci/scan-secrets.sh`
runs in CI and fails the build on credential-shaped literals in tracked source;
it reports file and line only, never the value.

## Documentation

| Document | Subject |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | What each system owns, and how a signal reaches an order. |
| [docs/WEBHOOK-CONTRACT.md](docs/WEBHOOK-CONTRACT.md) | The cross-repository payload contract, versioned. |
| [research/docs/COST-MODELS.md](https://github.com/MuhammadMuhamid/pythoncryptobacktesingsystems/blob/main/docs/COST-MODELS.md) | The cost model each research tree actually ran (research repository). |
| [docs/ALERTS.md](docs/ALERTS.md) | Notification alerts: all seven condition families, the trend gates, and the four frequency modes. |
| [docs/CANDLE-PERFORMANCE.md](docs/CANDLE-PERFORMANCE.md) | Candle and chart loading: what was measured, and what was not. |
| [docs/WEB-QA.md](docs/WEB-QA.md) | Desktop and mobile browser QA: what was exercised, and what was not. |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | The operator console, the halt control, paper mode, testnet, and what has never been verified here. |
| [research/docs/RESEARCH-METHODOLOGY.md](https://github.com/MuhammadMuhamid/pythoncryptobacktesingsystems/blob/main/docs/RESEARCH-METHODOLOGY.md) | How a research result may and may not be selected (research repository). |
| [docs/REMEDIATION-LEDGER.md](docs/REMEDIATION-LEDGER.md) | Every finding of the 2026-08-23 audit and its disposition. Generated — do not hand-edit. |
| [docs/SECURITY-AUDIT-2026-08-31.md](docs/SECURITY-AUDIT-2026-08-31.md) | A later, separate audit: an SSRF fix, two corrections to earlier claims, and the AWS cost answer. |
| `BACKTESTING_SYSTEMS.md` (backtesting repository) | Metric definitions and per-tree research notes. |
| `OPTIMIZATION_SYSTEM_BLUEPRINT.md` (backtesting repository) | Optimizer design. Contains figures superseded by the backtesting repository's `backtesting:docs/COST-MODELS.md`. |
| `CLAUDE_HANDOFF.md` | Historical handover. Parts of it describe directories and deployments that no longer match this checkout; treat `docs/` as authoritative where they disagree. |

## What CI does, and what it must never do

CI installs dependencies, lints, typechecks, tests and builds. It does not
deploy, does not hold AWS credentials, does not reach an exchange or a webhook,
does not read a production database, and does not run optimizers or backtests.

Three repository-hygiene checks run beside them, each one guarding a fix so it
cannot quietly come back:

| Check | Refuses |
|---|---|
| `scripts/ci/scan-secrets.sh` | Credential-shaped literals in tracked source. Reports file and line, never the value. |
| `scripts/ci/check-docs.sh` | Broken internal Markdown links and missing repository file citations in current docs. Research cost/registry/search-space checks run in the research repository. |
| `scripts/ci/check-repo-hygiene.sh` | An absolute home directory in tracked source, TradingView login automation, a browser remote-debugging port, a live code path depending on the research archive, and a tree re-declaring its own GA driver or objective. |

`python3 scripts/ledger/render.py --check` fails when the rendered ledger and
its JSON source disagree.
