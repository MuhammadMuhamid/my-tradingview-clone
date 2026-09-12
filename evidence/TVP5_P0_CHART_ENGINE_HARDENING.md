# TVP5 P0 — Chart engine hardening

Status: complete on `ui/codex-tradingview-feature-gap-closure-20260911`.

## Engine map and boundaries

`lib/chartType.ts` is the single registry. `CHART_TYPES` separates canonical
presentations from display-only transforms; `transformParams` carries the fixed
V1 settings and `syntheticDisclosure`/`timeAnchoredVisualsTruthful` drive the
menu, badge and truthful layer suppression. `app/chart/page.tsx` persists the
chart type per workspace. `components/tv/ChartPane.tsx` supplies canonical
history (and replay-clipped history), computes session profiles/TPO, and passes
the result to `components/CandleChart.tsx`. `CandleChart` owns the transform
cursor, initial fold, forming-bar re-step, live update, legend and crosshair.
No transform output is imported by trading, alerts, strategies, backtests,
science, persistence or execution paths.

| Type | settings → engine | renderer / interaction | history, live, replay, tests |
| --- | --- | --- | --- |
| Volume candles | registry presentation; volume colour from canonical `Candle.volume` | candlestick series with per-bar alpha; canonical legend/crosshair | shared canonical history/live/replay; chart type and DOM regression suites |
| Line with markers | canonical close presentation; `hasLineMarkers` | line series plus one marker per canonical bar | markers rebuilt from canonical history and replay window; chart controls tests |
| HLC area | canonical high/low/close; `ChartPane` creates high/low overlays and fill decoration | line series with explicit range fill | canonical history/live/replay; chart workspace and DOM tests |
| Columns / High-low | canonical histogram or hollow-range candlestick datum | real lightweight-charts histogram/candlestick branches | canonical history/live/replay; chart type tests |
| Session Volume Profile | `DEFAULT_PROFILE_SETTINGS`; latest UTC day is the session | `computeVolumeProfile` → price-pane profile decoration; basis notice says chart-bar estimate | visible candles are replay-clipped; profile recomputes on live/history; `volumeProfileChart.test.ts` |
| TPO | `tpoBlockMinutes: 30` in `ChartPane`; row size/value-area settings normalized | `computeTpoProfile` → profile decoration with A–Z then a–z bracket labels | latest UTC session, replay-clipped; fixed-block and 52-label rollover tests |
| Heikin Ashi | `transformParams` → `heikinAshiBar` (one output per canonical candle) | candlestick series; transformed legend, canonical time overlays remain truthful | cursor fold and forming-bar path share `transformStep`; no-lookahead/prefix tests |
| Renko | fixed ATR(14), close-driven two-brick reversal | candlestick bricks; source timestamp is retained, time-anchored layers disclosed/hidden | ATR state is incremental and replay-safe; source-time, no-lookahead, prefix and live equivalence tests |
| Line Break | fixed 3-line close break; prior confirmed line highs/lows | line series; sparse source-time provenance; canonical-time layers suppressed | incremental cursor and forming merge; high/low semantics, replay-prefix and batch/incremental tests |
| Kagi | fixed 1% close reversal with directional extreme tracking | line series; sparse point legend/source-time mapping | incremental cursor and forming merge; reversal, prefix, no-lookahead and equivalence tests |
| Point & Figure | fixed 1% box and 3-box reversal; OHLC high-first policy | line series; X/O column metadata and source time | active column is replaced in place on extension; reversal/source-time, replay-prefix and equivalence tests |

Synthetic output is display-only. `canonicalOpenTime()` is the only timestamp
allowed to leave a sparse transform; canonical candles remain the execution and
analysis boundary. Batch, incremental, forming-bar and live paths all merge an
active P&F column by display time, avoiding duplicate adjacent columns and
avoiding an O(n²) full-history fold.

## Range and Volume Footprint review

Range charts require ordered price-crossing information (or an equivalent
intrabar path) that is not present in the canonical OHLCV candle contract.
Volume Footprint additionally requires ordered trades/levels and aggressor side;
the implementation must not infer side from candle direction. The reviewed
provider seams expose OHLCV klines and ticker streams only:

* `backend/src/types/market.ts` defines `Candle` with OHLCV, optional quote
  volume/trade count, and no trade sequence or aggressor side.
* `backend/src/market/binanceSpotAdapter.ts` and
  `backend/src/market/officialSpotAdapters.ts` declare `trades` and `orderBook`
  unsupported for the current adapters; their candle streams are kline topics.
* `backend/src/data/candleWire.ts` deliberately carries only OHLCV in the
  compact chart payload.

Official Binance Spot REST/WebSocket documentation was reviewed for klines,
ticker and stream capabilities. Extending the current read-only adapters cannot
produce the missing ordered trade/side fields under this contract. Therefore
Range and Volume Footprint are absent from the registry/menu and are stated as
unavailable in Getting Started; no synthetic approximation is exposed.

## TradingView references consulted

Official Help Center pages (accessed 2026-09-12):

* Kagi — `/support/solutions/43000502272-learn-to-use-kagi-charts/`
* Line Break — `/support/solutions/43000502273-introduction-to-line-break-charts/`
* Point & Figure — `/support/solutions/43000502276-learn-using-point-and-figure-charts/`
* Range — `/support/solutions/43000474007-understanding-range-charts/`
* TPO — `/support/solutions/43000725590-time-price-opportunity-charts-explained/`
* Session Volume Profile — `/support/solutions/43000745275-session-volume-profile-charts-explained/`
* Volume Footprint — `/support/solutions/43000726164-volume-footprint-charts-a-complete-guide/`

## Validation

Passed focused transform/profile tests, full frontend unit suite (959 tests),
DOM suite (91 tests), `npm run typecheck`, `npm run lint`, `npm run build`, and
`git diff --check`.
