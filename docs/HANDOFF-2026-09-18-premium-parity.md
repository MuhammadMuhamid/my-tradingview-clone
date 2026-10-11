# Handoff — Premium parity + Mahamid reconciliation, 2026-09-18 (evening)

**For:** the owner, and anyone picking this up cold.
**Status:** IN PROGRESS. Paused at a clean checkpoint, not finished.

This continues the campaign whose earlier half is described in
`HANDOFF-2026-09-18.md`. That one ended at `ca30f80`; this one runs on top.

---

## 1. Where the work is

| | |
|---|---|
| branch | `finalization/mahamid-reconcile-premium-parity-20260918` |
| HEAD | `96f9516` — **local == `origin/…`, verified** |
| owner `main` | `ca30f80`, **deliberately untouched** |
| worktree | clean except the preserved untracked `phase2/` |
| commits this session | 19, all pushed |

**`main` has NOT been promoted.** It must not be until every gate passes; the
campaign is mid-flight.

The full, blow-by-blow record — every finding, its evidence, its disposition —
is the durable ledger at
`/Users/m/Desktop/Trading-Codex-V3/FINAL_PREMIUM_PARITY_RECONCILIATION_STATE.md`.
That file is the authority. This one is the summary.

---

## 2. Test state, re-derived rather than trusted

```
backend        1255 / 1255
frontend unit  1338 / 1338
frontend DOM    338 / 338
migrations        45   (045 applied to the dev database this session)
typecheck + lint clean, both sides
```

A caution worth carrying: **a green suite proved less than it looked.** This
session found, in the suite it inherited, a test that read the real clock and
was therefore red every weekend, a test that asserted `f.default === f.default`,
and three tests guarded by `if (x === null) return` over fixtures that never
existed. Prefer mutation-checking a new test to trusting a green one.

---

## 3. What was wrong, and is now fixed

**Five P0s**, all found by live interaction rather than by reading code:

- the Create-alert dialog **overwrote the price you typed with the live quote**
  about three seconds later, caret still in the field — and a gate row deleted
  itself 1.4s after you added it. One cause: `lastPrice` sat in the dependency
  array of the effect that seeds the dialog, so "seed on open" ran several times
  a second. This made the multi-gate alert model — the thing this campaign
  exists to preserve — unreachable from the only UI that creates it.
- **Replay advanced the clock three days without moving the chart.** The slicing
  was correct and tested; `CandleChart` simply never learned its array had been
  truncated on purpose.
- **Applying a comparison collapsed the pane** to three bars on a price scale the
  instrument had never traded in, and **removing one left a dead chart** whose
  every legend read `∅`.

Those four share one shape, worth remembering: *a fit that runs while data is
still in flight, and never runs again.* Range drew an empty plot for the same
reason.

**Safety.** The operator halt covered the manual ticket and left
`POST /api/deployments/:id/test-signal` — a real order through the same
dispatcher — ungated, while the Operations page said halting "refuses every
emission, entries and exits alike". Fixed, with both directions pinned, because
this repository has twice shipped a safety fix that trapped the exit it was
protecting. The halt is now visible in the manual panel too, so an operator is
told before they press Buy rather than after.

**Scientific truth.** Selecting `mtf_lean` rendered `ma_rr_v9`'s form; fixing the
wiring left thirteen of its *numbers* belonging to the other strategy, so a
`/research` run and a stress run of the same strategy silently ran different
strategies. The test written alongside the first fix could not have caught it.

**The icons.** The owner's complaint was correct and specific: "settings" was
drawn as a **sun** at all three call sites, the Indicators glyph was clipped by
its own box edge, and three right-rail icons had the wrong metaphor. Also: the
toolbar ran off the screen between 768 and 1231px, and the control that fell off
first was `More` — the only route to Correlation, the object tree and the data
window. Point & figure drew candle bodies instead of X/O columns; Kagi drew
diagonals instead of a staircase.

**What was NOT wrong.** Independent archaeology found **no post-Fable
regression** in icons, hover or tokens — the last commit anywhere to touch
`viewBox`, `strokeWidth` or `group-hover` is an *ancestor* of the Fable state.
A fresh Premium reviewer measured the left drawing rail, the Indicators dialog
and the chart-settings dialog as effectively identical to Premium's, and called
the icons "the strongest part of the product". The long-suspected duplicate
classical-pattern legend does not reproduce and is closed as false.

---

## 4. Exactly where to resume

Reviewer E's Wave 2 findings are open. In order:

1. **P1A** — every right-click context menu wears a 2px `rgb(79,140,255)` focus
   ring; Premium computes `outline: none`.
2. **P1A** — price-line pills half-erase the scale label beneath them; the
   suppression test is on the label's centre rather than its bounding box.
3. **P1B** — the indicator legend reserves 112px of dead space for hidden hover
   buttons; Premium's wrapper is `width:0` and the buttons overlay the value.
4. **P1B** — the indicator `⋯` menu paints *under* the next pane's legend: it is
   `z-index:91` inside a `z-[3]` stacking context and needs portalling.
5. **P1B** — `Remove` is tinted red; Premium tints nothing in these menus.
6. **P1B** — the main series legend has no hover cluster; Premium shows
   `Flag symbol` and `More`.
7. **P1B** — symbol search and Compare open onto an empty panel.
8. **P1B** — the status line wraps to two lines at 1440 with the side panel open;
   the contract says a legend clips rather than wraps.
9. **P1B** — `∅` is printed where a price belongs.

Then the required flow, none of which has run: convergence review A → fix →
convergence review B → **two consecutive clean material rounds** → full
authoritative validation → final fresh Premium acceptance → final report →
safe fast-forward of owner `main` → prove `main == origin/main`.

---

## 5. Two process rules learned the hard way

- **Do not run a test suite while editing the tree.** Two DOM runs were
  corrupted before this was adopted.
- **Give every reviewer a private scratch directory.** Wave 1 shared one; a
  reviewer's helper was overwritten and ~25 minutes of its commands executed
  against a different reviewer's browser. That evidence was discarded and
  re-gathered.

The browser fleet is `scratchpad/tvdrv.mjs <profile> <port>`. Profiles are
**copies** of `ms-playwright/tradingview-premium`, so another Claude session's
Chrome keeps its lock and is never disturbed. Premium entitlement was proven,
not assumed: `pro_premium_trial`, `is_pro: true`, badge "Premium Trial".

## 2026-10-11 nonvisual continuation

The accepted Claude/Opus campaign remains the baseline. Subsequent objective
engineering corrections and independent reviewer adjudication are recorded in
[NONVISUAL_ENGINEERING_CLOSURE_2026-10-11.md](NONVISUAL_ENGINEERING_CLOSURE_2026-10-11.md)
and [NONVISUAL_FRESH_REVIEW_2026-10-11.md](NONVISUAL_FRESH_REVIEW_2026-10-11.md).
Use that closure document's current validation and Git evidence rather than
historical counts above. Its `FABLE_OPUS_VISUAL_QUEUE` is the durable queue for
the next gate. No main promotion, Fable launch, or subjective redesign occurred.

Fable/Opus should inspect the final canonical campaign state, perform live visual
and interaction acceptance, and adjudicate the queued inherited items. Preserve
the tested engine, fail-closed workflow and Bot exit contracts. Engineering
readiness is not full release approval; main remains deliberately unpromoted.
