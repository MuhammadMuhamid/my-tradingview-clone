# MTF Confluence Spot Strategy — v2

A single self-contained Pine Script **v6 `strategy()`**: long-only spot, nine merged indicators, **every filter on its
own timeframe with its own on/off toggle**.

Files:

| File | What it is |
|---|---|
| `MTF_Confluence_Spot_Strategy.pine` | The strategy. |
| `MA_RR STRATEGY.pine` | The reference strategy whose section layout and R:R engine v2 adopts. |
| `all Indicators pine code.rtf` | The nine source indicators this was built from. |
| `CLAUDE_CODE_PROMPT.md` | The original build spec. |

---

## What changed in v2

1. **Per-filter timeframes.** Nothing is hardwired to 1H or 15m any more. G1, G2, G3, G4 and S1–S7 each have their
   own `input.timeframe`. Want RSI on 4h and the liquidity sweep on 5m? Just set them.
2. **One section per filter.** Each gate and each structure filter is its own numbered settings group with its own
   enable checkbox, so you can see and switch each one independently.
3. **The Confluence Weights engine is gone.** No weights, no score, no threshold. Selection is now a plain
   **AND of the filters you tick**: an enabled filter must pass, a disabled filter is ignored entirely. What you tick
   is what you get.
4. **Sections adopted from MA_RR** so both scripts tune the same way: `1 General`, `1b Profit-run limit`,
   `6e Volume filter`, `6f Higher-high structure`, `7b Entries — Long`, `9b R:R swing-low stop + ratio TP`,
   `11b Peak / spike filters`, `20 AlphaTrend`, and a Heikin-Ashi signal option.
5. **Two selectable stop/TP engines** (`2 Risk` → *Stop / TP engine*):
   - **R:R (swing low + ratio)** — *default.* MA_RR's engine: stop below the recent swing low with an ATR buffer,
     target at a reward:risk ratio. Optional % partials, % trailing, break-even.
   - **Structure (S1–S7 levels)** — v1's engine: the stop comes from whichever enabled S filter level sits closest
     below entry, with R-multiple partials and min/max stop-distance policing.

---

## Licensing — read this first

The script embeds logic from **LuxAlgo** indicators, published under **CC BY-NC-SA 4.0** — a *non-commercial*
licence. Therefore:

> **This script may not be sold, licensed for money, bundled into a paid product or service, or used as part of a
> commercial offering.** Personal and non-commercial use only. Derivative works must be shared alike.

ChartPrime's SR component is MPL 2.0. Full attribution is in the file header — do not strip it.

---

## Quick start

1. Paste `MTF_Confluence_Spot_Strategy.pine` into the TradingView Pine Editor → **Add to chart**.
2. Put the chart on **5m**. Each filter reads its own timeframe itself.
3. Watch the **debug table** (top right). It now has a **TF column**, so every row shows the filter, the timeframe
   it is reading, its current value, and ✓ / ✗ / – (– = disabled).

---

## Section reference

### 1 General
| Input | Default | Notes |
|---|---|---|
| Signals on confirmed bar only | ON | OFF lets conditions go true every tick → same-bar stop/re-entry loops. Keep ON for live. |
| New entries: bar close only | ON | Only entries wait for bar close; exits are never delayed. |
| Min bars after exit before new entry | 0 | Simple re-entry cooldown. |
| **HTF reads: last CLOSED bar only** | **ON** | **The single most important input in the script.** ON = every higher-timeframe value comes from the last closed bar (`[1]` offset), so the backtest matches live. OFF = reads the in-progress HTF bar: history looks better and it repaints live. Only turn it off to eyeball what a filter is doing. |
| Signals from Heikin Ashi candles | OFF | Feeds HA OHLC into the **trigger** only. Stops, targets and fills always use real prices. |
| Pause entries after N consecutive losses | OFF | Choppy-market circuit breaker. |
| Signal delivery | Off | 3Commas / custom webhook JSON fields for the `alert()` payload. |

### 1b Profit-run limit
After N consecutive winners that together made at least X% profit, pause new entries for a cooldown. Targets the
last "top" trade of a winning cluster. A loss resets the streak. Default OFF.

### 2 Risk & position sizing
`Fixed USDT` (default 1000) or `Risk % of Equity` where qty = `(equity × risk%) / (entry − stop)`.
`Stop / TP engine` picks between the R:R and Structure engines described above.

### 3–6 Gates G1–G4
| Gate | What it checks | Default |
|---|---|---|
| G1 | Supertrend bullish on its TF | ON, 60 |
| G2 | RSI between threshold and max on its TF | ON, 60, 50–100 |
| G3 | VFI above a level on its TF | ON, 60, > 0 |
| G4 | Price at/above the ChartPrime SR support box | OFF, 60 |

G2 now has a **max** as well as a minimum — set it to e.g. 70 to refuse entries when RSI is already exhausted.
G3 (VFI, length 130) needs ~130 closed bars of its timeframe before it means anything; until then the gate reads
false and the table shows `warmup`.

### 6e Volume filter / 6f Higher-high structure
Above-average volume on entry (TF-selectable), and last confirmed pivot high above the prior pivot high.
Both default OFF.

### 7–13 Structure filters S1–S7
| # | Condition | Stop candidate it contributes |
|---|---|---|
| S1 | Bullish liquidity sweep (LuxAlgo, *Only Wicks*) within N bars | Low of the swept wick |
| S2 | Inside / just above the demand zone | Bottom edge of the demand zone |
| S3 | At / above a standing ChartPrime support box | Bottom edge of the support box |
| S4 | Supertrend bullish | The Supertrend line |
| S5 | Pivot Point Supertrend bullish | `Trailingsl` |
| S6 | Sellside liquidity resting below, within reach | The sellside level |
| S7 | Above the last confirmed pivot low | That pivot low |

Stop candidates only matter when the **Structure** stop engine is selected.
`S2 / S3 proximity` and `S6 max distance` turn the vague words "just above" and "above" into something measurable —
they are expressed in ATRs of that filter's own timeframe.

### 14 Entry trigger
`Bollinger Reclaim` (default) / `Bollinger Basis Cross` / `Supertrend Flip` / `BB + Supertrend (both)`, evaluated on
its own timeframe so the cross is detected on **that** timeframe's closes. Turn the whole section off to enter on the
first bar where all filters agree (expect many more trades). If **AlphaTrend is PRIMARY**, it replaces this trigger.

### 9b R:R engine (default)
Stop = `min(swingLow − buffer×ATR, close − minSlDist×ATR)`; target = `entry + risk × ratio`.
Optional TP1/TP2 % partials, % trailing stop (monotonic — only ratchets up), break-even after +R.

### 11b Peak / spike filters
Parabolic-run block, ATR-spike block, upper-wick rejection, over-extension vs a reference EMA. All default OFF
except where noted — turn them on one at a time and watch the funnel counters.

---

## Known limitations

**1. Pivot confirmation lag is real and is not removed.** `ta.pivothigh/low(left, right)` confirm a pivot only
`right` bars *after* it forms — S1 (5 bars), S5 (2 bars), S3/G4 (20 bars), S7 (20 bars), all measured on each
filter's own timeframe. Every pivot call in the source carries a comment stating its delay. No `offset` tricks and no
`lookahead` were used to hide it; doing so would make the backtest a lie.

**2. Supply & Demand does not exactly match the LuxAlgo original.** The original derives its zones from
`chart.left/right_visible_bar_time` — from whatever is on your screen — so it redraws when you pan or zoom and cannot
be backtested. It is rewritten to a **fixed rolling lookback**, and the intrabar `request.security_lower_tf` volume
distribution is replaced with bar-level volume spread evenly across the profile bins each bar's high-low range spans.
Zones will be *close to but not identical to* your chart. That is the price of a reproducible backtest.

**3. Spot, long only.** No short logic anywhere. Sizing and stop maths assume long-only.

**4. RSI and VFI have no pane of their own** — an `overlay = true` strategy has only the price pane. Both are
computed, used, and exposed in the Data Window and the debug table.

**5. HTF components draw nothing.** Pine cannot create boxes/lines/labels inside `request.security()`. HTF values
drive the *logic*; the chart-timeframe instance of each component drives the *visuals*. So the SR boxes you see are
the chart-TF boxes, while S3 is evaluated on its own timeframe.

**6. Updating the script can scramble saved inputs.** TradingView maps a study's saved input values by position. When
a new version adds or reorders inputs, an already-placed study can keep stale values that land on the wrong inputs —
this genuinely happened during development and silently disabled most filters. **After updating, remove the study and
re-add it**, or hit *Reset settings* in its settings dialog.

---

## How to tune this

Work most-leverage-first, and change **one thing at a time**.

1. **Get the trade count sane before anything else.** Read the funnel counters in the Data Window
   (`n· gates ok`, `n· structure ok`, `n· all filters`, `n· trigger`, `n· filters+trigger`, `n· stop usable`,
   `n· ENTRIES`). They tell you *which stage* is rejecting bars, so you don't have to guess. In v1 testing the
   trigger was the binding constraint — 618 fires across ~20k bars, only 260 of them while the gates were open.
2. **Then fix the stop, not the entry.** Most losing configurations of this kind are stopped out by a stop that is
   too tight, not by bad entries. Widen `SL buffer below swing low` before touching any filter.
3. **Then prune filters that are always true.** A filter that is ✓ on every bar carries no information — it only
   costs you trades elsewhere. S4 and S7 are the usual culprits in an uptrend. This is much easier to see now that
   the table shows every filter's live state side by side.
4. **Then the exits.** `Reward : Risk ratio` and the trailing activation are the two most sensitive TP inputs.
5. **Write down the trade count after every change.** If a change moves net profit but not trade count, you changed
   the exits. If it moves trade count, you changed the entries. Conflating the two is how people convince themselves
   they have an edge.

A note on overfitting: this script has well over 150 inputs. That is enough freedom to fit any historical curve you
like. Tune on one date range, then check on a range you never looked at. If it doesn't survive that, it wasn't an edge.
