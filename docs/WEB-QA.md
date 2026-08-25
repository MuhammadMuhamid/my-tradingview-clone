# Desktop and mobile QA

**Status:** current. Reproduce with `platform/frontend/qa/` — see that
directory's README for the exact commands.

---

## 1. What was exercised, and what was not

**Exercised.** A real Chromium, driving a production build of the frontend
served locally:

- 8 routes × 5 viewports = **40 page loads**
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
| Document horizontal overflow | **0** across all 40 loads |
| Elements past the viewport edge outside a scroller | **0** |
| Uncaught page errors | **0** |
| Controls with no accessible name | **0** |
| Routes without a top-level heading | **0** |
| iOS-zooming fields (< 16px text, ≤ 640px wide) | **0** |
| `main`, skip link present | every route |
| `nav` present | every route but `/login`, which has none by design |
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

## 2b. Re-run after Phase 7 and Phase 8 (2026-08-24)

Phases 7 and 8 changed the shared navigation and four routes and added a fifth,
so the harness was re-run in full rather than partially — the navigation is on
every page, and a partial run would not have covered it. The route list gained
`/operations`, taking the matrix from 35 loads to 40.

**The result is identical to the Phase 6 record above**, including the single
third-party control below 24×24. Every other counter is still zero.

Two regressions were introduced by the Phase 8 work and caught here:

- **`/operations` had no top-level heading while it was loading or failing.**
  The heading was inside the success branch, so a page rendering only an error
  had nothing for a screen reader to announce as its subject — and with no
  backend available, that is the state the QA sees. The heading belongs to the
  route and now renders in every state.
- **Two new links on `/alerts` were 15 CSS pixels tall**, against a 24-pixel
  minimum every other control in the app clears. They are `inline-block` with
  vertical padding now, measured at 28.

One harness defect was also fixed: `.skip-link` animates `top` over 150ms, and
`keyboard.mjs` measured immediately after the Tab press, catching it mid-flight
at −42px. That is a flaky measurement of a link that does become visible, not a
finding. It waits for the transition now and measures 8px, matching the Phase 6
record.

Keyboard results are unchanged from the table above: skip link first and
visible, a 2px focus ring, the dialog announced and named, focus trapped over 25
presses, Escape closing it, body scroll restored, and focus returned to the
control that opened it.

**The limitation is unchanged.** PostgreSQL is still unavailable, so every one
of those 40 loads still had its API returning 500. Still Chromium only, still no
physical device, still no screen reader.

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

## 4. The execution bot's interface

The same harness was pointed at the bot's dashboard build (`bot:frontend`),
across the three routes reachable without a backend: 15 loads, 5 viewports.

| Check | Result |
|---|---|
| Horizontal overflow, page errors, oversized-for-viewport elements | **0** |
| Text fields below 16px on a phone | **0** |
| Controls with no accessible name | **1 → 0** (below) |

It found three defects, all fixed:

- **The dashboard had no error boundary.** React unmounts the whole tree on a
  render error, so any component fault replaced the interface that shows
  whether bots are running — and holds the only controls for closing a
  position — with a blank page.
- **Every sign-in field was unlabelled.** The `<label>` had no `htmlFor` and did
  not wrap its input, so a screen reader announced "edit text, blank" for the
  username, the password, the setup token and the authenticator code.
- **The password reveal was 13×13, unnamed, and `tabIndex={-1}`** — unreachable
  by keyboard, which removes the feature from the people it exists for.

The Partial Close overlay — which sells part of a real position — was also a
bare `fixed inset-0` div with no role, no Escape and no focus management. It
now uses a `Dialog` with the same contract as the platform's `Modal`. It could
not be QA'd in a browser, because reaching it needs a bot with an open trade
and therefore a backend with data.

---

## 5. Still open

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
