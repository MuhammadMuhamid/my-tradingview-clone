# Crypto research and signalling platform

Charting, backtesting, parameter optimization and live signal emission for
Binance spot markets. **This repository decides. It does not place orders.**

Orders are placed by a separate service, the execution bot
(`MuhammadMuhamid/3commabotclone`), which is the only component that holds
exchange credentials. Keeping the two apart is deliberate and is not to be
merged — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

> **This is a live-trading system.** Any change to live evaluation, alerting,
> deployments, secrets, position state or the webhook contract is
> production-sensitive. Read [docs/WEBHOOK-CONTRACT.md](docs/WEBHOOK-CONTRACT.md)
> before touching either side of it.

## Repository status

| | |
|---|---|
| Authoritative platform repository | `MuhammadMuhamid/pythoncryptobacktesingsystems` — **this one** |
| Authoritative execution bot | `MuhammadMuhamid/3commabotclone` |
| Superseded | `MuhammadMuhamid/my-tradingview-clone` — a byte-identical older copy. Do not develop against it. |

## Layout

| Path | What it is |
|---|---|
| `platform/frontend` | Next.js chart application: candles, 25 drawing tools, indicators, a Pine editor, layouts, alerts. |
| `platform/backend` | Fastify API, strategy engines, backtester, Binance data pipeline, live runner, alert dispatch, Postgres access. |
| `platform/deployment` | AWS deployment scripts. Run by the owner only; nothing here is executed by CI. |
| `docs` | Source-of-truth documentation. Machine-checked by `scripts/ci/check-docs.sh`. |
| `scripts` | Repository tooling, including the CI hygiene checks. |
| `platform/backend/lean_optimizer15m` and twelve sibling directories | Optimizer and research trees. Code and configuration are tracked; the multi-GB generated result data is not. |

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
| [docs/COST-MODELS.md](docs/COST-MODELS.md) | The cost model each research tree actually ran. |
| [docs/ALERTS.md](docs/ALERTS.md) | Price and moving-average notifications, and the four frequency modes. |
| [docs/CANDLE-PERFORMANCE.md](docs/CANDLE-PERFORMANCE.md) | Candle and chart loading: what was measured, and what was not. |
| [docs/RESEARCH-METHODOLOGY.md](docs/RESEARCH-METHODOLOGY.md) | How a research result may and may not be selected. |
| [docs/REMEDIATION-LEDGER.md](docs/REMEDIATION-LEDGER.md) | Every audit finding and its disposition. |
| `BACKTESTING_SYSTEMS.md` | Metric definitions and per-tree research notes. |
| `OPTIMIZATION_SYSTEM_BLUEPRINT.md` | Optimizer design. Contains figures superseded by `docs/COST-MODELS.md`. |
| `CLAUDE_HANDOFF.md` | Historical handover. Parts of it describe directories and deployments that no longer match this checkout; treat `docs/` as authoritative where they disagree. |

## What CI does, and what it must never do

CI installs dependencies, lints, typechecks, tests and builds. It does not
deploy, does not hold AWS credentials, does not reach an exchange or a webhook,
does not read a production database, and does not run optimizers or backtests.
