# TVP5 FX2 — RF3 final engineering repair

Branch: `ui/codex-tradingview-feature-gap-closure-20260911`  
Starting HEAD: `1b39ea704d99dce4bfb8c49e01bef068dbf47cd0`

## RF3 findings and repairs

- **Replay Range/Footprint execution window:** `frontend/lib/useMarketTrades.ts` now owns a deduplicated execution tape keyed by aggregate id. Replay entry fetches a deterministic 30-minute prefix; forward steps fetch only the newly exposed interval (including direct large jumps), backward steps clip the tape, and future timestamps are filtered before chart use. Replay does not subscribe to live trades. Symbol, chart type, and timeframe lifecycle keys clear the tape; leaving Replay resumes the live bounded fetch/stream path. Provider page-cap responses are reported as partial/unavailable instead of being presented as complete. `ChartPane.tsx` passes the lifecycle key and still applies horizon clipping to both Range and Footprint.
- **Range large moves:** `frontend/lib/tradeChartTransforms.ts` now works in provider-tick integer units and emits one bounded segment per crossed boundary. Intermediate boundary bars are explicitly synthetic (zero volume/source count); observed execution volume is retained on the observed segment. Up/down, exact boundaries, sub-cent ticks, deterministic ordering, and forming bars are handled without an oversized high-low.
- **Position Forecast:** `frontend/lib/drawingGeometry.ts` adds family-specific risk/target/continuation geometry. `DrawingCanvas.tsx` renders and hit-tests those exact segments through the same geometry function; anchors remain editable and existing drawing persistence/history/visibility/lock/delete infrastructure applies.
- **Bars Pattern:** historical candle closes selected by the two source anchors are derived into a projected, scaled path using `barsPatternGeometry`; source and projected paths render and hit-test from the same geometry. Existing anchor editing and persistence/history lifecycle remain shared and reachable.

## Semantic decisions

Replay never allows a trade timestamp greater than the active horizon to reach Range, Footprint, levels, delta, or totals. Overlapping fetches deduplicate by provider aggregate id. A provider page cap before the requested end is truthful partial/unavailable state. Range multi-boundary jumps use deterministic observed start/end boundary crossings only; no unobserved intratrade path is claimed.

## Focused tests

- `frontend/tests/tradeChartTransforms.test.ts`: footprint dedup/horizon clipping, Range exact and multi-range up/down jumps, sub-cent tick sizing, replay-prefix determinism.
- `frontend/tests/drawingGeometry.test.ts`: Position Forecast family geometry/continuation and Bars Pattern derived projection geometry.

## Validation

- Frontend unit: **977 passed**.
- Frontend DOM: **93 passed** (existing React `act(...)` warnings only).
- Frontend typecheck, lint, production build: **passed**.
- Backend typecheck and lint: **passed**.
- Backend full suite: **1100 passed, 3 skipped**; skips remain PostgreSQL-only and unrelated to this repair.
- `git diff --check`: passed.

No visual-parity or Claude/Fable completion claim is made. No RF3 material finding remains incomplete.
