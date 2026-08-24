# MA+R:R Optimization System — Architectural Blueprint

<!-- doc-status -->
> **HISTORICAL — superseded on the cost model.** Written 2026-07-09. Its "one
> source of truth: 0.05 % commission, 2 ticks slippage, $1000 capital,
> $930/trade" was never what the trees ran. Measured from every
> `config.json`: **0.1 % per side**, 2 ticks (0 in `optimizer1y1h`), $1 000 or
> $10 000 initial capital, $1 000 fixed cash per trade. The design discussion
> below remains useful; the friction figures do not. See
> [docs/COST-MODELS.md](docs/COST-MODELS.md). (`X-09`)
>
> **Two of its three tiers no longer exist.**
>
> - **Tier 1**, `backtest-spot/`, is archived at
>   [research-archive/backtest-spot](research-archive/backtest-spot/ARCHIVED.md)
>   with six confirmed defects, including look-ahead in the higher-timeframe
>   alignment and an entry point that can never fire. (`TV-07`–`TV-12`)
> - **Tier 3**, `approach1_ui_automation/`, is **deleted**. It scripted a
>   password login to tradingview.com and never produced any output. Driving,
>   scraping or automating a TradingView account is outside what this system
>   does, and the ToS paragraph in §0 below is not a mitigation for it.
>   (`TV-01`)
> - **Tier 2**, `pine_sweeper/rr_param_sweeper.pine`, survives unchanged.
>
> Configuration search now happens in the thirteen registered TypeScript trees
> under `platform/backend/`, against stored Binance candles with a stated cost
> model. Read the tier diagram as a record of what was considered in July 2026,
> not as the pipeline.

Strategy under test: `ma_riskreward_strategy.pine` (SR+Trend v9 lineage, Pine v6).
Last updated: 2026-07-09.

---

## 0. Read this first — where each approach will lie to you

| Failure mode | Affects | Mitigation |
|---|---|---|
| **In-Pine simulator ≠ broker emulator.** Same-bar SL/TP ambiguity, partial-TP legs, and `strategy.exit` bracket semantics cannot be replicated exactly in script-space arrays. | Approach A | Use A only to **rank** parameter regions. Certify nothing from its table. |
| **Overfitting.** 4 swept params × 4 symbols × short windows = a curve-fit machine. Optimal values clustering at grid edges, <100 trades, or one-coin-only performance are disqualifying, not encouraging. | All tiers | Walk-forward: tune on window W1, verify untouched on W2. `backtest-spot` already splits `--data-*` vs `--test-*` — use it. |
| **UI-automation fidelity drift.** TV DOM selectors change monthly; scraped "N/A" silently poisons CSV/JSONL rows. | Approach B | v2 records `report_updated` flag + errors per row; treat any row with `report_updated=0` as suspect. |
| **ToS exposure.** Automated TradingView UI access is not sanctioned. | Approach B | Own account, low concurrency (≤2 tabs), jittered pacing. Accept the risk consciously or use the local engine. |
| **Friction mismatch.** Strategy header says 0.05% + 2 ticks; the briefing docs mention 0.075% and 0.1%. Any mismatch between tiers invalidates cross-tier comparison. | All tiers | One source of truth: **0.05% commission, 2 ticks slippage, $1000 capital, $930/trade** (the `strategy()` header). Sweeper inputs default to these; change all four places together. |
| **Regime blindness.** All tuning to date is on 2026 trending windows. A parameter set optimized there will degrade in ranging regimes — the choppy circuit-breaker mitigates but does not solve this. | Strategy itself | Keep NEAR May-2026 style ranging windows in every validation set. |

---

## 1. Three-tier architecture (search → rank → certify)

```
┌────────────────────────────────────────────────────────────────────┐
│ TIER 1 — BROAD SEARCH (thousands of evals, seconds each)           │
│   backtest-spot/  (existing)                                       │
│   Vectorized Python sim on Binance klines + Optuna/random search.  │
│   NOT Pine-parity. Output: results/best_<coin>.json (top ~15).     │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ top parameter REGIONS
┌──────────────────────────────▼─────────────────────────────────────┐
│ TIER 2 — ON-CHART RANKING (≤150 configs, one chart pass)           │
│   pine_sweeper/rr_param_sweeper.pine  (Approach A, new)            │
│   Parallel array-matrix simulator inside one Pine indicator.       │
│   Uses TradingView's own data feed → kills any data-source drift   │
│   between Tier 1 and TradingView. Leaderboard table on chart.      │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ top 3–5 configs per symbol
┌──────────────────────────────▼─────────────────────────────────────┐
│ TIER 3 — CERTIFICATION (dozens of evals, 10–25 s each)             │
│   approach1_ui_automation/tv_optimizer_v2.py  (Approach B, new)    │
│   Playwright drives the REAL Strategy Tester (authoritative broker │
│   emulator incl. partial TPs, bracket legs, intrabar assumption).  │
│   Output: results/best_<symbol>.json + 3Commas template merge.     │
│   Alternative: TradingView Desktop MCP (indicator_set_inputs +     │
│   data_get_strategy_results + batch_run) — same role, structured   │
│   API instead of DOM scraping; preferred when TV Desktop is up.    │
└────────────────────────────────────────────────────────────────────┘
```

Rule: **information only flows downward.** Never promote a config that skipped a tier.

---

## 2. Approach A — in-Pine "Parallel Array Matrix" sweeper

File: `pine_sweeper/rr_param_sweeper.pine`

### Why it is shaped the way it is (Pine v6 constraints)

1. **`strategy.*` is a singleton.** One script = one broker-emulator instance, so N
   configs require a hand-rolled fill simulator: 19 parallel typed arrays hold
   per-config state (pending/entry/stop/TP/trail/BE) and metrics (net, gross P/L,
   trades, wins, peak equity, max DD, loss streak, pause-until).
2. **`request.security` args must be simple.** MTF timeframes/lengths cannot vary
   per config. Consequence: the MTF context (1m×200, 1h×400, exit 4h×100, HL 15m×9)
   is computed **once per bar and shared**; only chart-TF execution params are swept
   (`rrRatio`, `rrSwingLb`, `rrBufAtr`, `rrTrailPct`). Security-call count is
   therefore constant — 4 calls total, independent of config count.
3. **`ta.*` state pollution in loops.** `ta.lowest(low, len)` called inside a
   per-config loop corrupts its internal series buffer (one call site, N calls/bar).
   The swing low is instead scanned manually via `low[i]` history references
   (`max_bars_back(low, 500)` set explicitly).
4. **Loop/memory budget.** 150 configs × ~25 ops/bar ≪ the 500 ms/bar loop budget;
   ~19 × 150 array elements ≪ the 100k ceiling. Guard input aborts above `maxCfg`.
5. **No lookahead.** All `request.security` calls use `lookahead_off`; all decisions
   evaluate on `barstate.isconfirmed`; entries fill at the **next bar open** with
   adverse slippage — matching the live strategy's confirmed-bar-close behavior.

### Fill model (deliberately conservative)
- Gap through stop → exit at open; else stop touched → exit at stop − slippage.
- Stop checked **before** TP on the same bar (broker emulator may be kinder).
- Break-even floors the stop at entry after +0.75R; % trail ratchets up only.
- Shared soft exits (below MA1, 4h MA crossunder, 15m HL break) close at bar close.
- Friction: 0.05%/side on notional, 2-tick slippage per fill, $930 fixed cash.

### Output
Sorted leaderboard table (top-right): rank, RR, SwLb, Buf, Trail%, Trades, WR%, PF,
Net$, MaxDD%. Rank metric selectable: `Net/MaxDD` (default), `Net $`, `Profit Factor`.

### Not modeled — validate in Tier 3
Partial TPs (TP1/TP2 + runner), session filter, adaptive TP, one-trade-per-signal
latch, profit-run limit, indicator SELL exits.

---

## 3. Approach B — Python + Playwright pipeline (v2)

File: `approach1_ui_automation/tv_optimizer_v2.py` (v1 kept as reference).

| Requirement | Implementation |
|---|---|
| UI engine | Playwright/Chromium, saved storage-state login (`--session`), per-symbol tab from one context |
| Input injection | **Label-text targeting** (`ParamSpec.label` must match the dialog exactly) with xpath sibling fallbacks; supports float/int/bool (checkbox) |
| Explicit waits | MD5 fingerprint of the Performance-Summary DOM text taken *before* OK; poll (300 ms) until it mutates, 25 s cap. No fixed sleeps in the hot path |
| Data extraction | Row-label scraping of Net Profit %, Max DD %, Win Rate, PF, Total Trades → floats via regex; `report_updated` fidelity flag per row |
| Optimization heuristics | `grid` / `random` / `ga` drivers behind one ask/tell interface. GA: pop 12, tournament-3, uniform crossover, 15% per-gene mutation, dedup cache |
| Objective | `net% − dd_weight × maxDD%`, hard-rejecting < `--min-trades` (default 8) or PF floor |
| Concurrency | `asyncio.gather` over symbols, `--max-tabs` semaphore (keep ≤ 2-3: each TV tab is CPU-heavy and TV throttles) |
| Resume | JSONL append per symbol (`results/runs_<sym>.jsonl`); drivers warm-start from cache |
| Export | `results/best_<symbol>.json`: top-K configs + objective + `3commas_alert_message_template.json` merged in |

### Runbook — REMOVED

The runbook that stood here exported `TV_USERNAME` and `TV_PASSWORD` and drove a
browser through a TradingView login. Both the runbook and the tool it drove are
deleted (`TV-01`). Nothing in this repository logs in to TradingView, and
nothing should be added that does.

### Realistic throughput math
~15 s/eval × 60 budget × 4 symbols ÷ 2 tabs ≈ **2 h**. That is why Tier 1 does the
broad search and this tier only certifies. A full grid (4×4×3×3×2 = 288/symbol)
through the UI is ~10 h of scraping — don't.

---

## 4. Promotion pipeline (per coin)

1. `backtest-spot/fetch_data.py` → `optimize_optuna.py` (or `optimize_v8.py`) — 500+
   trials on the full param space. Keep top 15.
2. Load `rr_param_sweeper.pine` on the coin's 5m chart; set sweep lists to bracket
   the Tier-1 winners (± one step). Read the leaderboard; keep top 3–5.
3. `tv_optimizer_v2.py --mode grid` with `PARAM_SPACE` reduced to exactly those
   3–5 configs → authoritative Strategy Tester numbers.
4. Walk-forward: re-run step 3 on an untouched later window. A config that drops
   >40% of its edge out-of-sample is rejected.
5. Apply `best_<symbol>.json → top_configs[0].params` to the live strategy inputs,
   attach the 3Commas alert (Order-fills-only), paper for ≥1 week.

## 5. Acceptance thresholds (reject below)

Profit Factor > 1.5 · Max DD < 20% · ≥ 30 trades in-sample (the 5m system trades
sparsely; treat <30 as directional only) · out-of-sample retention ≥ 60% of
in-sample net · no parameter pinned at a grid edge.
