# TVP5 FX3 RF4 root-cause repair

- Starting HEAD: `2d8bd6cd4da22f8b4079727d86faaf4c92128149`
- Branch: `ui/codex-tradingview-feature-gap-closure-20260911`

## RF4 defect 1 — stale published execution state

Root cause: `useMarketTrades` cleared its ref-backed tape on lifecycle changes but retained published React state, while effect-local request generations did not protect the shared tape from late completions or disposed stream callbacks.

Repair: the hook now publishes an explicit identity comprising provider symbol, canonical symbol input, chart scope (chart type/timeframe), Replay/live mode, and Replay horizon. State is reset at the hook boundary on every identity/coverage change, and the return value is identity-gated during the pre-effect commit. Raw executions remain reusable only for the same base lifecycle; mode/symbol/scope changes clear tape and coverage metadata. A generation token plus abort signal validates every history/pagination/gap-repair result before it can mutate tape, coverage, loading, error, or published trades. Live callbacks validate the same token and disposed flag, so late events from a replaced subscription are ignored.

Lifecycle regressions cover symbol and horizon invalidation, Replay entry/no-lookahead, forward advancement, backward clipping, Replay exit, deferred A→B request races, overlapping-page deduplication, and a late callback from a disposed live subscription.

## RF4 defect 2 — Range exact-boundary continuity

Root cause: an exact completion set the forming state to `null`; the next execution therefore opened at its own price and omitted the move from the completed boundary.

Repair: `rangeBars` retains the last completed boundary in tick units. The next forming bar starts at that boundary, preserving `previous.close === next.open` for exact up/down transitions, same-price executions, reversals, and sequential completions. Multi-boundary jumps remain bounded one-range segments with zero-volume synthetic intermediates and the observed execution attributed only to the final segment. Provider tick quantization remains the boundary authority.

Range regressions cover exact up/down continuation, same-price and reversal transitions, sequential completions, up/down multi-range jumps with continuation/reversal, sub-cent and floating-point-hostile ticks, repeated equal executions, replay-prefix determinism, continuity, and completed-bar distance limits.

## Directly related checks

Footprint bid/ask levels, totals/delta, Replay clipping, execution deduplication, pagination overlap, gap-repair lifecycle, persisted Range sizing, and existing Kagi/P&F, drawing-geometry, and chart-type tests remain green. No backend/provider contract or backend source changed.

## Validation

- Frontend unit: **980 passed** (977 baseline plus the expanded Range regressions).
- Frontend DOM: **99 passed** (93 baseline plus 6 lifecycle regressions).
- Frontend typecheck and lint: passed.
- Backend: reused fresh RF4 evidence (`1100 passed, 3 PostgreSQL-only skips`); no backend/provider contract changed, so reinstall/full rerun was not warranted.

No genuine engineering blocker remains in this bounded repair scope.
