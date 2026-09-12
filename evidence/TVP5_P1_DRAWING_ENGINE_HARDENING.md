# TVP5 P1 — Drawing engine hardening

Status: complete on `ui/codex-tradingview-feature-gap-closure-20260911`.

## What shipped

The drawing canvas now derives advanced tools from family-specific geometry rather than rendering every advanced item as a connected polyline:

- Standard/Schiff/Modified Schiff/Inside pitchforks derive their median, parallel branches, and editable anchor triangle.
- Fib channel and Pitchfan use a baseline-normal offset; time tools use Fibonacci interval projections; speed/resistance fan and arcs, circles, spiral, and wedge have distinct constructions.
- Gann box/squares use a square grid with eighth subdivisions; Gann fan exposes 2:1 through 1:2 rays.
- Regression trend fits loaded close observations between the two anchors and draws a residual channel (falls back to the anchor line when data is insufficient).
- XABCD, Cypher, Head-and-Shoulders, ABCD, Triangle, Three Drives, and Elliott variants retain manual anchors and use family-specific labels.
- Cyclic lines/time cycles project stable interval lines; Sine line renders a sampled periodic curve. Position Forecast/Bars Pattern retain the manually selected path and projected continuation. Sector, rotated rectangle, and table retain their dedicated geometry.

Derived geometry is never persisted as extra state: the original chart-unit anchors remain the sole editable/serialised source, preserving undo/redo, copy, lock/hide/remove, timeframe visibility, replay clipping, and reload persistence.

## Reference and inventory

The captured TradingView flyout contact sheet (`TradingView-Parity-Capture-20260911/contact-sheets/04-drawing-flyouts.png`) was inspected against the current rail. Every captured advanced entry is reachable from the Advanced flyout and has an explicit anchor count in `lib/drawings.ts`; manual pattern tools remain manual and are not substituted with automatic pattern detection.

## Validation

- `npm run test:unit -- --test-name-pattern='drawing|pitchfork|fib levels|regression returns|time projections'`
- `npm run test:dom -- --test-name-pattern='drawing|trend|Delete|server'` (92 tests passed, including advanced flyout creation)
- `npm run typecheck`
- `npm run lint`
- `git diff --check`

New deterministic geometry coverage lives in `frontend/tests/drawingGeometry.test.ts`; the DOM suite exercises Schiff pitchfork, Gann square, XABCD, and cyclic-lines creation through the real toolbar flyout.
