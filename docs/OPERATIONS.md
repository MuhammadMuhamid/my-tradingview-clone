# Operating this system

**Status:** current.

Who this is for: whoever is holding the system when something is wrong. It
describes the controls that exist, what each one does and does not do, and the
things this workspace has never been able to verify.

---

## 1. The operator console

`/operations` in the app. The compact health overview reads `/api/ops/status`
plus the existing authenticated `/api/scanner/health` boundary. The detailed
controls remain below it. Risk, emitter, deployment, delivery, feed-integrity,
alert-evaluation and database-readiness state all come from the Platform process
and persisted rows that own those facts; Scanner remains the authority for its
own refresh and symbol-resolution state.

`Healthy` is shown only when the named source provides positive evidence. An
empty log, a saved configuration, or the existence of a deployment is not
treated as proof. `Unknown`, `No recent evidence`, `Not configured`, `Disabled`
and `Not applicable` are intentional answers: they mean the current architecture
cannot prove health, has no observation yet, or the subsystem is deliberately
out of service. The evidence source and exact reason are expandable beside each
summary.

The overall `Halted` state is an operating mode, not a crash verdict. The Trading
Mode row identifies an operator-selected halt separately from an automatic/risk
block, preserves the recorded reason and time, and leaves subsystem health
visible. Resume still uses the existing explicit confirmation flow and backend
risk re-checks.

### Trading mode

| Mode | Meaning |
|---|---|
| `LIVE` | This process holds the emitter lease and will send real buy and sell signals. |
| `STANDBY` | The live runner is enabled, but another process holds the lease. This one will not emit. |
| `HALTED` | Every emission is refused, entries and exits alike, until an operator resumes. |
| `DISABLED` | `LIVE_RUNNER_ENABLED` is not `"true"`, so this process emits nothing. **This is the default** (`X-06`). |

`STANDBY` and `DISABLED` are different answers on purpose. A process that does
not hold the lease cannot report on emission, and reporting it as halted would
suggest an operator decision that nobody made.

### Halting

The halt button on this page is the **Platform halt**. The execution Bot has a
second, separate halt (next section). The Platform halt refuses every emission
and needs a written reason — whoever finds the system halted has to be able to
see why. Resuming is deliberately harder than halting, and a latched daily-loss
halt re-checks the live number before it will resume: resuming straight back
into a breached limit would trip again on the next signal.

**Halting does not close open positions.** The platform cannot flatten a
position it does not hold: it has no exchange credentials, and it does not know
the fill price of anything it did not open. Inventing an exit would put real
money behind a guess. Close positions by hand instead. Close a strategy trade
with *Close* or *Partial* on `/bot`, and a manual position with a SELL in the
chart's Trade panel. If Trading Scene is unavailable, use the standalone Bot
dashboard. Each of these asks the Bot to sell, because the Bot holds the keys.

A flatten-all control is deliberately absent. It would require the platform to
place orders directly, which is the bot's job, and it could not be validated
here without Binance testnet credentials.

### Platform halt and Bot halt (added 2026-11-09)

There are two switches. Neither sets the other, and no screen shows one as the
other. `/bot` and the Bot panel on this page show both, each with what it blocks.

| | Platform halt (this page) | Bot halt (`/bot`, or the standalone Bot dashboard) |
|---|---|---|
| Automated orders | Every emission is refused, entries and exits (`evaluateRisk` in `platform/backend/src/engine/riskControls.ts`) | Every webhook BUY and SELL is refused. That includes TradingView exit alerts and Platform signals. A strategy intent that was never sent is not submitted (`evaluateBotHalt` in `bot:backend/src/services/riskControls.ts`) |
| New manual exposure | A manual BUY from the Trade panel, or a manual buy on a deployment, is refused with 409 (`assertNotHalted` in `platform/backend/src/api/routes/manualTrading.ts`, and `platform/backend/src/api/routes/deployments.ts`) | A manual BUY that reaches the Bot is refused with 409 |
| Operator exits: manual SELL, *Close*, *Partial* | Allowed | Allowed. The halt never refuses an operator's own exit (`isOperatorExit`) |
| TP/SL | Not touched. This switch never reaches the Bot | **Both TP/SL pollers stop**: strategy TP/SL (`bot:backend/src/services/smartTrade.ts`) and manual TP/SL (`bot:backend/src/services/manualProtection.ts`). Nothing is checked until the Bot is resumed |

- **TP/SL is not checked while the Bot is halted, and not while the Bot is
  down.** Protection is the Bot's 30-second in-process poll, and nothing rests
  on the exchange. `/bot`, this page and the Bot dashboard say: *"While the Bot
  is halted, TP/SL protection is not checked and TradingView exits are refused;
  your own SELL / Close / Partial still work."*
- **The Trade panel and the chart are cautious about protection.** They show a
  manual position as protected only while the Bot reports that its poller is
  checking that position. Otherwise the position reads *TP/SL NOT BEING
  CHECKED* with the reason, and the chart draws no Bot TP/SL line for it.
- **A re-halt keeps the existing halt.** Halting a Bot that is already halted
  keeps the original reason and who set it, so a daily-loss latch stays a
  daily-loss latch. It used to be overwritten, and resume then skipped the loss
  re-check. The answer says `alreadyHalted`.
- **Resuming a latched Bot.** While the rolling loss is still at the limit,
  Resume is refused with 409 `still_breached`.
- **The owner's options** (one switch for both, or a Bot halt that keeps TP/SL
  running) are an owner decision and are not implemented.

### Risk limits

These are the Platform's limits. Each is opt-in and `null` (off) by default, so
adding them changed no behaviour until an operator set a number:

- **Total exposure** — the sum of `buy_quote_qty` across deployments currently
  long. This is what they are *configured* to spend, not a balance read from the
  exchange.
- **Concurrent positions** — how many deployments may be long at once.

The Platform's **rolling realised loss** limit is disabled. The Platform does
not see realised fills; the Bot does. So `PATCH /api/ops/risk-limits` refuses
any non-null `maxDailyLossQuote` with 409, and this page says so. The daily-loss
limit that acts is the Bot's, set on `/bot` (below).

A breach of a numeric limit **latches the kill switch**. An exit is never
refused by a numeric limit: refusing a sell because exposure is too high would
trap the position that caused the problem. Only an explicit operator halt stops
an automated exit.

### The execution Bot from Trading Scene: `/bot` (added 2026-11-09)

`/bot` (Trading → Bot, administrator only) is where the administrator operates
the separately deployed execution Bot. The Bot keeps the exchange keys, the
order ledger and the 24/7 TP/SL poll. Nothing secret reaches the Platform or
the browser.

**The path.** The browser calls one Platform admin route per command. The
Platform rebuilds the body from validated fields and sends one signed request
to one Bot route under `/api/manual-trading/control/*`. That request uses the
manual-trading HMAC, with a ±60 s window and a single-use nonce. There is no
pass-through proxy. Path ids must be UUIDs. The browser mints a request id once
per intent, and the Platform requires it and never mints one
(`platform/backend/src/api/routes/botControl.ts`,
`bot:backend/src/routes/manualControl.ts`).

| Command | Platform route | Step-up |
|---|---|---|
| Status (signed C0, plus the Platform halt) | `GET /api/bot/control/status` | none (admin session) |
| Halt the Bot | `POST /api/bot/control/halt` (confirmation, reason of 3–200 characters) | code; or the password while two-factor is off |
| Resume the Bot | `POST /api/bot/control/resume` | code |
| Read / change risk limits | `GET` / `PATCH /api/bot/control/risk-limits` | none / code |
| Start or stop a bot (target state, not a toggle) | `POST /api/bot/control/bots/:id/status` | code |
| Close a strategy trade | `POST /api/bot/control/trades/:id/close` | code |
| Partial close (1–99 %) | `POST /api/bot/control/trades/:id/partial-close` | code |
| What happened to a command | `GET /api/bot/control/commands/:requestId` | none |

**Step-up, on every command that changes something.** The credential travels in
the same request, is checked by the existing `confirmIdentity`, and is never
forwarded, stored or logged. The Bot receives only who stepped up, how and when.
How the session was created plays no part, so a Google or GitHub sign-in is
treated the same as a password sign-in:

- **Two-factor on:** the authenticator code, and only that. Codes are single-use,
  and guesses are limited to 5 per 5 minutes per account.
- **Two-factor off, and the account has a password:** the password is accepted
  for **Halt only**, so a halt is never blocked in an emergency. Every other
  command answers 403 `two_factor_required`.
- **Two-factor off, and no password** (a provider-only account): 403
  `step_up_unavailable`. This is never a bypass.
- **`AUTH_ENABLED=false`:** every changing command is refused with 403
  `auth_disabled`. Reads still work, for local development.

**Go-live precondition: turn on the administrator's two-factor sign-in before
relying on Bot controls in Trading Scene.** Setting up, turning on and turning
off two-factor on an administrator account each write an `admin_audit` row
(`auth.2fa.setup_started`, `auth.2fa.enabled`, `auth.2fa.disabled`).

**Outcome unknown.** Only two answers are definitive: a Bot-authored JSON 2xx,
or a Bot refusal that carries a `code`. Anything else on a changing command is
*"Outcome unknown, checking…"*. That covers a timeout (10 s, or 30 s for Close
and Partial), a dropped connection, a proxy error, an unreadable reply and the
Bot's `command_in_progress`. The page then asks
`GET /api/bot/control/commands/:requestId` with the **same** request id, every
2 s for up to 60 s.

- *"Nothing was changed"* appears only when the Bot answers that it has no
  record of that id.
- If the window runs out, the page says the outcome is still unknown and offers
  *Check again*.
- Doing the same thing again while the outcome is unknown reuses the same id,
  and the Bot never runs a command twice.
- An order whose result is still pending is reconciled by the Bot from the
  exchange.

**Audit.** The Platform appends `bot.<kind>.requested` to `admin_audit` before
sending, and does not send if that row cannot be written. One of
`.succeeded`, `.refused` or `.uncertain` follows. No row carries the credential.
On the Bot, the `BotControlCommand` row records the command, the request id and
the outcome. Its actor is a claim signed by the Platform's key, not independent
proof.

**Risk limits on the Bot.** Total exposure, concurrent trades, daily loss
(`null` turns it off) and the daily-loss window (1–720 hours). A change never
clears a latched halt. Turning the daily-loss limit off, or raising it, makes a
latched daily-loss halt resumable, and the page warns about this.

**Close and Partial are for strategy trades only.** *Close* is refused with a
code, and nothing is sold, in each of these cases:

- `trade_manual`: the trade was opened from Trading Scene;
- `bot_deleted`: its bot was deleted;
- `bot_paused`: its bot is stopped;
- `pair_not_listed`: the pair has left the bot's list;
- `ambiguous_trade`: the bot holds more than one open trade on that pair.

*Partial* has the same refusals except `bot_paused` and `pair_not_listed`, so
it works on a stopped bot. If an earlier exit for the trade is still being
reconciled, both are refused with `exit_unresolved`.

**Manual positions are closed from the chart's Trade panel only** (SELL). That
keeps their ledger and TP/SL correct. `/bot` and the Bot dashboard link there
rather than offering Close.

**Status (Operations and `/bot`).** Each fact is shown under its own name; there
is no single "connected" verdict:

- whether the control channel is set up on this Platform;
- the signed connection: connected, refused (signature, proxy, replay, or the
  Bot's control key unset), rate-limited, unreachable, or an unexpected reply;
- the separate webhook-credential path;
- execution: *Dry run (simulated)* or live orders;
- the Bot halt and whether it is latched;
- exchange routing: testnet, mainnet, mixed or no accounts, with per-account
  counts;
- risk limits;
- the Bot's Shariah floor (*Enforced* with its policy, or *Off*), apart from
  the Platform's Shariah Mode;
- TP/SL protection;
- manual and mainnet-manual trading.

A Bot that is set up but down shows *Unreachable*, never *not configured*.

**Prerequisites.** The Platform needs `MANUAL_TRADING_BOT_URL` and a
`MANUAL_TRADING_HMAC_SECRET` of at least 32 characters. The Bot needs the same
secret. The control routes work with `MANUAL_TRADING_ENABLED=false`. The
overview, bots and trades lists below them still need it on both sides. The
proxy in front of the Bot answers `/api/manual-trading/*` only from the
Platform's address. Each side runs the control commands under its own rate
limit, so polling cannot starve a halt. A 429 from the Bot is definitive: the
command was not executed.

**Not in Trading Scene yet.**

- Creating, editing or deleting a bot, and entering exchange keys, stay on the
  standalone Bot dashboard. The keys stay on the Bot.
- Closing a stopped or deleted bot's trade, or one of several open trades on
  the same pair, is not built anywhere. The Bot dashboard refuses it too. It
  needs a trade-targeted exit in the Bot's money path, which is a separate,
  reviewed change. *Classic Bot appearance* at the foot of `/bot` is
an opt-in, per-browser recolouring
([UI contract §2](TRADING_SCENE_UI_UX_CONTRACT.md)).

**Recovery.** The standalone Bot dashboard (its own password and TOTP) remains
the restricted recovery and break-glass path. It has its own halt, Close and
Partial, which run the same Bot functions.

### Feed freshness

Per Spot symbol and timeframe: integrated candle-integrity state, issue codes
and counts, latest completed bar, completed-bar age, and last integrity-check
time. The UI consumes the bounded incremental `feed_health` projection from
`/api/ops/status`; it does not rescan candles or run another validator.
`unknown` is a real state — a feed that has not been assessed is never rendered
as live (`BE-14`).

### Other subsystem evidence

- **Database** — the existing readiness proof: connection plus the shipped
  migration set. A successful page request alone is not called healthy.
- **LiveRunner** — opt-in configuration and emitter-lease ownership. Deployments
  are counts and operating modes, not a heartbeat.
- **Notification Alerts** — recent `last_bar_time` evaluation watermarks for
  active alerts. With no active alerts it says `Not configured`; with no
  completed evaluation it says `No recent evidence`. This is not presented as a
  process heartbeat because none exists.
- **Scanner** — its existing `/api/health` contract: reachability, last refresh
  error/time, and resolved/unresolved symbols. Rendering `/scanner` is not proof.
- **Webhook delivery** — persisted signal-delivery outcomes in the existing 24h
  window. `idle` remains `No recent evidence`, not `Healthy`.

### Signal delivery

Are the signals this system produced actually reaching the bot? Before this the
only way to ask was to read the `alerts` table by hand, so a webhook that had
been failing for a day looked exactly like a quiet market.

| State | Meaning |
|---|---|
| `stalled` | An alert fired more than five minutes ago and never recorded an outcome. **The order may or may not have been placed.** Check the unresolved intents below it. |
| `failing` | Half or more of attempted deliveries failed. |
| `degraded` | Some failed. |
| `idle` | Nothing fired in the window. Normal in a quiet market. |
| `healthy` | Everything attempted was delivered. |

`blocked` is counted separately from `sent` and never folded into it: the
receiver answers HTTP 200 for outcomes where it placed no order, and `X-12` is
what happens when those two are conflated.

### Unresolved order intents

Orders whose outcome is unknown, because the process died between sending and
recording (`BE-13`). Reconcile each against the bot before resuming.

### Trade / Order Timeline

The **Timeline** control on a Manual Trading order or deployment is evidence
inspection only. `Persisted event` means the named record has an explicit event
time; `Current known state` means a mutable snapshot was last persisted at the
displayed time and does not prove every earlier transition. The panel labels
paper simulation, Bot dry-run, Binance testnet, Binance mainnet and an unknown
execution mode separately. A manual order's label comes from that order's own
evidence (its `dry-` exchange id and its own Bot account), never from the
Bot's current dry-run setting. The Journal and the chart overlay use the same
rule (below).

Bot execution evidence is fetched server-side only after one specific timeline
is opened. Manual orders use the exact signed order identity; custom deployment
evidence uses the exact Platform source/dedupe identity and is hard-bounded.
Bot unavailability or not-found leaves existing Platform evidence intact, and
the Timeline creates no rows or duplicate Bot ledger. Individual Bot exchange
fills, commission history, prior cumulative snapshots, and unpersisted
transitions remain unavailable rather than inferred.

### Trade Journal

Open **Journal** for a bounded cross-source view of activity and accumulated
known realized results. Every row carries an execution environment: `REAL`,
`TESTNET`, `DRY RUN`, `PAPER` or `UNKNOWN`. There are five separate summary
cards, one per environment, and none is ever added to another. The daily,
weekly, monthly and per-symbol lists name the environment on every line.

The environment comes from the row's own evidence. The Bot's current mode is
never an input, and a deployment's current delivery setting can never make a
row REAL. The Journal, the chart overlay and the manual Timeline share one rule
(the `journal/environment` module in the Platform backend):

- **REAL** needs positive per-row evidence. A manual order is REAL only when its
  own Bot account is explicitly mainnet and it has a non-`dry-` exchange order
  id. An automated row is REAL only when its realization declares MAINNET.
- A `dry-` exchange order id is **DRY RUN**. A manual order on a testnet account
  is **TESTNET**. A paper deployment's rows are **PAPER**.
- Everything else is **UNKNOWN**, and UNKNOWN is never counted as real money.
- **Automated Bot realizations declare their environment** (added 2026-11-09,
  OD-5). Realization contract v2 events carry `environment` (DRY_RUN, TESTNET,
  MAINNET or UNKNOWN), the environment of the SELL as the Bot recorded it; the
  Platform stores it in `realised_pnl.declared_environment` (migration 056,
  UNKNOWN as NULL) and the Journal shows MAINNET as REAL, TESTNET as TESTNET.
  A declaration that contradicts the row's own exchange id (MAINNET with a
  `dry-` id, DRY_RUN without one) reads UNKNOWN, and the event is still accepted
  so the Bot's outbox never stalls. P&L and fees stay the Bot's modeled figures.
  v1 events (an older Bot) and rows from before v2 stay UNKNOWN. Rollout is
  Platform first: an accepted ingest answers `capabilities: ["realization.v2"]`,
  and the Bot sends v2 only after it has seen that. The same event id re-sent
  under the other version is an integrity conflict (409), by design.

Manual orders and live cumulative execution reports can appear with **Unknown** P&L:
that means execution activity is known but cost basis, disposition linkage, or
commission evidence is not. Unknown is excluded from known totals and from
win/loss counts; it is never displayed as zero.

Daily, weekly, and monthly summaries use persisted realization time in UTC, the
Platform's existing timestamp convention. Paper realization uses the existing
paper accounting result. Live automated results appear only when Platform has a
persisted signed realization row; the Journal does not fan out to the Bot per
historical intent. Use the per-order/deployment Timeline for current exact Bot
execution evidence. Notes are not part of this first version: Platform has no
existing annotation persistence/ownership convention, and the smallest Journal
can remain a pure read projection instead of adding a new writable surface.

For the custom Bot path these are per-event accounting results, labeled as
modeled fee-adjusted at fixed 0.1% buy and sell rates rather than
exchange-observed net P&L. Partial and final-leg rows remain `REALIZATION`; a
final leg is not promoted to `CLOSED_TRADE` without authoritative entry pairing.

---

## 2. Paper mode

`delivery: "paper"` on a deployment. It evaluates the strategy on live bars,
records the signal exactly as a live deployment would, and then **simulates the
fill instead of sending it**.

- The cost model is the live one: 0.1 % commission per side, the figure every
  research tree runs (`backtesting:docs/COST-MODELS.md`, in the backtesting
  repository). A paper run at zero fees flatters
  a configuration exactly where it matters least.
- Fills are assumed at the signal bar's close, with no slippage and no partial
  fill. A live order is a market order and will differ. The API says so in the
  response and the UI shows it above the numbers.
- Refusals are recorded, not swallowed: a sell with nothing held, or a buy while
  already long, means the platform's position and the simulation's have
  diverged — which is one of the things a paper run exists to surface.

**It cannot place an order.** `platform/backend/src/engine/paperBroker.ts` is a pure module that
imports nothing at all, and `platform/backend/tests/paperIsolation.test.ts` walks its entire
transitive import graph and fails if it can reach the dispatcher, the webhook
contract, a credential or an exchange client. The live runner's paper branch
returns before any call to `deliver`, which is also asserted.

Results are at `GET /api/deployments/:id/paper`, and behind the **Paper
results** button on the deployments page.

`off` is a different thing and still exists: it records the signal and simulates
nothing.

---

## 3. Binance testnet

Testnet is a setting on the **execution bot**, which is the component that holds
the exchange credentials. The platform reports what its own environment says
(`BINANCE_TESTNET`) on the operator console so the two cannot silently disagree,
and makes no call to Binance from anywhere.

Turning it on is `BINANCE_TESTNET=true` in the bot's `.env`. On the bot side,
`bot:deploy/remote-deploy.sh` preserves whatever the server already has rather than
overwriting it (`BOT-030`). That variable is only the Bot's process-wide default,
for a bot with no exchange account of its own. Each exchange account carries its
own testnet flag, and that flag decides where the account's orders go. Since
2026-11-09 the Bot dashboard ticks **Use Binance testnet** by default and asks
for a typed `MAINNET` before it adds a mainnet account. The Bot's API also
refuses an account that does not state `testnet` explicitly. `/bot` shows the
routing per account: testnet, mainnet, mixed or none.

**No testnet order has ever been placed.** Production has testnet keys on the
Bot but runs `DRY_RUN=true` (§10). The exchange-native stop adapter (`BOT-017`) therefore remains
disabled and unverified. Canonical historical/live reporting uses the truthful
non-native completed-candle MARKET-exit model and makes no claim of resting
protection during process/network downtime.

---

## 4. Deploying, and the two ways it has bitten (added 2026-08-31)

Both of these cost a real outage before they were written down. The full
procedure is in
[platform/deployment/aws/README.md](../platform/deployment/aws/README.md); this
is why it looks the way it does.

**The app instance needs swap.** It is a `t3.micro` with 916 MB of RAM and
cannot build the Next.js image without it. Without swap the OOM killer takes
the SSM agent with it and the box wedges: `describe-instance-status` still
reports `running ok ok` while every `send-command` returns `Undeliverable` /
`ResponseCode -1`, and the only way back is an EC2-level stop/start. Sustained
high CPU during such a build is thrashing, not progress — do not read it as the
build working. A `/swapfile` may exist on disk while being neither enabled nor
in `/etc/fstab`; trust `free -m`, not the presence of the file.

**`update-app.sh` does not fetch its own bundle.** It builds from an already
extracted source tree and exits with `source bundle missing at ...` otherwise.
The S3 download and extraction are separate steps that `cloud-deploy.sh`
performs.

**A 200 from `/healthz` is not proof the stack is healthy.** Caddy answers it,
and the app serves `/login` long after the database has gone. When something
looks wrong, check `aws rds describe-db-instances` first — the production
database once sat stopped for four days while the site kept answering.

**A deploy rolls the containers straight after snapshotting RDS** (added
2026-09-15). The backend therefore starts against a database that may be
briefly unresponsive. It used to crash on that — `Connection terminated due to
connection timeout` inside `migrate()` — and rely on Docker's restart policy,
so each restart re-ran the same five-second gamble and a database slow for one
minute produced a deploy down for twenty.

`waitForDatabase()` now runs before the boot migration: fifteen attempts, 500 ms
doubling to a 10 s cap, about 105 s in total. It waits ONLY on connection
failures — anything carrying a SQLSTATE is rethrown immediately, so a genuinely
bad migration still crashes at once rather than two minutes later.

**Reading the difference between 502 and 503 matters here:**

| symptom | meaning |
|---|---|
| `502`, empty body | Caddy cannot reach the backend — the process is down or restarting |
| `503` with `"database":"unavailable"` | the backend is UP and answering; its database check failed |
| `200` with `applied > expected` | benign: two superseded migration filenames stay recorded |

A `503` is not a crash, and chasing it as one wastes the first ten minutes.

---

## 5. Platform backup and recovery

PostgreSQL is the authoritative recovery store. A complete database backup
contains strategy/config provenance, deployments and `runtime_state`, order
intents and dedupe identities, alert/execution history, risk controls and
realised P&L including Bot source identity/accounting semantics, realization
ingest nonce replay state, paper fills/accounting, notification-alert state and history,
saved layouts/Pine scripts/watchlists, push subscriptions, database-backed VAPID
keys, backtest history, feed-health evidence, and `schema_migrations`.

The artifact therefore contains sensitive state: encrypted webhook secrets and
bot UUIDs, Web Push endpoints/key material, and possibly a database-backed VAPID
private key. Store it with the same access restrictions as the database. The
matching `ALERT_ENCRYPTION_KEY` must be re-provisioned separately or encrypted
deployment credentials cannot be reopened. `SESSION_SECRET`, admin password
hash, database credentials, TLS keys, manual-Bot and realization HMAC secrets, and env-provided
VAPID keys are configuration/secrets outside PostgreSQL and must also be
re-provisioned from the existing operator-owned secret store. Sessions are
stateless cookies, so there is no session table to restore.

PostgreSQL candles are a cache: existing `ensureCandles`/backfill behavior can
rebuild a requested range from Binance. The full native database dump includes
the current PostgreSQL candle rows and restores them without treating them as
authoritative; allow storage for that data. Scanner OHLCV and `series_meta` in
the generated `data/ohlcv.sqlite` store are likewise a bounded cache, and
Scanner calibrations in that file are reproducible from the matching candles,
configuration and current calculation code. The procedure does not include the
Scanner SQLite cache, so expect a temporarily cold Scanner after machine
replacement. Validate or rehydrate both market-data stores before enabling the
LiveRunner; rehydration contacts Binance and is a separate operator action. The
Scanner's generated `user.json` under
`platform/screener/backend/config/`, when present, is authoritative user
configuration and must be copied separately with mode `0600`; restore it before
starting the Scanner. Browser-local drawings are not server-backed and are a
remaining per-browser recovery gap. Other browser pane/selection/display
preferences are ephemeral.

The current schema requires PostgreSQL 15 or newer (`NULLS NOT DISTINCT`) and
production uses PostgreSQL 16. Use PostgreSQL 16 `pg_dump`/`pg_restore` and a
fresh PostgreSQL 16 destination. TimescaleDB is optional: plain PostgreSQL keeps
`candles` as an ordinary table and is fully supported. If the source has a
TimescaleDB hypertable, the manifest records the exact extension version and
restore requires that version to be locally available; the wrapper runs the
required Timescale pre/post-restore hooks. Other source extensions must also be
available at their recorded versions.

Create a new artifact in an already secured directory (neither the dump nor its
manifest is overwritten):

```bash
BACKUP_DIR=/secure/operator-owned/platform-backup-20260902T120000Z
mkdir -m 700 "$BACKUP_DIR"
PLATFORM_BACKUP_SOURCE_URL='postgres://db-user@db-host/platform' \
  platform/scripts/backup-platform-db.sh \
  "$BACKUP_DIR/platform.dump"
if [ -f platform/screener/backend/config/user.json ]; then
  install -m 600 platform/screener/backend/config/user.json \
    "$BACKUP_DIR/screener-user.json"
fi
```

Restore only into a newly created database. The independently supplied expected
database name protects against a connection string pointing somewhere else;
the wrapper also refuses maintenance databases and any destination with user
relations, user schemas, or non-default extensions. It never drops or cleans a
destination. A failed restore leaves a disposable partial target: discard it
and create another fresh database rather than rerunning over it.

```bash
createdb --host=db-host --username=db-user platform_recovery_20260902
PLATFORM_RESTORE_DESTINATION_URL="postgres://db-user@db-host/platform_recovery_20260902" \
PLATFORM_RESTORE_EXPECT_DATABASE=platform_recovery_20260902 \
  platform/scripts/restore-platform-db.sh \
  /secure/operator-owned/platform-backup/platform-20260902T120000Z.dump
if [ -f /secure/operator-owned/platform-backup/screener-user.json ]; then
  test ! -e platform/screener/backend/config/user.json
  install -m 600 /secure/operator-owned/platform-backup/screener-user.json \
    platform/screener/backend/config/user.json
fi
```

Both scripts avoid ambient `DATABASE_URL`, fail on PostgreSQL/tool/extension
incompatibility, and verify the custom archive, SHA-256 integrity, and migration
identity. After restore, point a stopped/non-emitting Platform backend at the
new database, run its readiness check, compare recovery-critical state, and
only then perform the existing single-emitter cutover procedure. An independent
disposable proof on 2026-09-02 restored a compact representative fixture into a
second fresh PostgreSQL 16 database and reopened it through current Platform
repositories. The focused realization fixture also preserves a legacy nullable
row, one Bot source-event row, and one ingest nonce. It does not contact
Binance, Bot, or any webhook.

## 6. What has never been verified here

Stated because a control that has not been exercised is not a control you can
count on:

- **No testnet order, live order or TradingView-account validation has
  occurred.**
- **Browser QA covered Chromium only** — not Safari, not Firefox, not a physical
  device, not a screen reader (`docs/WEB-QA.md`).
- **The holdout deploy gate has never passed**, because no selection artifact
  carries a holdout block yet. It refuses every run of the `replace_*.mjs`
  deploy scripts, which is the designed behaviour (`OPT-01`); producing the
  clearance needs a tree run. The deployments API route doesn't check it.
- **No notification alert of the newer families has been observed firing.**
  `sr_zone`, `pivot_level`, `rsi`, `macd` and the trend gates are unit-tested
  and have been armed end to end through the real API, database and browser,
  but no live market event has driven one to delivery.
- **The Bot controls on `/bot` (2026-11-09) have not been run against the
  production Bot.** They are tested against a fake Bot that authenticates the
  way the real one does (`platform/backend/tests/botControlDb.test.ts`). The
  Bot's own route tests (`bot:backend/tests/botControl.test.ts`) use a fake
  exchange. The signing test vector is asserted on both sides.

### Since corrected (2026-08-31)

Two items previously listed here have been discharged, and are recorded rather
than deleted so the change is auditable:

- **Migrations have now been executed.** 010–017 are applied in production, and
  013–017 were additionally run against a throwaway PostgreSQL 16 database with
  their accept/reject matrix exercised by hand before shipping. That found two
  defects static review had missed — see [ALERTS.md](ALERTS.md) §8.
- **AWS and production have been operated directly**, including deploys,
  migration application, an instance recovery and a database restart.

## 7. Paired Platform+Bot release and rollback (added 2026-09-02)

Platform and Bot ship as a pair because of the realization-event pipeline
(§5, and `crossRepositoryRealization.test.ts`): the Bot outbox and this
service's ingestion route share the vendored `webhookContract.ts` and
`realizationEventContract.ts` files byte-for-byte. `platform/scripts/release.sh`
(read/report only — it never touches Git history, a database, or a running
process) makes that pairing explicit:

```bash
platform/scripts/release.sh identity
platform/scripts/release.sh gate --peer-bot-root /path/to/bot
platform/scripts/release.sh rollback-check --since <platform-git-ref> [--database-url <postgres-url>]
```

`identity` prints the exact commit, the applied-migration set and its hash,
and both contract versions/fingerprints — the deterministic pieces of a
release pair; there is no separate registry to keep in sync. `gate` adds a
clean-worktree check, tool availability (`psql`/`pg_dump`/`pg_restore`),
a byte-identical diff of both vendored contract files against a Bot
checkout, `npm run typecheck`, and the realization-focused test files
(`realizationEvents.test.ts`, `realizationRecovery.test.ts`, and — with
`--peer-bot-root` — `crossRepositoryRealization.test.ts`, which spawns the
real Bot outbox against a loopback Fastify receiver). It exits non-zero on
any failure.

**Known-good pairs** (Platform commit / Bot commit):

| Pair | Platform | Bot |
|---|---|---|
| Earlier known-good | `93e7544` | `fda4d1b` |
| Earlier accepted | `21bedb1` | `2bc543e` |
| Earlier production; `gate` passed 2026-11-05 | `d43ee5e` | `76d17c5` |
| Earlier production; `gate` passed 2026-11-05 | `34a7bca` | `1cce9ba` |
| Earlier production; `gate` passed 2026-11-05 with Platform `8ef0ae7` | `34a7bca` | `8d70730` |
| Current production; Platform changes since `8ef0ae7` don't touch the Bot boundary. No exchange order yet | `72ea65f` | `8d70730` |

**Ingestion is opt-in.** `REALIZATION_INGESTION_ENABLED` (this service) and
the Bot's `REALIZATION_DELIVERY_ENABLED` both default to `false`. A Platform
upgrade alone changes nothing until an operator turns ingestion on.

**Schema compatibility.** Migration `021_realization_events.sql` only adds
nullable columns to `realised_pnl` and two new tables/indexes; the
`CHECK` constraint permits `source_system IS NULL`, so pre-existing INSERT
paths (`platform/backend/src/repositories/liveSafety.ts`) are unaffected, and nothing here ever
`UPDATE`s or `DELETE`s a `realised_pnl` row. `rollback-check` verifies this
class of change generically (it fails closed — `ROLLBACK_INCOMPATIBLE` or
`UNKNOWN` — on any `DROP`/`ALTER COLUMN`/`RENAME` or a bare `NOT NULL`
without a default introduced since the given ref) rather than assuming
migrations are safe by convention. This was proven directly, not just by
inspection: a disposable PostgreSQL 16 cluster was migrated to the current
head, seeded with one legacy `realised_pnl` row and one `BOT_CUSTOM_V1` row,
and the **previous** Platform commit's `migrate.ts` and
`platform/backend/src/repositories/journal.ts` were run against it unmodified — `migrate.ts`
reported nothing pending, and `listAutomatedRealizations` returned both rows
(the Bot-sourced fields simply absent from its narrower `SELECT`) with the
underlying row byte-for-byte unchanged afterward. Because this holds for any
current data, **Platform code rollback is classified `BACKWARD_COMPATIBLE`
without a database restore** — no pending/delivered distinction applies on
this side, since ingestion is synchronous and durable the moment it is
accepted.

**Preferred upgrade order:** Platform first, then Bot. New Platform code
accepts old-Bot payloads unchanged (every `CONTRACT_VERSION` bump through the
current 5 has been additive over its predecessor), so there is no interval
where a signal cannot be processed; only after Platform is confirmed healthy
should an operator set
`REALIZATION_DELIVERY_ENABLED=true` on Bot. If the second step never
happens, Platform keeps working exactly as before — the sequence has no
required completion window.

**Rollback order** (see the Bot README for the pending-realization-event
rule that governs Bot's half):
- *Platform bad, Bot healthy:* roll back Platform code directly (see above).
  Bot keeps queuing/retrying delivery with bounded backoff regardless.
- *Bot bad, Platform healthy:* see the Bot README — check
  `bot/scripts/release.sh rollback-check --since <ref> --database <bot.db>`
  before touching Bot code.
- *Both must return to the previous pair:* run the Bot check first (it is
  the one that can fail closed); only after it passes (or after a drain/
  restore) roll back Bot, then Platform. Platform's own rollback is always
  safe on the current pipeline, so it is never the blocking side.

**Pre-release backup is mandatory** before any upgrade capable of writing
new state: `platform/scripts/backup-platform-db.sh` per §5, verified before
proceeding. If `rollback-check` ever reports `ROLLBACK_INCOMPATIBLE` or
`UNKNOWN` for a future migration, do not start old Platform code against the
current database — restore the verified pre-release backup into a fresh
database (§5) and start old code against that instead.

---

## 8. Acquiring Binance Spot history (added 2026-09-02)

Historical candles come from Binance's **public** Spot market-data endpoints —
`/api/v3/klines` and `/api/v3/exchangeInfo`. No API key, secret or signature is
involved, and no account or order endpoint is reachable from this path. The
platform holds no Binance credential at all.

### Choosing the market-data host

`BINANCE_MARKET_DATA_BASE_URL` sets the origin every public market-data request
goes to. Unset, it is `https://api.binance.com` — existing deployments need no
change.

Some networks are refused by `api.binance.com` (and `api1`–`api4` / `api-gcp`)
with **HTTP 451**. Binance publishes a market-data-only mirror for exactly this
case, which serves the identical public endpoints and carries no account or
order surface:

```
BINANCE_MARKET_DATA_BASE_URL=https://data-api.binance.vision
```

The value is validated at boot against the official-host allowlist in
`platform/backend/src/config.ts`: HTTPS on port 443, no credentials, no path, query or fragment,
and a hostname Binance actually operates. Anything else is a startup failure
rather than a silently redirected price feed. This setting never affects manual
trading — those commands go to the execution bot, not to Binance.

### Bounded historical backfill

`platform/backend/scripts/backfill_history.ts` is the supported entry point. Give
it explicit targets and an explicit window:

```
cd platform/backend
npx tsx scripts/backfill_history.ts \
  --targets=NEARUSDT:1m,NEARUSDT:5m,NEARUSDT:15m,NEARUSDT:1h \
  --start=2023-05-03 --end=2026-08-13
```

- `--targets=SYMBOL:INTERVAL,...` — only what is listed is fetched. Nothing
  universe-wide happens unless no symbol is named at all.
- `--start` / `--end` — an ISO date/datetime or epoch milliseconds. `--end`
  defaults to now. Windows of any length are allowed, including multi-year.
- Alternatively `--symbols=A,B --intervals=1m,1h` for a symbol × timeframe grid.
- Omitting `--start` keeps the historical rolling behaviour (730 days, 300 for
  1m, relative to now) for the named or all active symbols.

**The window is the caller's decision.** The script hardcodes no research dates
and reads no research configuration; whichever research tree needs a particular
history determines its own scientific window and passes those dates in.

Large histories are streamed, not buffered: rows are upserted in batches as each
page arrives, so three years of 1m bars (~1.6M rows for one symbol) never sit in
memory, and an interrupted run has already persisted every row it reported.
Candles upsert on `(symbol, interval, open_time)`, so rerunning an overlapping
window overwrites rather than duplicates — resuming is always safe.

Each target prints rows upserted, pages fetched, the stored row count and
min/max coverage inside the requested window, and the candle-integrity state
with issue counts. Gaps are reported, never filled or interpolated.

Unless `--skip-symbol-metadata` is passed, the run first registers each pair and
refreshes `price_tick`, `qty_step`, `min_notional`, base/quote asset and trading
status from `exchangeInfo`, so a freshly backfilled symbol is immediately usable
by production freezing. Filters Binance does not send stay zero rather than
being guessed at.


## 9. Deploying without an upload (added 2026-10-16)

The release repository is public, so CloudShell can build the bundle from the
exact commit CI tested:

```bash
TAG=$(date -u +%Y%m%d%H%M%S); SHA=<commit>
mkdir -p /tmp/ghx && curl -sfL https://github.com/MuhammadMuhamid/my-tradingview-clone/archive/$SHA.tar.gz | tar -xz -C /tmp/ghx
(cd /tmp/ghx/my-tradingview-clone-$SHA && tar -czf ~/src-$TAG.tar.gz platform/backend platform/frontend platform/deployment)
bash ts-alert-ops.sh dryrun src-$TAG.tar.gz   # pending migrations, applied and rolled back
bash cloud-deploy.sh $TAG
```

- The `platform/` prefix inside the bundle is required.
- Tags are UTC timestamps: env-backup pruning sorts by name, and a reused tag
  collides with its own pre-deploy RDS snapshot.
- Done means `/readyz` reports `expected` equal to the commit's migration
  count (53 as of migration 053; the 2026-11-09 changes add no Platform
  migration).
- Migration `053_package_ledger.sql` runs `CREATE EXTENSION IF NOT EXISTS btree_gist`.
  The database user needs that privilege, so check it in the dry run.
- Accounts need `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_BASE_URL`
  and optionally `ALLOW_SIGNUPS` in `/opt/srtrend/deployment/.env`. GitHub sign-in
  and verification email need the settings in `docs/ACCOUNTS.md` §7.

---

## 10. Production status (2026-11-07)

Update this section whenever production changes.

| | |
|---|---|
| Platform | `72ea65f` at `mytradingview.alphawebstudioz.com`, deployed 2026-11-06 (tag `20261106172520`) from `MuhammadMuhamid/my-tradingview-clone` |
| Bot | `8d70730` at `bot.alphawebstudioz.com`, on its own server, deployed with [BOT-DEPLOY.md](../platform/deployment/aws/BOT-DEPLOY.md) |
| Bot settings when deployed | `DRY_RUN=true`, `BINANCE_TESTNET=true`, `MANUAL_TRADING_ENABLED=true`, `MAINNET_MANUAL_TRADING_ENABLED=false`, `EXCHANGE_STOPS_ENABLED=false` |
| Platform settings | `MANUAL_TRADING_ENABLED=true`; GitHub sign-in and `EMAIL_FROM` set ([ACCOUNTS §7](ACCOUNTS.md)) |
| Account email | SES domain `alphawebstudioz.com` verified with DKIM. Production access requested 2026-11-06 and under review, so until it's approved mail only reaches verified addresses |
| Admin account | Two-factor sign-in on since 2026-11-07 |
| Observed in a browser as admin, 2026-11-05 | The Trade panel shows PAPER SIMULATION with the testnet account. Trading → Bot shows Paper simulation and one simulated $100 BTCUSDT BUY from 2026-11-04 |
| Not yet done | No order has been placed on testnet or mainnet |

Conditions to clear:

- **Old Bot server.** A stopped server tagged `tradingbot` may hold real Binance
  keys and live settings, and its containers may restart on boot. Don't start it
  without an explicit decision. Whether the real Binance account has open positions
  or orders hasn't been confirmed.
- **Bot backups.** Running every 6 hours since 2026-11-05, with the first upload confirmed.
  Nothing alerts on a failure, no restore has been tested, and `ENCRYPTION_KEY` and
  `SCRYPT_SALT` have no copy off the server. See
  [BOT-DEPLOY.md](../platform/deployment/aws/BOT-DEPLOY.md).
- **Instrument metadata sync.** The backend logged Binance's `Invalid symbol` during
  this sync at startup on 2026-11-05 and carried on. The symbol isn't named in the log.
- **Migration count.** `/readyz` reports 52 expected and 59 applied, with none
  missing, and returns 200. Migration `052` applied cleanly over them. The source of the extra 7 hasn't been traced. Check it
  before adding or rolling back migrations.

> *Pointer, added 2026-11-09 outside this production log:* questions that only
> the operator can answer, none verified, are listed in §11.

---

## 11. Unverified: questions only the operator can answer (added 2026-11-09)

These are not observations. Nobody in the engineering workspace can check them,
because each needs AWS, the production database, the exchange account or the
operator's secret store. Each stays open until the operator records an answer
in §10.

1. **The old Bot server.** The stopped EC2 instance tagged `tradingbot` may
   hold real Binance keys and live settings, and its containers may restart on
   boot. Is it still stopped, or retired? Are its keys revoked? Does the real
   Binance account have open positions or orders?
2. **The exposed webhook secret.** A webhook secret was committed to the public
   Bot repository's history. Rotation has not been verified. Has the bot that
   used it been given a new secret, and has the Platform deployment been
   updated to match?
3. **Bot `ENCRYPTION_KEY` and `SCRYPT_SALT`.** Is there a copy off the Bot
   server, in the operator's secret store? Has a restore of a Bot backup been
   tested end to end? Without these two values a restored database cannot
   decrypt its exchange keys.
4. **Production migration drift.** `/readyz` reported 52 expected and 59
   applied (§10). Where did the extra 7 come from? Settle that before
   deploying `053`.
5. **The `btree_gist` prerequisite.** Migration `053_package_ledger.sql` needs
   `CREATE EXTENSION btree_gist`. Can the production database user create it?
6. **New migrations in the 2026-11-09 changes.**
   - The Platform adds none: the set still ends at `053`.
   - The Bot adds two additive SQLite migrations, which its entrypoint applies
     with `prisma migrate deploy`:
     - `20261109120000_manual_command_body_hash` adds a nullable
       `ManualCommand.bodyHash`;
     - `20261109130000_bot_control_command` adds the `BotControlCommand` table.
   - Take a verified Bot backup before deploying them.
7. **The administrator's two-factor sign-in.** §10 records it on since
   2026-11-07. Confirm it is still on before relying on Bot controls from
   Trading Scene.
