# Trading Scene — Backtester: Final System Guide

Date: 2026-10-11 · Platform branch `finalization/mahamid-reconcile-premium-parity-20260918`
Authority: current source, tests and migrations. Where an older document disagrees, the code wins.

This guide explains what the user sees and what the implementation actually does. It is not
marketing copy. File paths are relative to `platform/` (backend) or `platform/frontend/` unless
stated.

---

## 1. Purpose and boundaries

The Platform Backtester answers one question: *what would this strategy, with these inputs, have
done over this window of real exchange history, if it could only take trades a spot account could
actually pay for?* It is the "quick historical check" inside Trading Scene. Parameter search,
genetic optimisation, walk-forward trees and distributed replay belong to the **Research
Backtester** application (separate `research` repository, see §15 and the Compute Helper guide).

Architecture rule that applies here, as everywhere: **Platform decides, Bot executes, Research
consumes canonical Platform semantics.** The Backtester never sends orders. It reads public market
data, simulates, and stores results.

## 2. Workflow at a glance

| Step | Screen / action | Implementation |
|---|---|---|
| CREATE | `/research` → *New backtest* form | `frontend/app/research/page.tsx`, `components/BacktestForm.tsx` |
| CONFIGURE | strategy, symbol, timeframe, dates, capital, commission, slippage, validation window, strategy parameters | `components/BacktestForm.tsx`, `lib/paramSchema.ts` (grouped inputs with min/max) |
| RUN | *Run backtest* → `POST /api/backtests` → row `queued` → worker claims → `running` → `done`/`error` | `src/api/routes/backtests.ts`, `src/api/backtestRequest.ts`, `src/engine/worker.ts`, `src/engine/backtester.ts` |
| UNDERSTAND | `/research/[id]` result page: headline, windows, equity, trades, run settings, engine corrections | `frontend/app/research/[id]/page.tsx`, `components/RunWindows.tsx`, `components/RunSettings.tsx`, `lib/backtestFigures.ts` |
| COMPARE | tick runs in *Recent runs* → *Compare* | `components/CompareRuns.tsx` (engine fingerprints compared, C-01) |
| VALIDATE | development in-sample / out-of-sample / validation rows on the result page | `src/engine/holdout.ts`, segment metrics in `src/engine/metrics.ts` |
| STRESS | *Stress this run* → `/stress?from=<id>` | `frontend/app/stress/page.tsx`, `src/engine/stress.ts`, `src/api/routes/stress.ts` |
| REPRODUCE | *Re-run with these settings*, *Edit and re-run*, *Copy link*, trades CSV | result page; refusal rules in `src/api/backtestReadTruth.ts` |

The Chart workstation also has a **Strategy Tester** tab under the chart (Pine strategies). It
uses the same broker and corrections through the Pine worker (§9).

## 3. Inputs the user controls

All are validated **before anything is queued**; a bad value is a `400` with a sentence the form
shows (`src/api/backtestRequest.ts`, `runSettingsProblem`, `paramsProblem`, `sizingProblem`).

| Input | Rule (current code) | Notes |
|---|---|---|
| Strategy | one of the shipped engine strategies: `ma_rr_v9` (MA + R:R, SR+Trend v9), `srtrend_v10` (SR+Trend Final v10), `mtf_lean` (MTF Confluence Lean) | `src/engine/strategies/*`; `engineDefaultParams(key)` supplies defaults |
| Symbol | Binance Spot instrument; displayed `BINANCE:SOL/USDT · SPOT`, stored canonically | §4 |
| Timeframe | 1m · 5m · 15m · 1h · 4h | |
| Start / end date | valid, `start < end`; the window may not begin after now nor end on a day that has not started (UTC) | "to today" with `T23:59:59Z` is allowed |
| Initial capital | finite, `> 0`, `≤ 1e12` | |
| Commission % per fill | finite, `0 … 5` | charged on **every fill** (entry and exit) |
| Slippage (ticks) | finite, `0 … 1000`; fractional ticks allowed | stored as `numeric` since migration **047** |
| Validation window | last 5 %–50 % of the range (UI offers 10–50 %; default 20 %) | `holdoutFraction` |
| Strategy parameters | each must be number/string/boolean; numbers finite; typed financial bounds: `qty_cash > 0`, `0 ≤ qty_pct_equity ≤ 100`, `rrRatio > 0` — **strings/booleans are refused for these** (PARAM-TYPE-BYPASS fix, `c0c3aa8`) | `qty_cash` is ignored when sizing by equity |

Position sizing is either a **fixed cash amount per entry** (`qty_cash`, the default — e.g. 930
of a 1,000 account) or **percent of equity** (`qty_pct_equity`, compounding). The form states the
consequence in plain words before the run: *"Each entry spends 930 of the 1,000 initial capital
(93%). After a loss the account may not afford the next entry; skipped entries are counted on the
result."*

## 4. Symbol / instrument identity

Instruments are identified by a canonical id
`instrument:v1:<VENUE>:<type>:<BASE>:<QUOTE>:<SETTLEMENT>:<series>` (migration 026/036/037,
`frontend/lib/instrument.ts`). Users see a ticker or the `BINANCE:SOL/USDT · SPOT` display form,
never the raw id (UI contract). Legacy tickers such as `SOLUSDT` are canonicalised on read. The
exchange tick size (`priceTick`), lot step and notional minimum come from the `symbols` table,
refreshed from Binance `exchangeInfo` (`syncExchangeFilters`). A symbol with no positive tick size
refuses to run.

## 5. Market data

`executeBacktest` (`src/engine/backtester.ts`) computes every feed a strategy needs (MTF
strategies need several intervals) and calls `ensureCandles(symbol, interval, from − warmup, to)`.
That backfills Binance public klines into the PostgreSQL `candles` cache. Integrity checks
(`src/data/candleIntegrity.ts`) report gaps; gaps are never filled or interpolated. A run reports
*window requested* and *window covered* separately. If the strategy cannot have warmed up
(`leanWarmupFloor`), it says so rather than trading on cold indicators. An optional finer feed
powers the *bar magnifier* (§7).

## 6. Order admission, available cash and MONEY-FEE

The broker (`src/engine/broker.ts`) emulates TradingView's Strategy Tester fill model for this
product's subset: **long only, one position at a time (pyramiding 0)**. Concurrent positions are
not implemented in the Platform engine.

On an entry signal at bar *i*'s close, the order fills at bar *i+1*'s open (or the signal bar's
close when the broker option `fillOnBarClose` — TradingView's "Process orders on bar close" — is set). Admission:

```
fillPx       = open + slippageTicks × tickSize          (adverse for a buy)
equity       = initialCapital + realizedNet              (flat when entering)
cash         = qty_cash                 or  equity × qty_pct_equity / 100
feeRate      = commissionPct / 100
if % sizing:   cash = min(cash, equity / (1 + feeRate))  (so the fee also fits)
requiredCash = cash × (1 + feeRate)                      (MONEY-FEE)
refuse if requiredCash > equity, cash ≤ 0, or not finite
qty          = cash / fillPx
entry fee    = fillPx × qty × feeRate
```

**MONEY-FEE (fee-inclusive affordability, correction `feeInclusiveAffordability`).** Before this
correction an entry was admitted when the *notional* fitted the account, even though the entry
commission then pushed spend above equity. That was an impossible spot trade. Now the notional
**plus its entry fee** must fit. A refused entry is recorded in `rejectedEntries` (bar, time,
required cash, equity), any bracket legs issued for it are discarded, and the result page says so
precisely. Example from this session's live run: *"This run could not have taken 2237 of its
entries. Each would have spent 931 while the account held less — 930.86 at the first…"*. The
correction is named in the result's provenance mapping (`296c78b`) and changes the engine
fingerprint.

**MONEY-FILL (impossible slipped fills, `2439d43`).** Slippage is applied against the trader:
`+slip` on buys, `−slip` on sells and stops. If a fill price after slippage is non-positive or
non-finite (for example a large tick slippage on a cheap asset), the broker **throws** —
*"Entry/Exit fill price must be positive and finite; check the price and slippage."* — and the
run ends `error`. A negative-price fill is never silently booked. The constructor also refuses
non-positive capital, negative commission or slippage, non-positive tick size and impossible
sizing.

## 7. Exits, proceeds and position accounting

- **Exit legs** (`strategy.exit` equivalents) are OCO limit+stop orders. Prices are rounded to the
  tick, and each leg is active from the bar after it was issued (`entryBarBrackets` governs
  same-bar activation).
- **Gap fills:** an open beyond the stop fills at `open − slip`; an open beyond the target fills
  at the open.
- **Intrabar order:** green bar open→low→high→close, red bar open→high→low→close
  (TradingView's heuristic). With `barMagnifier` and a finer feed, the real sub-bar path is
  walked instead, which shrinks the ambiguity to one sub-bar.
- **`executableCloseFills`:** under the executable live model, a protective touch is only
  knowable after the candle closes. A touched stop/target keeps its reason and intended trigger
  but fills at **that bar's close − slippage**, timestamped `closeTime + 1 ms` (the same decision
  boundary as `LiveRunner`).
- **Exchange filters (`exchangeFilters`):** leg quantities are floored to the lot step. A leg
  below one lot or the notional minimum is dropped and recorded in `rejectedLegs`; the position
  stays open, as on the exchange. **`lotDustExit`:** a remainder no exchange would let you sell
  is closed with the leg.
- **Proceeds and P&L per leg:**
  `pnl = (exitPx − avgPrice) × qty − exitFee − entryFee × (qty / entryQty)`. The entry fee is
  booked into `realizedNet` at entry; exit adds `(exitPx − avgPrice) × qty − exitFee`.
- **Equity** (mark to market): `initialCapital + realizedNet + qty × (price − avgPrice)`.
  Realised P&L is closed legs; unrealised is the open-position term. The equity curve stores
  points downsampled to ≤ 2,000 (`downsampleEquity`).

## 8. Metrics (formulas from `src/engine/metrics.ts`)

| Metric | Definition |
|---|---|
| Gross profit / loss | sum of positive / absolute negative leg `pnl` (net of commission per leg) |
| Net profit | `grossProfit − grossLoss`; **Net %** = `netProfit / initialCapital × 100` |
| Profit factor | `grossProfit / grossLoss`; `null` (shown —) when there is no loss |
| Scratches | `zeroPnlIsScratch`: a zero-P&L leg is neither win nor loss |
| Win rate | wins / **decided** trades (scratches excluded). The headline is per **entry**: an entry wins when its legs net positive (`entryFigures`). Leg-level figures are kept as `legWinRatePct` / `legProfitFactor` |
| Max drawdown | maximum `drawdownPct` along the equity curve (peak-to-trough % of the running peak) |
| Avg trade % | `netAvgTrade`: mean of `pnl / (entryPrice × qty) × 100`, **net of costs** (before BE-05 it was raw price change and overstated edge by the round-trip cost) |
| Trades | entries (legs shown separately); "< 100 = low sample" is flagged |

"Gross" in this product means *before subtracting losing legs*, not before fees: every leg figure
is already net of its own commission. Commission totals are shown separately (`comm 96.75`).

## 9. Pine integration and quarantine

Pine scripts (Chart → Pine Editor) run in a worker thread (`src/pine/runner.worker.ts`,
`runInWorker.ts`) with a time budget. Indicators never touch money. A **strategy** run with a
broker calls `assertCorrectedEngine()` first (PINE-QUARANTINE, `c0c3aa8`). Interactive strategy
metrics are new results, so they may not be produced under legacy or partial engine semantics.
Pure legacy `Broker` reproduction remains available to tests and diagnosis only. Unsupported Pine
visual constructs are listed explicitly and never replaced with a fake series.

## 10. Engine corrections and versioning

`src/engine/corrections.ts` names every engine correction:
`executableCloseFills, netAvgTrade, exchangeFilters, leanWarmupFloor, zeroPnlIsScratch,
assertSegmentValidity, entryBarBrackets, barMagnifier, lotDustExit, affordableEntries,
feeInclusiveAffordability`.

- Default (`ENGINE_CORRECTIONS` unset or `all`): all on. Fingerprint
  `engine:v2-corrected:<keys joined by +>` is stored on every row (`engine_fingerprint`).
- `ENGINE_CORRECTIONS=legacy-baseline|none` is **quarantined**:
  `engine:legacy-baseline:quarantined`. `assertCorrectedEngine()` refuses to produce new accepted
  work with any correction missing.
- Rows are never rewritten. `src/api/backtestReadTruth.ts` judges each stored row **at read
  time** against the current correction set and current request validators:
  - an *older engine* run gets an **"Older engine"** badge and is not called reproducible (C-02);
  - a run stored with settings today's validators refuse (legacy negative capital, etc.) gets
    **"Refused settings"**, and Re-run / Stress are disabled (C-07).

## 11. Development, validation and Stress windows — leakage prevention

`src/engine/holdout.ts` defines the window split. On the result page the **whole window** is one
simulation, divided by date into **Development · in sample** (first half of development),
**Development · out of sample** (second half) and **Validation** (last `holdoutFraction`, default
20 %). A trade belongs to the window that closed it. The page states plainly that the validation
window is **not withheld**: headline and equity include it. It is a check only if you did not tune
against it. For optimiser trees the module defines a frozen holdout that no selection step may
read, and the guard is a hard error (`assertWindowUsage`, `holdoutGate.test.mjs`).

**Stress windows** (`src/engine/stress.ts`) are found from **benchmark market data only**. The
module's functions take candles and a config; there is no parameter through which a trade or
metric can reach them (`stressWindows.test.ts` pins the signature). Windows are ranked by worst
return, deepest drawdown or highest volatility, at most 10, at least one window length apart. The
benchmark may differ from the traded symbol (a SOL strategy against BTC's worst stretches).
`STRESS_EPISTEMIC_NOTE` travels with every result: stress windows are chosen with hindsight and
are not out-of-sample evidence.

## 12. Stress linkage

*Stress this run* opens `/stress?from=<runId>` with the run's strategy, symbol, interval, capital,
costs and parameters fixed. `POST /api/stress/windows` previews windows. `POST /api/stress/runs`
creates the coordinator row **and** its child backtests atomically (one transaction, `2439d43`),
with merged parameters validated by the same rules as a backtest (`stressRequest.ts`). Children are
ordinary backtests marked with `stress_run_id` (migrations 042/044/046). They cannot be deleted
individually (the delete refuses), and the source-run link is `SET NULL` if the source is deleted.
The result table shows each window's benchmark move, target move, strategy %, drawdown and
entries, and records the discovery parameters ("Stored with the run, so the same windows can be
produced again").

## 13. Runs, history, CSV, filter, delete

- Statuses: `queued → running → done | error` (`repositories/backtests.ts`;
  `claimNextQueued` uses `FOR UPDATE SKIP LOCKED`; one job at a time per worker, 3 s poll).
  A `done` row with metrics but no trades is reported truthfully (`strategyNoEntry.test.ts`).
- *Recent runs*: text filter (symbol/strategy/status), status filter, compare checkboxes,
  **Delete** with confirmation (`DELETE /api/backtests/:id`; refuses `running` runs and stress
  children; trades cascade).
- Result page: *Copy link*, **trades CSV export**, *Re-run with these settings*,
  *Edit and re-run*.
- Endpoints: `GET /api/backtests`, `GET /api/backtests/:id`, `GET /api/backtests/:id/trades`,
  `GET /api/backtests/:id/parity`, `POST /api/backtests`, `DELETE /api/backtests/:id`.

## 14. Failure behaviour

| Situation | Behaviour |
|---|---|
| Invalid input (§3) | 400 before queueing, sentence shown on the form |
| Future window | refused before queueing |
| Data backfill failure / empty series | run ends `error` with the message; nothing fabricated |
| Impossible slipped fill | broker throws; run `error` (MONEY-FILL) |
| Entries the account cannot pay for | skipped, counted and explained (MONEY-FEE) |
| All entries skipped | headline explains why (`allEntriesSkippedReason`) |
| Legacy/partial engine requested | refused (`assertCorrectedEngine`) |
| Old row read today | badges, re-run/stress gating (`backtestReadTruth`) |

## 15. Relationship to the Research Backtester

The `research` repository (`backtester/`) is the full Backtester application: run controller,
optimisers, walk-forward trees, distributed production replay (`full3y1h`) and the coordinator for
**Compute Helpers**. It consumes canonical Platform semantics. The production executor
(`full3y1h_executor.py`) runs the Platform backend's own engine via Node, so the arithmetic above is
the arithmetic there. The execution fingerprint must match before a helper's result is accepted
(`execution_fingerprint.py`).

## 16. Database and migrations

Tables: `backtests` (settings, status, metrics JSON, equity curve, engine fingerprint, provenance,
segments, `stress_run_id`), `backtest_trades`, `stress_runs`, `candles`, `symbols`.
Relevant migrations: 018 (provenance), 038 (semantics provenance), 041 (segments and execution),
042 (stress runs), 044 (stress marker), 046 (stress source backtest), **047 (fractional slippage:
slippage columns `integer → numeric`)**. 047 is applied on the canonical dev database (verified in
the nonvisual closure). Other deployments must apply it through the normal migration runner
(`npm run migrate`) when separately authorised.

## 17. Test coverage (backend `platform/backend/tests`, frontend `platform/frontend/tests`)

`broker.test.ts` (fills, slippage, MONEY-FEE/MONEY-FILL red-first cases), `corrections.test.ts`,
`backtestRequest.test.ts` (every refusal incl. type bypass), `backtestReadTruth.test.ts`,
`backtestSegments.test.ts`, `segmentBoundary.test.ts`, `holdout.test.ts`, `holdoutGate.test.mjs`,
`backtestProvenance.test.ts`, `backtestContinuity.test.ts`, `strategyGolden.test.ts`,
`strategyNoEntry.test.ts`, `canonicalMultiAssetBacktester.test.ts`, `pine*.test.ts`,
`stressWindows.test.ts`, `stressRun.test.ts`; frontend `backtestFigures.test.ts`,
`stressCopy.test.ts`, DOM `researchResult.test.tsx`, `stressSurface.test.tsx`. Final counts are in
`FINAL_RELEASE_ACCEPTANCE_2026-10-11.md`.

## 18. Known limitations (honest)

- Long-only spot; no shorting, margin, futures funding, or concurrent positions in this engine.
- OHLC intrabar ordering is a heuristic unless a finer feed is available for the magnifier.
- Fixed-cash sizing can starve after losses; this is shown, not hidden. Use % of equity sizing
  for a compounding account.
- The validation window is a split of one simulation, not a withheld dataset.
- Stress results are hindsight robustness probes, never forecasts.
- Data source is Binance public klines; the venue's history and gaps are the limit.

## 19. Hypothetical end-to-end example (illustrative numbers, not a real result)

1. **Create.** On `/research`, choose *MA + R:R Strategy*, `BINANCE:SOL/USDT · SPOT`, 1h,
   2026-06-01 → 2026-09-01, capital 1,000, commission 0.1 %, slippage 2 ticks (tick 0.01),
   validation last 20 %, `qty_cash` 930.
2. **Run.** The request validates, a row is queued, the worker claims it, candles are backfilled
   with warm-up, the bar loop runs.
3. **First entry.** Signal at a close; next open 150.00 → fill 150.02. Required cash
   `930 × 1.001 = 930.93 ≤ 1,000` → admitted. `qty = 930 / 150.02 = 6.1992`; entry fee 0.93.
4. **Exit.** The stop at 146.00 is touched; with `executableCloseFills` it fills at the bar close
   146.40 − 0.02 = 146.38. Exit fee `146.38 × 6.1992 × 0.001 = 0.907`.
   `pnl = (146.38 − 150.02) × 6.1992 − 0.907 − 0.93 ≈ −24.40`. Equity ≈ 975.60.
5. **Next signal.** Required 930.93 ≤ 975.60 → admitted. After two more losses equity is about
   925. Required 930.93 > 925 → **skipped and counted** (MONEY-FEE). The result says how many and
   from when.
6. **Understand.** Headline net %, PF, drawdown, entries; development IS/OOS and validation rows;
   trades table with CSV export; run settings and engine fingerprint.
7. **Compare** with a run at `qty_pct_equity` 90 %. Compare shows both fingerprints match, so the
   figures are comparable.
8. **Stress.** *Stress this run* → BTCUSDT 1d, worst return, 3 windows → *Run the strategy through
   them* → per-window results with the epistemic note.
9. **Reproduce.** *Re-run with these settings* produces the same figures while the engine
   fingerprint is current. If the engine later gains a correction, the old run is badged "Older
   engine" instead of being silently relabelled.
