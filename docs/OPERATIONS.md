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

The halt button refuses every emission and needs a written reason — whoever
finds the system halted has to be able to see why. Resuming is deliberately
harder than halting, and a latched daily-loss halt re-checks the live number
before it will resume: resuming straight back into a breached limit would trip
again on the next signal.

**Halting does not close open positions.** The platform cannot flatten a
position it does not hold: it has no exchange credentials, and it does not know
the fill price of anything it did not open. Inventing an exit would put real
money behind a guess. Close positions in the execution bot or on the exchange.

A flatten-all control is deliberately absent. It would require the platform to
place orders directly, which is the bot's job, and it could not be validated
here without Binance testnet credentials.

### Risk limits

Three limits, each opt-in and each `null` (off) by default, so adding them
changed no behaviour until an operator set a number:

- **Total exposure** — the sum of `buy_quote_qty` across deployments currently
  long. This is what they are *configured* to spend, not a balance read from the
  exchange.
- **Concurrent positions** — how many deployments may be long at once.
- **Rolling realised loss** — over a configurable window, defaulting to 24 hours.

A breach of a numeric limit **latches the kill switch**. An exit is never
refused by a numeric limit: refusing a sell because exposure is too high would
trap the position that caused the problem. Only an explicit operator halt stops
an exit.

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
paper simulation, Bot dry-run, Binance testnet, and Binance mainnet separately.

Bot execution evidence is fetched server-side only after one specific timeline
is opened. Manual orders use the exact signed order identity; custom deployment
evidence uses the exact Platform source/dedupe identity and is hard-bounded.
Bot unavailability or not-found leaves existing Platform evidence intact, and
the Timeline creates no rows or duplicate Bot ledger. Individual Bot exchange
fills, commission history, prior cumulative snapshots, and unpersisted
transitions remain unavailable rather than inferred.

### Trade Journal

Open **Journal** for a bounded cross-source view of activity and accumulated
known realized results. REAL and PAPER totals are separate by default. Manual
orders and live cumulative execution reports can appear with **Unknown** P&L:
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
overwriting it (`BOT-030`).

**No credentialed testnet operation has ever been performed from this
workspace**, and two findings are blocked on that: the exchange-native stop
adapter (`BOT-017`, disabled by default) and replacing the order-signing library
(`BOT-039`).

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

- **No credentialed testnet, TradingView-account or live-order validation has
  occurred.**
- **Browser QA covered Chromium only** — not Safari, not Firefox, not a physical
  device, not a screen reader (`docs/WEB-QA.md`).
- **The holdout deploy gate has never passed**, because no selection artifact
  carries a holdout block yet. It currently refuses every deployment, which is
  the designed behaviour (`OPT-01`); producing the clearance needs a tree run.
- **No notification alert of the newer families has been observed firing.**
  `sr_zone`, `pivot_level`, `rsi`, `macd` and the trend gates are unit-tested
  and have been armed end to end through the real API, database and browser,
  but no live market event has driven one to delivery.

### Since corrected (2026-08-31)

Two items previously listed here have been discharged, and are recorded rather
than deleted so the change is auditable:

- **Migrations have now been executed.** 010–017 are applied in production, and
  013–017 were additionally run against a throwaway PostgreSQL 16 database with
  their accept/reject matrix exercised by hand before shipping. That found two
  defects static review had missed — see [ALERTS.md](ALERTS.md) §8.
- **AWS and production have been operated directly**, including deploys,
  migration application, an instance recovery and a database restart.
