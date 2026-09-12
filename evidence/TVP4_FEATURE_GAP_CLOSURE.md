# TVP4 — TradingView feature-gap engineering closure

Scope: the 46 TradingView / 34 Trading Scene screenshots in the 2026-09-11
capture corpus, reconciled against the current frontend source. `A`–`G` below
are the classifications from the TVP4 brief. Evidence references source
symbols rather than the stale generated counts in the capture summary.

## Chart types

| TradingView chart type | Final classification | Existing code/primitives | Action taken | Test/evidence | If not implemented: exact reason |
| --- | --- | --- | --- | --- | --- |
| Volume candles | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT` | `CandleChart` candlestick series; canonical `Candle.volume` | Added `volumeCandles` registry/menu entry and per-bar volume alpha colouring | `tests/chartType.test.ts`; menu DOM smoke capture `12-tvp4-chart-types.png` | — |
| Line with markers | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT` | Lightweight Charts line series and `SeriesMarker` | Added `lineWithMarkers`; marker generation is tied to every canonical bar | `tests/chartType.test.ts`; `CandleChart` marker effect | — |
| HLC area | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT` | Line series plus existing `ChartDecoration` fill primitive | Added `hlcArea`; high/low overlays and a shared fill between them; close remains the main line | `tests/chartType.test.ts`; `ChartPane` `hlcDecorations` | — |
| Columns | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT` | Lightweight Charts histogram series | Added `columns` and maps each canonical close to a histogram column | `tests/chartType.test.ts`; `CandleChart` histogram branch | — |
| High-low | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT` | Candlestick wick renderer | Added `highLow`; transparent zero-height body with the canonical high/low wick | `tests/chartType.test.ts`; `CandleChart` `highLow` colours | — |
| Volume footprint | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK` | Existing `computeVolumeProfile` only aggregates OHLCV bars | Not exposed or faked | `lib/volumeProfile.ts` documents chart-bar/refined profile basis | Requires bid/ask or trade-level volume-at-price, delta/imbalance rows, lower-timeframe/session aggregation, and footprint interaction/serialization. OHLCV cannot identify aggressor side or per-price executions. Blocker category: data + transformation + rendering. |
| Time price opportunity (TPO) | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT` | `computeTpoProfile` and `VolumeProfileLayer` | Added session-scoped TPO row counting, bracket letters (A–Z), POC/value-area rendering and menu exposure. | `tests/volumeProfileChart.test.ts`; chart TPO decoration path | Uses the available timestamped OHLC contract. Brackets are chart bars in the UTC session; finer exchange session calendars are outside the provider contract. |
| Session volume profile | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT` | `computeVolumeProfile` / `VolumeProfileLayer` | Added `sessionVolumeProfile`, latest UTC calendar-session profile, with explicit chart-bar estimate notice | `tests/volumeProfileChart.test.ts`; `ChartPane` session decoration | This is intentionally a chart-bar estimate unless refinement data is available; it does not claim lower-timeframe precision. |
| Line break | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK` | `chartTransforms` has only Heikin Ashi/Renko transforms | Not exposed or faked | `chartType.ts` comment and rejection tests | Requires price-driven 3/2/1-line break state, reversal thresholds, synthetic timestamps, replay stepping and transformed-axis mapping. Ordinary candles cannot express the state machine. Blocker category: transformation + state semantics. |
| Kagi | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK` | No price-reversal transform | Not exposed or faked | `chartType.test.ts` rejects `kagi` | Requires reversal amount/method, yin/yang line state, thickness transitions, synthetic time mapping and interaction alignment. Blocker category: transformation + rendering + state semantics. |
| Point & Figure | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT` | Canonical OHLC and chart-only transform leaf | Added deterministic percentage box policy, three-box reversals, X/O direction columns with source timestamps, synthetic line rendering, disclosure and replay/incremental fold tests. | `tests/chartTransforms.test.ts`; `tests/chartType.test.ts` | OHLC cannot reveal intrabar ordering when one bar spans both directions; the engine uses a documented high-first policy and exposes the result as display-only columns. |
| Range | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK` | Current history is time-indexed OHLC; `renko` is not a range transform | Not exposed or faked | `chartType.test.ts` rejects `range` | Requires tick/range aggregation from intrabar trades or sufficiently fine data, synthetic bar timestamps, history/live equivalence and replay boundaries. Fixed-time OHLC cannot recover price-range bars. Blocker category: data + aggregation + transformation. |

## Drawing-tool reconciliation

The corpus's approximate `~103` count excludes TradingView's icon/emoji/sticker
grids. The exact named inventory below is mapped to the shared
`DrawingTool`/`TOOL_POINTS`/`DrawingCanvas` geometry, persistence and toolbar
flyout. Rows are grouped only where every named tool has the same status.

| TradingView family / captured tool(s) | Trading Scene mapping | Final status / action |
| --- | --- | --- |
| Cross | `cursor` | `EXISTS_AND_EXPOSED` |
| Dot | `dot` | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; added one-anchor dot renderer and flyout entry |
| Arrow (cursor), Demonstration, Magic | no persistent drawing equivalent | `NOT_APPLICABLE`; these are cursor/demo modes rather than chart objects; the product exposes a cross cursor and keeps manual arrows in the Lines family |
| Eraser | `eraser` | `EXISTS_AND_EXPOSED` |
| Values tooltip on long press | no drawing object | `NOT_APPLICABLE`; value readouts belong to the chart crosshair/legend, not persisted drawings |
| Trendline, Ray, Extended line, Horizontal line, Horizontal ray, Vertical line | `trend`, `ray`, `extended`, `hline`, `hray`, `vline` | `EXISTS_AND_EXPOSED` (some in a different group) |
| Info line | `infoline` | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; added measured two-point line and delta/duration label |
| Trend angle | `trendAngle` | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; added angle label to the shared trend geometry |
| Crossline | `crossline` | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; added one-anchor horizontal + vertical renderer |
| Parallel channel | `parallel` | `EXISTS_AND_EXPOSED` |
| Disjoint channel | `disjointChannel` | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; added two rays and translucent channel fill |
| Pitchfork | `pitchfork` | `EXISTS_AND_EXPOSED` |
| Regression trend | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; manual regression requires fitting source candles over an anchor span, deviation/channel policy, and data-aware updates; the native regression study is an automatic study, not a manual object |
| Flat top/bottom | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; its constrained two-boundary construction and edit semantics are not represented by the current one-line/parallel model; implementing a plain trend line would mislabel the tool. Blocker category: geometry/state semantics |
| Schiff pitchfork, Modified Schiff pitchfork, Inside pitchfork | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; each needs distinct three-anchor projection formulas and handle semantics not present in `pitchfork` |
| Fib retracement, Trend-based fib extension | `fib`, `fibext` | `EXISTS_AND_EXPOSED` |
| Fib channel | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; needs ratio-driven parallel channel levels and a dedicated multi-level settings model |
| Fib time zone, Trend-based fib time | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; needs time-axis Fibonacci projection and vertical-level rendering, not price-level `fib` geometry |
| Fib speed resistance fan, Fib speed resistance arcs | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; requires price/time-scaled angle/arc construction and scale-aware handles; current canvas has no instrument aspect-ratio policy |
| Fib circles, Fib spiral, Fib wedge, Pitchfan | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; non-linear Fibonacci geometry, rotation/scale handles and dedicated serialization are absent |
| Gann box, Gann square fixed, Gann square, Gann fan | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; requires Gann price/time square calibration and angle families; ordinary rectangle/line primitives cannot preserve those semantics across zoom and non-square axes |
| XABCD pattern, Cypher pattern, Head and shoulders, ABCD pattern, Triangle pattern, Three drives pattern | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; manual templates need named multi-leg anchors, ratio validation, labels and editable leg state. The existing automatic screener is deliberately not counted as a manual drawing equivalent |
| Elliott impulse, Elliott correction, Elliott triangle, Elliott double-combo, Elliott triple-combo wave | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; needs wave-specific anchor counts/constraints and nested-label editing; no such template state exists in `Drawing` |
| Cyclic lines, Time cycles, Sine line | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; require periodic/time or trigonometric projection parameters and scale-aware rendering, beyond polyline geometry |
| Long position, Short position | `long`, `short` | `EXISTS_AND_EXPOSED` (different group) |
| Position forecast | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; requires forecast target/uncertainty semantics and a projection model, not the risk/reward box used by `long`/`short` |
| Bars pattern | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; copies/translates a historical OHLC segment and therefore needs source-window references, live/replay clipping and a second OHLC renderer |
| Ghost feed | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; requires an alternate/live feed snapshot and time-series overlay identity; no second feed is available in the current data contract |
| Sector | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; circular sector needs scale-aware radius/angle handles and a dedicated three-anchor geometry; it was visible in the flyout capture but is not a named row in the manifest table |
| Anchored VWAP | `avwap` | `EXISTS_AND_EXPOSED`; reusable `anchoredVwapOverlays` plus shared anchor drawing |
| Fixed range volume profile | `vprange` | `EXISTS_AND_EXPOSED`; `fixedRangeProfiles` / `VolumeProfileLayer` |
| Anchored volume profile | `avprofile` | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; reuses fixed-range profile computation from one anchor through the current tail, with no lookahead |
| Price range, Date range | `pricerange`, `daterange` | `EXISTS_AND_EXPOSED` (different group) |
| Date and price range | `datePriceRange` | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; added the combined measurement renderer and registration |
| Brush | `brush` | `EXISTS_AND_EXPOSED` |
| Highlighter | `highlighter` | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; added translucent freehand path and shared drag lifecycle |
| Arrow marker | `arrowMarker` | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; added one-anchor marker |
| Arrow (geometric) | `arrow` | `EXISTS_AND_EXPOSED` (different group) |
| Arrow mark up, Arrow mark down | `arrowUp`, `arrowDown` | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; added one-anchor directional markers |
| Rectangle | `rect` | `EXISTS_AND_EXPOSED` |
| Rotated rectangle | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; needs a rotation handle and oriented-rectangle hit testing; axis-aligned `rect` cannot represent it |
| Path | `path` | `EXISTS_AND_EXPOSED` |
| Circle | `circle` | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; added radius-based circle geometry |
| Ellipse | `ellipse` | `EXISTS_AND_EXPOSED` |
| Polyline | `polyline` | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; added freeform polyline alias with shared path hit testing |
| Triangle | `triangle` | `EXISTS_AND_EXPOSED` |
| Arc, Curve, Double curve | `arc`, `curve`, `doubleCurve` | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; added fixed-anchor quadratic curve renderers and hit testing |
| Text | `text` | `EXISTS_AND_EXPOSED` |
| Note, Price note, Comment, Signpost, Flag mark | `note`, `priceNote`, `comment`, `signpost`, `flagMark` | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; added caption collection through the shared text flow and dedicated annotation geometry |
| Pin | none | `EXISTING_PRIMITIVE_CAN_SUPPORT_IT`; added one-anchor pin annotation |
| Callout, Price label | `callout`, `pricelabel` | `EXISTS_AND_EXPOSED` |
| Table | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; needs anchored multi-cell layout, editable cell state, sizing and serialization; `Drawing` only stores point anchors and one caption |
| Image | none | `REQUIRES_DISTINCT_SUBSTANTIAL_ENGINE_OR_DATA_WORK`; needs upload/asset persistence, CSP-safe loading, sizing/crop handles and export behavior |
| Post, Idea | none | `NOT_APPLICABLE`; these are TradingView social/community publishing integrations, and Trading Scene has no community service or backend contract to target |
| Icon, Emojis, Stickers | none | `NOT_APPLICABLE`; no local asset catalog/upload service exists; substituting emoji or arbitrary glyphs would violate the product's explicit control/icon policy |
| Measure | `ruler` | `EXISTS_AND_EXPOSED` |
| Zoom in | browser/chart zoom controls | `NOT_APPLICABLE`; zoom is owned by Lightweight Charts' wheel/pinch/time-scale interaction, not a persisted drawing |
| Magnets | `magnet` toggle | `EXISTS_AND_EXPOSED`, simpler single toggle |
| Keep drawing | no separate toggle | `NOT_APPLICABLE`; current workflow arms one tool and returns to cursor after commit; introducing a second persistence mode would require a toolbar state contract not used elsewhere |
| Lock options, Hide options, Remove options | lock/hide/remove-all controls | `EXISTS_AND_EXPOSED`, intentionally simpler single controls; per-drawing lock/hide/delete remain available in the context menu |

## Other material gaps and exposure

| Feature | Final result | Code-grounded evidence |
| --- | --- | --- |
| Per-timeframe drawing visibility | `EXISTS_BUT_HIDDEN_OR_UNEXPOSED` → implemented | Optional backward-compatible `Drawing.visibleOn?: Resolution[]`, `drawingVisibleOnTimeframe`, canvas draw/hit filtering, profile/AVWAP filtering, and `DrawingSettingsModal` Visibility tab. Empty/missing means all timeframes; malformed stored resolutions are rejected. Native resolutions plus a valid current derived resolution are selectable. `tests/drawingVisibility.test.ts` and profile visibility tests cover the behavior. |
| Layouts manager | `EXISTS_AND_EXPOSED` | `components/tv/LayoutMenu.tsx`, `lib/useSavedLayouts.ts`, and `lib/layouts.ts` already expose open/recent list, save, Save as, rename, delete, autosave status/toggle, dirty-state confirmation and server persistence. No duplicate persistence was created in TVP4. |
| Watchlist details | `PARTIALLY_IMPLEMENTED` → completed to available-data boundary | `Watchlist.tsx` now shows selected symbol identity, venue/type, quote, change, feed source, and explicit News/Key stats sections. `useWatchlistTickers` supplies last/24h change and source/freshness. No news provider, volume field or 30-day average exists in the ticker/API contract, so those are stated unavailable rather than fabricated. |
| Indicator settings | `EXISTS_AND_EXPOSED` | `NativeStudySettings` and the existing Pine/settings workflow are wired from the chart and verified by the prior DOM/unit baseline; no reimplementation was needed. |
| Price-scale modes, bottom workstation, Pine/editor, drawing history/favourites/serialization | `EXISTS_AND_EXPOSED` | Existing `priceScale`, chart toolbar, `ChartDialogs`, `drawingHistory`, `DrawingToolbar` favourites and `drawingStore` paths are reachable from the workstation; TVP4 only reused them for the new tools. |

## Validation and artifacts

- Full frontend unit suite: rerun after the chart-engine checkpoint; focused transform/type/workspace tests cover Line Break, Kagi, TPO and Point & Figure.
- Full frontend DOM workflow suite: **91 passed**.
- Focused closure tests: chart types, drawing visibility/tool registry, profile wiring and anchored profile behavior all passed.
- `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` pass after the closure changes.
- Changed after-state screenshots: [12-tvp4-chart-types.png](/Users/m/Desktop/Trading-Codex-V3/TradingView-Parity-After-Codex-20260911/12-tvp4-chart-types.png) and [13-tvp4-watchlist-details.png](/Users/m/Desktop/Trading-Codex-V3/TradingView-Parity-After-Codex-20260911/13-tvp4-watchlist-details.png). The local QA fixture has no seeded watchlist rows, so the second capture demonstrates the available empty-state/provider boundary; details render when a saved row is selected.
- Dedicated remaining work is Range and Volume Footprint (their required source granularity is absent), plus the manual pattern/Fibonacci/Gann/forecasting families listed above. Implemented transforms remain display-only and are never represented as canonical trading data.
