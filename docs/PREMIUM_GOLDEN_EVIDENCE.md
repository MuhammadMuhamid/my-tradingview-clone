# Premium-parity golden evidence and regression lock

This file indexes the workstation surfaces that have been compared against
live, authenticated TradingView Premium and ACCEPTED, the measurement each
acceptance rests on, and the check that now protects it. It exists to stop a
cycle this project has repeated: a surface is brought to parity, a later pass
changes it for an unrelated reason, and it quietly regresses.

## The rule

An accepted surface is LOCKED. A change to its icon, geometry, spacing,
typography, menu structure, hover, focus or responsive behaviour needs:

1. a stated requirement that forces it;
2. a fresh comparison with current Premium; and
3. a green run of `platform/frontend/qa/premiumLock.mjs` (updated in the same
   commit if the accepted state itself moved, with the reason).

Functional work does not license a visual change; visual work does not license
a behavioural one.

## Running the lock

```sh
QA_CHANNEL=chrome QA_PLAYWRIGHT_FROM=/path/with/node_modules/ \
QA_BASE=http://localhost:3000 node platform/frontend/qa/premiumLock.mjs
```

It needs a running frontend with a live backend (real candles). It asserts
geometry and behaviour, never pixels of market data.

## Accepted surfaces (Premium measured live, `pro_premium_trial`)

| surface | accepted state | measured on Premium | lock check |
|---|---|---|---|
| top toolbar | one 38px row; nothing off-screen at 1440/1100/1000; More reachable | 38px row, 1px×22px separators | `[toolbar]` |
| left drawing rail | 52×38 cells at fixed pitch | identical 52×38 cells, same y-positions | `[drawing rail]` |
| rail switches | ON switch = inverted chip rgb(242)/ink rgb(15); selected tool rgb(61)/ink rgb(219) | 2026-10-11, Keep drawing ON vs trend-line selected | DOM/contract `tests/drawingRail.test.ts` (A4) |
| iconography | gear (never the 8-ray sun), no glyph clipped by its box | — | `[icons]` |
| chart context menu | 325px, 32px rows, portalled, no focus ring, no row highlighted on pointer-open, Escape closes | 347px chart menu, `outline:none`, no highlighted row | `[context menu]` |
| study legend | hover cluster zero-width at rest, 4 actions 28×22 on hover, value ≤8px after title | `buttonsWrapper width:0`, 28×22 / 18px glyph | `[study legend]` |
| study ⋯ menu | paints above next pane, Remove in ink, anchored at button | Remove rgb(219,219,219), no tint | `[study ⋯ menu]` |
| series legend | hover reveals Flag symbol + More (28×22); More opens the chart's own menu | `legend-flag-action`, `legend-more-action`; More = chart menu (347px) | `[series legend]` |
| status line | one row at 1440 with side panel open; values wrap as a group only in a narrow pane; O H L C follows crosshair | wraps values under title at 537px chart width | `[status line]` |
| price axis | no tick label half-covered by a pill | ticks a label touches are hidden | `[price scale]` (8 zoom states) |
| panes | pan keeps every pane on one time axis; no update-depth loop | — | `[panes]` |
| compare | opens immediately on Recent / your symbols, never the catalogue alphabet, never the chart itself | RECENT SYMBOLS list on open | `[compare]` |
| layout menu | one row per count, every arrangement as an outline glyph | per-count rows of outline grids | DOM `advancedChart.test.tsx` + `chartToolbar.test.ts` |

Screenshots for the final acceptance round are stored with the campaign
evidence under `/Users/m/Desktop/Trading-Codex-V3/TradingView-Premium-Audit-20260918-final/`
(golden set recorded at final acceptance; see the campaign ledger).
