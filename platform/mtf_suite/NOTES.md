# NOTES — MTF Indicator Suite

## Verified on live data (BINANCE:ZECUSDT, 2026-08-27/28)

Every number below was checked against an independent reference, not eyeballed.

| Check | Result |
|---|---|
| Calculations run in the REQUESTED context (spec §4.3) | 4H SMA20 through the engine wrapper = **805.3895**, identical to the known-good direct idiom. The wrong form (pull HTF close down, average on chart bars) gave **790.149**. |
| RSI port | **59.86** vs TradingView built-in RSI **59.86** — exact |
| ADX port | **19.8701** vs independent Wilder reimplementation **19.8701** — exact |
| VFI v2→v6 rewrite | **9.0766 / 7.3588** vs independent reimplementation of the v2 source **9.0765 / 7.3586** |
| Supertrend v4→v6 port | up **776.4634** / down **861.4195** / dir **1** vs independent reimplementation of the v4 source — exact |
| All modules on simultaneously | No runtime error, no silently dropped drawings. Debug table: 78 lines / 80 labels / 0 boxes against 500 each. |
| Drawing-object caps | Each module pinned exactly at its own cap — eviction working, not overflowing |
| Lower-timeframe guard | On a weekly chart the warning label correctly named all ten sub-chart modules: SMA 1 (240), SMA 2 (D), SMA 3 (240), EMA 1 (120), EMA 2 (240), EMA 3 (D), Supertrend 2 (240), Supertrend 3 (D), Trendlines TF2 (240), Trendlines TF3 (D) — and suppressed them |
| Pivots / S&R / Trendlines / Auto fib drawing | All render correctly, including HTF-anchored trendlines placed via `xloc.bar_time` |
| MACD port (added 2026-08-30) | Compiles clean. Verified offline against an independent EMA(12,26,9) reference on ZECUSDT 1H: macd **9.8205** / signal **6.5294** / hist **3.2911** on the last closed bar. Not observed rendering on chart — see below |
| VWAP port (added 2026-08-30) | Compiles clean. Not yet verified numerically or on chart |
| Auto fib ZigZag anchor (added 2026-08-28) | Compiles clean. Algorithm verified offline against 500 bars of ZECUSDT 1H: it selects the swing low **773.01** (2026-08-27 04:00) and the swing high **834.34** (2026-08-27 17:00) — both exact OHLC extremes of real bars, in the right order. On-chart rendering of the new anchor was NOT observed; see below |
| Both scripts compile | Zero errors, zero warnings |
| Both scripts run together | Confirmed, no error badges |

## NOT verified — two open items

**Repaint A/B test.** The check that a closed bar's value is byte-identical before and after a
chart refresh was not completed. TradingView's input plumbing kept serving a stale copy of the
study through the automation layer, so I could not reliably force an HTF module into a known
state and re-read it across a reload. What *is* established: the shift uses `expr[1]` with
`lookahead_off` (TradingView's documented non-repainting idiom), it is applied only when the
module's timeframe is genuinely above the chart's, and HTF values match independent references.
To close it by hand: set a module to 4H on a 1H chart, note the value on a closed bar, reload
the chart, and confirm the same bar reads the same.

**MACD and VWAP rendering.** Both compile and MACD's maths is verified against an
independent reference, but neither was observed drawing on the chart: TradingView stopped
rendering newly added study instances late in these sessions, including ones reporting
correct values in the data window. Turn them on and confirm against the numbers above.

**Auto fib ZigZag rendering.** The new anchor compiles and its pivot selection is verified
against real data (above), but I did not get the module to draw on the chart after the change —
TradingView stopped rendering newly added study instances late in the session, including ones
that were reporting correct values in the data window. The drawing code is unchanged in shape
from the version that was observed drawing correctly earlier (same pool, same `xloc.bar_time`
lines and labels); only the anchor maths moved. Turn the module on and confirm the levels match
the table below before relying on it.

Expected output on ZECUSDT 1H at the time of writing, Deviation 3, Depth 10:

| level | price |  | level | price |
|---|---|---|---|---|
| 0 | 834.34 |  | 1.0 | 773.01 |
| 0.236 | 819.87 |  | 1.618 | 735.11 |
| 0.382 | 810.91 |  | 2.618 | 673.78 |
| 0.5 | 803.67 |  | 3.618 | 612.45 |
| 0.618 | 796.44 |  | 4.236 | 574.55 |
| 0.786 | 786.13 |  | | |

## Defects found in my own code during verification, and fixed

1. **Confirm-on-close lagged chart-timeframe modules for nothing.** The `expr[1]` shift was
   applied unconditionally, so a module running on the chart timeframe was one bar stale even
   though there is no higher bar to wait for. Fixed with `engConfirm()`, which applies the shift
   only when the resolved timeframe is strictly above the chart's. Proof it worked: after the
   fix, the suite's RSI matches the built-in RSI exactly; before it, it was a bar behind.
2. **Pools kept dead handles.** S&R deletes its own drawings, but the pool was never told, so its
   counters drifted high and eviction could free handles that were already gone instead of live
   ones. The debug table reported 40 S&R labels where only 10 existed. Fixed with
   `engPool.release()`; the table now reports 6 lines / 10 labels for the same state.
3. **The zone cap was unfair to whichever timeframe was processed first.** Levels are unshifted
   per timeframe in handling order and the cap popped from the back, so the chart timeframe was
   always culled first — on a 1H chart with three timeframes enabled, every surviving level was
   weekly or daily. Fixed: the cap now evicts the OLDEST level by start time.
4. **S&R ignored the lower-timeframe guard entirely.** Every other module consults it; S&R
   pulled levels from below the chart timeframe regardless. Fixed, and confirmed: on a weekly
   chart the daily levels are now gone.

## Repaint characteristic, per module

The engine input **"Confirm HTF values on close"** (default ON) makes every higher-timeframe
request return the last *closed* value, so historical bars never change and a forming HTF bar
cannot mutate what is already drawn. The cost is up to one HTF bar of lateness. Modules on the
chart timeframe are unaffected either way.

| Module | Request | Repaint characteristic |
|---|---|---|
| SMA ×4, EMA ×4 | 1 per enabled slot, `lookahead_off` | Non-repainting with the toggle ON |
| Supertrend ×3 | 1 tuple per instance, `lookahead_off` | Non-repainting with the toggle ON. Flip markers use a rising edge on the HTF direction series — one marker per flip, on the chart bar where it becomes visible, not smeared across the HTF candle |
| Bollinger bands | 1 tuple, `lookahead_off` | Same as the MAs |
| Pivot points | 1 tuple, **`lookahead_on`** | Non-repainting in substance: `ta.pivot_point_levels()` derives the current period's levels solely from the COMPLETED previous period, so nothing about the future leaks. `lookahead_on` only makes those already-final levels appear from the first bar of the period instead of one HTF bar late. Inherited from TradingView's own built-in; approved as the single audited exception |
| Support & resistance | 1 per enabled timeframe, `lookahead_off` | Confirmation-only by construction — a level needs `srPivotLength` bars to confirm and all state updates are gated on `barstate.isconfirmed`. Ignores the confirm toggle for that reason. Levels are re-derived each confirmed bar, so a level can disappear if it stops qualifying |
| Trendlines | 1 tuple per timeframe slot, `lookahead_off` | A line cannot exist until its second pivot confirms, `tlLen` bars after the pivot happened — on a higher timeframe, `tlLen` HTF bars late. Inherent to pivot detection, stated in the source's own header. Lines never move once drawn |
| Auto fib | 1 tuple, `lookahead_off` | Redrawn on the last bar. The anchor swing moves when a new extreme forms, so levels shift — that is what "auto" means, and it is true of the built-in too |
| RSI, ADX, VFI | 1 tuple each, `lookahead_off` | Non-repainting with the toggle ON |

Every `request.security()` in both files carries `gaps = barmerge.gaps_off` and
`lookahead = barmerge.lookahead_off`, except the one Pivot Points call above.

## Defaults (set 2026-08-30 to match the supplied screenshots)

**Script A**
- Moving averages: all four SMAs OFF; EMA 21 white (w1), EMA 50 yellow (w2), EMA 100 green
  (w1), EMA 200 red (w2), all ON.
- Supertrend: ST1 on (10 / 3 / chart), ST2 and ST3 off, source (H+L)/2, ta.atr on, flip
  markers on, **highlight trend fill ON**.
- Pivot points: **ON**, type **Fibonacci**, anchor Auto, 3 sets.
- Support & resistance: **ON**, style **Zones**, **zone width 2**, TF1 chart only.
- Trendlines: **ON**, lookback 30, wicks, falling-high/rising-low only, extend right, TF1 only.
- VWAP: ON, Session anchor, hlc3, band 1 shown at 1.0 (green), bands 2 and 3 hidden.
- Bollinger bands and Auto fib: OFF, matching the screenshots.

**Script B**
- Lower-timeframe guard: **Fall back to chart timeframe**.
- RSI: ON, **length 50**, smoothing MA **EMA** (length 14), bands shown.
- ADX: ON, 14 / 14, +DI/-DI hidden.
- VFI: ON, 130 / 0.2 / 2.5 / 5, normalise on, window 500.
- MACD: ON, 12 / 26 / 9, EMA / EMA, blue line, orange signal, histogram on.
- Show: "All in one pane".

## One pane per oscillator

A Pine script draws into exactly one pane; there is no way to split one script's plots
across several. The oscillator script therefore has a **"Show"** input with options
`All in one pane / RSI only / ADX only / VFI only / MACD only`. Add the indicator twice
(or more) and set a different module on each copy — TradingView stacks them as separate
panes, which is the layout in the reference screenshot.

Two consequences worth knowing:

1. **Each pane costs an indicator slot**, and the plan allows 2 per chart. Overlay suite +
   one oscillator pane fits. Overlay suite + MACD pane + RSI pane does not.
2. **Normalisation switches off automatically in single-module mode.** VFI and MACD are
   rescaled to 0-100 only when sharing a pane with RSI and ADX. On their own they plot in
   native units with a true zero line, because the pane's scale belongs to them alone.

## Deviations from the source scripts

1. **Trendlines is a rewrite, not a port.** The v4 source stores pivots in a hand-rolled 3D
   dataframe of float arrays — machinery that exists only because v4 had no user types. Replaced
   by a typed record; behaviour preserved.
2. **A bug in the Trendlines source is not reproduced.** It deletes `trendline_low` in *both* its
   high-side and low-side eviction branches, so high-side lines are never freed.
3. **MTF trendline placement needed no bar-index mapping.** The spec flagged this as the build's
   highest risk. It does not arise: the source already draws with `xloc.bar_time`, so an HTF
   pivot's timestamp is directly a valid x-coordinate. Nothing is approximated.
4. **S&R gained caps the source lacks** — its level list is never pruned upstream and its
   `retestTimes` array is unbounded.
5. **S&R timeframe labels are built from seconds, not strings.** `timeframe.in_seconds()` takes a
   *simple* string, but a level's timeframe arrives as a *series* string from the requested
   context, so the level record carries its timeframe in seconds.
6. **Auto Fib now uses the ZigZag anchor** (ported 2026-08-28, replacing the earlier
   highest-high / lowest-low anchor). The algorithm matches the built-in: candidate pivots from
   `ta.pivothigh`/`ta.pivotlow` with `depth` bars each side; a same-direction candidate extends
   the leg when more extreme; an opposite-direction candidate is accepted only when the move
   exceeds `ta.atr(10) / close * 100 * multiplier`, which is the built-in's own expression. The
   TradingView/ZigZag/7 library is deliberately NOT imported: its instance is stateful and
   drawing-aware, and this suite needs the anchor computed inside `request.security()` so the fib
   can be pinned to a higher timeframe's swing.

   The difference this makes is large. On ZECUSDT 1H the old anchor spanned 888.00 → 513.59 (the
   200-bar extremes, a leg weeks old); the ZigZag anchors to 834.34 → 773.01, the swing actually
   in progress.

   Two deliberate departures from the built-in: it raises `runtime.error` when fewer than two
   pivots exist, which would kill every other module in this script, so this module simply draws
   nothing instead; and it exposes 22 levels with per-level value and colour inputs (66 inputs),
   where this port ships the 11 that are ON by default at the built-in's values and colours.
7. **Dropped from the MA sources**: the "Smoothing MA / Bollinger Bands" sub-block, which was not
   requested and would have tripled the plot count per MA. Bollinger Bands is its own module.
8. **Alerts consolidated.** No `alertcondition()` anywhere; S&R uses two `alert()` calls with
   composed messages, because `alertcondition` competes with the 64-output plot budget.
9. **`timeframe=""` removed** from every `indicator()` declaration.
10. **VWAP drops three anchors.** The built-in offers Earnings, Dividends and Splits anchors;
    each is a separate `request.*()` call (three more against the 40-call budget) and none
    fires on a crypto symbol. Every time-based anchor is kept. The built-in also raises
    `runtime.error` when the feed reports no volume — that would kill every other module in
    the script, so this module draws nothing instead.
11. **MACD replaces two `alertcondition()` calls with one `alert()`**, per the same
    plot-budget rule applied to S&R.

## Usability note

With S&R set to weekly on a low-timeframe chart, the levels it returns are genuinely months old
(a 15-bar weekly pivot looks back 15 weeks) and will sit far outside the visible price range.
That is correct behaviour, not a bug, but it makes the weekly slot close to useless on a 1H
chart. Consider daily as the highest S&R timeframe for intraday work.

## Open decisions, resolved

- **Two scripts, not one** — price scale and an unbounded volume-scaled series cannot share a
  pane legibly.
- **VFI scale collision** — "Normalise to 0-100" toggle, ON by default. Both VFI and its signal
  are scaled by the same window, so crossovers and relative sign are preserved exactly, and the
  zero reference moves with the transform. It creates no signal.
- **Bollinger Bands and Auto Fib Retracement added** at the user's request, outside original scope.
- **Pivot `lookahead_on` kept** as the single audited exception.

## Licensing

Derivative works. Keep both scripts **private / invite-only**; do not publish as original.

- Support & Resistance — Mozilla Public License 2.0, © fluxchart
- Trendlines — © Copyright 2019 to present, Joris Duyck (JD)
- Volume Flow Indicator — © LazyBear
- Supertrend, Pivot Points Standard, Bollinger Bands, RSI, ADX, moving averages — adapted from
  the TradingView built-ins

## Not a trading system

A visualisation tool. Multi-timeframe confluence displays confer no predictive power. Stacking
ten indicators across three timeframes mostly increases the number of places to find a signal
that agrees with whatever you already believe.
