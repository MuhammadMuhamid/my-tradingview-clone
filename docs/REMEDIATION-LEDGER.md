# Remediation ledger

**Status:** current. Generated from `scripts/ledger/findings.json` by
`scripts/ledger/render.py`; CI fails if the two disagree. Do not hand-edit this file.

Audit of 2026-08-23, 154 findings. Last updated after **Phase 1 — local security hardening**.

Every finding identifier in the audit's findings register appears here exactly
once. A finding is marked `fixed` only when code changed and a test or an
explicit check proves the new behaviour — never because documentation was updated.

## Totals

| Disposition | Count |
|---|---:|
| fixed | 30 |
| audit finding corrected or stale | 2 |
| intentionally preserved | 2 |
| blocked by Mahamid/external evidence | 1 |
| not yet dispositioned | 119 |
| **total** | **154** |

## Scope reserved for Mahamid

No work in this programme performed, attempted or simulated any of the
following, and no finding is marked `fixed` on the strength of one:

- Webhook-secret rotation or propagation to TradingView alerts and deployment records.
- Binance API-key changes, permission checks or IP-allowlist confirmation.
- Any AWS inspection or modification, and any production deployment.
- Production database access, and confirmation of production runtime state.
- Live exchange, wallet, webhook or order operations.
- TradingView account operations, including the MTF parity comparison that gates BE-08.
- Binance testnet operations, which need credentials this workspace does not hold.

## Cross-system (`X-*`)

| Id | Repo | Status verified | Disposition | Phase | Commit | Evidence | Remaining risk |
|---|---|---|---|---|---|---|---|
| `X-01` | both | Confirmed by inspection: sender clamps to 100, receiver schema is `.lt(100)`. | not yet dispositioned | Phase 2 | — | — | — |
| `X-02` | both | Confirmed: platform barIndex is floor(epoch/interval); Pine bar_index is chart-relative. | not yet dispositioned | Phase 2 | — | — | — |
| `X-03` | both | Confirmed: liveRunner consumes only `flat` from a two-state report. | not yet dispositioned | Phase 2 | — | — | — |
| `X-04` | platform | Confirmed: 4 mapped directories are absent; 13 trees exist on disk, 4 are routable. | not yet dispositioned | Phase 7 | — | — | — |
| `X-05` | bot | Confirmed present in two tracked files at audit time; both literals are now `PASTE_YOUR_BOT_SECRET_HERE`. | fixed | Phase 0 | `bot a61fed3` | `scripts/ci/scan-secrets.sh` returns clean in both repositories and now fails CI on a 40+ hex literal (verified against a probe file). The old value was never printed, used or propagated. | **The credential itself is still exposed.** Rotation, and updating every TradingView alert input and platform deployment record, is Mahamid's action (M1) and must happen at a flat-position window. |
| `X-06` | platform | Confirmed: `LIVE_RUNNER_ENABLED !== "false"`, and the plist sets no environment. | not yet dispositioned | Phase 2 | — | — | — |
| `X-07` | bot | Confirmed: the `dev-insecure-key` fallback is reachable whenever DRY_RUN is true. | fixed | Phase 1 | `bot d157535` | `deriveKey` throws instead of substituting `dev-insecure-key`; `POST /api/exchange-accounts` returns 503 when `canStoreSecrets()` is false; `assertConfig()` exits non-zero on missing key material in dry run. Covered by `bot:backend/tests/security.test.ts`. | Rows already written under the published key remain in any existing `bot.db`. They must be deleted and the keys re-entered — that is an operator action on production data. |
| `X-08` | bot | Confirmed: length-only validation, and `Buffer.from(str,'hex')` truncates silently. | fixed | Phase 1 | `bot d157535` | A non-hex salt now fails startup. Tested: `SCRYPT_SALT=my-trading-bot-salt-2026` exits non-zero. | Deliberate deviation from the audit's `^[0-9a-fA-F]{32}$`: any all-hex salt of 16-64 characters is still accepted with the original padEnd/slice normalisation, because exact-32 would make stored API keys undecryptable for a deployment that used a shorter hex salt. The derivation is unchanged. |
| `X-09` | platform | Confirmed and corrected: every tree runs 0.1%/side. 0.05% and 0.075% exist only in prose. | not yet dispositioned | Phase 0 | — | — | — |
| `X-10` | platform | Confirmed: the frontend reads opt-in, the backend reads opt-out plus a hash check. | fixed | Phase 1 | `f3c67a5, 2d0a86d` | One `parseAuthEnabled` rule, mirrored in `platform/frontend/lib/authFlag.ts` and asserted on both sides. `AUTH_ENABLED=1` now leaves the gate ON in both. | The frontend value is still inlined at build time by Next, so changing it in a container needs a rebuild. Documented in `platform/frontend/.env.local.example`. |
| `X-11` | platform | Confirmed: AWS account id, stack name, instance ids and hostnames in tracked docs and scripts. | fixed | Phase 1 | `74fa882` | No AWS account id, instance id, public IP, bucket name, RDS identifier or Secrets Manager ARN remains in tracked source; every deployment script reads them through `platform/deployment/aws/env.sh` and fails with a named error when one is missing. Verified by grep across the whole tree. | The identifiers were previously distributed in loose archives; they should be treated as known. Nothing here changes the infrastructure. |
| `X-12` | both | Confirmed: `ignored_stale_sell` returns HTTP 200 and the dispatcher treats any 2xx as sent. | not yet dispositioned | Phase 2 | — | — | — |
| `X-13` | audit process | Incident record for X-05. No rotation, use or propagation performed in this programme. | blocked by Mahamid/external evidence | Phase 0 | — | Nothing to fix in code; the required action is the owner's. | The credential must be treated as exposed until Mahamid rotates it. |

## Platform backend (`BE-*`)

| Id | Repo | Status verified | Disposition | Phase | Commit | Evidence | Remaining risk |
|---|---|---|---|---|---|---|---|
| `BE-01` | platform | Carried from the register: Live MTF feed is two bars staler than the backtest's. | not yet dispositioned | Phase 2 | — | — | — |
| `BE-02` | platform | Carried from the register: Backtest fills stops intrabar at the trigger; live cannot. | not yet dispositioned | Phase 3 | — | — | — |
| `BE-03` | platform | Carried from the register: Exit precedence inverted between backtest and live. | not yet dispositioned | Phase 2 | — | — | — |
| `BE-04` | platform | Carried from the register: Entry bar unprotected; touched TP tiers silently cancelled. | not yet dispositioned | Phase 3 | — | — | — |
| `BE-05` | platform | Carried from the register: avgTradePct is gross while neighbouring metrics are net. | not yet dispositioned | Phase 3 | — | — | — |
| `BE-06` | platform | Carried from the register: IS/OOS metrics invalid under percent-of-equity sizing; boundary trades leak. | not yet dispositioned | Phase 3 | — | — | — |
| `BE-07` | platform | Carried from the register: stepSize/minNotional fetched and stored but never applied. | not yet dispositioned | Phase 3 | — | — | — |
| `BE-08` | platform | Carried from the register: MTF merge convention contradicts its own header comment. | not yet dispositioned | Phase 3 | — | — | — |
| `BE-09` | platform | Carried from the register: Recursive indicators seeded from the loaded-window start. | not yet dispositioned | Phase 3 | — | — | — |
| `BE-10` | platform | Carried from the register: Zero-P&L trades counted as losses. | not yet dispositioned | Phase 3 | — | — | — |
| `BE-11` | platform | Carried from the register: No kill switch, daily-loss limit, exposure cap or order-rate cap. | not yet dispositioned | Phase 2 | — | — | — |
| `BE-12` | platform | Carried from the register: Webhook retries can duplicate real orders on the 3Commas path. | not yet dispositioned | Phase 2 | — | — | — |
| `BE-13` | platform | Carried from the register: Crash between delivery and persistence re-fires the order. | not yet dispositioned | Phase 2 | — | — | — |
| `BE-14` | platform | Carried from the register: 1.5% silent data-gap tolerance in the live path. | not yet dispositioned | Phase 2 | — | — | — |
| `BE-15` | platform | Carried from the register: Live win/loss ignores fees, desynchronising the circuit breaker. | not yet dispositioned | Phase 2 | — | — | — |
| `BE-16` | platform | Carried from the register: Dedupe-key skip reported to the caller as accepted. | not yet dispositioned | Phase 2 | — | — | — |
| `BE-17` | platform | Carried from the register: Position-sync POSTs the decrypted secret to a URL that is not re-validated. | fixed | Phase 1 | `d0ab9f2` | The 30-second position-sync path now calls the same `validateWebhookUrl` as `deliver`, and logs a per-deployment skip when the URL is rejected. | A deployment whose stored URL is outside `ALLOWED_WEBHOOK_HOSTS` stops being reconciled rather than silently POSTing its secret. That is the intended trade; the log line names the deployment. |
| `BE-18` | platform | Carried from the register: Single-emitter enforced only by an in-memory Set. | not yet dispositioned | Phase 2 | — | — | — |
| `BE-19` | platform | Carried from the register: mtf_lean cannot be backtested through the platform. | not yet dispositioned | Phase 3 | — | — | — |
| `BE-20` | platform | Carried from the register: Live SELL contracts computed from the original size, with a dead ternary. | not yet dispositioned | Phase 2 | — | — | — |
| `BE-21` | platform | Carried from the register: Platform authentication silently disables itself. | fixed | Phase 1 | `f3c67a5` | Startup throws when auth is expected and `ADMIN_PASSWORD_HASH` is absent; all four auth variables are documented in `.env.example`. Nine child-process boot tests cover the fail-closed matrix, including that `AUTH_ENABLED=1|yes|TRUE|off` does NOT open the gate. | A production instance running without a hash will now refuse to start. Mahamid must confirm the variable is set before deploying this. |
| `BE-22` | platform | Carried from the register: Path traversal in the optimizer routes. | fixed | Phase 1 | `d0ab9f2` | `GET /api/optimizer/best/:symbol` routes its path parameter through `assertSymbol`; nine traversal and injection probes are asserted to throw. | — |
| `BE-23` | platform | Carried from the register: /api/pine/run blocks the live trading event loop for up to 45s. | not yet dispositioned | Phase 7 | — | — | — |
| `BE-24` | platform | Carried from the register: Synchronous multi-GB file reads and a write inside GET handlers. | not yet dispositioned | Phase 7 | — | — | — |
| `BE-25` | platform | Carried from the register: No rate limiting anywhere, including sign-in; session identity unchecked. | fixed | Phase 1 | `f3c67a5` | Fixed-window limiter on `POST /api/auth/login` (5/min/client), cleared on a correct password, bounded key count, forwarded addresses honoured only under TRUST_PROXY. `verifySession` now checks `claims.username === config.adminUsername`. Seven limiter tests plus a session-identity test. | Single-process only. A multi-instance deployment needs a shared store; recorded in the module header rather than pretended away. |
| `BE-26` | platform | Carried from the register: MA-alert symbols bypass assertSymbol and reach the WebSocket URL builder. | fixed | Phase 1 | `d0ab9f2` | MA alert create and list filter both call `assertSymbol` before the value can reach the websocket stream-name builder. | — |
| `BE-27` | platform | Carried from the register: Receiver response bodies stored and served verbatim. | fixed | Phase 1 | `d0ab9f2` | `redactResponseBody` scrubs secret-shaped fields and bare credential-shaped runs, then truncates at 1000 characters; `markDelivery` applies it. Five tests, including that ordinary diagnostic bodies pass through unchanged. | Historical rows written before this change are unaffected. Migration 003 retro-scrubbed the payload half only. |
| `BE-28` | platform | Not a credential — retrieval still needs IAM. Folded into X-11 by the register itself. | audit finding corrected or stale | Phase 1 | `74fa882` | Tracked as part of `X-11`; the ARN now comes from the untracked deployment env. | — |
| `BE-29` | platform | Confirmed: 12 test files, none covering liveRunner, backtester, mtf, metrics or the strategy bar loops. Phase 0 added 42 characterization cases (timeframe registry, candle contract, MA bar-close behaviour, push boundaries, cross-repository contract) but not the two highest-value suites — golden-file per strategy and backtest-vs-live equivalence. | not yet dispositioned | Phase 0 (partial) → Phase 3 | — | Platform backend: 150 tests pass (110 pre-existing, 42 new, plus the extraction coverage). Frontend: 9 tests where there were none. | Golden-file and equivalence suites are gated on resolving BE-08 first, or they would enshrine a look-ahead bug as expected output. |
| `BE-30` | platform | Carried from the register: Portability and dependency floating. | not yet dispositioned | Phase 7 | — | — | — |

## Execution bot (`BOT-*`)

| Id | Repo | Status verified | Disposition | Phase | Commit | Evidence | Remaining risk |
|---|---|---|---|---|---|---|---|
| `BOT-A` | bot | Alias for BOT-017 in the register's priority table; not a separate finding. | audit finding corrected or stale | Phase 0 | — | Tracked as `BOT-017`. | None — identifier bookkeeping only. |
| `BOT-002` | bot | Confirmed: the file's entire content was one line that fetched a script from an ephemeral localtunnel subdomain and piped it into a shell. | fixed | Phase 0 | `bot a61fed3` | File deleted; the reference in `bot:docs/BOT_COMPLETE_GUIDE.md` removed; `scan-secrets.sh` now fails on any remote script piped into a shell. | None locally. Operators must upload `bot:deploy/cloudshell-launch.sh` through CloudShell's Actions → Upload file instead. |
| `BOT-003` | bot | Carried from the register: Default bot config is the maximum-risk one. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-004` | bot | Carried from the register: .env.example ships DRY_RUN=false with placeholders that pass every check. | fixed | Phase 1 | `bot d157535` | `.env.example` ships `DRY_RUN=true` with every secret blank; placeholder values are refused by deny-list; every check runs unconditionally. Six child-process boot tests, including that a missing secret is fatal in dry run. | — |
| `BOT-005` | bot | Carried from the register: Double-sell race: three of four close paths never take the lock. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-006` | bot | Carried from the register: Recorded quantity is gross of commission. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-007` | bot | Carried from the register: An order that succeeds then throws leaves an untracked live position. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-008` | bot | Carried from the register: detectManualCloses fabricates P&L and closes partially drained trades. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-009` | bot | Carried from the register: Registration is world-open until the first account exists; TOCTOU race. | fixed | Phase 1 | `bot d0fa625` | `SETUP_TOKEN` required and compared in constant time before the account count is consulted; `count` + `create` moved inside one transaction; a P2002 race resolves to the same 409. The login page collects the token and explains it. | Routes are still not tenant-scoped, so a second account would still be a co-admin. That is now unreachable, but the scoping itself is tracked as BOT-025. |
| `BOT-010` | bot | Carried from the register: Express 4 does not catch async errors; requests hang forever. | fixed | Phase 1 | `bot ec14e70` | Terminal `errorHandler` plus `asyncHandler` and a JSON 404 for unmatched `/api` paths; Prisma P2025/P2002/P2003/P2000 map to 404/409/409/400. `NODE_ENV=production` set in the image. | — |
| `BOT-011` | bot | Carried from the register: No kill switch, max exposure, daily-loss limit or concurrency cap. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-012` | bot | Carried from the register: direction short/reversal is offered and stored but never affects order side. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-013` | bot | Carried from the register: 'per Bot' and 'per SmartTrade' investment units compute identically. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-014` | bot | Carried from the register: toFixed(2) rounds the quote up, so default-sized buys are rejected. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-015` | bot | Carried from the register: exitEnabled defaults to false, so a default bot rejects every exit webhook. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-016` | bot | Carried from the register: The webhook secret is served on every 15-second dashboard poll. | fixed | Phase 1 | `bot 9c5bff9` | `mapBot` masks the secret and omits the payloads that embed it; the plaintext is served only from the creation response and `GET /api/bots/:id?reveal=1`, which is logged. Three masking tests. The Edit page has a Reveal control. | Any secret already captured in a proxy log or browser cache from the previous behaviour is still out there. |
| `BOT-017` | bot | Carried from the register: No exchange-native stop-loss; protection dies with the process. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-018` | bot | Carried from the register: Stale quantity in the TP/SL loop. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-019` | bot | Carried from the register: Stale-sell guard is in-memory and evaporates on restart. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-020` | bot | Carried from the register: No terminal Express error middleware; NODE_ENV unset in the image. | fixed | Phase 1 | `bot ec14e70` | `ENV NODE_ENV=production` in `bot:backend/Dockerfile`, plus the terminal error middleware that suppresses thrown detail on 5xx. | — |
| `BOT-021` | bot | Carried from the register: nginx.conf omits X-Forwarded-For, collapsing every client into one bucket. | fixed | Phase 1 | `bot 88bccaa` | `bot:frontend/nginx.conf` sets `X-Forwarded-For` and `X-Forwarded-Proto` on both proxy blocks. | — |
| `BOT-022` | bot | Carried from the register: frontend/nginx.conf sets no security headers on the HTML document. | fixed | Phase 1 | `bot 88bccaa` | All five security headers plus a CSP are set on the HTML document in the container nginx, with `always` so they survive error responses. `server_tokens off` added in all three configs. | — |
| `BOT-023` | bot | Carried from the register: All monetary values are SQLite REAL floats. | not yet dispositioned | Phase 7 | — | — | — |
| `BOT-024` | bot | Carried from the register: PartialClose index dropped and never recreated; no SmartTrade.status index. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-025` | bot | Carried from the register: exchangeOrderId nullable and non-unique; no tenant scoping or audit trail. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-026` | bot | Carried from the register: One 30/min limiter shared between order signals and a polling endpoint. | fixed | Phase 1 | `bot ec14e70` | `/api/webhooks/signal_bots/status` gets its own 120/min limiter so the 30-second position poll cannot exhaust the 30/min order-signal budget. | — |
| `BOT-027` | bot | Carried from the register: Buy dedupe blocks legitimate scale-ins and returns HTTP 200. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-028` | bot | Carried from the register: nginx-host-ssl.conf proxies port 80 to itself. | fixed | Phase 1 | `bot 88bccaa` | `bot:deploy/nginx-host-ssl.conf` proxies to 127.0.0.1:8080, and `docker-compose.yml` publishes the frontend there, matching `bot:deploy/nginx-production.conf`. | The published frontend port changes from 80 to 127.0.0.1:8080. The host nginx config must be in place before this compose file is rolled out — flagged for Mahamid in the commit message. |
| `BOT-029` | bot | Carried from the register: Containers run as root, no healthcheck, no database backup. | fixed | Phase 1 | `bot ec14e70, bot 3f195ce` | Container runs as `node` with a healthcheck; `bot:scripts/backup-db.sh` uses SQLite `.backup` and verifies `integrity_check` plus the presence of the three core tables; `bot:scripts/restore-db.sh` refuses without `--yes`, refuses while the container runs, refuses a backup failing integrity, and keeps a safety copy. Both exercised locally against a migrated throwaway database, including rejection of a corrupted file. | Backups are as sensitive as the keys they contain and must be stored accordingly. Scheduling them is an operator task. |
| `BOT-030` | bot | Carried from the register: remote-deploy.sh hardcodes another machine's home and forces DRY_RUN=false. | not yet dispositioned | Phase 7 | — | — | — |
| `BOT-031` | bot | Carried from the register: No MIN_NOTIONAL check; a zero-fill order creates an immortal trade. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-032` | bot | Carried from the register: floorToStep float error leaves dust. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-033` | bot | Carried from the register: The TP/SL loop is sequential and can exceed its own interval. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-034` | bot | Carried from the register: Starting a bot has no confirmation; live-vs-dry-run is invisible. | not yet dispositioned | Phase 6 | — | — | — |
| `BOT-035` | bot | Carried from the register: DRY_RUN is not a simulation — simulated exits are capped by real balances. | not yet dispositioned | Phase 2 | — | — | — |
| `BOT-037` | bot | Confirmed: no test file and no CI workflow existed. | fixed | Phase 0 | `bot 1daadd1, 8fc5ae4, 3f32844` | 38 tests across three files pass; `npm run verify` runs lint (0 warnings), typecheck, tests and build; CI runs all four plus the secret scan with DRY_RUN forced true. | Coverage is at the pure-logic layer. Route- and Prisma-level tests still need a database harness. |
| `BOT-038` | bot | Confirmed: the secret is looked up by unique index rather than compared in constant time. | intentionally preserved | Phase 1 | — | Left as-is deliberately. The secret is two concatenated `uuidv4()` values (~192 bits); a timing oracle over an indexed database lookup does not reduce that to anything searchable. The alternative — fetching every bot and comparing in constant time — makes the hot order path O(bots) and adds a worse failure mode. | Accepted. Revisit only if secrets ever become low-entropy or operator-chosen. |
| `BOT-039` | bot | Carried from the register: binance-api-node@0.12.9 is effectively unmaintained. | not yet dispositioned | Phase 7 | — | — | — |
| `BOT-040` | bot | Carried from the register: An anonymous /login visit spends from the shared refresh budget. | fixed | Phase 1 | `bot ec14e70` | The refresh limiter skips a request with no `refresh_token` cookie; the route already rejects those before touching the database, so an anonymous login-page visit can no longer spend a signed-in user's budget. | — |
| `BOT-041` | bot | Carried from the register: Assorted minor items. | not yet dispositioned | Phase 6 | — | — | — |

## Research, optimizer and operations (`OPT-*`)

| Id | Repo | Status verified | Disposition | Phase | Commit | Evidence | Remaining risk |
|---|---|---|---|---|---|---|---|
| `OPT-01` | platform | Carried from the register: Live-deployed configs selected by maximising over the out-of-sample window. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-02` | platform | Carried from the register: The walk-forward tree validates a parameter space production no longer has. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-03` | platform | Carried from the register: Cost model and metric definitions diverge across trees. | not yet dispositioned | Phase 0 | — | — | — |
| `OPT-04` | platform | Carried from the register: win_rate/profit_factor are leg-based while trades is entry-based. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-05` | platform | Carried from the register: Every OOS sort mode in the leaderboard CLI is a leakage path to deployment. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-06` | platform | Carried from the register: The GA is non-deterministic across restarts and re-seeds identically each round. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-07` | platform | Carried from the register: Round startup reads every coin's full history twice, concurrently. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-08` | platform | Carried from the register: No reported result is reproducible or auditable from the repository. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-09` | platform | Carried from the register: GA winners cluster exactly on the min_trades boundary. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-10` | platform | Carried from the register: Top-1000 pools were 100% saturated on maximum leverage. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-11` | platform | Carried from the register: resolve_config.py emits a cost model no tree uses. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-12` | platform | Carried from the register: Data validation is narrower than the trees use; interior gaps stay invisible. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-13` | platform | Carried from the register: Universe from a screenshot; six coins dropped after seeing their results. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-14` | platform | Carried from the register: Wilson bounds maximised; the consensus z-test assumes uniform sampling. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-15` | platform | Carried from the register: PARAMETER_REDUCTION.md contradicts params.json. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-16` | platform | Carried from the register: full3y1h and lean3y15m dropped the Spearman rank-correlation analysis. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-17` | platform | Carried from the register: lean3y15m recommends the config at the median of out-of-sample net. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-18` | platform | Carried from the register: range.end 'now' makes OOS metrics time-dependent. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-19` | platform | Carried from the register: Metric-interpretation issues. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-20` | platform | Carried from the register: Cost-sensitivity issues. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-21` | platform | Carried from the register: Parity-harness issues. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-22` | platform | Carried from the register: Fill-realism issues. | not yet dispositioned | Phase 3 | — | — | — |
| `OPT-23` | platform | Carried from the register: Every launchd service and the optimizer wrapper point at a non-existent path. | not yet dispositioned | Phase 7 | — | — | — |
| `OPT-24` | platform | Carried from the register: The optimizer Docker stage copies a missing directory and omits three trees. | not yet dispositioned | Phase 7 | — | — | — |
| `OPT-25` | platform | Carried from the register: run_overnight.sh always logs exit 0. | not yet dispositioned | Phase 7 | — | — | — |
| `OPT-26` | platform | Carried from the register: Six apply_*.ts scripts have no --dry flag and four hardcoded order sizes. | not yet dispositioned | Phase 7 | — | — | — |
| `OPT-27` | platform | Carried from the register: replace_*.mjs DELETE FROM deployments and re-create flat. | not yet dispositioned | Phase 7 | — | — | — |
| `OPT-28` | platform | Carried from the register: wipe_chartss.sh ships a base64-encoded destructive production payload. | not yet dispositioned | Phase 7 | — | — | — |
| `OPT-29` | platform | Carried from the register: Dashboard snapshots served to the UI are two weeks stale. | not yet dispositioned | Phase 7 | — | — | — |
| `OPT-30` | platform | Confirmed: §2/§8 name four optimizer trees that are absent; §7 states a cost model no tree runs and points at a gitignored, absent parity directory. | fixed | Phase 0 | `213fe3c, 3ed8d79` | `CLAUDE_HANDOFF.md` carries a banner naming each contradiction; `docs/` is declared authoritative; `scripts/ci/check-docs.sh` now fails when a document names a directory that does not exist or a cost figure that disagrees with its config.json. | The document is retained as history. Its production claims about the AWS stack remain unverifiable from here. |

## Platform frontend (`FE-*`)

| Id | Repo | Status verified | Disposition | Phase | Commit | Evidence | Remaining risk |
|---|---|---|---|---|---|---|---|
| `FE-01` | platform | Carried from the register: Chart Alert button creates a LIVE 800 USDT deployment and activates it. | not yet dispositioned | Phase 6 | — | — | — |
| `FE-02` | platform | Carried from the register: Unvalidated open redirect immediately after authentication. | fixed | Phase 1 | `2d0a86d` | `safeNextPath` allow-lists same-origin absolute paths only. Seven tests cover script schemes, protocol-relative and backslash forms, embedded control characters, percent-encoded payloads, malformed encoding and a login loop. | — |
| `FE-03` | platform | Carried from the register: Frontend auth gate fails open and is baked in at build time. | fixed | Phase 1 | `2d0a86d` | Shared opt-out parse rule; three tests assert that only the literal `false` disables the gate. | Build-time inlining remains a property of Next's edge runtime and is documented, not removed. |
| `FE-04` | platform | Confirmed: the page gate checks cookie presence, not the signature. | intentionally preserved | Phase 1 | `2d0a86d` | Intentional and now documented in `proxy.ts` and `.env.local.example`: the signing secret must not reach the edge runtime, the backend is the real gate, and every protected byte comes from the authenticated API. A forged cookie buys a redirect and nothing more. | None beyond the flash-of-app the gate exists to avoid. |
| `FE-05` | platform | Carried from the register: No CSP or frame-ancestors protection (the register groups FE-04–FE-15 as one 'frontend robustness' band; numbering here follows the roadmap's own anchors where it names them). | fixed | Phase 1 | `2d0a86d` | CSP with `frame-ancestors 'none'`, plus frame/sniffing/referrer/permissions headers on the frontend and a stricter `default-src 'none'` policy on the API. API headers asserted in `platform/backend/tests/security.test.ts`. | `'unsafe-inline'` is required on script-src and style-src by Next's inline bootstrap, so this CSP does not stop injected inline script. The compensating control is that the tree has no HTML or script sink at all, enforced by `platform/frontend/tests/noUnsafeSinks.test.ts`. |
| `FE-06` | platform | Carried from the register: A GET link writes server state and auto-runs a backtest (the register groups FE-04–FE-15 as one 'frontend robustness' band; numbering here follows the roadmap's own anchors where it names them). | not yet dispositioned | Phase 6 | — | — | — |
| `FE-07` | platform | Carried from the register: No AbortSignal on roughly 55 endpoints (the register groups FE-04–FE-15 as one 'frontend robustness' band; numbering here follows the roadmap's own anchors where it names them). | not yet dispositioned | Phase 4 | — | — | — |
| `FE-08` | platform | Carried from the register: No React error boundary (the register groups FE-04–FE-15 as one 'frontend robustness' band; numbering here follows the roadmap's own anchors where it names them). | not yet dispositioned | Phase 6 | — | — | — |
| `FE-09` | platform | Carried from the register: Binance WebSockets have no onerror/onclose/reconnect; prices freeze silently (the register groups FE-04–FE-15 as one 'frontend robustness' band; numbering here follows the roadmap's own anchors where it names them). | not yet dispositioned | Phase 4 | — | — | — |
| `FE-10` | platform | Carried from the register: Secrets rendered in type="text" inputs (the register groups FE-04–FE-15 as one 'frontend robustness' band; numbering here follows the roadmap's own anchors where it names them). | fixed | Phase 1 | `2d0a86d` | All three webhook-secret inputs are `type="password"` with autofill, autocorrect and spellcheck disabled. | — |
| `FE-11` | platform | Carried from the register: An undefined `warn` colour renders the OPEN TRADE banner invisible (the register groups FE-04–FE-15 as one 'frontend robustness' band; numbering here follows the roadmap's own anchors where it names them). | not yet dispositioned | Phase 6 | — | — | — |
| `FE-12` | platform | Carried from the register: No catch on activate/pause/delete of live deployments (the register groups FE-04–FE-15 as one 'frontend robustness' band; numbering here follows the roadmap's own anchors where it names them). | not yet dispositioned | Phase 6 | — | — | — |
| `FE-13` | platform | Carried from the register: Pervasive empty catch {} blocks (the register groups FE-04–FE-15 as one 'frontend robustness' band; numbering here follows the roadmap's own anchors where it names them). | not yet dispositioned | Phase 6 | — | — | — |
| `FE-14` | platform | Carried from the register: Frontend robustness item grouped in the register without an individual description (the register groups FE-04–FE-15 as one 'frontend robustness' band; numbering here follows the roadmap's own anchors where it names them). | not yet dispositioned | Phase 6 | — | — | — |
| `FE-15` | platform | Carried from the register: Frontend robustness item grouped in the register without an individual description (the register groups FE-04–FE-15 as one 'frontend robustness' band; numbering here follows the roadmap's own anchors where it names them). | not yet dispositioned | Phase 6 | — | — | — |
| `FE-18` | platform | Confirmed: ESLint was absent from `platform/frontend`, so its six `eslint-disable` comments were inert. | fixed | Phase 0 | `711ebda` | `npm run lint` runs a flat config with typescript-eslint and react-hooks; four real unused-binding errors were found and fixed; the suite now reports 0 errors. | Seven `exhaustive-deps` warnings are left visible rather than silenced. Changing a dependency array in the charting surface changes runtime behaviour and is handled in the QA phase, not by a lint fix. |

## Experimental TradingView trees (`TV-*`)

| Id | Repo | Status verified | Disposition | Phase | Commit | Evidence | Remaining risk |
|---|---|---|---|---|---|---|---|
| `TV-01` | platform | Carried from the register: approach1_ui_automation scripts a password login to tradingview.com. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-02` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-03` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-04` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-05` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-06` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-07` | platform | Carried from the register: backtest-spot never liquidates an open position at window end. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-08` | platform | Carried from the register: The 1m x 200 SMA trend gate is computed from 1-hour bars in three of five drivers. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-09` | platform | Carried from the register: Look-ahead in the backtest-spot HTF alignment. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-10` | platform | Carried from the register: The README-documented backtest-spot entry point can never fire an entry. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-11` | platform | Carried from the register: The exit MA is hardcoded to 1h x 100 VWMA while the report says 4h x 100 SMA. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-12` | platform | Carried from the register: No IS/OOS split anywhere in tv_autotuner or backtest-spot. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-13` | platform | Carried from the register: A fourth independent copy of the ask/tell GA with a fourth objective definition. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-14` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-15` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-16` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-17` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-18` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-19` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-20` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-21` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-22` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-23` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-24` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |
| `TV-25` | platform | Grouped in the register under 'TV-02–TV-06, TV-13–TV-25 experimental-tree issues' (an unauthenticated CDP debugging port, a tracked TradingView session cookie jar, and timeout handling that records the previous config's metrics against a new genome). No individual description was published. | not yet dispositioned | Phase 7 | — | — | — |

