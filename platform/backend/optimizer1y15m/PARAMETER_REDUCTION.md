# Parameter reduction — 15m MA + R:R (optyear), 2026-08-21

Cut the search space from **31 parameters to 7**. This note records how that
number was arrived at, because the reasoning matters more than the result.

## The problem

The 31-parameter space held **1.5 × 10¹⁹** combinations. 7,242,202 evaluations
had been spent on it — that is **0.00000000005%** coverage. At that density a
genetic algorithm is not optimising; it is drawing near-random samples and
reporting the maximum. Any "best value" it finds for a parameter is largely a
record of which draws happened to land well.

## The naive measure, and why it lies

The obvious importance metric is **pin cost**: for each parameter, how much
score is lost if you pin it to one global value instead of tuning it per coin.
Computed over all 7.2M evals, it produced a clean-looking ranking, from
`useSuperTrend` (7.4) up to `hhPivotLen` (453.3).

That ranking is almost entirely an artefact. Pinning a parameter to one value
restricts you to the subset of evals that used it, and **the maximum of a
smaller sample is lower purely by chance**. Pin cost therefore measures subset
size, not parameter importance.

## The control

For each parameter, the per-value subset sizes were held fixed and membership
randomised — 40 trials, sampling from the same per-coin score distribution.
That gives the pin cost expected from chance alone. The real quantity of
interest is the **excess** over that null, in standard deviations.

| verdict | z | count | parameters |
|---|---|---|---|
| **REAL** | > 4 | 4 | `hhPivotLen` (9.6), `rrRatio` (7.7), `volMultMin` (4.9), `runMaxPct` (4.4) |
| **weak** | 2–4 | 3 | `hlBreakPivLen` (2.7), `ma1_slopeLb` (2.5), `volMaLen` (2.5) |
| **chance** | < 2 | **24** | everything else |

Twenty-four of thirty-one parameters could not be distinguished from noise.
For several — including all four `ma*_len` and most `ma*_slopeLb` — the observed
pin cost was *below* the null, i.e. **less** informative than a random split.

A second signal was cited here as agreeing, and read the wrong way round
(`OPT-15`). The figures were: across the 23 per-coin winners, chance-level
parameters landed at 43–48% against a 33% coin-flip share (3 values), while
high-pin-cost parameters sat at 22–30% against 20% (5 values) or 14% (7 values).

Those percentages are **not comparable**, because the groups have different
numbers of values. On the only scale that is comparable — concentration over
chance — the chance-level group is at 1.3–1.45× and the high-pin-cost group at
1.1–2.1×. The high-pin-cost parameters are therefore *at least as* concentrated,
which is the opposite of the reading the sentence gave. The signal does not
support the conclusion; it is inconclusive. The permutation control below is the
real evidence, and it stands on its own.

## What changed

- **8 tunables kept.** Space is **370,440** combinations — exhaustively
  searchable, so the GA can actually converge.
- **Pinned** in `base_params.json`, each at its lowest-average-regret value.
  For a chance-level parameter that choice is close to arbitrary — which is the
  point: it does not matter. `useLocalTrend` and `useRunLimit` were coin-flips
  and are pinned **off**, preferring the simpler strategy with fewer things to
  overfit.

> **Corrected 2026-08-24 (`OPT-15`).** This section previously read "7 tunables
> kept", "**185,220** combinations", and listed `useSuperTrend` among the three
> switches pinned off. Measured from `params.json`: there are **8** searched
> parameters and **370,440** combinations, and `useSuperTrend` is one of them,
> searched over two values — it does not appear in `base_params.json` at all.
> The doubled count is exactly that parameter. `scripts/ci/check-docs.sh` now
> recomputes both figures from `params.json` and fails when this page disagrees
> with it.
- **`dd_weight` 1.0 → 2.5**, **`min_trades` 30 → 50**, matching the Lean trees.

## Caveats, stated plainly

- The analysis was run on scores produced under the **old cost model** (capital
  1000, zero slippage, no IS/OOS). Those scores are gone as a scoring basis;
  what survives is the *structural* finding — which knobs carry information —
  and that is not sensitive to the cost model.
- z > 2 means "distinguishable from chance", not "profitable". The 7 survivors
  earned a place in the search, not a guarantee of edge. The OOS column is now
  the arbiter of that, and it is the reason the split was added.
- Pinning 24 parameters at once is not the sum of 24 individual pin costs;
  interactions are not measured here. The OOS numbers on the rebuilt tree are
  the check on whether the reduction cost anything real.

## Reproducing

Archived inputs: `archive/reduce_20260821/` (5.5 GB, 7.2M evals, 23 coins) —
preserved on the machine that produced them, and **not in this repository**:
`.gitignore` excludes `archive/` along with `results/`, `best/` and `index/`,
because they run to tens of gigabytes. The permutation-control script that
produced this analysis is likewise absent. Nothing here can be re-derived from a
clone (`OPT-08`).

Runs from 2026-08-24 onward are traceable even though their data is not
committed: every round writes `index/runs.jsonl` recording the content hash of
`params.json`, `base_params.json`, `config.json`, `coins.txt`, `idmap.json`,
`seeds.json` and `evalWorker.ts`, plus the objective, the coin list, the node
version and the checked-out revision — and every result record carries that
run's id. A result with no `run` field predates this and cannot be tied to a
search space.
