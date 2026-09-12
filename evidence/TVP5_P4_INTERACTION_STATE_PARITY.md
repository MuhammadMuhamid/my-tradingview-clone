# TVP5 P4 — Interaction and state parity

Status: complete on `ui/codex-tradingview-feature-gap-closure-20260911`.

## Delivered

- Added standard keyboard navigation to chart type, saved layout, product, sync,
  trading-overlay, and timeframe menus. Arrow keys cycle enabled controls and
  Home/End reach the first/last item.
- Opening a menu moves focus into its actionable controls; Escape closes the
  menu and restores focus to its trigger. Outside clicks continue to dismiss
  popovers.
- Added a shared menu keyboard primitive so menu behavior stays consistent as
  new controls are added.
- Added Escape dismissal for the side-panel drawer and explicit pressed/labels
  for desktop and mobile panel controls, preserving the existing panel,
  replay, and touch behavior.
- Escape on the toolbar More strip now closes it and returns focus to More.

## Validation

- `npm run test:unit` — 969 passed.
- `npm run test:dom` — 93 passed.
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run build` — passed.
- `git diff --check` — passed.
