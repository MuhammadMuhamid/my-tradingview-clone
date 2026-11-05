# Trading Scene — Owner's Feature Guide

Written 2026-11-01 during the V2 completion campaign, reconciled 2026-11-02 in the V3 engineering
closeout and again in the V4 experience finish, and kept as the one owner-facing guide.
For each product area it states **where you find it, who can use it, the exact choices you get,
what must be configured first, the ordinary workflow, what success and errors look like, and what
is unsupported or unverified** — then links to the maintained document with the detail. Where this
guide and the code disagree, the code wins; fix this page.

Evidence levels: **LOCAL UI VERIFIED** (exercised in a browser against the real local backend and
a disposable database during the campaign; screenshots in the campaign evidence folder) ·
**TESTED** (automated tests actually run during the campaign) · **SOURCE-IMPLEMENTED** (read, not
executed) · **TESTNET / LIVE VERIFIED** (never claimed here: no order has ever been placed on an
exchange, [OPERATIONS §6](OPERATIONS.md)) · **NOT SUPPORTED**.

Final test runs (2026-11-02, V4 release polish, at platform `303acd1` / research `69ed83b`, logs in
`Trading-Scene-Campaign/V4-Release-Polish/evidence/final-*.log`): Platform backend 1,499 tests,
0 skipped; Platform frontend 1,590 unit + 671 DOM, 0 skipped; Research 262 Python (0 skipped, single
run) + 127 node `.mjs` + 29 TypeScript; Bot unchanged since the V2 logs (386 backend, 13 dashboard).
Two-account isolation and Shariah publication ran against a real PostgreSQL 16. `tsc`, `eslint`
(zero warnings, as CI runs them) for backend and frontend, and `next build` pass at the final commit.
(V4 figures: 1,499 / 1,589 / 665 / 262 / 127 / 29; V3: 1,483 / 1,577 / 621 / 257 / 118 / 24.)

---

## 1. The four products

| Product | What it is | Where it runs |
|---|---|---|
| **Trading Scene** (Platform) | Charting workstation and decision authority: chart, Screener, indicators and Pine, drawings, layouts, watchlists, alerts, accounts, Shariah screening, the manual order ticket, the Journal, the Quick Backtester. **Never holds exchange keys.** | `platform/` — Next.js on :3000, Fastify on :4000, PostgreSQL |
| **Execution Bot** | The only component holding Binance Spot API keys and placing orders; own dashboard (password + TOTP). | `bot/` — Express + SQLite, :4001 when co-hosted |
| **Backtester Optimizer** (Research) | Search, Walk-forward, Replay, Holdout, Stress on registered strategy trees, using the Platform's engine. Loopback-only web UI. | `research/` — Python controller on :8765 |
| **Compute Helper** | A second Mac that takes one kind of Research job over a paired mTLS link. | `research/backtester/compute_helper*.py`, page on :8877 |

Rule: Platform decides; Research uses Platform semantics; Bot executes authorised orders
([ARCHITECTURE.md](ARCHITECTURE.md)).

---

## 2. Accounts — who can do what

**Where:** `/login` (sign in / create account), `/onboarding`, `/profile`. **Who:** anyone when
`ALLOW_SIGNUPS` is on (default); the administrator signs in with `ADMIN_USERNAME` and the
environment's password hash.

| | Administrator | Standard account |
|---|---|---|
| Chart, Screener (read), alerts, watchlists, layouts, drawings, Pine scripts, push devices, Shariah screen (read-only) | yes | yes — isolated per account |
| Trading ticket, Automations, Journal, Quick Backtester, Optimizer, Stress, Operations, scanner configuration, Shariah management | yes | **no** — backend 403; navigation, chart workstation, the Shariah screen and the pages themselves say so instead of showing controls that would fail |
| Deep market-history requests | unlimited (large backfills stream) | backfill/coverage requests clamped to the newest 200,000 source bars; requests over 20,000 source bars run at most 2 per account and 4 across all ordinary accounts (the response says `clamped`); Market v1 chart/candle reads are clamped the same way **before the venue is asked** (the response says `truncated` with a note naming the limit); reads too wide for the candle cache (over 50,000 source bars) hold one of the same slots, and beyond them the browser waits its turn; a Pine run over more than 200,000 source bars including warm-up is refused with a sentence naming the limit |

**Options:** display name, password change, Google link (admin links from Profile; a user whose
Google email matches a password account joins it and loses the password), sign out everywhere,
delete account. **Prerequisites for Google:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`PUBLIC_BASE_URL`; the button appears only when all three are set. **Success/errors:** a wrong
password says nothing about which half was wrong; duplicate email is 409; a user on an admin URL
sees "This page is for the administrator" with a link to the chart. While the account is still being
checked (first load, before `/api/auth/me` answers) **no administrator control is drawn**: the chart
and Shariah screen render their neutral view and admin-only pages say "Checking your account…"; the
controls appear once the role is known. A session that **cannot be read** (backend down, a 5xx, the
network) is a fourth, distinct state since V4: no administrator control is drawn anywhere, the chart
and Shariah screen stay in their neutral view, the admin-only pages say "Your account could not be
checked — the server did not answer" with *Retry* and *Open the chart*, and an answered "signed out"
(expired cookie) sends the browser to sign in and back to the page it was on. Since the V4 polish the
same sentence is also in the chart's product menu (the avatar at the top left, and the same menu on
every other page) with *Retry* and *Sign out*, where the account row would be — so an administrator
whose read failed is told why the page looks like a Standard one and can recover without reloading;
the Shariah screen shows its own read-only sentence with *Retry* above its tabs. An instance with
accounts disabled is still the administrator's. The navigation never offers an admin-only page to a
non-administrator: the rail, the product menu, the section tabs (no "Automations · Journal" strip
above a refusal) and the Manual's step links all follow the role.

Evidence: **TESTED** (`accounts.test.ts`, `accountsDb.test.ts` on real Postgres: watchlists,
alerts, layouts, scripts, drawings, panes, devices, reach, password change, sign-out-everywhere,
deletion), **LOCAL UI VERIFIED** (sign-up → onboarding → chart, alerts, profile, admin URLs and the
Shariah screen as a Standard account; admin sign-in restores everything; re-verified 2026-11-02 on the
production build with a fresh Standard account: `/journal` shows the restriction notice, `/shariah`
the read-only view — screenshots `Closeout-V3/evidence/ui-*.png`), **TESTED** (unknown→admin and
unknown→user transitions in `chartRoleTabs`, `shariahReadOnly`, `adminOnlyPages` DOM tests; the
Market v1 bound in `marketCandleBounds.test.ts` and live against the local backend,
`Closeout-V3/evidence/a-live-standard-user-candles-demo.log`). Google OAuth round trip:
**SOURCE-IMPLEMENTED** only (token checks unit-tested; no real Google call). Reference:
[ACCOUNTS.md](ACCOUNTS.md).

---

## 3. Shariah screening

**Where:** left rail → *Shariah screening*; tabs *Status* and *Screening & publication* (a Standard
account sees *Status* and *Universe & decisions*).
**Who:** administrator manages; a Standard account sees a read-only view (universe, each asset's
decision, evidence and BUY-permission line).

**Exact choices:** selection = tick assets in the universe list (filter: needs review / due /
all; search by ticker or project name), *Download next N* with pack size 10–100 and *Include
settled decisions*, or *Download pack for selected*; re-review horizon 180 / 365 / 730 days /
never; Mode *Turn on* / *Turn off*; *Create universe snapshot*; per-asset *Record evidence* (URL,
title, publisher, retrieved-at, note) and *Publish a decision* (ELIGIBLE / REVIEW / EXCLUDED,
reason, prohibited categories, review-completed-at); batch *Correct draft decision*. Universe =
Binance Spot **USDT base assets this install tracks**; there is no exchange or category selector.

**Prerequisites:** none for screening; for the Bot floor, `MANUAL_TRADING_BOT_URL` +
`MANUAL_TRADING_HMAC_SECRET` on the Platform and the same secret on the Bot.

**Workflow:** *Sync universe* → tick / queue → download pack (`TS_SHARIAH_REVIEW_PACK_V1`: policy
questions, interpretation rules, fixed categories, per-asset identity, prior decisions, and the
results template with an example; its `resultContract.required` names the six answer keys and the
rule that `researchCompletedAt` / `retrievedAt` may not be later than now) → research outside
Trading Scene by any external reviewer (ChatGPT or a person — the product only validates the file's
shape and never issues a ruling) → paste or load the results JSON → *Check results* → read each
decision → *Review publication summary* → *Confirm publication of N decisions* → click an asset to
see the decision → *Turn on* (which first shows how many assets are ELIGIBLE and that every other BUY
will be refused, with *Turn on enforcement* / *Cancel*; *Turn off* is one click). On the Status tab
*Select the N assets needing review* ticks the STALE, UNSCREENED and due assets for a pack;
downloading a pack keeps the ticks and names the assets; *Create universe snapshot* lives in the
Snapshots card and is optional (an audit freeze for Research runs, not required to publish). A single
asset can also be published from its panel (*Publish a decision*); its refusal or success is said
under that button.

**Fixed in V4 (defect since the accounts change of 2026-10-15):** with authentication on, every
publication, import and snapshot answered 401 "not authenticated" for a signed-in administrator,
because the Shariah write routes re-verified the cookie as the pre-accounts admin token while
sign-in issues account tokens; the mode audit recorded "unknown-operator". The audit identity now
comes from the session the gate resolved (account email, or the configured admin name). Nothing was
relaxed: a Standard account is still refused every Shariah write (403) and reads stay read-only.

**Success/errors:** sync notice counts and names what moved; a bad file is refused whole with one
line per problem ("policyVersion must be TS_SHARIAH_V1", "unrecognised field", "assetId must be
the numeric id copied from the review pack"…); publications are append-only; the asset panel says
"Mode ON: a new BUY of XUSDT is refused (status REVIEW)" or "allowed (ELIGIBLE)", always with
"Selling or reducing a position is never blocked". Mode ON with a configured but unreachable Bot:
stays OFF, 502 explained. Mode ON with **no Bot control channel configured:** turns ON and shows
*Bot floor: not armed* (a direct webhook BUY is not gated by this Platform). **Mode ON is this
Platform's gate; it is not the Bot being armed** — the Bot floor line is the separate fact, and the
Status tab says which of *not required / not armed / enforcing / unknown / out of sync* applies.

**Unsupported/unverified:** other asset classes (refused for BUY under enforcement); production
mode is not visible here; the owner must decide whether a no-channel installation may show ON.
Evidence: **LOCAL UI VERIFIED** (V4, 2026-11-02: two independent fresh-context evaluators each walked the whole
journey in a real browser with authentication on — empty registry → sync → select → pack → invalid and valid
import → publish → per-asset publish → reload / new tab / sign-out-in persistence → Mode ON with confirmation →
Bot floor "not armed" → Mode OFF → Standard read-only view; the first found the publication 401, the second
completed everything; ledgers and 58 screenshots under `Experience-Finish-V4/`), **TESTED** (`shariahRoutes` with
account sessions, `shariahGate`, `shariahExitAvailability`, `shariahReviewBatch`, `shariahUniverseDb` on real
Postgres; Bot `shariahEnforcement`; 17 first-use DOM tests). Reference:
[FINAL_SYSTEM_GUIDE_SHARIAH_2026-10-11.md](FINAL_SYSTEM_GUIDE_SHARIAH_2026-10-11.md).

---

## 4. Manual trading — "can I connect an exchange and buy/sell from the website?"

**Yes for the administrator, Binance Spot only, once the Bot is set up. The ticket offers testnet
accounts only, and no order has yet been placed on testnet or mainnet.**

**Production (2026-11-05):** the Bot runs in simulation and the Trade panel shows PAPER SIMULATION
with the testnet account. No simulated order has been confirmed yet ([OPERATIONS §10](OPERATIONS.md)).

**Where:** chart → *Trade* button / order-ticket rail cell / *Positions & Orders* bottom tab.
Keys are entered on the **Bot dashboard** (Settings → exchange account: API key, secret, testnet
flag), never on the website. **Who:** administrator only.

**Exact choices:** account (from the Bot), side BUY / SELL, order type **MARKET** or **LIMIT**,
amount (BUY in USDT quote amount with quick-fill percentages; SELL in base quantity, optionally
tied to a tracked position), limit price, optional **take profit** and **stop loss** prices on a
BUY, cancel a pending LIMIT, edit or remove TP/SL on an active position, order list filters (all /
working / filled / cancelled / rejected / blocked), per-order Timeline.

**Prerequisites:** Platform `MANUAL_TRADING_ENABLED=true`, `MANUAL_TRADING_BOT_URL`,
`MANUAL_TRADING_HMAC_SECRET`; Bot `MANUAL_TRADING_ENABLED=true`, same secret, an exchange account;
`DRY_RUN=true` (Bot default) simulates without placing an exchange order. The Bot supports mainnet
with `MAINNET_MANUAL_TRADING_ENABLED=true` and the exact confirmation phrase on every order, but
`ManualTradingPanel.tsx` lists testnet accounts only, so real-money orders also need a code change.

**Gates on every BUY:** Platform halt → Shariah gate (Mode ON) → Bot HMAC → Bot halt/risk → Bot
Shariah floor → exchange. SELL is never blocked by halt or Shariah. TP/SL are **bot-managed**: a
30-second poll sells at market when the ticker crosses the level; **no exchange-native stop is
placed**, `EXCHANGE_STOPS_ENABLED` is inert, and positions are unprotected while the Bot is down.

**Success/errors:** the ticket shows PAPER SIMULATION / TESTNET SANDBOX / mainnet state, refusals
in the Bot's own words (Shariah refusals are their own bucket), a named 502 when the Bot is down,
and "manual trading is disabled" when the feature is off. **3Commas** is a deployment delivery
mode only (signal to 3Commas' webhook): Platform halt and Shariah gates apply, the Bot's do not,
no Bot protection, no Journal realization rows.

Evidence: **TESTED** (Platform `manualTrading`, `manualHalt`, `shariahGate`; Bot `manualTrading`,
`tpslHalt`, `shariahEnforcement`, `security`), **LOCAL UI VERIFIED** (ticket surface and disabled
state), **TESTNET / LIVE: never**. Reference: [ARCHITECTURE.md](ARCHITECTURE.md),
[WEBHOOK-CONTRACT.md](WEBHOOK-CONTRACT.md), Bot `README.md`,
[BOT-DEPLOY.md](../platform/deployment/aws/BOT-DEPLOY.md).

---

## 5. Journal

**Where:** *Journal* (administrator). **Choices:** From / Through (UTC dates, ≤ 366 days),
Source (All · separated / Manual / Automated / Paper), Symbol, Summary period (daily / weekly /
monthly), paging.

| Row | Comes from | P&L and fees |
|---|---|---|
| AUTOMATED | Realization events the Bot signs and delivers for custom-delivery deployments, plus persisted deployment activity | **modeled** (0.1 % buy + 0.1 % sell), labelled; not exchange-observed |
| MANUAL | one bounded read of the Bot's current manual-order state (only when manual trading is enabled) | activity only; economics **Unknown** — manual BUY and SELL are never paired |
| PAPER | simulated fills of paper deployments | exact paper accounting, kept apart from real |

**Success/errors:** "Unknown" means a record exists but cost basis or commission evidence does not
(never shown as zero); an empty period says what feeds the Journal; an install with manual trading
off says so under *Evidence limits*. Evidence: **TESTED** (`journal.test.ts`), **LOCAL UI
VERIFIED** (empty state, admin and user views). Reference: [OPERATIONS.md](OPERATIONS.md) §1.

---

## 6. Chart workstation and alerts

**Where:** `/chart` (every account). **Choices:** symbol search across Binance Spot pairs (tracked
pairs first; opening an untracked pair registers it from Binance's directory with the venue's own
base/quote — if the directory is unreachable the request fails with "the instrument directory is
unavailable … try again later" (503) and **nothing is written** to the shared catalog; a pair the
venue does not list is 404); native intervals 1s / 1m / 3m / 5m / 15m / 30m / 1h / 2h / 4h / 6h / 8h / 12h / 1d (the
toolbar shows six favourites) plus every derived resolution the venue's bars fold into exactly
(5s, 30s, 2m, 45m, 23m…); chart styles (candles, Heikin Ashi, Renko and
more); indicators from the shipped Pine library and your own scripts (Pine editor in the bottom
panel); 25 drawing tools with magnet, lock, hide, templates; history depth 2K / 10K / 50K / All;
layouts (single/multi-pane, saved layouts); watchlists with live prices; Bar Replay; Compare;
light/dark theme; keyboard shortcuts sheet. Administrator-only on the chart: Trade, Positions &
Orders, Strategy Tester, Automate, Strategy / Best config, trading Overlays. The toolbar's ⋯ row is
named for what it holds: "History, overlays & automation" for the administrator, "History depth" for
a Standard account. On an install where manual trading is off the *Trade* panel says so at once
(V4; it used to show "Loading manual trading…" indefinitely). The product menu indents the Journal,
Stress and Optimizer entries under their destinations.

**Alerts** (`/alerts` and from the chart): sixteen condition families (`price`, `ma`, `ma_vs_ma`,
`sr_zone`, `pivot_level`, `rsi`, `macd`, `supertrend`, `bollinger`, `stochastic`, `adx`,
`fib_level`, `msb`, `order_block`, `liquidity_swing`, `candlestick_pattern`), optional trend gates, four frequency modes
(`once_per_bar_close` default, `once_per_bar`, `once_per_minute`, `once_only`), cooldown, a note,
arming across a watchlist or every tracked coin; delivery by web push after *Enable* on the device.
**Success/errors:** "N alerts armed on SYMBOL · tf"; *Recently fired* list; alerts never place
orders. **Unverified:** no live market event has been observed firing the newer families.
Evidence: **LOCAL UI VERIFIED** (chart first load with live data; level alert created as a
Standard account), **TESTED** (alert families and frequencies). Reference: [ALERTS.md](ALERTS.md),
[TRADING_SCENE_UI_UX_CONTRACT.md](TRADING_SCENE_UI_UX_CONTRACT.md).

**Screener** (`/screener`): needs the separate Python scanner service (`platform/screener/start.sh`,
FastAPI :8000, `ccxt`); without it the page shows *Scanner service unavailable* as an error notice
on a card with *Retry* and the provider's reason on hover (V4 aligned it with the other pages'
feedback). **NOT RUN** during the campaign (the service calls `api.binance.com`, HTTP 451 from this
network).

---

## 7. Quick Backtester (built-in)

**Where:** *Research → Quick backtest* (administrator); also the chart's *Strategy Tester* tab for
Pine strategies. **Choices:** strategy (`ma_rr_v9` MA + R:R v9, `srtrend_v10` SR+Trend Final v10,
`mtf_lean` MTF Confluence Lean); tracked Binance Spot symbol (listed by ticker, as the chart shows it);
timeframe 1s–1d; start / end date;
initial capital; commission % per fill (0–5, default 0.1); slippage ticks (0–1000, default 2);
validation window last 10–50 % (default 20 %); position size *fixed cash per entry* (default 930 of
1,000) or *percentage of current equity*; every strategy parameter (defaults apply unless changed).

**Prerequisites:** candles for the window are fetched automatically through the market-data host.
**Data integrity:** the backtester refuses to run over an interior hole in the stored candles
(`assertNoInternalCandleGaps`); partial coverage at the edges is shown as covered-vs-requested. The
stored-candle check behind it (`ensureCandles`) still tolerates up to 1.5 % missing bars when deciding
whether to *download*, but now returns an honest coverage report (expected, present, leading /
interior / trailing shortfalls, first gap) that *Stress this run* records as `dataCompleteness` in its
provenance. Since V4 every Stress window also records its own **data integrity** — bars × interval
against the time it actually spans, the bars missing inside it and the missing UTC ranges — and the
Stress page shows it on the row (*Complete*, *Impaired* for one missing bar, *Not comparable* for two
or more, with the sign colours of a not-comparable window muted), with a warning above the table and
the searched period's completeness on the provenance line. Windows are still chosen by stored-bar
count (not re-selected), figures are never adjusted, and a result saved before this was measured reads
*Not verified*, never *Complete*.
**Workflow:** fill the form → *Run backtest* → the result page opens when done (seconds).
**Success:** headline metrics (net profit, profit factor, max drawdown, win rate, entries, average
entry, commission), development in-sample / out-of-sample / validation table, an affordability
note ("this run could not have taken N of its entries"), equity and drawdown curve, price chart
with trades, trade list, CSV export, *Stress this run*, *Edit and re-run*, *Re-run with these
settings*, *Copy link*. **Errors:** a bad input is a 400 sentence shown on the form; a symbol with
no exchange tick size refuses to run.

Evidence: **LOCAL UI VERIFIED** (ZECUSDT 15m, 2026-08-01→11-01). Reference:
[FINAL_SYSTEM_GUIDE_BACKTESTER_2026-10-11.md](FINAL_SYSTEM_GUIDE_BACKTESTER_2026-10-11.md).

---

## 8. Backtester Optimizer (Research)

**Where:** `http://127.0.0.1:8765` after `set -a; source <platform backend env>; set +a;
PLATFORM_BACKEND=<…>/platform/platform/backend python3 -m backtester` from the `research`
checkout. **Who:** whoever runs it on that Mac (loopback only: the controller listens on
`127.0.0.1`, so the Platform's "Open Research Backtester / Optimizer" link and this address work only
in a browser on the Mac that runs Research — from another computer they do not resolve, by design;
the Platform page says so since the V4 polish). **Prerequisite:** the Platform
backend's full environment (`.env`, or at least `AUTH_ENABLED=false`, `ALERT_ENCRYPTION_KEY`,
`ALLOWED_WEBHOOK_HOSTS`; `DATABASE_URL` defaults to :5433), and candles prepared on the Platform
with `POST /api/data/backfill` for **every feed the strategy reads** (chart timeframe plus the
strategy's auxiliary intervals).

| Stage | What you choose | What it answers | Status |
|---|---|---|---|
| **Search** (trees `lean_optimizer15m`, `optimizer1y15m`, `optimizer1y5m`, `optimizer1y5m_ma`; `optimizer1y1h` not comparable) | coins (tick list / paste), evaluation budget per symbol, workers (Low 1 / Balanced half / Maximum all / exact) | candidate parameter sets by the registered genetic algorithm, scored on the in-sample side of the frozen split | LOCAL UI VERIFIED (50/50 evaluations) |
| **Walk-forward** (`lean_wf_15m_current` current — no folds run yet; `lean_wf_15m`, `lean_wf_fixedsize`, `optimizer1y15m_wf`, `optimizer1y1h_wf_trail`, `wf6m_1h` historical; `regime_wf` not comparable) | coins, folds come from the definition | per-fold out-of-sample performance of the searched space | SOURCE-IMPLEMENTED + UI tests; one ad-hoc offline run on synthetic candles completed end to end (not a committed test, not validation); **at the shipped sizing ($1,000 capital, $1,000 fixed entry) it takes 0 trades**; no fold run on real data |
| **Replay** (`full3y1h`, `lean3y15m` historical) | coins, candidate replay limit per symbol (topN) | existing candidates over a longer history (still in-sample where it overlaps tuning) | LOCAL UI VERIFIED via the distributed unit (§9) |
| **Holdout** (`holdout1h` historical) | coins, topN | the leaderboard on history the optimizer never saw | SOURCE-IMPLEMENTED; same ad-hoc synthetic smoke as Walk-forward (0 trades at shipped sizing); no real-data run |
| **Stress** (from a completed run → *Test candidates in bad periods*) | coin, up to 10 candidates, find periods by largest decline / deepest drawdown / most volatile on daily, 4h or 1h stored candles, period length, count, search range; adjust / add / deselect periods | each frozen candidate's return, drawdown and trades per bad period beside the market's own; since V4 each period carries its data state (*Complete* / *Impaired* / *Not comparable* / *Not verified* for results saved before it was measured) in the preview and in the saved results table, measured on the market series and on the candidate's own chart feed. V4 also fixed *Find difficult periods*, which had failed with a TypeError since the V3 provenance change | LOCAL UI VERIFIED (3/3 periods, V2); integrity display TESTED (UI + TS tests) |
| **Tree Definitions** | duplicate a supported preset into an immutable custom version: dates, costs, execution settings, folds, pinned inputs and sizing, searched dimensions (duplicate values refused) | the assumptions a run inherits | SOURCE-IMPLEMENTED + UI tests |
| **Shariah Mode pin** | Off / On (ELIGIBLE-only from an imported Platform snapshot) | which universe the run used, recorded immutably | SOURCE-IMPLEMENTED + Python tests |

**Candidate files:** a Search's best file carries `inputs_to_apply` keyed by the strategy's parameter
**names** (`lean_optimizer15m`, `optimizer1y5m` and the three lean walk-forward trees used to write a
single `"undefined"` key; older best files on disk still do — they were not rewritten). Nothing in the
product reads that field; it is for applying a candidate by hand.
**Workflow:** New Run → *Review preflight* (what will run, exact frozen dates, read-only stored
chart-feed coverage check — it now reports leading / **interior** / trailing missing bars per feed, and
says "coverage unverifiable" instead of guessing if any stored row is off the interval grid; a gapped
feed keeps the status `needs-data` and is named in the summary — frozen market assumptions,
fingerprints, warnings) → *Create immutable
run* → *Start local run* (or queue with priority) → run page (status, progress, Events, Logs,
Manifest, Results & artifacts) → History & Results / Experiments. **Success/errors:** Start refuses
when tree inputs or the Platform commit changed since creation ("clone a new run"); a run that
completed with nothing evaluated says *Completed — no results* and now shows the adapter's reason
and a next step; the coverage check names a Platform boot error and what to start the controller
with. **Interpretation limits the product states:** Search is not validation; Stress is hindsight,
not Holdout; stages are a progression, not a pipeline; historical trees are not comparable.
Reference: `research/docs/BACKTESTER-CONTROLLER.md`, `research/docs/RESEARCH-METHODOLOGY.md`,
`research/README.md`.

---

## 9. Compute Helper

**Where:** `python3 -m backtester.compute_helper run` on the donating Mac (page :8877);
*Distributed Compute → Add a Mac* on the coordinator. **Supported job: one** — `full3y1h` replay,
one symbol per unit, topN = 1; Search, Walk-forward, Holdout, custom definitions and other replays
stay on the coordinator. **Choices:** Helping ON/OFF, Drain, profile Light / Balanced / Maximum /
Custom, power and thermal safeguards (AC only, minimum battery, pause in Low Power Mode, thermal
response), coordinator pairing (block or separate fields).

**Engine compatibility:** the coordinator fingerprints the 14-file canonical engine closure it stages
(indicator maths `src/ta/core.ts` included); a staged package hashes to that fingerprint, one changed
byte changes it, and a helper advertising a different fingerprint is refused work with "worker
canonical Platform engine fingerprint does not match this run's coordinator files" (**TESTED** against
the real checkout, `research/tests/test_backtester_distributed_production.py`). A Platform commit that
touches a closure file changes the fingerprint, so an older distributed run then says "clone a new run".
**Parity:** the same frozen unit replayed locally and through the real helper executor on one Mac
produces byte-identical results with 16 closed trades on synthetic candles (**TESTED**,
`test_backtester_full3y1h_parity.py`); real-data, two-machine parity is not demonstrated.
**Workflow (every step exercised on one Mac):** name the helper → coordinator identity → pairing
block → approve the helper's certificate (fingerprint shown first) → enable the listener → restart
the coordinator once → paste the block on the helper and confirm the fingerprint → Helping ON →
*Connection connected* → `compute-helper.sh set-execution …` → *Able to run work: Yes* → a
`full3y1h` run with the helper-compatible preset → *Start distributed run* → unit executed by the
helper and accepted (1/1, attributed to the helper). **Success/errors:** honest capacity reasons
("Paused — Low Power Mode is on"), compatibility shown as compatible/unknown, "Connected — waiting
for eligible work". The run header of a distributed run now follows the coordinator while the run's
own lifecycle record is still *created*: "Waiting for a helper · 0/1 accepted", "Running on helpers",
"All work accepted · finalizing". **Since V4 the run completes:** when the last unit is accepted the
coordinator re-verifies every accepted unit from disk (input id, compatibility hash, attempt manifest,
artifact bytes and result hash), publishes `artifacts/distributed-results.jsonl` (the accepted metrics
verbatim) and `artifacts/distributed-result.json`, marks the run *Completed — distributed work
completed* and appends the two events once; a controller stopped in between repairs it on the next
read or at start-up. Partial, rejected, expired, stale, duplicate or tampered work never completes a
run; if re-verification fails the run stays *created* and says *Results blocked* with the reason. A
run with every unit accepted is no longer offered to helpers or startable locally. The accepted
scientific artifact is listed with its hash; above the 1 MiB preview cap it previews as bounded text.
**Unverified:** a second physical Mac and the private-network address step (the completion path is
proven on one Mac over the real mTLS transport with the 16-trade synthetic unit). Reference:
[FINAL_SYSTEM_GUIDE_COMPUTE_HELPER_2026-10-11.md](FINAL_SYSTEM_GUIDE_COMPUTE_HELPER_2026-10-11.md).

---

## 10. What still needs the owner, real services or hardware

| Item | Why it is open |
|---|---|
| Binance testnet / live manual order | never run; both sides tested with fakes. Production Bot has testnet keys and `DRY_RUN=true`, so the next steps are one simulated order, then testnet orders with `DRY_RUN=false` |
| Bot backups | `bot:scripts/backup-db.sh` isn't scheduled, so the Bot database and encrypted keys exist only on that server's disk |
| Exchange-native stops | adapter exists, no call sites, five testnet checks pending (`bot/backend/src/services/exchangeStops.ts`) |
| Production Shariah mode, `ALLOW_SIGNUPS`, 3Commas deployments | production database, not visible here |
| Google sign-in round trip | needs a real OAuth client |
| Second Mac for Compute Helper | not available; loopback pairing and execution verified |
| Scanner service | not run (network); honest unavailable state verified |
| Walk-forward of the current 15m space | registered but no folds computed on real data; the shipped sizing takes no trades (see §8) |
| Finishing a distributed run | done in V4 (one-Mac proof); a run whose accepted results fail re-verification stays *created* with *Results blocked* — accepted units are final, so the recovery is to clone the run (an explicit re-open action is an owner decision) |
| Policy decision | whether Shariah Mode may show ON with no Bot control channel (today: yes, disclosed as *not armed*) |
| Decided in V4 | a session that cannot be read shows the neutral view with *Retry*; a signed-out answer goes to sign-in (the backend was and is the authority) |
| Policy decision | whether a backtest or Stress run over stored candles with an interior hole should **refuse** (backtester today) or **disclose** (Stress today marks each affected window *Impaired* / *Not comparable* and still runs it); and whether strict callers should re-download a hole the venue can fill |
| Policy decision | the Research preflight derives missing-bar counts from COUNT/MIN/MAX guarded by an on-grid check; accept that, or require a streamed row-by-row check that also names gap locations |
| Known limit | when more heavy history requests (over 20,000 source bars, such as 5s/25m at default depth or depth *All*) arrive than the 2-per-account and 4-server-wide slots, the chart waits its turn for up to 90 seconds, then shows the 429 |
| Known limit | venues paged at 300 bars (Coinbase, OKX, Kraken) cannot serve a 200,000-bar window and answer 502 rather than a truncated window (pre-existing) |
