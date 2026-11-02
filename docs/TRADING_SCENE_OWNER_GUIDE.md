# Trading Scene — Owner's Feature Guide

Written 2026-11-01 during the V2 completion campaign. One page that says **what a user can
actually do, where, with which choices, and how much of it has been verified**. It links to the
maintained documents instead of repeating them. Where this guide and the code disagree, the code
wins; please fix this page rather than the code's behaviour.

Evidence levels used below:

| Level | Meaning |
|---|---|
| **LOCAL UI VERIFIED** | Exercised in a browser against the real local backend and a disposable database during the campaign (screenshots under the campaign evidence folder). |
| **TESTED** | Covered by automated tests that were actually run during the campaign (fixtures, fake exchange, local PostgreSQL). |
| **SOURCE-IMPLEMENTED** | The code path exists and was read, but it was not executed here. |
| **TESTNET / LIVE VERIFIED** | Never claimed in this repository: no credentialed Binance testnet or live order has ever been placed from this workspace ([OPERATIONS §6](OPERATIONS.md)). |
| **NOT SUPPORTED** | The feature does not exist, or a switch exists that does nothing. |

Campaign test runs (2026-11-01, local): Platform backend 1,446/1,446; Platform frontend 1,575
unit+DOM (baseline, before the campaign's own additions); Bot backend 386/386; Research Python
238/238. Two-account isolation and Shariah publication tests ran against a real PostgreSQL 16.

---

## 1. The four products in one sentence each

| Product | What it is | Where it runs |
|---|---|---|
| **Trading Scene** (Platform) | The charting workstation and the decision authority: charts, Screener, indicators and Pine, drawings, layouts, watchlists, alerts, accounts, Shariah screening, the manual order ticket, the Journal, and the built-in Quick Backtester. It **never holds exchange keys**. | `platform/` — Next.js frontend on :3000, Fastify backend on :4000, PostgreSQL |
| **Execution Bot** | The only component that holds Binance Spot API keys and places orders. It has its own dashboard (password + TOTP) for keys and signal bots. | `bot/` — Express + SQLite, :4001 when co-hosted |
| **Backtester Optimizer** (Research) | A separate research product: Search, Walk-forward, Replay, Holdout, Stress on registered strategy trees, using the Platform's canonical engine. Loopback-only web UI. | `research/` — Python controller on :8765, runs the Platform engine through Node |
| **Compute Helper** | A second Mac that can take one kind of Research job (`full3y1h` replay, one symbol per unit) over a paired mTLS link. | `research/backtester/compute_helper*.py`, helper page on :8877 |

Architecture rule: **Platform decides; Research uses Platform's semantics; Bot executes authorised
orders.** Details: [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 2. Accounts and what each role can do

| | Administrator | Ordinary user |
|---|---|---|
| Sign-in | `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` from the server environment | email + password sign-up (`ALLOW_SIGNUPS`, default on) or Google sign-in when configured |
| Chart, Screener (read), Shariah screen (read), own watchlists / layouts / drawings / Pine scripts / alerts / push devices | yes | yes — isolated per account |
| Trading ticket, Automations (deployments), Journal, Research/Quick Backtester, Optimizer, Stress, Operations, scanner configuration, Shariah mode and publication | yes | **no** (backend returns 403; the navigation and, since this campaign, the chart workstation no longer show these controls) |
| Deep market-history requests | unlimited (large backfills stream in bounded memory) | at most 200,000 source bars per request and 4 requests in flight — the same amount the chart can display |

Evidence: **TESTED** — `backend/tests/accounts.test.ts`, `accountsDb.test.ts` (two accounts on a
real PostgreSQL: watchlists, alerts, layouts, scripts, drawings, panes, devices, reach, password
change, sign-out-everywhere, deletion), `historyLimits.test.ts`, `symbolRegistration.test.ts`,
`frontend/tests/dom/chartRoleTabs.test.tsx`. Google OAuth itself is **SOURCE-IMPLEMENTED** only
(token checks are unit-tested; no real Google round trip was made). Reference: [ACCOUNTS.md](ACCOUNTS.md).

---

## 3. Shariah screening — the owner's journey, step by step (LOCAL UI VERIFIED)

Open **Shariah screening** in the left rail. Two tabs: *Status* and *Screening & publication*.

| Step | What you do | What you get | Evidence |
|---|---|---|---|
| 1. Discover the universe | *Sync universe* | Every USDT Spot base asset this install tracks (the `symbols` table ∩ Binance exchange info) becomes an UNSCREENED asset. Nothing is classified. | LOCAL UI VERIFIED (3 assets) |
| 2. Choose what to research | Tick assets in the *Universe* list, or use the queue | *Download pack for selected (N)* or *Download next 20 for ChatGPT*. Pack size 10–100. Queue order: STALE, UNSCREENED, published REVIEW, then due settled decisions. Downloading does not reserve the queue. | LOCAL UI VERIFIED (API) |
| 3. Export | The pack is one JSON file (`TS_SHARIAH_REVIEW_PACK_V1`) | Contains the policy questions, interpretation rules, the fixed prohibited categories, per-asset identity and prior decisions, **and the exact results template** (`TS_SHARIAH_REVIEW_RESULTS_V1`) with an example. No private data. | LOCAL UI VERIFIED |
| 4. Research outside | Upload to your own research tool (the UI names ChatGPT) or give it to an analyst | They fill the template: classification, six answers, reason, categories, cited evidence (URL, title, publisher, retrievedAt, note), unresolved uncertainties. Trading Scene calls no model API. | by design |
| 5. Import and check | Paste the JSON or *Load a … results JSON file* → *Check results* | Strict validation with one line per problem (wrong policy version, unknown field, missing evidence…). The whole batch is refused on any problem. Each decision is readable before publishing; *Correct draft decision* lets you override classification/reason/categories explicitly. | LOCAL UI VERIFIED (valid and malformed files) |
| 6. Review and publish | *Review publication summary* → read → *Confirm publication of N decisions* | Append-only immutable publications, one transaction, all-or-nothing. Uncertain ELIGIBLE decisions need per-asset acknowledgement first. | LOCAL UI VERIFIED (ELIGIBLE / REVIEW / EXCLUDED) |
| 7. See the result | Click an asset | Lifecycle, current reason, cited evidence, published history, and (new) **whether a BUY of that asset is permitted under the current mode**. | LOCAL UI VERIFIED |
| 8. Enforce | *Turn on* | Mode ON: a BUY is refused unless the asset is ELIGIBLE; UNSCREENED/STALE/unknown count as REVIEW. **SELL, reduce and exit are never blocked and nothing is ever liquidated.** | LOCAL UI VERIFIED (mode); gate TESTED (`shariahGate`, `shariahExitAvailability`, Bot `shariahEnforcement`) |

Selectors supported: Binance Spot **USDT base assets only**. There is no exchange or category
selector; the universe is what the install tracks. Other asset classes are refused for BUY under
enforcement.

Statuses: ELIGIBLE · REVIEW · EXCLUDED (published), UNSCREENED and STALE (lifecycle, both
effectively REVIEW). Re-review age (180/365/730 days/never) is advisory only.

**Bot floor — what actually happens when you turn Mode ON** (resolved from source during the
campaign, `backend/src/shariah/botEnforcement.ts`):

- Bot control channel configured (`MANUAL_TRADING_BOT_URL` + `MANUAL_TRADING_HMAC_SECRET`) and the
  Bot answers with the same floor → Mode ON and *Bot floor: armed*.
- Channel configured but the Bot is unreachable or answers differently → **Mode stays OFF**, you
  are told why (502).
- **No channel configured** → Mode turns ON for everything the Platform originates, and the page
  says *Bot floor: not armed*: a signal sent straight to a Bot webhook is not gated by this
  Platform. (The 2026-10-11 guide's table only described the second case.)

Policy decisions that remain the owner's: whether a no-channel installation should be allowed to
show "ON" at all, and the actual production mode (stored in the production database, not visible
here). Reference: [FINAL_SYSTEM_GUIDE_SHARIAH_2026-10-11.md](FINAL_SYSTEM_GUIDE_SHARIAH_2026-10-11.md).

---

## 4. "Can I connect an exchange account and buy/sell manually inside the Trading Scene website?"

**Yes for the administrator, on Binance Spot only, once the execution Bot is set up — and nobody
has verified it against a real exchange (testnet or live) from this workspace.**

| Question | Answer | Evidence |
|---|---|---|
| Who | Administrator only. Ordinary users never see the ticket. | TESTED |
| Where do keys go | The **Bot dashboard** (Settings → exchange account: API key + secret, testnet flag). The website never stores or sees a key. | SOURCE-IMPLEMENTED (`bot/backend/src/routes/exchange.ts`) |
| Where is the ticket | Chart workstation → *Trade* button / order-ticket rail cell, and the *Positions & Orders* bottom tab. | LOCAL UI VERIFIED (visible; feature disabled on the campaign instance) |
| Venues | Binance **Spot** only. Other venues are refused with `unsupported_execution`. | TESTED |
| Order types | **MARKET** and **LIMIT**. BUY sizes by quote amount (USDT), SELL by base quantity. | TESTED (Bot `manualTrading` tests) |
| Take profit / stop loss | Absolute prices on a long BUY entry only. **Bot-managed**: a 30-second in-process poll sells at market when the ticker crosses the level. **No exchange-native stop is ever placed**; `EXCHANGE_STOPS_ENABLED` changes a status string only. While the Bot is down, positions are unprotected. | SOURCE-IMPLEMENTED + TESTED (`manualProtection`) |
| Cancel / edit | Cancel a pending LIMIT; edit TP/SL on an active position. Market orders cannot be cancelled. | TESTED |
| Balances / open orders / positions | Read through the Bot (`/state`, `/account-state`), shown in the ticket and the bottom tab. | SOURCE-IMPLEMENTED |
| Simulation / testnet / live | Bot `DRY_RUN=true` (default) simulates without calling the exchange. Testnet is a property of the Bot's exchange account. Mainnet manual orders additionally require `MAINNET_MANUAL_TRADING_ENABLED=true` on the Bot and an exact confirmation phrase on every order. | SOURCE-IMPLEMENTED; **TESTNET / LIVE: never verified** |
| Prerequisites | Platform: `MANUAL_TRADING_ENABLED=true`, `MANUAL_TRADING_BOT_URL`, `MANUAL_TRADING_HMAC_SECRET`. Bot: the same secret, `MANUAL_TRADING_ENABLED=true`, an exchange account. Both processes up. | documented in both `.env.example` files |
| Gates on every BUY | Platform halt → Shariah gate (mode ON) → Bot HMAC → Bot halt/risk → Bot Shariah floor → exchange. SELL is never blocked by halt or Shariah. | TESTED (Platform `manualHalt`, `shariahGate`; Bot `tpslHalt`, `shariahEnforcement`) |
| If the Bot is down | Ticket reads show an honest "unavailable" state; orders fail with a named 502. Nothing is queued on the Platform. | TESTED (`manualTrading.test.ts`) |

**3Commas** is a different thing: a *delivery mode* for automated deployments that posts the
signal to 3Commas' webhook instead of the Bot. It passes the Platform's halt and Shariah gates but
**not** the Bot's gates, has no deduplication beyond 3Commas' own, no Bot-managed protection, and
produces no Journal realization rows. Reference: [ARCHITECTURE.md](ARCHITECTURE.md),
[WEBHOOK-CONTRACT.md](WEBHOOK-CONTRACT.md), Bot `README.md`.

---

## 5. Journal — what the records mean

Open **Journal** (administrator). Filters: From/Through (UTC dates, ≤ 366 days), Source (Manual /
Automated / Paper), Symbol, Summary period.

| Row source | Comes from | P&L / fees |
|---|---|---|
| AUTOMATED | Realization events the Bot signs and delivers for custom-delivery deployments, plus deployment activity the Platform persisted | **Modeled** (0.1 % buy + 0.1 % sell), labelled as such; not exchange-observed |
| MANUAL | One bounded read of the Bot's current manual-order state | Activity only; economics **Unknown** (manual BUY and SELL are never paired) |
| PAPER | Simulated fills of paper deployments | Exact paper accounting, kept separate from real |

"Unknown" means the record exists but cost basis or commission evidence does not; it is never
shown as zero. An empty period now says so and explains what feeds the Journal; an installation
with manual trading switched off now says that instead of "the state read failed". Evidence:
**TESTED** (`journal.test.ts`), **LOCAL UI VERIFIED** (empty state). Reference: [OPERATIONS.md](OPERATIONS.md) §1.

---

## 6. Backtester Optimizer (Research) — a complete journey, verified locally

Start (from the `research` checkout):

```bash
set -a; source <platform backend env file>; set +a   # DATABASE_URL + boot secrets, or AUTH_ENABLED=false
PLATFORM_BACKEND=<…>/platform/platform/backend python3 -m backtester --port 8765
```

**The controller needs the Platform backend's full environment**, because its read-only data
check and every run execute the Platform's own engine and candle reader. Started without it, the
preflight data check failed with a generic message; since this campaign it names the real cause
and this next step (finding E1). Candles are never downloaded by the Backtester: prepare them on the
Platform (`POST /api/data/backfill`) for **every feed the strategy needs** — `mtf_lean` reads
5m/15m/1h/4h-class feeds, not only the chart timeframe, and the coverage check inspects only the
chart timeframe and says so.

| Step | Choices you get | Evidence (2026-11-01) |
|---|---|---|
| New Run | 15 registered trees (5 current, 10 historical / not-comparable), Stage, run name, Shariah Mode pin (Off / On = ELIGIBLE-only from an imported snapshot), coin selection (tick list or paste), evaluation budget per symbol (Search) or candidate replay limit (Replay), frozen dates from the tree, resource profile (1 / half / all CPUs or exact count) | LOCAL UI VERIFIED |
| Preflight | What will run, exact frozen dates, read-only stored chart-feed coverage check, frozen market assumptions, engine/controller fingerprints, warnings | LOCAL UI VERIFIED |
| Create → Start | Immutable manifest; Start refuses if tree inputs or the Platform commit changed since creation ("clone a new run") | LOCAL UI VERIFIED (both the refusal and a normal start) |
| Search run | `lean_optimizer15m`, ZECUSDT, 50 evaluations: completed 50/50 in 5 s, best candidate score 4.86 (net +12.2 %, drawdown 2.9 %, 58 trades) | LOCAL UI VERIFIED — after fixing E4: in a fresh checkout every evaluation failed because the tree's `results/` folder did not exist, and the run honestly said *Completed — no results* |
| Stress ("Test candidates in bad periods") | Choose a coin and up to 10 candidates; find periods by largest decline / deepest drawdown / most volatile on daily, 4h or 1h stored candles, period length, count, search range; adjust or add periods; save a frozen study; Start; result table shows each candidate's return/drawdown/trades beside the market's own return/drawdown per period | LOCAL UI VERIFIED (1 candidate × 3 periods; market −51 %/−51 %/−39 % vs strategy −0.7 %/−0.3 %/+0.2 %) |
| History & Results, Experiments, Tree Definitions, Settings, How it works | run history with clone, experiments comparison, immutable custom definitions, in-product guide | SOURCE-IMPLEMENTED; UI tests exist (`research/tests/*.test.mjs`) |

Interpretation limits the product itself states: a Search result is not validation; Stress dates
are chosen with hindsight so it is not untouched Holdout; Walk-forward / Replay / Holdout are a
progression, not a pipeline; historical trees are not comparable with current ones.
Reference: `research/docs/BACKTESTER-CONTROLLER.md`, `research/README.md`.

## 7. Compute Helper — verified end to end on one Mac

Supported job: exactly one — `full3y1h` replay, one symbol per work unit, topN = 1. Search,
Walk-forward, Holdout, custom definitions and other replays stay on the coordinator Mac.

Journey (every step was exercised in the browser on 2026-11-01, with the helper and the
coordinator on the same Mac): helper page (`python3 -m backtester.compute_helper run`, :8877) →
*Name this Mac* creates its identity → coordinator *Distributed Compute → Add a Mac* (identity,
pairing block, approve the helper's certificate with the fingerprint shown first, enable the
listener, restart once) → paste the pairing block on the helper, confirm the fingerprint → *Helping
ON* → *Connection connected* → `compute-helper.sh set-execution …` → *Able to run work: Yes* →
New Run with the helper-compatible replay preset → *Start distributed run* → the helper took the
unit and the coordinator accepted its result (1/1 accepted, attributed to the helper). The helper
first offered **0 capacity because macOS Low Power Mode was on** and said so; unticking *Pause in
Low Power Mode* under the helper's safeguards released the slot. *Drain* and *Helping OFF* stop new
work; a running job finishes.

Honest gaps: a **second physical Mac was not available**, so the private-network address step
(step 2 on the coordinator page) was left at loopback; after all distributed work is accepted the
run header still reads *Ready to start · 0/1* while the Distributed panel (marked authoritative)
reads 100 % (noted as E5). Reference:
[FINAL_SYSTEM_GUIDE_COMPUTE_HELPER_2026-10-11.md](FINAL_SYSTEM_GUIDE_COMPUTE_HELPER_2026-10-11.md).

## 8. Chart workstation, Screener, alerts, Quick Backtester

- **Chart**: symbol search, timeframes 1m–1d plus derived resolutions, chart styles, indicators
  (shipped Pine library + your scripts), 25 drawing tools, layouts, watchlists with live prices,
  Bar Replay, Compare. **LOCAL UI VERIFIED** (loads with live data through the Binance market-data
  mirror; first-run default is SOLUSDT 15m with four indicator panes). Ordinary accounts no longer
  see the administrator's trading, tester, automation and overlay controls (§2).
- **Quick Backtester** (*Research → Quick backtest*, administrator): shipped strategies
  `ma_rr_v9`, `srtrend_v10`, `mtf_lean`; tracked Binance Spot symbols; 1s–1d; dates; capital;
  commission % per fill; slippage ticks; validation window 10–50 %; fixed-cash or %-of-equity
  sizing; every strategy parameter. **LOCAL UI VERIFIED**: ZECUSDT 15m, 2026-08-01→11-01, done in
  about ten seconds; the result page shows headline metrics, development/validation windows, an
  honest affordability note (entries the account could not pay for are counted and skipped),
  equity/drawdown curve, trades on the chart and as a list, CSV export, *Stress this run*, *Edit
  and re-run*. The chart's *Strategy Tester* tab does the same for Pine strategies. Reference:
  [FINAL_SYSTEM_GUIDE_BACKTESTER_2026-10-11.md](FINAL_SYSTEM_GUIDE_BACKTESTER_2026-10-11.md).
- **Screener**: needs the separate Python scanner service (`platform/screener/start.sh`, FastAPI on
  :8000, `ccxt` against Binance). Without it the page shows an honest *Scanner service
  unavailable* notice with Retry; the chart, alerts, trading and Journal do not depend on it.
  **NOT RUN** during the campaign (the service talks to `api.binance.com`, which answers HTTP 451
  from this network). Reference: `platform/screener/README.md`.
- **Alerts**: seven condition families, trend gates, four frequency modes; armed end to end
  through the API and browser in earlier QA, but no live market event has been observed firing
  ([OPERATIONS §6](OPERATIONS.md)). Reference: [ALERTS.md](ALERTS.md).

## 9. What still needs the owner, real services or hardware

| Item | Why it is open |
|---|---|
| Binance testnet / live manual order | No credentials in this workspace; never run. The fake-adapter and HMAC paths are tested on both sides. |
| Exchange-native stops | Adapter exists, no call sites, needs the five testnet checks in `bot/backend/src/services/exchangeStops.ts`. |
| Production Shariah mode, `ALLOW_SIGNUPS`, 3Commas deployments | Production database state, not visible here. |
| Google sign-in round trip | Needs real OAuth client configuration. |
| Second Mac for Compute Helper | Not available; one-Mac loopback pairing and execution verified. |
| Scanner service | Not run (network); honest unavailable state verified. |
| Policy decision | Whether a Platform with no Bot control channel may show Shariah Mode ON (today: yes, with *Bot floor: not armed* disclosed). |
