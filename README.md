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
| the optimizer trees | Moved to the [backtesting-systems repository](https://github.com/MuhammadMuhamid/pythoncryptobacktesingsystems) under `backtesting:trees/`. Each owns a `tree.json` the application routes through. Point `OPTIMIZER_ROOT` at a checkout of that repository to serve them from here; with no trees present the optimizer API reports an empty registry rather than failing. |
| the retired research archive | Also in the backtesting-systems repository, under `backtesting:legacy/`. Nothing there runs, and no live code path may depend on it. |

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
| [docs/WEB-QA.md](docs/WEB-QA.md) | Desktop and mobile browser QA: what was exercised, and what was not. |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | The operator console, the halt control, paper mode, testnet, and what has never been verified here. |
| [docs/RESEARCH-METHODOLOGY.md](docs/RESEARCH-METHODOLOGY.md) | How a research result may and may not be selected. |
| [docs/REMEDIATION-LEDGER.md](docs/REMEDIATION-LEDGER.md) | Every audit finding and its disposition. |
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
| `scripts/ci/check-docs.sh` | A documented path that does not exist, a cost-model figure that disagrees with a tree's `config.json`, a tree with no registry entry, a documented search-space size that disagrees with `params.json`, and a walk-forward tree whose divergence claim disagrees with the two parameter lists. |
| `scripts/ci/check-repo-hygiene.sh` | An absolute home directory in tracked source, TradingView login automation, a browser remote-debugging port, a live code path depending on the research archive, and a tree re-declaring its own GA driver or objective. |

`python3 scripts/ledger/render.py --check` fails when the rendered ledger and
its JSON source disagree.
