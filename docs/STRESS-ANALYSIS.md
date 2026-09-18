# Stress-regime analysis

**Status:** current. Added 2026-09-18.

A strategy can pass a development window and a validation window and still be a
strategy that has never met a bad market. Stress analysis asks the adversarial
question instead: take the periods in which the market itself behaved worst,
and see what the strategy did in them.

---

## What this evidence is, and what it is not

**Stress windows are chosen by searching history for the benchmark's worst
stretches. That is ex-post by construction.**

It measures robustness against conditions already known to be bad. It is
emphatically **not** out-of-sample evidence: the windows were selected because
of what happened in them, so a result over them carries no confidence interval
and supports no claim about the future.

`STRESS_EPISTEMIC_NOTE` in `platform/backend/src/engine/stress.ts` is the
sentence that says so. It is stored **on the discovery record itself** rather
than left to whatever renders it, it is returned by every stress route, and
`/stress` shows it as a warn notice **above** the numbers — not as a footnote
and not behind a disclosure. A stress score placed beside a holdout score with
nothing between them invites exactly the reading this analysis cannot support.

Three kinds of window now exist in the product and they must never be presented
as interchangeable:

| Window | Where | What it is |
|---|---|---|
| Development (in-sample) | `engine/holdout.ts` `splitWindows` | the stretch a strategy was built against |
| Out of sample | same | not developed on — but, in this product's own optimizer history, *selected* on |
| Holdout (frozen) | same | the last fraction. Reported once, never selected on |
| Stress | `engine/stress.ts` | chosen with hindsight. Adversarial, not unbiased |

---

## The invariant that makes it worth running

**Windows are discovered from benchmark MARKET DATA and from nothing else.**

If strategy performance could reach the selector, the report would be "here are
the periods where the strategy did badly, and look, it did badly" — circular,
and worse than not running it.

The guarantee is structural rather than documentary. `discoverStressWindows`
takes candles and a configuration; there is no parameter through which a trade,
an equity curve or a metric could arrive. `tests/stressWindows.test.ts` asserts
the function's arity and the config's key set, so a third parameter cannot be
added quietly. The `/stress` page's `Find the windows` control exists for the
same reason: it runs discovery **with no strategy named**, so a user can see the
independence rather than take it on trust, and a DOM test reads the request the
page actually makes and fails if a strategy, config or param set ever travels
with it.

---

## Benchmarks

The benchmark is named **independently of the traded instrument**, and may be
it. "How does my SOL 15-minute strategy behave when BTC falls apart" is a
different and usually better question than asking about SOL, because crypto
drawdowns are substantially common-factor.

`resolveBenchmark` (`api/routes/stress.ts`) is an abstraction with one supported
kind today: any instrument whose candles this install stores, with its provider
named in the provenance. **Broad-market stress (S&P 500 and similar) is not
supported**, and is not faked: this install has no trustworthy historical
provider for it. Adding one is a second kind behind the same interface, and
changes nothing about discovery, which reads candles and knows nothing about
where they came from.

---

## Methods and configuration

| Method | Ranks on |
|---|---|
| `worst_return` | most negative close-to-close move over the window |
| `deepest_drawdown` | largest peak-to-trough fall inside the window |
| `highest_volatility` | realised volatility of bar returns |
| `manual` | windows the user named; ranked by date |

Every window reports **all three** benchmark statistics whichever one it was
ranked on, so "worst" is never taken on trust, and `selectedBy` names the metric
and the exact value the ranking used.

- **Ties break on the earlier window.** Equal severity is common on flat or
  synthetic data, and without a total order the top N would depend on array
  order — the same inputs producing different reports on different days.
- **`minSeparationBars` defaults to the window length.** A rolling window one
  bar left of the worst window is the second-worst, so an unseparated top five
  is one crash five times.
- **`topN` is a ceiling, not a promise.** A benchmark that cannot hold N
  separated windows returns fewer; padding would mean inventing episodes.
- **Manual windows snap to benchmark bars**, and a window naming a period the
  benchmark does not cover is refused rather than clipped — clipping would
  report statistics for a period the user did not ask about.

---

## Execution

Each discovered window runs as an **ordinary backtest**: same engine, same
correction set, same warm-up, same no-lookahead guarantees, claimed by the same
worker. A stress run is a *coordinator* that records how the windows were chosen
and which runs answered them.

Stress analysis adds no execution path, and must not — if it did, its numbers
could not be compared with the development and holdout numbers they exist to be
compared against.

A partial failure stays `done`: a report over four of five windows is a real
report, and the per-window status is on each child.

---

## Reproducibility

`StressProvenance` (`stress-discovery.v1`) is stored with every run:

- benchmark symbol, canonical instrument, interval, provider id, feed id —
  *"BTC's worst week" is a different week on a different venue's series*
- the period **searched** (not the periods returned), and its bar count
- method, window length, top-N, separation rule, manual windows
- the epistemic note, restated on the record so a stored result cannot lose it

Replaying the stored config reproduces the stored windows; a test asserts it.

---

## Routes

| Route | Purpose |
|---|---|
| `POST /api/stress/windows` | discovery only. Names no strategy, and cannot. |
| `POST /api/stress/runs` | discovers, then queues one ordinary backtest per window |
| `GET /api/stress/runs` | previous runs |
| `GET /api/stress/runs/:id` | a run, its windows, and whatever the worker has made of them |

Storage: `stress_runs` (migration 042). Per-window results live in `backtests`.

---

## Evidence

17 unit tests in `platform/backend/tests/stressWindows.test.ts` cover ranking,
ties, overlap suppression, separation, insufficient history, the empty
benchmark, invalid configuration, manual windows, bar alignment,
reproducibility, benchmark independence and the epistemic note. Six DOM tests in
`platform/frontend/tests/dom/stressSurface.test.tsx` cover the discovery
request's contents, the caveat's presence and placement, and the windows panel.

Runtime, on this install: BTC 1d 2025-01-01→2026-09-01, 609 bars searched, worst
21-bar windows by return — 2026-01-16 (−34.16 %), 2025-11-02 (−23.34 %),
2026-05-16 (−21.87 %), distinct and non-overlapping. An `mtf_lean` SOLUSDT 1h
strategy through those three BTC windows returned −0.17 %, −0.40 % and −0.37 %
on one trade each.
