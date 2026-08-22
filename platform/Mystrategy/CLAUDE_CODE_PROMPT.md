# Build Prompt — Multi-Timeframe Confluence Spot Strategy (Pine Script v6)

You are building a **single, self-contained Pine Script v6 `strategy()`** for TradingView. Everything below is the spec. Read the whole document before writing any code.

---

## 0. Inputs you have in this folder

| File | Contents |
|---|---|
| `all Indicators pine code.rtf` | Source of all 9 indicators. Convert with `striprtf` or `textutil -convert txt` before reading. |
| `Screenshot 2026-08-10 at 4.58.13 AM.png` | ZECUSDT 5m chart showing the target visual output — all overlays, panel layout, label styles. |

**Indicators present in the RTF, in file order:**

1. `Supertrend` — v4, Everget-style ATR trailing stop
2. `Support and Resistance (High Volume Boxes) [ChartPrime]` — v5, "SR Breaks and Retests"
3. `Liquidity Sweeps [LuxAlgo]` — v5
4. `Pivot Point SuperTrend` — v4, LonesomeTheBlue
5. `Buyside & Sellside Liquidity [LuxAlgo]` — v5
6. `Supply and Demand Visible Range [LuxAlgo]` — v5
7. `Pivot Points High Low & Missed Reversal Levels [LuxAlgo]` — v5
8. `Bollinger Bands` — v6, TradingView built-in
9. `Relative Strength Index` (with divergence) — v6, TradingView built-in
10. `Volume Flow Indicator [LazyBear]` — v4 (labelled "VFI_LB" on the chart)

Ports 1, 4, and 10 are **Pine v4** and 2, 3, 5, 6, 7 are **v5**. All must be migrated to v6.

---

## 1. What the strategy does — plain statement

Spot, **long only**. No shorts, ever. Three timeframes, each with a distinct job:

- **1H — regime gate.** Is the market in a condition where longs are worth taking at all?
- **15m — structure and location.** Is price at a level where a long has a defined invalidation point?
- **5m — trigger.** Fire the entry.

The 5m trigger is only evaluated when the 1H gate is open. Stop loss comes from **15m structure**, never from the 5m chart.

---

## 2. Non-negotiable technical constraints

Read this section carefully. Several of these will silently destroy the backtest if ignored.

### 2.1 Multi-timeframe data must not repaint

Every higher-timeframe value is fetched with `request.security()` using **`lookahead = barmerge.lookahead_off`** and read from the **previous completed HTF bar**. Use this exact helper pattern:

```pinescript
// Returns the value of `expr` from the last CLOSED bar of timeframe `tf`.
// barmerge.lookahead_off + [1] offset = no repaint, matches live behaviour.
f_htf(simple string tf, series float expr) =>
    request.security(syminfo.tickerid, tf, expr[1], lookahead = barmerge.lookahead_off)
```

Do **not** use `lookahead_on` anywhere. Do **not** read the in-progress HTF bar for any signal condition. The only acceptable exception is purely cosmetic plotting, and if you do that it must be behind an input named `Plot Live HTF (visual only)`, default `false`, with a comment saying it is not used in logic.

### 2.2 `request.security()` call budget

TradingView caps a script at **40 `request.security` calls**. This strategy needs 1H and 15m data for many series. **Bundle every value from one timeframe into a single call using a tuple or a UDT**, not one call per value.

```pinescript
[h1_trend, h1_rsi, h1_vfi, h1_sup, h1_res, ...] = request.security(syminfo.tickerid, "60", [ ... ], lookahead = barmerge.lookahead_off)
```

Target: **≤ 4 total `request.security` calls** in the finished script (one per timeframe, plus at most one spare). Compute everything inside the security expression, not outside it.

### 2.3 Drawing object limits are per-script, not per-indicator

Pine caps a script at **500 boxes, 500 lines, 500 labels total**. Six of these indicators draw boxes and lines. Merged naively, the script will hit the cap and silently stop drawing (or throw).

Mitigations, all required:
- Declare `max_boxes_count = 500, max_lines_count = 500, max_labels_count = 500` in `strategy()`.
- Give **every** visual component its own `input.bool` show/hide toggle, grouped by indicator. Default the heavy ones **off** (`Buyside & Sellside Liquidity`, `Pivot Points HL`, `Supply & Demand`) so the script is usable out of the box.
- Add an input `Max Historical Bars For Drawings` (default 500). Guard every drawing block with `if last_bar_index - bar_index <= maxDrawBars`. Signal logic must run on all bars; only *drawing* is limited.
- Delete stale objects. Every array of boxes/lines needs an eviction path — `array.shift()` + `.delete()` when over its own per-component cap.

### 2.4 Execution time

`Supply and Demand` uses nested loops over intrabar data and is the single most expensive component. `Buyside & Sellside Liquidity` uses `max_bars_back = 3000`. Combined, the script may exceed the 20s compile / per-bar execution budget.

- Wrap the Supply & Demand calculation so it only recomputes on **`barstate.islast`** or on a fixed interval, not every bar.
- Set `max_bars_back` explicitly and as low as the logic tolerates (start at 1000, raise only if you hit "bar index too far" errors).
- If the script won't compile, report back with the specific error rather than silently dropping a component.

### 2.5 Supply & Demand must be rewritten as fixed-lookback

**This is a required change, not optional.** The original `Supply and Demand Visible Range [LuxAlgo]` derives its zones from `chart.left_visible_bar_time` / `chart.right_visible_bar_time` — i.e. from what is currently on screen. It recalculates when the user pans or zooms. A strategy built on it produces backtest results that change on every reload and cannot be evaluated bar-by-bar.

Rewrite it to use a **fixed rolling lookback window**:
- Replace the visible-range bounds with a `Supply/Demand Lookback Bars` input (default `300`, on the 15m timeframe).
- Keep the volume-profile bin logic, the `Threshold %` and `Resolution` inputs, and the supply/demand/equilibrium outputs.
- The intrabar `request.security_lower_tf` call is expensive and adds another security call — replace intrabar volume distribution with **bar-level volume allocated across the bins the bar's high–low range spans**. Document this simplification in a code comment.
- Expected outcome: zones will be close to but not identical to the user's current chart. That is acceptable and expected; note it in the code header.

### 2.6 Pivot-based signals are confirmed late

`ta.pivothigh(left, right)` / `ta.pivotlow(left, right)` confirm a pivot only `right` bars **after** it forms. This affects Liquidity Sweeps (`Swings = 5`), Pivot Point SuperTrend (`prd = 2`), ChartPrime SR, and Pivot Points HL.

Do **not** try to remove this lag with `offset` tricks or `lookahead`. It is real. Instead:
- Expose the `left`/`right` lookback as inputs so the user can tune the lag/reliability tradeoff.
- Add a code comment at each pivot call stating the confirmation delay in bars and minutes at that timeframe.
- Add an input `Max Bars Since 15m Signal` (default `12`) — a 15m structural condition only counts as "active" if it confirmed within this many 15m bars. Prevents entering on a sweep that happened six hours ago.

### 2.7 Namespace collisions

Merging nine scripts means duplicate identifiers (`len`, `src`, `atr`, `up`, `dn`, `trend`, `center`, `per`, `div`, `mode`, `n`). **Prefix every variable and input by its source component**: `st_`, `sr_`, `ls_`, `ppst_`, `bsl_`, `sd_`, `pp_`, `bb_`, `rsi_`, `vfi_`. No exceptions — silent shadowing here produces wrong signals that look plausible.

---

## 3. Signal specification

### 3.1 1H — regime gate

All values from the **last closed 1H bar**.

| # | Condition | Source | Default |
|---|---|---|---|
| G1 | Supertrend direction is bullish (`st_trend == 1`) | Indicator 1, on 1H | ON |
| G2 | RSI(14) > 50 | Indicator 9, on 1H | ON, threshold input `H1 RSI Threshold` = 50 |
| G3 | VFI > 0 | Indicator 10, on 1H | ON |
| G4 | Price is above the nearest 1H support, or within `X ATR` of it | Indicator 2 (ChartPrime SR) on 1H | OFF by default |

- **G1–G3 are hard gates.** If any enabled hard gate is false, no entry is evaluated at all. Do not fold these into the score.
- **G4 is a soft gate** contributing to the score (see §3.4).
- Each gate gets its own `input.bool` so the user can disable it.
- Port VFI from v4 faithfully: `iff` → ternary, `stdev` → `ta.stdev`, `sma` → `ta.sma`, `log` → `math.log`, `sum` → `math.sum`. Keep `length = 130`, `coef = 0.2`, `vcoef = 2.5`, `signalLength = 5`. **Note:** VFI with `length = 130` on 1H needs ~130 closed 1H bars of warmup. Guard the gate with a `bar_index > warmup` check so early bars don't produce garbage entries.

### 3.2 15m — structure and location

All values from the **last closed 15m bar**. Each of these produces (a) a boolean "condition met recently" flag and (b) **a price level to be used as the stop loss candidate**.

| # | Condition | Stop level it produces |
|---|---|---|
| S1 | Bullish liquidity sweep confirmed within `Max Bars Since 15m Signal` (Indicator 3, `Only Wicks` mode) | Low of the swept wick |
| S2 | Price is inside or just above a 15m **demand** zone (rewritten Indicator 6) | Bottom edge of the demand zone |
| S3 | Price is at or above a 15m **support** box (Indicator 2 ChartPrime) | Bottom edge of the support box |
| S4 | 15m Supertrend is bullish (Indicator 1) | Supertrend line value |
| S5 | 15m Pivot Point SuperTrend is bullish, `Trend == 1` (Indicator 4) | `Trailingsl` value |
| S6 | Price above nearest **sellside liquidity** level, i.e. resting liquidity below (Indicator 5) | Sellside liquidity level |
| S7 | Price above the last confirmed 15m pivot low (Indicator 7) | That pivot low |

Every one of S1–S7 is toggleable and weighted (§3.4).

### 3.3 5m — entry trigger

Evaluated **only on 5m bar close** (`barstate.isconfirmed`) and **only when the 1H hard gates pass and the 15m score clears the threshold**.

Trigger modes, via `input.string("Bollinger Reclaim", "5m Entry Trigger", options = [...])`:

1. **`"Bollinger Reclaim"`** *(default)* — close crosses back **above** the lower Bollinger band after having closed below it within the last `N` bars (`5m BB Reclaim Lookback`, default 3). BB defaults: length 20, SMA, source close, mult 2.0.
2. **`"Bollinger Basis Cross"`** — close crosses above the BB basis (middle band).
3. **`"Supertrend Flip"`** — 5m Supertrend flips from bearish to bullish (`st_trend == 1 and st_trend[1] == -1`).
4. **`"BB + Supertrend (both)"`** — trigger 1 AND the 5m Supertrend is already bullish. Strictest.

Add an optional confirmation input `Require 5m Supertrend Bullish` (default `true`) applied on top of whichever trigger mode is selected.

### 3.4 Scoring engine

Build a scoring system, not a hard AND chain.

```pinescript
// Each filter: [enabled?, condition, weight]
score = 0.0
score += (useS1 and s1_ok ? wS1 : 0.0)
score += (useS2 and s2_ok ? wS2 : 0.0)
// ... etc for S3–S7 and G4
maxScore = (useS1 ? wS1 : 0.0) + (useS2 ? wS2 : 0.0) + ...
```

- Each filter gets an `input.float` weight, default `1.0`, in a group `Confluence Weights`.
- `Entry Score Threshold` — `input.float`, default `4.0`.
- `Threshold Mode` — `input.string`, options `["Absolute", "Percent of Max"]`, default `"Percent of Max"` with a `Score Threshold %` input default `60`. Percent mode keeps the threshold meaningful when the user toggles filters off.
- **Entry fires when:** all enabled 1H hard gates pass **AND** `score >= threshold` **AND** the 5m trigger fires on a confirmed bar **AND** `strategy.position_size == 0`.
- Plot the current score in a `table` in the top-right corner (see §6), with each contributing filter listed as ✓/✗. This is the single most important debugging affordance in the script — build it properly.

---

## 4. Risk management

### 4.1 Position sizing

```pinescript
strategy("MTF Confluence Spot Strategy",
     overlay              = true,
     default_qty_type     = strategy.cash,
     default_qty_value    = 1000,
     initial_capital      = 10000,
     currency             = currency.USD,
     commission_type      = strategy.commission.percent,
     commission_value     = 0.1,
     slippage             = 2,
     pyramiding           = 0,
     calc_on_every_tick   = false,
     process_orders_on_close = true,
     max_boxes_count = 500, max_lines_count = 500, max_labels_count = 500)
```

- `Trade Amount (USDT)` input, default `1000`, feeding `strategy.cash`.
- Add a `Sizing Mode` input: `["Fixed USDT", "Risk % of Equity"]`. In risk mode, quantity = `(equity * riskPct/100) / (entry - stop)`. Default to `"Fixed USDT"` at 1000 to match the user's stated default.
- Spot only — **never** call `strategy.entry` with `strategy.short`. Add an assertion comment.
- Commission and slippage defaults above are deliberately non-zero. A 5m strategy with zero costs backtests as profitable when it isn't. Do not set them to zero.

### 4.2 Stop loss

Input `Stop Loss Source` — `input.string`, options:
- `"Nearest 15m Structure"` *(default)* — of all **enabled and currently active** 15m stop candidates from §3.2, take the one **closest below entry price**. Tightest valid stop.
- `"Furthest 15m Structure"` — the lowest of the active candidates. Widest, most room.
- `"15m Liquidity Sweep Low"` — S1's level specifically.
- `"15m Demand Zone Bottom"` — S2's level specifically.
- `"15m Support Box Bottom"` — S3's level specifically.
- `"ATR"` — fallback, `entry - (atrMult * ta.atr(len))` on 15m.

Then:
- `SL Buffer (ATR mult)` input, default `0.25` — stop is placed this many 15m ATRs **below** the chosen structural level, so it sits beyond the wick rather than on it.
- `Min Stop Distance %` input, default `0.3` — if the computed stop is closer than this to entry, either widen to the minimum or skip the trade, controlled by `On Too-Tight Stop` = `["Widen", "Skip Trade"]`.
- `Max Stop Distance %` input, default `3.0` — if the structural stop is further than this, **skip the trade**. Prevents the "nearest structure is 8% away" catastrophe.
- If no structural level is available, fall back to ATR and log it.
- **The stop level must be captured and frozen at entry time** into a `var float` — recomputing it as structure moves will make the backtest inconsistent and the stop crawl.

### 4.3 Take profit — R:R, partials, and trailing

Risk `R = entryPrice - stopPrice`. All targets are expressed in R.

**Partial TPs** (`Enable Partial Take Profit`, default `true`):

| Leg | Input | Default R | Default % of position |
|---|---|---|---|
| TP1 | `TP1 R Multiple` / `TP1 % of Position` | 1.0 | 40 |
| TP2 | `TP2 R Multiple` / `TP2 % of Position` | 2.0 | 30 |
| TP3 / runner | `TP3 R Multiple` | 3.0 | remainder (30) |

Validate at runtime that TP1% + TP2% ≤ 100 and `runtime.error()` with a clear message if not.

**Implementation notes — this is where Pine bites:**
- Use **separate `strategy.exit()` calls with distinct IDs** for each leg, each with its own `qty_percent`, all attached to the same entry ID. Do not attempt to reuse one exit ID.
- `qty_percent` is a **percentage of the position remaining at the time the exit executes**, not of the original position. If the user asks for 40/30/30 of the *original* size, you must convert: leg 2 must be `30/(100-40) = 50%` of remaining, leg 3 is the rest. **Add an input `Partial % Basis` = `["Original Position", "Remaining Position"]`, default `"Original Position"`, and do the conversion math explicitly with a comment showing the arithmetic.** Getting this wrong is the most common bug in partial-TP Pine strategies.
- Every leg's `strategy.exit` must also carry the stop, otherwise the unclosed remainder ends up unprotected.

**Break-even** (`Move Stop To Break-Even After TP1`, default `true`): once TP1 fills, move the stop to `entry + (beOffsetR * R)` where `BE Offset (R)` defaults to `0.1` (slightly in profit, covering fees).

**Trailing take profit** (`Enable Trailing Stop`, default `true`):
- `Trail Activation (R)` — default `1.5`. Trailing does not begin until price has reached this R multiple.
- `Trail Mode` — `["ATR", "Supertrend 5m", "Percent"]`, default `"ATR"`.
  - ATR: trail at `high_since_entry - (trailAtrMult * ta.atr(trailAtrLen))`, `trailAtrMult` default 2.0, `trailAtrLen` default 14, on 5m.
  - Supertrend 5m: trail at the 5m Supertrend line.
  - Percent: `high_since_entry * (1 - trailPct/100)`.
- The trailing stop is **monotonic** — it only ever moves up. Enforce with `trailStop := math.max(nz(trailStop[1], trailStop), newTrail)`.
- Trailing applies to the **runner leg only** by default (`Trail Applies To` = `["Runner Only", "Whole Position"]`).
- Implement trailing via a recomputed `stop` value passed to `strategy.exit` on each bar. Do **not** mix Pine's built-in `trail_points`/`trail_offset` with a manually computed stop on the same exit call — pick one mechanism and use it consistently. Prefer the manual computation; it is transparent and debuggable.

### 4.4 Additional exits

- `Exit On 1H Trend Flip` (default `false`) — close the whole position if the 1H Supertrend turns bearish.
- `Exit On 5m Supertrend Flip` (default `false`).
- `Max Bars In Trade` (default `0` = disabled) — time stop.

---

## 5. Code structure

Organize the file in this order, with clear banner comments:

```
1.  Header: strategy() declaration, description, attribution to original authors
2.  Inputs — grouped: Timeframes / 1H Gates / 15m Structure / 5m Trigger /
    Confluence Weights / Risk / Take Profit / Trailing / Visuals / Debug
3.  UDT definitions (piv, liq zone, bin, sr box, etc. — prefixed per component)
4.  Reusable functions:
      f_supertrend(), f_pivotSupertrend(), f_vfi(), f_srBoxes(),
      f_liquiditySweeps(), f_buysideSellside(), f_supplyDemand(),
      f_pivotPointsHL(), f_bollinger()
    Each takes explicit parameters — no reliance on globals. This is what lets
    the same function serve 1H, 15m and 5m.
5.  HTF data fetch — the ≤4 request.security() calls
6.  Local (5m) calculations
7.  Gate evaluation
8.  Score computation
9.  Entry logic
10. Stop / TP / trailing management
11. strategy.entry / strategy.exit calls
12. Drawing (guarded by toggles and bar limit)
13. Debug table
14. Alerts
```

**Attribution is mandatory.** LuxAlgo indicators are CC BY-NC-SA 4.0 and ChartPrime's is MPL 2.0. Include a header comment block crediting LuxAlgo, ChartPrime, LonesomeTheBlue, LazyBear, and TradingView, with the license names. Note in the header that CC BY-NC-SA is **non-commercial** — this script may not be sold or used in a paid product.

---

## 6. Visual output

Match `Screenshot 2026-08-10 at 4.58.13 AM.png` as closely as the object budget allows. Preserve each indicator's original colors, box styles, and label text so the merged script looks like the user's current chart.

Additionally:
- Plot the active stop loss as a red stepped line, and each TP level as a dashed green line, only while a position is open.
- Label the entry bar with the score that triggered it.
- **Debug table** (top-right, `Show Debug Table` default `true`):

| Row | Content |
|---|---|
| 1H Supertrend | ✓ Bull / ✗ Bear |
| 1H RSI | value, ✓/✗ vs threshold |
| 1H VFI | value, ✓/✗ vs 0 |
| S1 Liq Sweep | ✓/✗ + bars since |
| S2 Demand | ✓/✗ |
| S3 Support | ✓/✗ |
| S4 15m ST | ✓/✗ |
| S5 PP ST | ✓/✗ |
| S6 Sellside Liq | ✓/✗ |
| S7 Pivot Low | ✓/✗ |
| **Score** | `4.0 / 7.0 (57%)` — colored by pass/fail |
| Position | flat / long + entry, stop, R multiple, unrealised R |

---

## 7. Alerts

Use `alert()` with JSON-formatted messages suitable for webhook/bot consumption:

```json
{"action":"buy","symbol":"{{ticker}}","price":"{{close}}","qty":"...","sl":"...","tp1":"...","tp2":"...","tp3":"..."}
```

Separate alert conditions for: entry, TP1 fill, TP2 fill, TP3 fill, stop hit, trailing stop hit, and manual exit.

---

## 8. Delivery and validation

1. **Write the strategy to `MTF_Confluence_Spot_Strategy.pine`** in this folder.
2. **Write `README.md`** covering: what each input does, the recommended starting configuration, known limitations (pivot confirmation lag, S&D rewrite deviation from the original, spot-only), and a short "how to tune this" section.
3. **Self-review before declaring done.** Explicitly verify and report on each:
   - [ ] No `lookahead_on` anywhere
   - [ ] Every HTF read uses the `[1]` closed-bar offset
   - [ ] `request.security` call count ≤ 4 — state the actual number
   - [ ] No variable shadowing between merged components — state how you verified
   - [ ] Every drawing array has an eviction path
   - [ ] Partial TP percentage basis math is correct — show the arithmetic in the report
   - [ ] Stop loss is frozen at entry, not recomputed
   - [ ] Trailing stop is monotonic
   - [ ] No `strategy.short` calls
   - [ ] Commission and slippage are non-zero
   - [ ] All v4 syntax migrated (`iff`, `study`, `sma`, `atr`, `max`, `min`, `nz`, `crossover`, `input(type=)`, `transp=`)
4. **If the script exceeds Pine's compile or execution limits**, do not silently drop components. Report which limit was hit and propose a specific split (e.g. a companion indicator script for the heavy visual components, with the strategy consuming only the signal booleans).

---

## 9. Things to raise rather than guess

Stop and ask if you encounter any of these:

- A merged component behaves differently from its standalone version in a way you can't reconcile.
- The object or execution budget forces a real tradeoff between visual fidelity and signal completeness.
- Any 15m structural component cannot produce a usable stop-loss price level.
- The scoring threshold defaults produce zero trades or hundreds of trades on a normal ZECUSDT 5m backtest — report the trade count you observe.
