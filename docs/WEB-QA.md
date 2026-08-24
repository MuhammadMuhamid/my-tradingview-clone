# Desktop and mobile QA

**Status:** current. Reproduce with `platform/frontend/qa/` — see that
directory's README for the exact commands.

---

## 1. What was exercised, and what was not

**Exercised.** A real Chromium, driving a production build of the frontend
served locally:

- 7 routes × 5 viewports = **35 page loads**
- desktop 1440×900, laptop 1024×768, iPhone 13 portrait, iPhone 13 landscape,
  Pixel 7 — the last three with touch emulation and device pixel ratios
- keyboard operation of the skip link, the focus ring and the shared dialog

**Not exercised, and not claimed:**

- **Anything requiring the backend.** PostgreSQL is not available in this
  workspace, so every page was loaded with its API returning 500. That is a
  real state — it is what a user sees when the backend is down, and it is how
  the Phase 6 error paths were reached — but **no chart in this QA had candles
  on it**, no alert list had rows, and no deployment could be paused.
- **Safari and Firefox.** Chromium only. The device profiles emulate iOS
  metrics and touch; they do not run WebKit.
- **Real hardware.** No phone was used.
- **Screen readers.** Roles, names and landmarks were inspected in the DOM.
  VoiceOver and TalkBack were not run.

---

## 2. Results

| Check | Result |
|---|---|
| Document horizontal overflow | **0** across all 35 loads |
| Elements past the viewport edge outside a scroller | **0** |
| Uncaught page errors | **0** |
| Controls with no accessible name | **0** |
| Routes without a top-level heading | **0** |
| `main`, `nav`, skip link present | every route |
| Controls below 24×24 CSS px | **1**, third-party (below) |

Console errors are present on every route and are the expected `500` from the
absent backend, plus the Binance websocket failing to open in a sandboxed
browser. Neither is a defect in the page.

### Keyboard

| Check | Result |
|---|---|
| First Tab stop is the skip link, and it becomes visible | yes, at 8px from the top |
| Focus ring | 2px solid `#4f8cff` |
| Skip link moves focus to `#main` | yes |
| Dialog announced with `role`, `aria-modal` and a name | yes — "Price alert SOLUSDT" |
| Focus moves into the dialog on open | yes |
| Tab cannot leave the dialog | held over 25 presses |
| Escape closes it | yes |
| Body scroll restored on close | yes |
| Focus returns to the control that opened it | yes |

---

## 3. What this found that review did not

**The dialog did not return focus.** It restored to `<body>`, which for a
keyboard user means being thrown to the top of the page every time they close
an alert dialog.

The cause is only visible at runtime. The dialog captured "what had focus
before I opened" inside its open-effect — but a field with `autoFocus` has
already taken focus by the time that effect runs, so the dialog recorded one of
its own children, found it removed on close, and gave up. Tracing
`HTMLElement.prototype.focus` in the browser showed the restore call was never
made at all.

The first fix was wrong too, for a second runtime-only reason: it tested
"outside" against the panel's own ref, and that ref is still `null` during the
commit in which a child autofocuses itself. It now tests
`closest('[role="dialog"]')`, which is also correct for the four dialogs
mounted at once on the chart, each of which runs one of these listeners.

**Two controls were below the 24×24 minimum.** The drawing toolbar's "more
tools" corner triangle measured **10×10** — the smallest control in the
application, and the only route to two thirds of the drawing tools. The
strategy-tester tab strip measured 22px high on a phone, and it is also the
handle that brings a collapsed panel back. Both were sized from the measurement,
not from a guess.

**Three routes had no `<h1>`.** `/chart`, `/backtests` and `/optimizers`
offered a screen-reader user nothing to orient on. The chart's is `sr-only`:
its title is the symbol and timeframe already in the toolbar, and a visible
heading would repeat them and cost a row of a screen that page spends its whole
design reclaiming.

---

## 4. Still open

- **`Charting by TradingView`, 35×19.** The attribution link injected by
  `lightweight-charts`. Below the target minimum, not ours to size, and removing
  it is a licence violation.
- **Tight but passing.** The chart's timeframe buttons are 28px high and the
  history-depth buttons 24px. Both clear the 24×24 AA minimum and neither
  reaches the 44×44 that AAA asks for. On a chart toolbar that is a genuine
  trade-off against how much of the screen the chart itself gets, and the
  current balance is deliberate.
- **Everything requiring data.** The chart has not been QA'd with candles, the
  alert list with alerts, or the deployment controls against a backend that can
  fail. Those need a database.
