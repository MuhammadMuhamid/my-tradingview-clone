# Multi-Coin Multi-Timeframe Binance Spot Scanner

The Python service is the calculation authority behind Platform's native,
authenticated `/scanner` route. It is **not** a TradingView indicator — 36
symbols × up to 8 independently configurable timeframes is ~300 unique
symbol/timeframe contexts, and Pine caps `request.*()` at 40 (64 on
Professional). The Pine files under `../mtf_suite/` are a different project;
`screener.rtf` is a reference for indicator *math* only.

The production market is Binance Spot (`ccxt.binance`, `defaultType: spot`).
Mahamid's Scanner logic is unchanged by the market migration.

**This tool does not predict price.** It ranks current indicator state across a watchlist. That is
the whole product.

## Column layout (restructured 2026-08-30)

The table is now **per-timeframe**, not per-indicator. Each group shows the slots that matter for
that indicator rather than one selectable timeframe:

| Group | Columns |
|---|---|
| Symbol | symbol, price, 24h % *(sticky)* |
| Strategy | Bias, Setup, Bull %, Bear %, 1h, 15m, 5m |
| EMA | 1h 21/50/100/200 **%**, 1h Stack · 15m 200 %, 15m Stack · 5m 200 % |
| RSI | 1h / 15m / 5m RSI(50) each with its state |
| MACD | 1h / 15m / 5m MACD **line** value |
| VFI | 5m VFI line value |
| ADX | 5m ADX, +DI, −DI |
| VWAP | 5m bias (above = bull, below = bear) and distance % |
| Candles | unchanged — pattern and bias, with its own timeframe selector |
| Supertrend | 1h / 15m / 5m direction, separately |
| S&R | distance to the 1h / 15m / 5m support zone, in % |
| Pivots | distance to the nearest 1h / 15m / 5m Fibonacci pivot, in %, plus which level |

The **Score group was removed** from the table. The confluence score, its bucket breakdown and the
§6.2 empirical probability all still exist — they live in the row-expand panel and on the API, which
is where a number that needs three paragraphs of caveats belongs.

### Three consequences worth knowing

1. **The per-group timeframe selectors are gone**, except on Candles. A per-group selector cannot
   express "1h and 15m and 5m at once", which is the entire point of the new layout. The three slots
   are set once, in the toolbar, and every MTF column follows them.
2. **EMA distances are percent here, ATR in the strategy checklist.** You asked for percent, and
   percent is the more readable number on a single coin. It is *not* comparable across coins —
   4% off the 200 EMA is noise on one and a dislocation on another — which is why the rule engine
   still tests proximity in ATR.
3. **MACD is shown as a percent of price, not raw.** The raw line is a difference of two EMAs, so
   it carries the price's units: on 2026-08-30 it read `6.81` on BTC, `0.000635` on ALLO and
   `0.0000895` on PUMP. No decimal setting renders those legibly in one column, and comparing them
   is meaningless anyway. Dividing by price gives the EMA spread as a fraction of price —
   dimensionless, same sign, same shape, and readable at three decimals on every coin
   (`+0.009`, `+0.254`, `+1.777`, `−0.123`). The raw line stays under **More columns** and on the
   cell's hover text, so the underlying number is never unavailable.
   `test_macd_percent_is_comparable_across_price_scales` divides the fixture's prices by 320,000 and
   asserts the raw values then differ by five orders of magnitude while the percent form is
   unchanged.

   VFI needs none of this — it is already a volume ratio, so it renders readably as-is. Both columns
   are still **coloured by sign only**: which side of zero is the question the strategy asks, and
   scaling colour by magnitude would make the column read as "BTC is the only thing happening".

### Pivot Points Standard, per timeframe

Fibonacci type, as requested. Anchoring follows the built-in's Auto rule from the source you
supplied — `timeframe.multiplier <= 15 ? "1D" : "1W"` — so **5m and 15m both anchor to the previous
day and 1h anchors to the previous week**. That means the 15m and 5m pivot columns are *expected* to
show identical values: they are derived from the same previous-day OHLC. That is the indicator
behaving correctly, not a slot mix-up.

The S&R columns are genuinely independent per timeframe: on 2026-08-30, 27 of 35 symbols had a
different nearest support on 15m than on 5m. The eight that matched did so because the same price
extreme qualifies as a pivot on both series.

## MTF 1h + 15m + 5m scalping strategy

Added on 2026-08-30 at the user's request, on top of the eight-indicator screen.

One row per coin, **both scenarios evaluated side by side** — every condition is checked for a long
and, as its mirror, for a short. Seven conditions on each of 1h, 15m and 5m, exactly as specified.

### What the percentages mean

`Bull %` and `Bear %` are **the share of the checklist that currently passes** — 18 of 20 required
conditions is 90%. That is a count of facts about the closed bar. It is not a probability, it is not
the confluence score, and it says nothing about what price does next. The payload carries that
sentence and the UI prints it under every checklist.

`Setup` fills in only when **every** required rule on **all three** timeframes passes. On
2026-08-30 across 36 symbols, none did — a twenty-condition alignment is genuinely rare, and a
screen that showed setups constantly would be lying about its own thresholds.

`Prob.` is the §6.2 empirical hit rate, and it stays `off (§6.2)` until you enable that mode and
calibrate the symbol. It is never a number this feature invented.

### The rules, as implemented

| | 1h | 15m | 5m |
|---|---|---|---|
| 1 | EMA stacked 21>50>100>200 | EMA stacked 21>50>100>200 | Close above the 200 EMA |
| 2 | RSI(50) above 50 | Close above the 200 EMA | RSI(50) above 50 |
| 3 | Close touching a 21/50/100/200 EMA | RSI(50) above 50 | VFI crossed its signal upward |
| 4 | Supertrend direction *(optional)* | Supertrend bullish | Supertrend bullish |
| 5 | Close on a support / pivot fib level | Close on a support / pivot fib level | ADX and +DI above 20 |
| 6 | ADX and +DI above 20 | ADX and +DI above 20 | Close above VWAP |
| 7 | MACD line above 0 | MACD line above 0 | MACD line above 0 |

Bear is the mirror of each: stack inverted, RSI below 50, MACD below zero, Supertrend bearish,
−DI instead of +DI, resistance instead of support, below the 200 EMA and VWAP, VFI crossing down.

### Judgement calls, all configurable

- **The 1h Supertrend rule is optional.** Your spec says it "must be bullish and can be bearish
  also", so it is reported but excluded from the count — the 1h denominator is 6, not 7. An
  optional rule that counted toward the percentage would pad it.
- **"Touching" an EMA needs a tolerance.** Price equalling an EMA to the tick effectively never
  happens, so the test is proximity in ATR (`ema_touch_atr`, default 0.25). ATR rather than percent,
  because 0.5% is noise on one coin and a dislocation on another.
- **"On a support level"** likewise uses `level_touch_atr` (default 0.5) and accepts **either** an
  S&R level or a Pivot Points Standard level, per "a support level **or** pivot point standard fib
  level". A long only counts support-side pivots (S1–S3 or P); a resistance pivot does not qualify.
- **"VFI crossed over"** is a crossover, not a standing state: VFI must be above its signal *and*
  the cross must have happened within `vfi_cross_max_bars` (default 5). A cross forty bars ago is
  not a crossover.
- **A rule that cannot be evaluated is `null`, never a pass.** Missing data lowers the percentage
  and blocks `Setup`; it never quietly inflates the count.

### Two new indicators

§5 of the original spec put Pivot Points Standard out of scope and named no VWAP. Your strategy asks
for both, which supersedes that. They live in `STRATEGY_EXTRAS`, deliberately outside `REGISTRY`, so
the main table stays at the eight columns §5 allows while the strategy can still reach them.

- **Pivot Points Standard** — Fibonacci by default. The reference script calls TradingView's
  built-in so the formulas are not in the source, but the source corroborates the level counts
  (`showLevel4` excludes Fibonacci, so it has P, R1–R3, S1–S3 and nothing more). Levels come from
  the previous **completed** period only. Anchor follows the built-in's Auto rule: 15m and below
  anchor daily, longer anchors weekly — so your 5m and 15m slots use daily pivots and 1h uses
  weekly.
- **VWAP** — session-anchored to the UTC day, `hlc3` typical price, matching the built-in. Anchoring
  matters: a VWAP run over the whole cached window is a different line from the one your chart draws,
  and "above VWAP" would then mean something else.

### A bug this work uncovered

The VFI crossover code first used `~series.shift(1).fillna(False)`. On pandas' object dtype that is
a **bitwise integer inversion, not a logical not**, and it produced wrong crossovers — it reported
BTC's last cross as "this bar" when the series actually flipped six bars earlier. Python 3.16
deprecates it, which is how it surfaced: two million warnings in one test run. Now cast to a real
bool dtype first, and the corrected value is verified against the printed series.

### Cost

Three timeframes x 36 symbols = 108 cached series, still one fetch per `(symbol, timeframe)` — the
§8.3 guarantee is unchanged and separately tested for the strategy's slots. Building a full snapshot
is about 10s, so it is now **built on refresh and cached** rather than recomputed on every poll,
which the UI was previously paying for on a 15-second timer.

## Status

| Step (spec §9) | State |
|---|---|
| 1. Data layer + cache + symbol validation | **done** — §8.3 proven |
| 2. EMA, RSI, MACD, ADX | **done** — §8.1 partial, see below |
| 3. VFI, Supertrend | **done** |
| 4. S&R level extraction | **done** |
| 5. Candle patterns | **done** |
| 6. API + frontend table | **done** |
| 7. Confluence score | **done** |
| 8. Empirical calibration | **done** — 288 backend tests; verified in-browser |

## Layout

```
frontend/            Next.js App Router + TypeScript + TanStack Table + Tailwind v4
  lib/columns.ts     declarative column model — group, kind, colour saturation, accessor
  lib/format.ts      formatters and the colour-blind-safe diverging scale
  components/        Cell, ScreenerTable, FilterPanel, RowDetail
backend/
  app/ta.py           Pine primitives: ema, rma, sma, stdev, tr, atr, rsi, sources
  app/indicators/     one module per indicator, all exposing compute(df, params) -> dict
  app/timeframes.py   bar durations, bucket boundaries, closed-bar test
  app/config.py       default.json + user.json overrides, validation, hot reload
  app/store.py        SQLite OHLCV cache, keyed (exchange, symbol, timeframe, ts)
  app/exchange.py     ccxt adapter behind a MarketFeed protocol; symbol resolution
  app/cache.py        fetch dedup, TTL, closed-bar trimming, concurrency cap
  app/scoring.py      bucketed confluence score, ADX gate, sub-score breakdown
  app/calibration.py  §6.2 walk-forward calibration; fast path + decile table
  app/service.py      config + cache + indicators -> rows; the scheduled-pull refresh
  app/api.py          FastAPI endpoints
  config/             default.json, symbols.json  (user.json is generated, gitignored)
  tests/
    pine_oracle.py           scalar transcription of the Pine source; test-only
    fixtures/BTCUSDT_1h.csv  1799 closed bars, frozen 2026-08-28
```

## Running

One command, from `platform/screener/`:

```bash
./start.sh
```

It stops anything already running, creates the virtualenv and installs packages on first run only,
starts the API on `:8000` and the UI on `:3000`, waits until both actually answer, and prints the
URL. A cold start takes about 25 seconds — the API resolves all 36 symbols and backfills three
timeframes before it reports healthy.

```bash
./start.sh --stop
```

```bash
./start.sh --logs
```

Then open **http://localhost:3000**. Tests: `cd backend && .venv/bin/python -m pytest -q`.

Two details that took a couple of attempts to get right, recorded so they are not re-broken:

- **`setsid` does not exist on macOS.** The servers are launched through a tiny `python3` shim that
  calls `os.setsid()` and `execvp`s, so they get their own session and survive the script exiting.
- **Stopping by process name does not work for Next.js.** `pkill -f next-server` kills the worker,
  and its `npm run dev` parent immediately respawns it under a new PID — the port never frees.
  `--stop` therefore kills by *port*, resolving the listener to its process group so the supervisor
  goes with it, escalating to `SIGKILL` after a few attempts. That also catches servers started
  outside the script, or left over from a session whose pidfile is gone.

## Notes on the data layer

- **One fetch per `(symbol, timeframe)`.** Eight indicators on 1h across 36 symbols cost 36 network
  calls, not 288. Enforced by the SQLite primary key and asserted in `tests/test_cache.py`.
- **Closed bars only.** The forming bar is dropped once, in `cache.drop_forming_bar`, before
  anything is written. Every value the screener shows comes from a confirmed bar, and the source
  bar's close time is exposed per series so the UI can render provenance and grey out stale cells.
- **TTL is the bar duration.** A 1h series is not re-fetched until the next hourly bar closes.
- **Market identity is explicit.** Everything above `app/exchange.py` talks to a `MarketFeed`
  protocol for deterministic tests, while production is pinned to Binance Spot. The ccxt adapter
  forces `defaultType: spot` and exact resolution refuses any perpetual, dated future or alias.
- **Legacy state is isolated, not rewritten.** SQLite keys candles and series metadata by
  `(exchange, symbol, timeframe)` and calibrations by the same identity. Old `binanceusdm` rows may
  remain, but the current `binance` cache cannot read them. Calibration fingerprints include the
  exchange, Spot market type and exact native symbol, so Futures calibration is stale/incompatible.
  A legacy `config/user.json` exchange override is retained on disk but ignored at reload; the
  shipped Spot source is authoritative.

### Deviations from the spec, and why

1. **36 symbols, not 38.** Two were removed at the user's direction on 2026-08-28. The 38th ticker
   rendered as `BIANRENSHENGUSDT` and does not resolve to a base asset. `PEPE/USDT` went with it —
   see note 3. The `unverified` array in `config/symbols.json` and its startup warning remain, for
   the next symbol that cannot be resolved.
2. **Config symbols are exact Spot `BASE/QUOTE` identities.** `BTC/USDT` resolves only when that
   exact active Spot market exists. `BTC/USDT:USDT` and any other perpetual/future stay unresolved.
3. **Denominated Spot markets are suggested, never substituted.** An exact pair that is absent may
   name a `1000BASE/QUOTE` Spot near match in the reason, but resolution does not adopt it. Percentage
   outputs might survive the substitution while price levels would not.

**Historical USD-M evidence (superseded):** the 2026-08-28 live check against `binanceusdm` resolved
all 36 then-configured symbols and demonstrated cache deduplication. It describes the old market
source and is not Binance Spot evidence. No live exchange check was performed for the Spot migration.


## Notes on the indicators

No `pandas_ta`, no TA-Lib. Both disagree with Pine on the details that matter here:

- **`ta.ema` is not `df.ewm(span=n).mean()`.** Pine emits `na` until `n` bars exist, seeds with the
  SMA of those `n` bars, and only then runs the recursion. pandas' `adjust=True` default computes a
  weighted mean over all history instead — different on every bar. `app/ta.py` implements Pine's
  rule; `test_ema_is_sma_seeded_not_pandas_ewm` pins it.
- **`ta.rma` (Wilder) is the same shape with `alpha = 1/n`.** RSI, ATR and ADX all sit on it.
- **`ta.stdev` is population (ddof=0)**, not the sample stdev pandas defaults to. VFI needs this.

### Fetch depth is 1800 bars, not 750

The spec's 750 is not deep enough. Because Pine seeds EMA with an SMA, a 200-period EMA still
carries **0.4% of its seed after 550 bars** — visible contamination in a column the user sorts on.
1800 bars puts it near 1e-7. Binance caps a Spot OHLCV page at 1000 bars regardless of the `limit`
asked for, so `CcxtFeed.fetch_ohlcv` paginates backwards; one series is still one cache entry and
one TTL, so the §8.3 dedup guarantee is unchanged.

### §8.1 parity: what is proven and what is not

**Proven.** Every ported formula is checked against `tests/pine_oracle.py` — a second
implementation written as literal bar-by-bar scalar loops from the `screener.rtf` source, sharing
no code with `app/ta.py`. They agree to **1e-9 relative** across 1799 bars, tighter than the 1e-6
the spec asks for, and Supertrend `direction` matches as an **exact integer sequence** over every
bar, across three parameter sets and both `changeATR` branches. `test_the_oracle_can_actually_fail` is a negative control: a deliberately wrong
EMA must and does fail the same comparison, so the assertion is not vacuous.

The frozen `tests/fixtures/BTCUSDT_1h.csv` source is
`BINANCE:BTCUSDT.P`; `.P` identifies perpetual provenance. It remains a valid
deterministic numerical fixture for formula parity, scoring and no-lookahead
properties, but it does **not** prove Binance Spot exchange parity. Spot market
identity tests use synthetic, deterministic ccxt-shaped Spot markets instead.

**Not proven.** Agreement with TradingView's *own* rendered values. The comparison was attempted on
2026-08-28 against `BINANCE:BTCUSDT.P` 1h and abandoned: the chart-automation bridge reported a
study list that contradicted what the chart actually rendered, and `data_get_study_values` returned
nothing for studies the same API claimed were present. Numbers read through that path would not have
been trustworthy. Two implementations agreeing to 1e-9 catches porting and vectorisation bugs, which
is the real risk; it cannot catch a shared misreading of what TradingView does. To close it, add
EMA/RSI/MACD/ADX to a chart by hand and paste the data-window values for one closed bar.


### Supertrend and VFI — the two ports the spec singles out

Both get negative tests, not just positive ones. A positive test passes for a port that is wrong on
every bar; these assert that doing it the wrong way produces a *different* answer, so the trap stays
pinned if someone later "simplifies" the code.

**Supertrend (§4.7).** The band ratchets — `up := close[1] > up1 ? max(up, up1) : up`, where `up1`
is the previous bar's *reassigned* value, not the raw `src - m*ATR`. Three pinned behaviours:

- The ratchet resets across a trend flip. `test_ratchet_resets_across_a_flip_rather_than_running_
  cumulatively` asserts `up` actually falls somewhere in the fixture and does **not** equal
  `np.maximum.accumulate` of itself — which is what a port that drops the `close[1]` guard produces.
- The comparison is against `close[1]`, not `close`. A one-bar-shifted variant is computed inline
  and asserted to differ.
- `changeATR` selects `ta.atr` (RMA-smoothed) or `ta.sma(tr, period)`; both branches are compared
  against the oracle separately.

**VFI (§4.4).** Three traps, each with a negative test:

- `ma(x, 3)` is the **identity** when `smoothVFI` is false, which is the default. The test asserts
  the smoothed and unsmoothed curves differ, and that the smoothed one equals `sma(plain, 3)` — so
  the default cannot silently be the smoothed branch.
- `vave` is `sma(volume, length)[1]` — the **previous** bar's average. Without the shift a bar
  normalises by an average containing its own volume. Pinned by both a value comparison and a
  first-valid-index offset.
- `stdev` is population (ddof=0), asserted to differ from the ddof=1 form pandas defaults to.

### End-to-end check

**Historical USD-M result (superseded):** against `binanceusdm` on 2026-08-28, 36 symbols resolved
and 36 series were fetched in 18.2s at 1800 bars
each (two pages per series), every implemented indicator computed for every symbol, every result
JSON-serialisable, no series short of 1000 bars. Computing all eight indicators across all 36
symbols takes **4.7s** — Supertrend 30ms/symbol, ADX/S&R/EMA ~17ms, the rest under 11ms.

## Support & Resistance (§4.8)

A reimplementation, not a port. The Flux Charts script is a drawing engine — line and box pools,
break/retest labels, ephemeral flipped levels, timeframe-string bookkeeping — all of which exists to
render on one chart. Only the level-finding core is reimplemented, following §4.8's five steps.
There is no oracle for it, so every step is pinned against a hand-built series whose answer is known
by construction.

**Two deliberate divergences from the source, both following the spec:**

1. **Strength is the pivot count in a cluster** (§4.8 step 3). The source never clusters — it
   *discards* a new pivot landing within `tooCloseATR` of an existing level, starts every level at
   strength 1, and increments on retests instead. Its resistance branch also compares the candidate
   against `pivotLow` where `pivotHigh` was meant, so near-duplicate resistances are rejected
   against the wrong series. That bug is not reproduced.
2. **A level is a support or a resistance by which side of the current close it sits on**, not by
   the pivot kind that made it. `position_in_range` needs it that way. Broken levels are dropped;
   the source's flipped "ephemeral" levels sit behind an option that is off by default.

**No repaint.** A pivot at bar `i` needs `pivot_length` bars on each side, so it cannot be known
until bar `i + length`. `test_a_level_does_not_appear_before_its_pivot_confirms` walks a level
through exactly that boundary: absent at the pivot bar, absent one bar short of confirmation,
present on the confirmation bar.

**Ties are not pivots.** Two equal highs inside the same window means neither is a unique extreme,
so neither is reported — otherwise a flat range manufactures levels out of noise.

`position_in_range` is `None`, not a fabricated number, when price sits above every level (no
resistance) or below every one. On 2026-08-28 that was 4 of 36 symbols, all near their highs.


## Candle patterns (§4.6)

No source in the reference file; written from scratch. All 20 patterns the spec names — 8 single-bar,
8 two-bar, 4 three-bar.

**No magic numbers.** Every threshold is a named parameter, and anything comparing a size against
the market is expressed in ATR, because a 40-point body is a marubozu on one symbol and a rounding
error on another. Beyond the five thresholds the spec names, the implementation needs five more
(`trend_lookback`, `tweezer_tol_atr`, `star_body_ratio`, `soldier_wick_max`, `harami_containment`);
all are explicit and overridable rather than buried in conditionals.

**`strength` is a documented function of the bar's own ratios**, in `[0, 1]`: **0.0 means the bar
only just qualified, 1.0 means the ideal form.** The exact ratio behind each number is named in
`STRENGTH_BASIS` and returned with every hit, so a reader can always see what produced it. Strengths
are comparable within a pattern and only loosely across patterns — they measure textbook-ness, not
predictive power, and nothing downstream should read them as the latter.

**Prior trend is a parameter, not an assumption.** Hammer and Hanging Man are the same shape, as are
Inverted Hammer and Shooting Star; only what came before separates them. That context is
`trend_lookback` — the sign of `close[i-1] - close[i-1-trend_lookback]` — and the tests assert the
identical bar reads as Hammer after a downtrend and Hanging Man after an uptrend.

**Conflicts cancel.** Two patterns disagreeing on the most recent bar produce `net_bias = "none"`,
never a majority vote. Only the most recent occurrence of each pattern within the lookback is kept.

### One deviation from the spec

`min_body_atr` is measured against the bar's **range**, not its body. A doji has no body by
construction, so a body-based filter would make the entire doji family permanently undetectable. The
parameter keeps its name from the spec; the measure is the honest one. `test_bars_smaller_than_min_
body_atr_are_ignored` pins it: a textbook doji on a microscopic bar is not reported, and the same
shape scaled up is.

### §8.4 fixtures

Every pattern gets a hand-built bar that must be detected *and* a near-miss that must not — a wick
one notch too short, a close on the wrong side of a midpoint, a third bar that gaps instead of
opening inside the previous body. The near-miss is the test that matters: a detector with its
threshold wired backwards passes every positive test.

Building those fixtures caught a real problem in the harness rather than the code. The first padding
alternated bullish and bearish bars, and that alternation formed a genuine Piercing Line all by
itself. The padding is now single-colour in the direction of its drift, with wicks deliberately long
enough to fail `soldier_wick_max` — otherwise a drifting run of same-colour bars reads as Three
White Soldiers.

Live on 2026-08-28, 19 of the 20 patterns fired across the 36 symbols; Piercing Line was the only
one absent, which is unsurprising for the rarest of them.


## API and UI (§6, §7)

### Reads never fetch

§2.4 says refresh is a scheduled pull and the UI reads the cache. That is enforced, not just
intended: `test_reading_the_screener_never_triggers_a_fetch` hammers the read endpoints and asserts
the network-call count does not move. A user spamming the sort control cannot rate-limit the
exchange. The only endpoints that touch the network are `POST /api/refresh` and adding a symbol,
which has to validate against `load_markets()` before it can be persisted.

### One bad indicator does not blank a row

Each indicator is computed inside its own guard. A failure lands in `row.errors[name]`, the row
state becomes `partial`, the other seven still render, and the cell shows a hoverable `⚠`.
Unresolved symbols keep their row with `state: "unresolved"` and the reason — never silently
dropped (§2.5).

### The table

Dense grid, sticky symbol column, collapsible column groups, sort on any column, per-row expand.

- **Per-indicator timeframe selectors live in the group header**, so changing the RSI timeframe is
  one click, no settings modal. It PATCHes the config and the cache TTL means only the newly
  required `(symbol, timeframe)` pairs are fetched.
- **Every cell carries its own provenance.** Verified in-browser with two timeframes active at
  once: on the same BTC row the EMA cell reported `timeframe 1h, source bar closed 03:00Z` while
  the RSI cell reported `timeframe 4h, source bar closed 00:00Z`. Cells whose source bar is older
  than 2x its timeframe render greyed and italic.
- **Filters compose with AND.** Verified live: `stack == bull` plus `RSI state == overbought`
  narrowed 36 rows to 1.
- **Colour is teal/rose, not red/green.** Roughly 8% of men have a red-green deficiency, and a
  table whose entire meaning rides on that axis is unreadable for them. Teal is blue-shifted enough
  to stay separable under both protanopia and deuteranopia. Colour encodes magnitude only — the
  number is always rendered beside it.

### Deviations worth knowing

1. **The default sort is EMA 200 distance in ATR, not Confluence Score.** The score does not exist
   until step 7. Sorting by a column that isn't there would have meant shipping a placeholder that
   looks like a number; the row-expand panel says the breakdown lands with the score rather than
   showing an empty section.
2. **A few extra columns beyond the spec's counts.** §7 lists "EMA (8 cols)", but §7 also requires
   filtering on `stack == bull`, which needs `stack` to be a column. Secondary columns
   (`cross_state`, DI direction, nearest EMA, `above_zero`) are hidden behind a **More columns**
   toggle so the default view stays at the spec's density while the filter panel can still reach
   them.
3. **CORS accepts any localhost port.** The dev server takes whatever port is free — it came up on
   3005 during testing — and a hard-coded `:3000` allowlist breaks every request silently the
   moment that happens.


## Confluence score (§6.1)

**It is a score, not a probability.** It has not been validated against forward returns. The label
in the UI is "Confluence Score", the tooltip says so, and `test_nothing_in_the_payload_is_named_
like_a_probability` asserts no key in the payload contains "prob", "chance" or "%". The empirical
mode of §6.2 is the only thing permitted to use the word, and it is off by default.

### Why buckets

EMA distance, Supertrend, ADX direction and MACD are all transforms of the same close series.
Summed as eight independent votes, one trend move gets counted four times and the score saturates
at 90+ on what is really a single signal. So inputs are bucketed and each bucket casts one capped
vote: Trend 30, Momentum 25, Volume 20, Location 15, Trigger 10.

`test_a_pure_trend_move_cannot_saturate_the_score` pins this directly: every trend-shaped input
maxed out with everything else neutral must still land under 80. Live on 2026-08-28 the top score
across 36 symbols was **69.4**, not 95 — which is the design working.

### ADX is a gate, not a sixth vote

`regime == ranging` scales the Trend and Trigger buckets by 0.5 (configurable), because trend
signals read in chop are the main source of false positives. Tests assert the gated buckets'
effective weights halve while Momentum, Volume and Location do not move, and that ADX never appears
as a bucket of its own.

§6.1 also names DI direction as a gate input but specifies only the regime behaviour, so
`di_conflict_multiplier` is the hook for it — **defaulted to 1.0, so shipped behaviour is exactly
what the spec describes**. The conflict itself is detected and displayed either way.

### A redundancy found by reading the breakdown

The obvious second Location component, `(d_res - d_sup) / (d_res + d_sup)`, is **algebraically
identical to the first**: expand `d_sup = (close - sup)/atr` and `d_res = (res - close)/atr` and it
reduces to exactly `1 - 2 * position_in_range`. Averaging them would have displayed one number
twice and read as two independent confirmations — the same fake-confluence failure the bucketing
exists to prevent, reproduced *inside* a bucket.

The ATR distances are now used for something the position genuinely cannot express: **conviction**.
Sitting 0.2 ATR off support is a strong location read; the same relative position inside a range six
ATR wide is barely a read at all. Direction comes from the position, magnitude from proximity to the
nearer level, and they multiply rather than average — one vote, not two.

### Missing inputs narrow the basis, they do not drag the score

A bucket with no usable inputs is dropped and the weights are renormalised over what remains, with
a `coverage` figure reported. Without that, disabling one indicator would pull every score toward
neutral and look like a market-wide move rather than a config change. Live, 4 of 36 symbols had no
resistance above price, so their Location bucket is unavailable and they score at 85% coverage.

### Supertrend has no neutral state

`direction` is always +1 or -1, so a row carrying Supertrend can never have an exactly-zero Trend
bucket — an otherwise flat row still reads 10 points off neutral. That is a property of the
indicator, not a scoring bug, and
`test_supertrend_always_leans_because_it_has_no_neutral_state` pins the exact magnitude so it
cannot drift unnoticed.

### The breakdown is visible, because a bare number is unauditable

Row expand shows every bucket's sub-score as a signed bar, its nominal and effective weight, the
gate that was applied, the coverage, and — on hover — the raw components behind each sub-score.
Verified in-browser: the panel is pinned to the left edge of the horizontally-scrolling table, since
a breakdown rendered off-screen defeats its own purpose.


## Empirical calibration (§6.2) — read this before trusting a number

This is the only part of the system permitted to use the word "probability", and only because a
forward-return sample stands behind it. **It is off by default.**

### What it does

For one symbol, it walks the cached history bar by bar, computes the confluence score at each closed
bar using only data up to that bar, labels the forward outcome over `horizon_bars` (did price reach
`+target_atr x ATR` before `-stop_atr x ATR`?), sorts the bars into equal-count score deciles, and
reports the hit rate and sample size for each. The live figure is the rate of the decile the current
score falls into.

### What it refuses to do

Every display rule is enforced in `app/calibration.py`, not left to the UI:

- **`n` travels with every answer**, including the refusals. "insufficient data" with no number
  attached hides how far short the sample fell.
- **A decile under `min_decile_samples` (default 100) reports `insufficient data`**, and the payload
  carries `hit_rate: null` — there is no number for a caller to fall back on.
- **If no decile clears the threshold, the whole calibration is `available: false`.** Ten rows of
  "insufficient data" is not a usable calibration, and presenting it as one invites squinting.
- **A bar whose range spans both the target and the stop is resolved as a loss** and counted
  separately. OHLC cannot say which came first, and calling it a win is the easiest way to
  manufacture a flattering hit rate.
- **It is per symbol.** A rate calibrated on BTC is never shown for ETH; uncalibrated symbols say
  "not calibrated". Verified live: 35 of 36 rows said exactly that.

### The honest caveats, stated plainly

This is **in-sample** unless you run it walk-forward. It does not model fees, funding, spread or
slippage. The samples **overlap** — at a 24-bar horizon walking every bar, each observation shares 23
bars with its neighbour, so `n` counts observations, not independent ones, and any confidence you
might infer from it is overstated. A favourable hit rate on lagging indicators is the single most
overfittable result in retail trading.

### What it actually found

Historical run against the Futures-origin BTC/USDT 1h fixture on 2026-08-28,
1509 labelled bars over 64 days (not a current Spot calibration):

| Decile | Score range | Hit rate |
|---|---|---|
| 0 | 10.4–33.3 | 32.1% (n=137) |
| 1 | 33.3–39.3 | 39.2% (n=143) |
| 2 | 39.3–44.5 | 38.3% (n=141) |
| 3 | 44.5–49.0 | 39.3% (n=145) |
| 4 | 49.0–53.5 | 45.5% (n=145) |
| 5 | 53.5–57.6 | 29.9% (n=144) |
| 6 | 57.6–61.7 | 42.1% (n=145) |
| 7 | 61.7–66.7 | 37.9% (n=140) |
| 8 | 66.7–71.9 | 27.3% (n=139) |
| 9 | 71.9–93.6 | 32.2% (n=146) |

**There is no monotonic relationship between the score and the forward outcome.** The rates bounce
between 27% and 46% with no ordering, and the highest decile (32.2%) does worse than the middle.
The base rate is 36.4%, which is roughly what a 2:1 target-to-stop produces on a random walk.

On this window, on this symbol, at this horizon, the confluence score does not predict the outcome
it was tested against. That is one symbol over 64 days and it is not a verdict on the tool — but it
is exactly why the score is labelled a score, why §6.2 is off by default, and why none of this may
be presented as a probability without the sample behind it.

### Why there is a fast path

Scoring one bar means computing eight indicators, about 53ms; walking two thousand bars that way is
nearly two minutes per symbol. Every indicator with a full-history series form is instead computed
once and read per bar — 0.81ms per bar, a 65x speedup. S&R has no series form (its horizon and
invalidation sweep are both defined relative to the end of the data) so it is genuinely recomputed
per bar, which is most of the ~10s a calibration takes.

The substitution is only legitimate because `series(full)[i]` equals `compute(history[:i+1])`
exactly. `test_fast_path_matches_the_slow_path` checks that end to end against the real `compute()`
functions, field by field, and `test_fast_path_produces_the_same_score_as_the_live_pipeline` checks
the score itself. Without those the calibration would be measuring a different model from the one
the table displays.

## A test defect found and fixed during step 8

The §8.2 no-lookahead tests written in steps 2–5 were **tautologies**. They compared
`compute(df[:n])` against `compute(df[:n+50].iloc[:n])` — and `df[:n+50].iloc[:n]` *is* `df[:n]`, so
the assertion compared a frame with itself and would have passed for any function whatsoever,
including one that openly read the future.

They are replaced by `tests/test_no_lookahead.py`, which tests the property that can actually fail:
`series(full_history)[i] == compute(history_up_to_i)`, at six bars across the fixture, for every
indicator with a series form. It carries a negative control — a centred rolling mean, which really
does read ahead, must and does fail the same probe. This is also the exact guarantee the calibration
fast path depends on.

A second defect fixed alongside it: `tests/test_cache.py` used the production config paths and wrote
`config/user.json` in the repo, which made results order-dependent and stomped on a locally running
server. Tests now use an isolated store, and an autouse fixture fails any test that leaves the
repo's config modified.
