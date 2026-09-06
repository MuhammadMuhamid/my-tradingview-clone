# Alerts

**Status:** current. Behaviour is pinned by
`platform/backend/tests/` (the `alert*.test.ts` files) and `platform/frontend/tests/alerts.test.ts`.

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
| `sr_zone` | the nearest swing support/resistance on the alert's own timeframe | `sr_side`, `sr_pivot_length`, `sr_invalidation`, `mode` |
| `pivot_level` | one pivot level from a completed anchor period | `pivot_type`, `pivot_level_name`, `pivot_anchor`, `mode` |
| `rsi` | RSI against a fixed level, or against its own SMA | `rsi_length`, `rsi_level`, `rsi_ma_length`, `indicator_target`, `mode` |
| `macd` | the MACD line against its signal, or against zero | `macd_fast`, `macd_slow`, `macd_signal`, `indicator_target`, `mode` |
| `supertrend` | the Supertrend changing direction | `st_period`, `st_multiplier`, `st_atr_method`, `mode` |
| `bollinger` | price against one Bollinger band — the only new family that watches a PRICE, so it keeps the touch and approach modes | `bb_length`, `bb_mult`, `bb_band`, `bb_ma_type`, `mode`, `near_min_pct`, `near_max_pct` |
| `stochastic` | Stochastic %K against its %D, or against a fixed level | `stoch_k_length`, `stoch_k_smooth`, `stoch_d_smooth`, `stoch_level`, `indicator_target`, `mode` |
| `adx` | ADX rising or falling through a strength threshold | `adx_di_length`, `adx_smoothing`, `adx_level`, `mode` |

A row that does not carry the columns its own kind needs is refused by the
database (`ma_alerts_shape_ck`). An alert stored half-specified would be
accepted and then silently never fire, which is the worst failure an alert has.

### The level families resolve their reference, they do not name it

`ma` and `price` are compared against a number the alert stores. `sr_zone` and
`pivot_level` are not: the runner resolves *which* level price is approaching on
each bar, and the notification names what it matched ("1h support", "Fibonacci
S1"). That is why neither carries a price column, and why an `any` pivot alert
can fire on a different line each time.

Support/resistance comes from **confirmed** swing pivots, so a pivot at bar `i`
is only knowable at `i + length` — the detector never sees a level before the
chart could have. Pivot levels are computed from the last **completed** anchor
period, never the forming one, and share `platform/backend/src/engine/pivotLevels.ts` with the Pine
indicator so the alert and the drawn line cannot disagree.

### Oscillators cross a reading, not a price

For `rsi` and `macd` the quantity that crosses is the indicator. A bar that
makes a new price high while RSI stays under 50 has not crossed 50, and
`evaluateSeriesCross` compares the reading rather than the close.

Distance is therefore carried in **indicator units**, not as a percentage of
price: an RSI of 55 against the midline is *5 points* away, and printing "5%"
would read as a market move. MACD makes this unavoidable rather than merely
preferable — its zero reference makes a percentage undefined outright.

Two rules exist because the alternative is an alert that is armed and can never
fire: an RSI level outside 0..100 could never be crossed, and a `macd_fast` at
or above `macd_slow` inverts the oscillator so every "crosses above" reports
what the reader sees as a downturn. Both are refused by the request parser, by
`validateCondition`, and by a database CHECK.

### Supertrend flips, it does not cross

`supertrend` is a direct port of the v4 study (`platform/backend/src/engine/ta.ts`), and the port is
deliberately literal. Its bands are **stateful**: `up` may only rise while the
previous close is above it, and `dn` may only fall while the previous close is
below it. Recomputing them from the current bar alone gives a line that wanders
and several times the real flip count. The flip test also compares this bar's
close against the **previous** bar's band; using the band being computed shifts
every signal by one bar.

The event is the **direction change**, not price touching the line. Those are
never quite the same event: on the flip bar the line has already jumped to the
other side of price, so a close-versus-line test reports the new side one bar
early and then sees no cross when the flip actually happens. `evaluateSupertrend`
therefore reads the indicator's own `trend` for the side, while still reporting
the drawn line as the reference — that is the price a notification can name.

`st_atr_method` records which average of true range is in use — `rma` (Wilder's,
the study's default) or `sma`. It is stored as a name rather than the study's
`changeATR` boolean because these are two different indicators, and a column
called `change_atr` would not say which one an existing row uses.

The multiplier is bounded 0 < m ≤ 100 by the parser, `validateCondition` and a
CHECK. At or below zero the two bands collapse onto `hl2` or swap, so the trend
flips on nearly every bar; far above, the band is wider than any move the market
makes and it never flips at all. Both are alerts that look armed and are
useless, in opposite directions.

### Trend gates, on every family

Any alert may carry optional preconditions, stored in the `filter_*` columns:
RSI(length) above/below a level, the close above/below a moving average, or
price above/below a Supertrend. "Approaching 1h support, but only while 1h RSI
50 is above 50" is one alert rather than two to correlate by hand. Every gate is
measured on the alert's **own** symbol and timeframe, on the same bar as the
trigger. There is deliberately no per-gate timeframe: allowing one would turn
every alert into a multi-timeframe query.

> **Changed in `025`.** Gates were originally confined to `sr_zone` and
> `pivot_level` by `ma_alerts_filter_kind_ck`. That restriction was an artefact
> of the order the families were built in, not a rule — "MACD crosses up, but
> only while price is above the Supertrend" is the same shape of request. The
> constraint is dropped rather than widened: a list of the kinds that *may* have
> a gate, when the answer is all of them, is a line that must be edited every
> time a family is added and whose only possible failure is a false rejection.

Two single points of application make that safe. `evaluateCondition` applies the
gates once, around the family switch, and `withSeries` resolves their readings
once for every kind. A per-family call is a line a new family can silently omit,
which would present as a filter the UI shows, lets you set, and never applies.

The Supertrend gate reads the indicator's `trend` rather than comparing the
close to the drawn line. The two agree on every bar but the flip bar, and the
trend is what the study itself acts on.

Three properties, all pinned by `platform/backend/tests/levelAlertFilters.test.ts`
and `platform/backend/tests/supertrendAlerts.test.ts`:

- **A gate can only subtract.** It suppresses `triggered` and nothing else; it
  cannot turn an untriggered level event on.
- **It does not touch cross state.** The side and distance are still recorded
  while a gate is shut. A gate that withheld the side would leave stale state
  that fires spuriously the moment the gate opens.
- **It fails closed.** An RSI, EMA or Supertrend that has not warmed up blocks
  the alert. "Only when the trend is up" must not fire because the trend is
  *unknown*.

A gate is complete or absent — a length with no side is refused by
`ma_alerts_filter_ck`, and a half-written row is read back as *no* gate rather
than guessed at.

> The `IS NOT NULL` tests in that constraint are load-bearing. A CHECK passes
> when it evaluates to NULL, so `filter_rsi_length > 0 AND filter_rsi_level > 0`
> with a NULL level is `TRUE AND NULL` = NULL — the constraint accepted exactly
> the row it was written to reject until those tests were added.

### Every alert can carry a note, and the notification shows it

`note` is the user's own reason for arming the alert — "TP1 for the March long",
"stop loss", "watching for the retest". It is offered by every dialog and
appended to the notification body.

**Appended, not substituted.** The note says *why* you cared; the generated
sentence says what the market actually did. A phone showing only the note would
tell you that an alert you wrote three weeks ago fired, without saying at what
price or on which line. It goes **last** because notification bodies truncate
from the end on both iOS and Android, so the market fact — the part that cannot
be reconstructed from memory — survives the truncation.

Bounded at 280 characters by the route, by `ma_alerts_note_len_ck`, and by the
textarea. That is a limit about what a phone can render in roughly two lines,
not about storage; an unbounded note would push the price off the end of the
notification or exceed the 4 KB Web Push payload. A blank or whitespace-only
note is stored as NULL, so the formatter never appends a bare separator.

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

## 8. Migrations 010–031

Every column an existing row gains carries a default describing what that row
already did — `condition_kind = 'ma'`, `frequency = 'once_per_bar_close'` — so
applying the migration cannot change any alert's behaviour. It drops no column
and no table, and every constraint is added behind an existence check so a
re-run cannot fail a boot.

Uniqueness is preserved per kind, with the `ma` key byte-for-byte the one
migration 007 used: two alerts that coexisted before still coexist.

The same discipline holds for the later migrations. `013`–`014` added the level
families, `015` and `016` widened the kind CHECK for them and for the
oscillators, `017` added the trend gates, and `025` added the `supertrend`
family, the Supertrend gate and the note length bound — while dropping `017`'s
`ma_alerts_filter_kind_ck`, which had confined gates to the two level families.
Each new kind's completeness rule
lives in `ma_alerts_kind_complete`, and `alertMigration.test.ts` compares the
**effective** vocabulary — the last definition across the whole set — against
`CONDITION_KINDS`, so columns can never be added without widening the CHECK
that would then refuse them.

`027` added the `bollinger`, `stochastic` and `adx` families with the same
discipline, and `028` corrected two things it got wrong: a Stochastic alert
targeting its own %D was storing a level it does not read, which made two
identical alerts distinct rows in the uniqueness index and notified twice, and
three numeric columns were unbounded where every prior family uses
`numeric(10,4)`.

Length combinations are now bounded as a COMBINATION, not only individually.
`adx_di_length` 700 with `adx_smoothing` 700 passes both 1..1000 checks and
needs 1400 bars, which is more than the runner's 1200-bar window: the alert
would have been stored, listed as armed, and never able to warm up.
`ALERT_HISTORY_BARS` and `warmupBars` in `platform/backend/src/types/maAlerts.ts` are the one
authority for that, and the API refuses the combination.

**Now verified by execution.** These are applied in production, and 013–017
were additionally run against a throwaway PostgreSQL 16 database before
shipping, with the accept/reject matrix exercised by hand. That found two
defects the SQL review had missed: a CHECK defeated by NULL three-valued logic
(§2), and an RSI uniqueness index that needed `NULLS NOT DISTINCT` — without
it, only one of `rsi_level`/`rsi_ma_length` is populated per target, two NULLs
never conflict, `ON CONFLICT` never matches, and re-arming inserts duplicates
instead of updating.

Parsing the SQL is not the same as running it. Both kinds of check earn their
place, and the ones above were only caught by the second.

---

## 8b. Push subscriptions go stale silently

A subscription can be dead while every server-side signal says it is healthy.
Apple keeps accepting notifications for endpoints belonging to apps that were
uninstalled weeks ago, returning success and only 404/410 much later, if ever.

That is not a hypothetical. Four dead iPhone subscriptions once sat in
`push_subscriptions` with `last_ok_at` timestamps minutes old while the phone
received nothing; every alert reported `pushedTo: 4` and no failures. The
outage was invisible from the server for days.

**`last_ok_at` therefore cannot measure liveness** — it records that the push
service accepted bytes, not that a device displayed anything. `last_seen_at`
(migration 018) records the one thing a ghost cannot do: come back and
re-register. The app re-POSTs its own subscription on load
(`refreshSubscription`, which never prompts), and `pruneUnseen` ages out rows
that stop doing so, daily, at `PUSH_STALE_DAYS` (default 30).

The window is generous on purpose. The costs are asymmetric: pruning a live
device silently stops its alerts until someone notices, while keeping a dead
one only inflates a counter.

**Four independent facts get confused here, and every one of them has caused a
bug:** browser permission, a subscription in *this* browser, a row in the
table, and acceptance by the push service. The UI once read permission alone
and declared a desktop browser enrolled that had never subscribed — offering
Test/Off and no way to reach Enable.

## 9. What is still not verified

- **Live Binance websocket behaviour.** The intrabar path is exercised through
  its pure planner, not against a live stream.
- **A firing `sr_zone`, `pivot_level`, `rsi`, `macd`, `supertrend` or gated alert.** Every
  one of these has been armed end to end — HTTP, database, UI — and their
  evaluators are unit-tested, but no live market event has driven one to
  delivery. That is the honest gap: arming is proven, firing is not.
- **Web Push delivery of the newer families.** The transport is in production
  and delivers; what has not been observed is one of the new kinds arriving on
  a device.

**Verified for the Supertrend family, the universal gates and the note (025).**
Migration `025` was executed against a real PostgreSQL 16 three ways: fresh
(all 25 apply, every constraint ends up `convalidated`), on a table populated
with a row of every prior family including a gated one (all rows survived), and
on a deliberately dirty table (the deploy completes with a warning). The
accept/reject matrix was then run by hand at both the SQL and HTTP layers, and
every dialog was driven in a browser against that database with the stored rows
read back. Four defects came out of it, three of which no unit test had caught:

1. **A NULL `mode` was accepted for every cross family** — `rsi`, `macd`,
   `ma_vs_ma` and the new `supertrend`. `mode IN (...)` is NULL when `mode` is
   NULL, so that OR-branch was NULL, and `FALSE OR NULL` is NULL, which a CHECK
   accepts. Pre-existing since `016`; fixed in `025` with explicit
   `mode IS NOT NULL` on each branch, and pinned by `alertMigration.test.ts`.
2. **Tightening that CHECK could have aborted a deploy**, because migrations run
   on boot. It is now added `NOT VALID` and validated separately, reporting
   rather than failing.
3. **A bad gate multiplier was rejected with the wrong field name**
   (`stMultiplier` for a `filterStMultiplier` input), sending the reader to the
   wrong control.
4. **The editor's note was a one-line input** while the creation dialogs used a
   proper box with a counter — the same field for the same 280-character value,
   presented two ways. They are now one component.

The indicator itself was checked against an **independent transcription** of the
v4 study into Python, written from the Pine rather than from `ta.ts`, over 600
real SOLUSDT 15m candles and four parameter sets: zero trend mismatches, band
agreement to 1.4e-14. A 160-bar slice containing nine real direction changes is
frozen as `platform/backend/tests/fixtures/supertrendGolden.json`, so the port cannot drift.

**Verified earlier:** the alert dialogs have now
been driven in a real browser against a real backend — the MA rail's Levels and
Oscillators sections, the RSI/MACD dialog and the level dialog's gates were
rendered, filled and saved, and the stored rows checked. That found a defect no
unit test did: the request parser read `b.level` while the client and the column
both said `rsiLevel`, so a request for RSI level 70 was accepted and quietly
armed at the 50 default.
