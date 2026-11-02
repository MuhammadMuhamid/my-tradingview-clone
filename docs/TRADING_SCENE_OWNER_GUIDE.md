# Trading Scene — Owner's Feature Guide

Written 2026-11-01 during the V2 completion campaign and kept as the one owner-facing guide.
For each product area it states **where you find it, who can use it, the exact choices you get,
what must be configured first, the ordinary workflow, what success and errors look like, and what
is unsupported or unverified** — then links to the maintained document with the detail. Where this
guide and the code disagree, the code wins; fix this page.

Evidence levels: **LOCAL UI VERIFIED** (exercised in a browser against the real local backend and
a disposable database during the campaign; screenshots in the campaign evidence folder) ·
**TESTED** (automated tests actually run during the campaign) · **SOURCE-IMPLEMENTED** (read, not
executed) · **TESTNET / LIVE VERIFIED** (never claimed here: no credentialed exchange call has ever
been made from this workspace, [OPERATIONS §6](OPERATIONS.md)) · **NOT SUPPORTED**.

Campaign test runs (2026-11-01): Platform backend 1,453 tests; Platform frontend 1,577 unit +
605 DOM; Bot backend 386 and dashboard 13; Research 249 Python + 110 node. Two-account isolation
and Shariah publication ran against a real PostgreSQL 16. Production builds of both Platform halves
compile.

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
| Deep market-history requests | unlimited (large backfills stream) | clamped to the newest 200,000 source bars per request, 4 in flight; the response says `clamped` |

**Options:** display name, password change, Google link (admin links from Profile; a user whose
Google email matches a password account joins it and loses the password), sign out everywhere,
delete account. **Prerequisites for Google:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`PUBLIC_BASE_URL`; the button appears only when all three are set. **Success/errors:** a wrong
password says nothing about which half was wrong; duplicate email is 409; a user on an admin URL
sees "This page is for the administrator" with a link to the chart.

Evidence: **TESTED** (`accounts.test.ts`, `accountsDb.test.ts` on real Postgres: watchlists,
alerts, layouts, scripts, drawings, panes, devices, reach, password change, sign-out-everywhere,
deletion), **LOCAL UI VERIFIED** (sign-up → onboarding → chart, alerts, profile, admin URLs and the
Shariah screen as a Standard account; admin sign-in restores everything). Google OAuth round trip:
**SOURCE-IMPLEMENTED** only (token checks unit-tested; no real Google call). Reference:
[ACCOUNTS.md](ACCOUNTS.md).

---

## 3. Shariah screening

**Where:** left rail → *Shariah screening*; tabs *Status* and *Screening & publication*.
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
results template with an example) → research outside Trading Scene → paste or load the results
JSON → *Check results* → read each decision → *Review publication summary* → *Confirm publication
of N decisions* → click an asset to see the decision → *Turn on*.

**Success/errors:** sync notice counts and names what moved; a bad file is refused whole with one
line per problem ("policyVersion must be TS_SHARIAH_V1", "unrecognised field", "assetId must be
the numeric id copied from the review pack"…); publications are append-only; the asset panel says
"Mode ON: a new BUY of XUSDT is refused (status REVIEW)" or "allowed (ELIGIBLE)", always with
"Selling or reducing a position is never blocked". Mode ON with a configured but unreachable Bot:
stays OFF, 502 explained. Mode ON with **no Bot control channel configured:** turns ON and shows
*Bot floor: not armed* (a direct webhook BUY is not gated by this Platform).

**Unsupported/unverified:** other asset classes (refused for BUY under enforcement); production
mode is not visible here; the owner must decide whether a no-channel installation may show ON.
Evidence: **LOCAL UI VERIFIED** (full fixture cycle with ELIGIBLE / REVIEW / EXCLUDED, mode on/off,
read-only user view), **TESTED** (`shariahGate`, `shariahExitAvailability`, `shariahReviewBatch`,
`shariahUniverseDb` on real Postgres; Bot `shariahEnforcement`). Reference:
[FINAL_SYSTEM_GUIDE_SHARIAH_2026-10-11.md](FINAL_SYSTEM_GUIDE_SHARIAH_2026-10-11.md).

---

## 4. Manual trading — "can I connect an exchange and buy/sell from the website?"

**Yes for the administrator, Binance Spot only, once the Bot is set up — and no real exchange
(testnet or live) has ever been exercised from this workspace.**

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
mainnet additionally `MAINNET_MANUAL_TRADING_ENABLED=true` on the Bot and the exact confirmation
phrase on every order; `DRY_RUN=true` (Bot default) simulates without calling the exchange.

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
[WEBHOOK-CONTRACT.md](WEBHOOK-CONTRACT.md), Bot `README.md`.

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
pairs first); timeframes 1m / 5m / 15m / 1h / 4h / 1d plus every derived resolution the venue's
bars fold into exactly (seconds, 2m, 3m, 45m, 2h…); chart styles (candles, Heikin Ashi, Renko and
more); indicators from the shipped Pine library and your own scripts (Pine editor in the bottom
panel); 25 drawing tools with magnet, lock, hide, templates; history depth 2K / 10K / 50K / All;
layouts (single/multi-pane, saved layouts); watchlists with live prices; Bar Replay; Compare;
light/dark theme; keyboard shortcuts sheet. Administrator-only on the chart: Trade, Positions &
Orders, Strategy Tester, Automate, Strategy / Best config, trading Overlays.

**Alerts** (`/alerts` and from the chart): fifteen condition families (`price`, `ma`, `ma_vs_ma`,
`sr_zone`, `pivot_level`, `rsi`, `macd`, `supertrend`, `bollinger`, `stochastic`, `adx`,
`fib_level`, `msb`, `order_block`, `liquidity_swing`), optional trend gates, four frequency modes
(`once_per_bar_close` default, `once_per_bar`, `once_per_minute`, `once_only`), cooldown, a note,
arming across a watchlist or every tracked coin; delivery by web push after *Enable* on the device.
**Success/errors:** "N alerts armed on SYMBOL · tf"; *Recently fired* list; alerts never place
orders. **Unverified:** no live market event has been observed firing the newer families.
Evidence: **LOCAL UI VERIFIED** (chart first load with live data; level alert created as a
Standard account), **TESTED** (alert families and frequencies). Reference: [ALERTS.md](ALERTS.md),
[TRADING_SCENE_UI_UX_CONTRACT.md](TRADING_SCENE_UI_UX_CONTRACT.md).

**Screener** (`/screener`): needs the separate Python scanner service (`platform/screener/start.sh`,
FastAPI :8000, `ccxt`); without it the page shows *Scanner service unavailable* with Retry. **NOT
RUN** during the campaign (the service calls `api.binance.com`, HTTP 451 from this network).

---

## 7. Quick Backtester (built-in)

**Where:** *Research → Quick backtest* (administrator); also the chart's *Strategy Tester* tab for
Pine strategies. **Choices:** strategy (`ma_rr_v9` MA + R:R v9, `srtrend_v10` SR+Trend Final v10,
`mtf_lean` MTF Confluence Lean); tracked Binance Spot symbol; timeframe 1s–1d; start / end date;
initial capital; commission % per fill (0–5, default 0.1); slippage ticks (0–1000, default 2);
validation window last 10–50 % (default 20 %); position size *fixed cash per entry* (default 930 of
1,000) or *percentage of current equity*; every strategy parameter (defaults apply unless changed).

**Prerequisites:** candles for the window are fetched automatically through the market-data host.
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
checkout. **Who:** whoever runs it on that Mac (loopback only). **Prerequisite:** the Platform
backend's full environment (`.env`, or at least `AUTH_ENABLED=false`, `ALERT_ENCRYPTION_KEY`,
`ALLOWED_WEBHOOK_HOSTS`; `DATABASE_URL` defaults to :5433), and candles prepared on the Platform
with `POST /api/data/backfill` for **every feed the strategy reads** (chart timeframe plus the
strategy's auxiliary intervals).

| Stage | What you choose | What it answers | Status |
|---|---|---|---|
| **Search** (trees `lean_optimizer15m`, `optimizer1y15m`, `optimizer1y5m`, `optimizer1y5m_ma`; `optimizer1y1h` not comparable) | coins (tick list / paste), evaluation budget per symbol, workers (Low 1 / Balanced half / Maximum all / exact) | candidate parameter sets by the registered genetic algorithm, scored on the in-sample side of the frozen split | LOCAL UI VERIFIED (50/50 evaluations) |
| **Walk-forward** (`lean_wf_15m_current` current — no folds run yet; `lean_wf_15m`, `lean_wf_fixedsize`, `optimizer1y15m_wf`, `optimizer1y1h_wf_trail`, `wf6m_1h` historical; `regime_wf` not comparable) | coins, folds come from the definition | per-fold out-of-sample performance of the searched space | SOURCE-IMPLEMENTED + UI tests; no fold run here |
| **Replay** (`full3y1h`, `lean3y15m` historical) | coins, candidate replay limit per symbol (topN) | existing candidates over a longer history (still in-sample where it overlaps tuning) | LOCAL UI VERIFIED via the distributed unit (§9) |
| **Holdout** (`holdout1h` historical) | coins, topN | the leaderboard on history the optimizer never saw | SOURCE-IMPLEMENTED |
| **Stress** (from a completed run → *Test candidates in bad periods*) | coin, up to 10 candidates, find periods by largest decline / deepest drawdown / most volatile on daily, 4h or 1h stored candles, period length, count, search range; adjust / add / deselect periods | each frozen candidate's return, drawdown and trades per bad period beside the market's own | LOCAL UI VERIFIED (3/3 periods) |
| **Tree Definitions** | duplicate a supported preset into an immutable custom version: dates, costs, execution settings, folds, pinned inputs and sizing, searched dimensions (duplicate values refused) | the assumptions a run inherits | SOURCE-IMPLEMENTED + UI tests |
| **Shariah Mode pin** | Off / On (ELIGIBLE-only from an imported Platform snapshot) | which universe the run used, recorded immutably | SOURCE-IMPLEMENTED + Python tests |

**Workflow:** New Run → *Review preflight* (what will run, exact frozen dates, read-only stored
chart-feed coverage check, frozen market assumptions, fingerprints, warnings) → *Create immutable
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

**Workflow (every step exercised on one Mac):** name the helper → coordinator identity → pairing
block → approve the helper's certificate (fingerprint shown first) → enable the listener → restart
the coordinator once → paste the block on the helper and confirm the fingerprint → Helping ON →
*Connection connected* → `compute-helper.sh set-execution …` → *Able to run work: Yes* → a
`full3y1h` run with the helper-compatible preset → *Start distributed run* → unit executed by the
helper and accepted (1/1, attributed to the helper). **Success/errors:** honest capacity reasons
("Paused — Low Power Mode is on"), compatibility shown as compatible/unknown, "Connected — waiting
for eligible work". **Unverified:** a second physical Mac and the private-network address step;
after acceptance the run header still reads *Ready to start · 0/1* while the authoritative
Distributed panel reads 100 %. Reference:
[FINAL_SYSTEM_GUIDE_COMPUTE_HELPER_2026-10-11.md](FINAL_SYSTEM_GUIDE_COMPUTE_HELPER_2026-10-11.md).

---

## 10. What still needs the owner, real services or hardware

| Item | Why it is open |
|---|---|
| Binance testnet / live manual order | no credentials here; never run; both sides tested with fakes |
| Exchange-native stops | adapter exists, no call sites, five testnet checks pending (`bot/backend/src/services/exchangeStops.ts`) |
| Production Shariah mode, `ALLOW_SIGNUPS`, 3Commas deployments | production database, not visible here |
| Google sign-in round trip | needs a real OAuth client |
| Second Mac for Compute Helper | not available; loopback pairing and execution verified |
| Scanner service | not run (network); honest unavailable state verified |
| Walk-forward of the current 15m space | registered but no folds computed (needs data and compute) |
| Policy decision | whether Shariah Mode may show ON with no Bot control channel (today: yes, disclosed as *not armed*) |
