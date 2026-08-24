# Alerts

**Status:** current. Behaviour is pinned by
`platform/backend/tests/alert*.test.ts` and `platform/frontend/tests/alerts.test.ts`.

---

## 1. Two things called "alert"

This system has always had two, and until Phase 5 they shared a word, a bell
icon and a navigation entry.

| | **Notification alert** | **Automation** (deployment) |
|---|---|---|
| What it does | pushes a message to your devices | runs a strategy and sends real orders to the bot |
| Where | `/alerts`, the chart's bell, the MA panel | "Automate" button, `/deployments` |
| Table | `ma_alerts` | `deployments` |
| API | `/api/ma-alerts` | `/api/deployments` |
| Can it move money | **no — enforced, see §6** | yes |

`FE-01` was the consequence of the overlap: the chart's bell, labelled
"Alert", created *and activated* a live deployment with a default 800 USDT buy
size on the first click. The bell now arms a price alert. Automation has its
own button, its own dialog title, and an acknowledgement that names the buy
size before it can be started.

The route names still overlap (`/api/ma-alerts` for notifications,
`/api/alerts` for the deployment signal log). That rename is Phase 7; the UI no
longer conflates them.

---

## 2. What a notification alert can watch

| `condition_kind` | Watches | Columns |
|---|---|---|
| `ma` | price against one moving average — the original family, semantics unchanged | `ma_type`, `ma_length`, `mode`, `near_min_pct`, `near_max_pct` |
| `price` | a fixed price level | `target_price`, `price_direction` |
| `ma_vs_ma` | one moving average against another | `ma_type`/`ma_length` (fast), `ma2_type`/`ma2_length` (slow), `mode` |

A row that does not carry the columns its own kind needs is refused by the
database (`ma_alerts_shape_ck`). An alert stored half-specified would be
accepted and then silently never fire, which is the worst failure an alert has.

### Crosses need a previous side

`cross_up` and `cross_down` fire on a **close**, and only when the previous
evaluated close was on the other side. On the first evaluation after an alert is
created there is no previous side, so the alert seeds it and stays quiet.

Without that, arming "notify me when price crosses above 100" while price is at
105 fires immediately. That is not what was asked, and it is the single most
common way an alert system loses a user's trust.

### `either` is a range test

`price_direction = 'either'` fires when the candle's **range** reaches the level
— a wick is enough — and needs no previous side. A user who drags a line to 100
wants to know when price got there; a candle that spikes to 100.4 and closes at
99.8 did reach it.

The MA `touch` mode is the same test against the moving average, and is
unchanged.

---

## 3. The four frequency modes

`frequency` decides how often a **true** condition is allowed to notify. The
condition and the frequency are evaluated separately, which is what makes each
testable; conflating them is how "fires too often" bugs become hard to localise.

| Mode | Evaluates | Cap |
|---|---|---|
| `once_per_bar_close` | closed candles only | one per candle, then the cooldown window |
| `once_per_bar` | the forming candle | one per candle, ever |
| `once_per_minute` | the forming candle | one per minute while the condition stays true |
| `once_only` | whichever cadence is available | one, ever — then the alert retires |

**`once_per_bar_close` is the default and the migration value**, and its
behaviour is exactly what the runner did before frequencies existed.

### The intrabar warning

`once_per_bar` and `once_per_minute` evaluate a candle that has not finished.
That is a different promise, and the UI states it verbatim:

> May trigger before the candle closes. The condition can become false again before bar close.

The sentence is defined once, in
`platform/backend/src/alerts/alertFrequency.ts`, served from
`/api/ma-alerts/options`, and copied into the frontend only as the value shown
before that response arrives. A test reads the backend file and fails if the two
drift.

A notification that fired on a forming candle is marked `intrabar` in
`ma_alert_events` and reads "bar still forming" in the feed and the push body.

### The cooldown applies to one mode

`cooldown_min` throttles `once_per_bar_close` and nothing else. A 60-minute
silence stacked on `once_per_bar` at 15m would defeat the mode the user just
chose. The input is hidden for the other three, and the alerts list stops
showing a cooldown that is not applied.

### `once_only` retires on delivery, not on firing

`completed_at` is set only when the push reached at least one device.
Deactivating an alert whose notification reached nobody would lose the one
alert the user asked for; leaving it armed is the recoverable direction.

A retired alert leaves the runner's feed set (`ma_alerts_feed_idx`), reads
"Fired once — done" rather than as armed, and is re-armed by re-enabling it or
by saving the same alert again.

---

## 4. Why a bar-close alert never sees a forming candle

`last_side` — the memory a cross is detected against — is stored **per alert**.
`shouldEvaluate` refuses to show a forming candle to a `once_per_bar_close`
alert, and that is a correctness rule rather than an optimisation:

> If a mid-candle wick above the line updated the stored side, the cross would
> be consumed and the close would find itself already `above`. The alert would
> not fire at the close — a bar-close alert silently turned into a worse
> intrabar one.

Because each alert only sees the samples its own frequency accepts, the intrabar
modes could be added without touching bar-close behaviour at all. Two alerts on
the same line with different frequencies do not interfere.

---

## 5. Forming candles are never stored

The websocket manager emits forming klines as `barUpdate` and **never** calls
`upsertCandles` on them. Writing an unfinished high/low/close into the candle
store would mean every backtest, indicator and chart that later read that row
was reading a bar that never existed — a corruption that outlives the frame that
caused it by months.

Frames are not even parsed when nothing is listening for `barUpdate`, so the
live strategy runner pays nothing for a feature it does not use.

Intrabar evaluation reuses the closed-bar history already in memory, refreshed
on each bar close, and is floored at one evaluation every two seconds per feed.
Binance sends an update roughly every second; the fastest mode caps at one
notification a minute, so evaluating every frame would recompute a 1 200-bar
window per second for no benefit.

---

## 6. A notification alert cannot move money

`platform/backend/tests/alertIsolation.test.ts` walks the **entire transitive
import graph** of the alert runner and the alert routes, and fails the build if
either can reach the webhook dispatcher, the contract module, the broker, any
live evaluator, the deployments repository or the live-safety repository. It
also asserts that the only Binance endpoints on that path are public
market-data ones and that nothing on it builds a signed request.

The test proves itself: a third case walks `liveRunner.ts`, which genuinely
does reach the dispatcher, and fails if the walker reports it clean.

---

## 7. Stale and out-of-order samples

Feeds are multiplexed onto one websocket and re-subscribed on every reconnect,
so a frame for a just-unsubscribed stream is ordinary rather than exotic. Three
guards, all in `shouldEvaluate`:

- **symbol mismatch** — evaluating BTC's alert against ETH's price would fire a
  wrong notification *and* corrupt the stored cross side.
- **timeframe mismatch** — a response that arrives after the user switched
  timeframe.
- **older bar** — a late or replayed frame must not rewrite cross state that has
  already moved on.

A reconnect that replays a bar is safe by construction: the replayed frame
carries the same bar open time, so `last_fired_bar_time` recognises it rather
than notifying again.

---

## 8. Migration 010

Every column an existing row gains carries a default describing what that row
already did — `condition_kind = 'ma'`, `frequency = 'once_per_bar_close'` — so
applying the migration cannot change any alert's behaviour. It drops no column
and no table, and every constraint is added behind an existence check so a
re-run cannot fail a boot.

Uniqueness is preserved per kind, with the `ma` key byte-for-byte the one
migration 007 used: two alerts that coexisted before still coexist.

**Not verified:** no PostgreSQL server is available in this workspace, so 010
has *not* been executed. `tests/alertMigration.test.ts` pins the properties its
safety rests on by parsing the SQL; that is not the same as running it. Applying
it against a populated database is outstanding, and is recorded as such in
[REMEDIATION-LEDGER.md](REMEDIATION-LEDGER.md).

---

## 9. Also not verified here

- **Web Push delivery.** Needs a push service and a registered device. What is
  tested is the pure surface: the message shape, its size against the 4 KB
  payload limit, and which HTTP statuses prune a subscription.
- **Live Binance websocket behaviour.** The intrabar path is exercised through
  its pure planner, not against a live stream.
- **Browser rendering of the dialogs.** The frontend typechecks, lints, tests
  and builds; it has not been driven in a browser.
