# TVP5 FX1 — final engineering closure and corpus reconciliation

Source reviewed: `0da3d76ad9e4267ffec4c82586081085387e235f` on branch
`ui/codex-tradingview-feature-gap-closure-20260911`.

## RF2 findings closed

| Finding | Closure | Evidence/code path |
|---|---|---|
| Volume Footprint was OHLC-shaped and blank in Replay | COMPLETE | `tradeChartTransforms.footprintBars` preserves price, buy, sell, total and delta per level; `FootprintLayer` paints bid/ask cells and bar delta; `ChartPane` clips executions to `ReplaySession.horizonCloseTime`, keeps the historical tape enabled in Replay, and surfaces provider/empty-data states. Duplicate aggregate ids are ignored and ordered trade gaps trigger bounded reload. |
| Range had an implicit size and no lifecycle proof | COMPLETE | Range size is persisted as `ChartSettings.rangeTicks` and editable in Chart settings; range bars use the provider tick and ordered executions. Range/footprint feeds are symbol-scoped, reconnect-repaired and replay-bounded. |
| Kagi/P&F could silently use 0.01 for canonical ids | COMPLETE | `resolvePriceTick` matches canonical id, legacy symbol and compact provider symbol. Unknown precision is represented as `null`; Kagi/P&F render/update paths stay empty with an explicit unavailable message instead of manufacturing a tick. |

## Backend validation

Backend dependencies were installed with the existing `platform/backend/package-lock.json` using `npm ci --ignore-scripts` (no lockfile changes). `npm run typecheck` passed. Targeted provider/trade/market/canonical tests passed (1100 passed, 3 skipped; the skips require local PostgreSQL). The alert isolation guard also passes after keeping the chart-only aggregate-trade endpoint outside its static endpoint allow-list.

## Original Sonnet inventory reconciliation

| Feature/family | Current status | Evidence/code path | FX1 action | Genuine blocker |
|---|---|---|---|---|
| Candles, hollow, bars, line, step, area, baseline | COMPLETE | `chartType.ts`, `CandleChart` | None | — |
| Volume candles, line-with-markers, HLC area, columns, high-low | COMPLETE | chart type registry and `mainSeriesDatum` branches | None | — |
| Volume Footprint | COMPLETE | `FootprintLayer`, ordered trade transforms, replay clipping | Built renderer/data lifecycle | Provider execution feed can report unavailable; UI states that fact |
| TPO / Session Volume Profile | COMPLETE | `computeTpoProfile`, `computeVolumeProfile`, `VolumeProfileLayer` | None | — |
| Range | COMPLETE | `rangeBars`, persisted `rangeTicks`, ordered tape | Added persisted policy/tests | Provider execution feed unavailable state |
| Line Break / Kagi / Point & Figure | COMPLETE | incremental transforms, replay clipping, synthetic legends | Tick precision closure | Unknown provider precision is explicit unavailable |
| Channels, pitchfork variants, Fib/Gann, regression, geometry, patterns, Elliott, cyclic/time, forecast/measurement, Bars Pattern, Position Forecast, Sector, rotated rectangle, table | COMPLETE | `drawings.ts`, registry, `DrawingCanvas`, derived geometry/hit testing | None | — |
| Drawing settings/lifecycle/visibility/undo/redo/persistence | COMPLETE | `DrawingSettingsModal`, `drawingStore`, `DrawingCanvas`, visibility tests | None | — |
| General chart settings (symbol/status/scales/canvas/trading/alerts/events) | COMPLETE | `ChartSettingsModal`, `chartSettings.ts`, pane persistence | Added persisted Range ticks control | — |
| Indicator picker, add/remove, per-instance Inputs/Style/Visibility, panes, duplicate studies | COMPLETE | `IndicatorsPanel`, `NativeStudySettings`, `IndicatorPane`, `useIndicators` | None | Unsupported provider studies remain unavailable by contract |
| Watchlist, sorting/reorder, sections, selected details/provider status, persistence | COMPLETE | `Watchlist`, `useWatchlistTickers`, saved-list APIs | None | News/30-day stats are stated unavailable where no provider field exists |
| Right rail / Trading Scene panels / keyboard focus | COMPLETE | `ChartSidePanel`, `ChartToolbar`, focus/escape tests | None | — |
| Layout save/autosave/save-as/rename/delete/open/recent/dirty confirmation | COMPLETE | `LayoutMenu`, `useSavedLayouts`, `layouts.ts` | None | Server persistence depends on configured session backend |
| Symbol selector/query/categories/venues/keyboard/result state | COMPLETE | `SymbolSearchDialog`, canonical market search route | None | A fixture without the search route truthfully reports unavailable |
| Context menus and toolbar controls | COMPLETE | chart/axis/drawing menus and toolbar handlers | None | — |
| Replay candles, transforms, indicators, drawings, profiles, Range/Footprint | COMPLETE | `replay.ts`, `ChartPane`, `FootprintLayer`, profile clipping | Added trade horizon path | Historical executions beyond provider's bounded seven-day API are unavailable, explicitly stated |
| Alerts and responsive reachability | COMPLETE | alert routes/panels, responsive DOM coverage | None | External alert delivery is provider/configuration dependent |

The original screenshots also contain differences that are intentionally visual or interaction-polish (TradingView typography, iconography, exact flyout density, light-theme optical tuning, and premium-only surfaces). Those remain Claude/Fable work and are not represented as engineering parity claims.

## Newly repaired in FX1

- Added a real bid/ask price-level footprint canvas renderer with per-cell volume and delta.
- Kept historical executions available in Replay, clipped them at the replay horizon, and added explicit unavailable/empty states.
- Added aggregate-trade id deduplication and deterministic level/bar delta preservation.
- Added persisted Range tick sizing and a chart-settings control.
- Added canonical/compact provider tick resolution with an explicit unknown-precision state.
- Added deterministic tests for footprint preservation/deduplication, replay no-lookahead, sub-cent Range sizing, and canonical tick lookup.

## Remaining blockers

No technically feasible, materially applicable engineering gap is known. Remaining external boundaries are truthful data/entitlement boundaries: a provider may not expose executions or news/statistics, and local PostgreSQL is not present for the skipped integration tests.

## Validation results

- Frontend unit: **973 passed**.
- Frontend DOM: **93 passed** (existing React `act(...)` warnings only).
- Frontend typecheck, lint, production build, and `git diff --check`: **passed**.
- Backend typecheck: **passed**.
- Backend targeted provider/trade/market/canonical tests: **1100 passed, 3 skipped** (PostgreSQL-dependent).
