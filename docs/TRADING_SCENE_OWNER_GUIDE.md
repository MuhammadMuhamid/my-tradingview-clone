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

## 6. Backtester Optimizer (Research) — first run, verified locally

Start: `cd research && set -a && source <platform backend env> && set +a && PLATFORM_BACKEND=<platform/backend> python3 -m backtester --port 8765`.
**The controller needs the Platform backend's full environment** (database URL and the boot
secrets, or `AUTH_ENABLED=false`), because its read-only data check runs the Platform's own
candle reader. Without it the data check fails with a generic message (campaign finding E1).

| Screen | Choices you get | Evidence |
|---|---|---|
| New Run | 15 registered trees (5 current, 10 historical / not-comparable), Stage, run name, Shariah Mode pin (Off / On = ELIGIBLE-only from an imported snapshot), coin selection (tick list or paste), evaluation budget per symbol, frozen dates from the tree, resource profile (1 / half / all CPUs or exact count) | LOCAL UI VERIFIED |
| Preflight | What will run, exact frozen dates, read-only **stored chart-feed coverage check**, frozen market assumptions, engine/controller fingerprints, warnings (e.g. dirty Platform worktree) | LOCAL UI VERIFIED |
| Run page | Start / queue with priority, status, progress, Events, Logs, Manifest, Results & artifacts, "Test candidates in bad periods" (Stress) | LOCAL UI VERIFIED (created + started) |
| Data | The Backtester **never downloads candles**. Prepare them on the Platform with `POST /api/data/backfill` for every feed the strategy needs — `mtf_lean` needs 5m/15m/1h/4h-class feeds, not only the chart timeframe; the coverage check only checks the chart timeframe and says so. | LOCAL UI VERIFIED: a run with only 15m data completed with 0/50 evaluations ("no 5m data"), reported honestly as *Completed — no results* |
| History & Results, Experiments, Tree Definitions, Distributed Compute, Settings, How it works | see the in-product guide | SOURCE-IMPLEMENTED; UI tests exist (`research/tests/*.test.mjs`) |

Stress ("bad market" testing): from a completed Search run, choose up to ten candidates and up to
ten difficult periods for one coin (auto-found by price decline, drawdown or volatility, or typed
in), frozen into an immutable Stress study; each candidate/period pair starts with fresh capital;
results sit beside the market's own return. Date selection uses hindsight, so Stress is **not**
untouched Holdout. Reference: `research/docs/BACKTESTER-CONTROLLER.md`, `research/README.md`.

---

## 7. Compute Helper

Supported job: exactly one — `full3y1h` replay, one symbol per work unit, topN = 1. Search,
Walk-forward, Holdout, custom definitions and other replays stay on the coordinator Mac.
Journey: *Distributed Compute → Add a Mac* on the coordinator → run the helper on the other Mac
(`python3 -m backtester.compute_helper run`, page on :8877) → pair → *Helping ON* with a resource
profile → progress on the run page → *Drain* / *Helping OFF* to stop safely.
Evidence: **TESTED** (Python fixtures on one machine: pairing, leases, presence, delivery, revocation).
**A real second Mac was not available during the campaign.** Reference:
[FINAL_SYSTEM_GUIDE_COMPUTE_HELPER_2026-10-11.md](FINAL_SYSTEM_GUIDE_COMPUTE_HELPER_2026-10-11.md).

---

## 8. Chart workstation, Screener, alerts, Quick Backtester

(Sections filled in as each area is walked; see the campaign checkpoint for progress.)

- **Chart**: symbol search, timeframes 1m–1d plus derived resolutions, chart styles, indicators
  (shipped Pine library + your scripts), 25 drawing tools, layouts, watchlists with live prices,
  Bar Replay, Compare. **LOCAL UI VERIFIED** (loads with live data through the Binance market-data
  mirror; first-run default is SOLUSDT 15m with four indicator panes).
- **Quick Backtester**: *Research → New backtest* (shipped strategies `ma_rr_v9`, `srtrend_v10`,
  `mtf_lean`; Binance Spot symbol; 1m/5m/15m/1h/4h; dates; capital; commission % per fill;
  slippage ticks; validation window 10–50 %; strategy parameters; fixed-cash or %-of-equity
  sizing) and the chart's *Strategy Tester* tab (Pine strategies). Reference:
  [FINAL_SYSTEM_GUIDE_BACKTESTER_2026-10-11.md](FINAL_SYSTEM_GUIDE_BACKTESTER_2026-10-11.md).
- **Alerts**: [ALERTS.md](ALERTS.md).
