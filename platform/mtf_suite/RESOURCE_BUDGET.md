# Resource Budget — MTF Indicator Suite

Both scripts compile in the Pine Editor with **zero errors and zero warnings** (Pine v6),
and both run together on one chart. Verified on BINANCE:ZECUSDT, 2026-08-27/28.

## Caps (verified against current documentation)

| Resource | Cap | Source |
|---|---|---|
| Unique `request.*()` executions | **40** non-professional plan; **64** on Professional (Expert/Ultimate) for v6 | TradingView support: "The script executes too many unique `request.*()` function calls" |
| Plot outputs (`plot`, `plotshape`, `plotchar`, `fill`, `hline`, `bgcolor`, `barcolor`, `alertcondition`) | **64** per script | TradingView Pine limitations |
| `max_lines_count` / `max_labels_count` / `max_boxes_count` | **500** each (default 50) | TradingView Pine limitations |
| `max_polylines_count` | 100 | TradingView Pine limitations |
| Compiled tokens | ~100,000 (1,000,000 including imported libraries) | Pine limits reference |
| Indicators per chart | **2** on the account's Basic plan | observed directly ("You've applied 2 indicators — the maximum available on your plan") |

Uniqueness rule: a request is unique per **(context, expression, scope)**, and the limit counts
calls *executed*, not compiled call sites. One call site looping over 3 timeframes costs **3**.

## Script A — `mtf_overlay_suite.pine` (1281 lines)

| Resource | Cap | Compiled sites | Worst case executed | % of cap |
|---|---|---|---|---|
| `request.security()` | 40 | 16 | **21** | 53% |
| Plot outputs | 64 | 25 plot + 6 plotshape + 10 fill = **41** | 41 | 64% |
| lines | 500 | — | **~254** | 51% |
| labels | 500 | — | **~212** | 42% |
| boxes | 500 | — | **~30** | 6% |
| `alertcondition` | — | 0 (two `alert()` calls instead) | — | — |
| `lookahead_on` | — | **1** (Pivot Points only, audited) | — | — |

Worst-case requests: 8 MA slots + 3 Supertrend + 1 VWAP + 1 Pivots + 3 S&R timeframes
+ 3 Trendlines timeframes + 1 Bollinger + 1 Auto fib = **21**.

VWAP costs 10 plot outputs (line + 3 band pairs + 3 fills) and 1 request. The built-in's
Earnings / Dividends / Splits anchors were dropped: each is a separate `request.*()` call,
three more against the 40-call budget, and none fire on a crypto symbol.

### Drawing objects — MEASURED, not projected

The debug table (Engine → "Show drawing-object debug table") with **every module enabled** on a
1H chart, all at default caps:

| Module | lines | labels | boxes | cap |
|---|---|---|---|---|
| Pivots | 33 | 33 | 0 | 33/33/0 |
| S&R | 8 | 40 | 0 | 8/40/8 |
| Trendlines | 30 | 0 | 0 | 30/0/0 |
| Auto fib | 7 | 7 | 0 | 7/7/0 |
| **TOTAL** | **78** | **80** | **0** | **500 each** |

Auto Fib's cap rose to **12 lines / 11 labels** when the ZigZag anchor landed (2026-08-28): the
module now draws the built-in's 11 default levels plus the dashed zigzag leg, where the earlier
swing-anchored version drew 7. Measured total with everything on becomes **83 / 84 / 0** — still
17% of each pool. The module also creates up to 10 `linefill` objects between adjacent levels;
linefills are tied to their lines rather than to the 500-object pools, and the module deletes and
rebuilds its own on each redraw.

16% of the line pool and 16% of the label pool with everything on. Every module sits exactly at
its own cap, which is the eviction working rather than overflowing. Worst case with every input
cap maxed is bounded by design at ~254 / 212 / 30 — still under 500 on all three pools.

## Script B — `mtf_oscillator_suite.pine` (533 lines)

| Resource | Cap | Compiled sites | Worst case executed | % of cap |
|---|---|---|---|---|
| `request.security()` | 40 | 7 (4 module + 3 unused engine helpers) | **4** | 10% |
| Plot outputs | 64 | 15 plot + 3 hline + 2 fill = **20** | 20 | 31% |
| lines / labels / boxes | 500 | — | 0 / ≤1 / 0 | <1% |
| `lookahead_on` | — | **0** | — | — |

## Plan constraint

Script A and Script B together consume the entire 2-indicator allowance of the Basic plan. No
other indicator can share the chart with them.


## Per-chart indicator slots — read this before splitting panes

The account's plan allows **2 indicators per chart**. A separate pane costs a separate
indicator, so the pane layout you can actually run is:

| Layout | Slots used | Fits in 2? |
|---|---|---|
| Overlay suite + all four oscillators in one pane | 2 | yes |
| Overlay suite + MACD alone in its own pane | 2 | yes |
| MACD pane + RSI pane, no overlay suite | 2 | yes |
| Overlay suite + MACD pane + RSI pane | 3 | **no** |

Each extra pane is one more copy of the oscillator script with "Show" set to a single
module.
