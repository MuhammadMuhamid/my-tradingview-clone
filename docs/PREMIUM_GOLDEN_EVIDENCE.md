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
| top toolbar | one 38px row; nothing off-screen at 1440/1200/1100/1000/768; ⋯ on screen and opening a dropdown (progressive overflow, A13) | 38px row, 1px×22px separators | `[toolbar]` |
| left drawing rail | 52×38 cells at fixed pitch | identical 52×38 cells, same y-positions | `[drawing rail]` |
| rail switches | ON switch = inverted chip rgb(242)/ink rgb(15); selected tool rgb(61)/ink rgb(219) | 2026-10-11, Keep drawing ON vs trend-line selected | DOM/contract `tests/drawingRail.test.ts` (A4) |
| iconography | gear (never the 8-ray sun), no glyph clipped by its box | — | `[icons]` |
| chart context menu | 325px, 32px rows, portalled, no focus ring, no row highlighted on pointer-open, Escape closes; every menu's row mark an 18px glyph in a 28px box in the row's ink, label 4px after the box (W2A-07) | 347px chart menu, `outline:none`, no highlighted row; re-measured 2026-10-11 on the indicator menu: icon box 28×28 at row x+8, glyph rgb(219), label at row x+40 | `[context menu]` |
| study legend | hover cluster zero-width at rest, 4 actions 28×22 on hover in ink rgb(219) (W2A-07), value ≤8px after title | `buttonsWrapper width:0`, 28×22 / 18px glyph, rgb(219) | `[study legend]` |
| study ⋯ menu | paints above next pane, Remove in ink, anchored at button | Remove rgb(219,219,219), no tint | `[study ⋯ menu]` |
| study pane control (F-04) | ONE 24×24 `⋯` in ink rgb(219) 4px left of the axis, opening Manage panes (Maximize · Collapse · Move up · Move down · Delete; 32px rows, 18px glyph in 28px box) | re-measured 2026-10-11: one `Manage panes` button, not four icons | `[study pane]` |
| layouts / interval / chart-type menus (F-05, F-12) | Manage layouts marks 18 in 28; interval and chart-type stars 18 in 24; chart-type menu full-height from y=0 | 2026-10-11: chart-type 273×900 at y=0; stars 18 in 24 | `[manage layouts]`, `[interval menu]`, `[chart-type menu]` |
| series legend | hover reveals Flag symbol + More (28×22) in flow AFTER the identity row (incl. `vs` chip), which does not move, and covering no value (F-02, 2026-10-11 — the earlier "cluster overlays" acceptance painted More over the open price); More opens the SERIES menu (325px, 32px rows) | `legend-flag-action`, `legend-more-action`; re-measured 2026-10-11: More is a series menu (Add alert/order at price, Add indicator/strategy, Symbol info, Copy price, Paste, Table view, Add to watchlist, Add text note, Settings…), not the chart menu — the earlier "More = chart menu" reading was wrong | `[series legend]`; `tests/powerUx.test.ts` (A4) |
| status line | one row at 1440 with side panel open; values wrap as a group only in a narrow pane; O H L C follows crosshair | wraps values under title at 537px chart width | `[status line]` |
| price axis | no tick label half-covered by a pill | ticks a label touches are hidden | `[price scale]` (8 zoom states) |
| panes | pan keeps every pane on one time axis; no update-depth loop | — | `[panes]` |
| compare | opens immediately on Recent / your symbols, never the catalogue alphabet, never the chart itself | RECENT SYMBOLS list on open | `[compare]` |
| drawing toolbar | per-tool widget set: line = Template · Colour · (Text colour) · Width · Style · Settings · Lock · Delete · More; text = Template · Text colour · `14` · Settings · Lock · Delete · More; no Clone / Hide on the bar (M1 / F-10) | reviewer, live Premium, verified twice: trend line drag · Template · Colour · Text colour · Width · Style · Settings · Add alert · Lock · Delete · More; Text drag · Template · Text colour · `14` · Settings · Lock · Delete · More (`Add alert` withheld here: no sloped alerts) | DOM `tests/dom/drawingTextInline.test.tsx` |
| text tool | a click places the text and opens an inline editor on the canvas at the click, toolbar beside it; no modal (M1 / F-01) | reviewer, live Premium, verified twice: inline text box at the click point, floating toolbar shown | DOM `tests/dom/drawingTextInline.test.tsx` |
| layout menu | one row per count, every arrangement as an outline glyph in ink; the chosen one the inverted chip (W2A-15) | per-count rows of outline grids; re-measured 2026-10-11: outlines rgb(219), chosen cell rgb(242) with dark line work | DOM `advancedChart.test.tsx` + `chartToolbar.test.ts` |

Screenshots for the final acceptance round are stored with the campaign
evidence under `/Users/m/Desktop/Trading-Codex-V3/TradingView-Premium-Audit-20260918-final/`
(golden set recorded at final acceptance; see the campaign ledger).
