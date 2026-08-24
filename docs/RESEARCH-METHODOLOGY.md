# Research methodology, and what the published numbers do and do not mean

**Status:** current.

This page exists because the audit's single most consequential finding is not a
bug in the engine — it is that **the way winning configurations were chosen
re-used the data meant to check them**, and nothing in the repository said so.
The numbers are not fabricated. Their *interpretation* was wrong.

Read this before treating any leaderboard figure, any `WIN_QUALITY` report, or
any `ANALYSIS_*` document as evidence.

---

## 1. The selection problem (`OPT-01`)

The pipeline correctly splits history into in-sample and out-of-sample. The
selection step then picks the configuration that scores best on **both**:

```
gates    : >=50 IS trades, >=30 OOS trades
           net > 0 on both sides
           profit factor >= 1.10 on both sides
           drawdown <= 3.0% on both sides
maximise : min(WR_is, WR_oos)          <- the lower of the two win rates
```

Every one of those reads the out-of-sample window. So OOS is not a validation
set for anything deployed — it is a second selection criterion, and the reported
IS/OOS agreement is a **selection artefact**, not evidence of robustness.

The chain to real money was traced end to end by the audit:
`platform/backend/scripts/analyze_lean15m_win_quality.py` → the `LEAN15M_WIN_QUALITY_*.json`
artifact → `platform/deployment/aws/replace_mtf_lean15m.mjs` reads its
`full_params` → `INSERT INTO deployments`. The analysis script's own emitted
metadata says *"OOS is optimized here and is consumed; forward/paper validation
is mandatory."* Nothing in the pipeline enforced that sentence.

**Corroborating evidence, all from inside this repository:**

- `platform/backend/holdout1h/HOLDOUT_REPORT.md` — the mean rank correlation
  between in-sample leaderboard rank and out-of-sample net is **+0.03**, where
  1.0 would be perfect. In-sample rank has essentially no predictive power.
- `platform/backend/lean_optimizer15m/BEST_CONFIGS.md` — 9 of the 15 deployed
  coins are tier-C, with as few as **4** surviving configurations out of roughly
  206,600 candidates.
- `reports/watchlist_backtest_2026-07-09.json` — the same strategy family at the
  owner's real chart inputs returns **−87 % to −97.6 % across all 19 symbols**
  for Dec 2025 – Jul 2026, with the author's own conclusion that round-trip
  commission over thousands of trades destroys the capital.

### What is in place now

`platform/backend/src/engine/holdout.ts` defines a **third window, taken from
the end of the range, that no selection step may read**, and
`assertWindowUsage(window, purpose)` throws when one tries. It is an error, not
a warning: `OPT-05` records that the leaderboard CLI already printed a warning
about out-of-sample leakage, directly beside seven OOS sort modes each ending
with a one-keystroke "Apply one" command. A warning next to an easier path is
not a control.

`evaluateClearance` is the deploy gate. Its most important property is that
**absence of a holdout result is a refusal, not a pass** — the failure being
prevented is a configuration reaching production because nobody could tell
"validated" from "never checked". It also refuses a result scored against a
different window than the one now frozen, because a holdout that moves is not a
holdout (`OPT-18`).

### The gate is now wired into the deploy path

`platform/deployment/aws/lib/holdoutGate.mjs` enforces it in all four
`replace_*.mjs`. **Absence of a holdout result is a refusal, not a pass.** The
frozen window and the thresholds come from the deploy artifact, not from the
deploy invocation, so a window cannot be chosen to fit; one uncleared coin
refuses the whole portfolio, because those scripts replace it as a set.

A deliberate override exists — `HOLDOUT_GATE=off` **together with**
`HOLDOUT_OVERRIDE_REASON`, both printed prominently — because the failure being
prevented is silent passage, not a considered decision by the owner.

**No current artifact carries a holdout block, so those scripts will refuse
until one is scored.** The refusal names the exact fields to add. Producing the
score requires running a tree over the frozen window, which needs the market
data and database this checkout does not have.

### What is NOT in place

Nothing has been re-selected, and no tree has been re-run. Those are explicitly
out of scope here and require the owner's decision (`M8`). The existing
selections remain as they are, and the reports that describe them now say what
they are.

---

## 2. The unresolved multi-timeframe convention (`BE-08`) — **BLOCKED**

`platform/backend/src/engine/mtf.ts` contained a header asserting one convention and an
implementation using another:

| | cutoff |
|---|---|
| header claimed, higher TF | last feed bar with `closeTime <= chart bar's OPEN` |
| header claimed, lower/equal TF | last feed bar with `closeTime <= chart bar's CLOSE` |
| **implemented, all TFs** | `closeTime <= chart bar's CLOSE` |

If the header was right, every `ma_rr_v9` and `srtrend_v10` result carries one
bar of higher-timeframe **look-ahead**, because neither strategy applies a
compensating shift. `mtf_lean` does — it gates on `htfClosed` and then
`shift(src, 1)` — which is why it is unaffected either way, and why the two
families cannot be compared until this is settled.

The code's inline comment cited a *"DEXE parity run 2026-07-11"* as
verification. Those artifacts lived in a `parity` directory under
`platform/backend`, which is gitignored and **absent from every clone**, so the
claim cannot be checked from source. `platform/README.md` separately records the parity run as "deferred".

### Why it is blocked

Settling it requires a side-by-side comparison against TradingView. This
workspace has no TradingView account and is not permitted to obtain one, and the
parity artifacts do not exist here. **`M3`** (were the parity artifacts
gitignored or lost?) and a TradingView comparison are both owner actions.

### What is in place instead — nothing guesses

- The convention is an **explicit parameter**: `MERGE_CONVENTIONS` is
  `["chartClose", "chartOpen"]`, both are implemented, and
  `MTF_MERGE_CONVENTION` selects one.
- The **default is `chartClose`** — bit-for-bit what the code always did — so no
  stored result is invalidated by this change. A test asserts the default
  reproduces the previous indices exactly.
- Both conventions are asserted **not to leak the future**:
  `analyseLookahead` confirms no chart bar sees a feed bar that closed after it,
  under either. That reduces BE-08 from "does the code cheat" to "does
  TradingView delay by one bar" — a question one comparison answers.
- `compareConventions` emits the **bar-by-bar table to run that comparison
  against**, filtered to the bars where the two actually differ. A bar where
  they agree cannot settle anything.

### The exact test to run

On a 15m TradingView chart:

```pine
plot(request.security(syminfo.tickerid, "60", close))
```

Read the plotted value on the bar **closing at 10:00**. Compare it against
`compareConventions(...)`'s `underChartClose` and `underChartOpen` for the same
bar. Whichever matches is the answer; then change
`DEFAULT_MERGE_CONVENTION` and re-run every affected tree.

---

## 3. Engine corrections are opt-in, and every result says which engine made it

Several findings are corrections to the backtest engine, and each changes what a
historical number means. The generated result data is gitignored and absent
(`OPT-08`), so it cannot be recomputed here — and **half-corrected leaderboards
are worse than uncorrected ones, because the two cannot be told apart.**

So every correction is a named flag, **off by default**, with the pre-existing
behaviour preserved bit-for-bit when off. Enable them with:

```
ENGINE_CORRECTIONS=netAvgTrade,exchangeFilters   # or `all`
```

An unrecognised name is a hard error, not a silent no-op: a typo that disabled a
correction someone believed was on would reintroduce exactly the ambiguity this
is meant to remove.

| Flag | Finding | What it changes | Invalidates stored results? |
|---|---|---|---|
| `netAvgTrade` | `BE-05` | `avgTradePct` is derived from net P&L instead of raw price change. | That metric only |
| `exchangeFilters` | `BE-07` | Applies the `stepSize`/`minNotional` already stored and read by nothing; a leg the exchange would reject is dropped and the position stays open. | **Yes, unpredictably** |
| `leanWarmupFloor` | `BE-09` | Gives `mtf_lean`'s three ratcheting Supertrends the same 1500-bar floor `ma_rr_v9` already applies. | Yes, slightly — and it makes them reproducible |
| `zeroPnlIsScratch` | `BE-10` | An exact-zero trade is neither a win nor a loss, and is excluded from both sides of the win rate. | Only where such a trade exists |
| `assertSegmentValidity` | `BE-06` | Throws when IS/OOS metrics are computed on a compounding run, and attributes a boundary-straddling trade by its EXIT. | The recorded split only |
| `entryBarBrackets` | `BE-04` | `ma_rr_v9` and `srtrend_v10` issue brackets on the fill bar, as `mtf_lean` already does. | **Yes — every leaderboard number for those two moves** |

`correctionsFingerprint()` is recorded on every backtest output, so a stored
result always says which engine produced it. That is the property whose absence
made the cost-model contradiction in `X-09` unresolvable.

**None of the implemented corrections depends on resolving BE-08.** The
`BE08_DEPENDENT` list and `assertNotBe08Dependent` exist so that a future
correction which *is* dependent cannot be added without declaring it.

---

## 4. Reproducibility

Not achieved, and the reason is structural rather than an oversight.

`.gitignore` excludes the `results`, `best`, `index` and `archive` directories,
plus `SUMMARY.json` and `seeds.json`, under every tree (KNOWN-ABSENT) — correctly, because the data
reaches tens of gigabytes — and `find platform/backend -maxdepth 2 -type d -name
results` returns **nothing**. So every evaluation count in
`BACKTESTING_SYSTEMS.md` is unverifiable from a clone, and the archive cited by
`PARAMETER_REDUCTION.md` is both gitignored and, in the case of the
permutation-control script itself, absent from the repository entirely
(`OPT-08`).

What that means in practice: **no published leaderboard number in this
repository can be reproduced from source.** Labelling those documents honestly
is the only remedy available without the data, and that is what the status
banners on them do.

`OPT-08` is half-fixed, and the half that is fixed is the half that could be.
The generated data stays out of the repository — it runs to tens of gigabytes —
so a clone still cannot re-derive a historical number. What a clone CAN now do
is tie a result to its inputs: from 2026-08-24 every round writes
`<tree>/index/runs.jsonl` recording the content hash of `params.json`,
`base_params.json`, `config.json`, `coins.txt`, `idmap.json`, `seeds.json` and
`evalWorker.ts`, plus the objective, the coin list, the node version and the
checked-out revision — and every result record carries that run's id. **A result
with no `run` field predates this and cannot be tied to a search space.** That
is every result currently on disk.

`OPT-06` — the GA was not deterministic across restarts. It seeds from
`random_seed + (h % 1000)`, and resuming replays the whole history through
`tell()`, which does not advance the RNG: a process resuming at evaluation
10,000 started from the same RNG state as a fresh one, while a process that had
run continuously to 10,000 was somewhere else entirely. The documented
`random_seed: 42` therefore did not make a run reproducible even with the data
present.

**Fixed.** The RNG state is persisted beside the results and restored on resume,
so a resumed run continues exactly where it stopped;
`platform/backend/tests/gaDriver.test.ts` shows a resumed driver reproducing a
continuous one's next twenty candidates. `platform/backend/lean_wf_15m/wf.ts`
was already deterministic — it never resumes — and both now use one shared
driver whose equivalence with the original is pinned by that same test file.

---

## 5. Cross-tree comparison is invalid unless the cost models agree

See [COST-MODELS.md](COST-MODELS.md) for the measured per-tree table. The two
rows that are not comparable with the rest, and why:

- **`optimizer1y1h`** — the only tree with `slippageTicks: 0`, the only one with
  no IS/OOS split, and the only one that compounds (`qty_pct_equity: 100`). Its
  headline figures, including the +3114 % for DEXEUSDT in `ANALYSIS_1H_1Y.md`,
  are fully in-sample, zero-slippage and fully compounded (`OPT-03`).
- **`lean_wf_15m`** — its own `config.json` claimed the search space was
  "exactly as `lean_optimizer15m` has it (qty_pct_equity still searched)". Both
  halves were false: production searches 18 parameters and pins
  `qty_pct_equity` to 0; the walk-forward searches 30 and includes it. **The
  current production search space has no walk-forward evidence at all**
  (`OPT-02`). The claim is corrected in place, every walk-forward tree now
  declares `spaceDivergesFromProduction` in its `tree.json`, and
  `scripts/ci/check-docs.sh` recomputes that claim from the two parameter lists.
  Four of the five diverge; `wf6m_1h` is the only one that matches.

### Metric-definition hazards

- `OPT-04` — **fixed.** `win_rate` and `profit_factor` are leg-based in every
  tree, while `trades` is entry-based in the two MTF Lean trees (deliberately,
  so `min_trades` is not inflated ~13× by partial take-profits).
  `riskPerTrade()` multiplied the entry count by the leg win rate, and its
  output feeds `multiPick`'s Pareto vector — one of the three pre-declared rules
  the walk-forward exists to *compare*.

  The solver was worse than the mixed counts. It bisected `[1e-7, 0.95]` and
  fell back to a grid search whenever the endpoints shared a sign — which is
  almost always, because the target function is unimodal with a root on each
  side of its peak. The fallback returned the *argmax*, the peak-growth
  fraction, not a root, and it was not monotone in net: on a real Lean record,
  20 % net implied 33.3, 50 % implied 1.2, 120 % implied 31.5. The rule was
  ranking on noise. It now counts the population the rates describe, returns the
  smallest fraction that reproduces the multiple, and returns `null` when no
  fraction does. `platform/backend/tests/selection.test.ts` pins all of it,
  including the old version's non-monotonicity.

- `OPT-09` — GA winners cluster exactly on the `min_trades` floor. SYNUSDT,
  KAITOUSDT and EIGENUSDT all win with **31** trades against a floor of 30,
  reporting +2799 %, +494 % and +342 %. Maximising over ~1e19 candidates with a
  hard floor produces winners at the floor by construction: the fewer trades a
  result rests on, the more of its return can be luck, and the search is free to
  find the luckiest such result. The leaderboard API marks those rows and the
  optimizer page shows a `floor` badge with that explanation. The finding is
  *surfaced*, not removed — removing it means raising the floor, which is a
  research decision (`M8`).

### The remaining interpretation findings

None of these is a code defect; each is a limit on what the numbers support.
They are recorded here because the reports themselves did not say them.

- `OPT-10` — `platform/backend/lean3y15m/configs/DEXEUSDT.json` (gitignored,
  KNOWN-ABSENT from a clone): all 1,000 top-ranked configs
  carry `qty_pct_equity: 100`. Under the old objective the leaderboard was
  ranking **leverage**, not edge. The live tree is now pinned to fixed cash, but
  the 3-year replay still runs that leverage-selected pool at fixed size, so it
  answers a confounded question. Its `tree.json` says so.
- `OPT-13` — the coin universe came from a 2026-08-10 screenshot, and six coins
  were dropped **after** their results were seen (`ANALYSIS_1H_1Y.md`). Every
  aggregate over that universe is survivorship-conditioned, and the survivors
  skew to 2025-26 listings with large one-way trends. Fixing this means
  declaring a universe rule before looking — an owner decision (`M8`).
- `OPT-14` — the Wilson lower bounds are **maximised** over millions of
  candidates, which is not what a lower confidence bound is for: taking a
  maximum over many bounds reproduces the selection bias the bound was meant to
  remove. The consensus z-test's null assumes uniform sampling, which is false
  for GA output — a GA concentrates its draws where it is already winning — and
  no multiplicity correction is applied over the number of parameters tested.
  Treat both as descriptive, not inferential.
- `OPT-18` — `range.end: "now"` makes every out-of-sample metric depend on when
  it was computed, so two records for the same genome are not comparable across
  days, while `platform/backend/scripts/indexed_results.py` de-duplicates by
  `(coin, genome)`.
  `evaluateClearance` refuses a holdout result scored against a different window
  than the one now frozen, which is the same hazard caught at the deploy gate: a
  holdout that moves is not a holdout.
- `OPT-19`, `OPT-20`, `OPT-21`, `OPT-22` — grouped in the register as
  metric-interpretation, cost-sensitivity, parity-harness and fill-realism
  issues, with no individual descriptions published. What is verified and
  addressed of that group is above and in [COST-MODELS.md](COST-MODELS.md): the
  metric definitions (`OPT-04`), the per-tree cost models and their
  incomparability (`OPT-03`), and the fill-realism gap between the backtest's
  stop fill and the live path's next-bar-close exit, which is `BE-02` and is
  gated on `BE-08`. Nothing further can be resolved without the individual
  descriptions.

---

## 6. What is worth preserving

A remediation plan should not damage these, and none of them was changed:

- `platform/backend/holdout1h/report.py` — Spearman rank correlation between in-sample rank and
  holdout net, framed as a distribution rather than a maximum. The most honest
  statistical work in either repository, and the source of the +0.03 figure.
- `platform/backend/lean_wf_15m/wf.ts` — a genuinely correct walk-forward: a fresh search per
  fold, training window only, three pre-declared selection rules, and frozen
  scoring on an untouched test block. The defect is what it was pointed at, not
  how it works.
- `platform/backend/optimizer1y15m/PARAMETER_REDUCTION.md` — a real permutation control with
  fixed subset sizes, randomised membership, 40 trials, excess-over-null in
  standard deviations, and an exemplary caveats section.

---

## 7. Open owner decisions

| Ref | Decision |
|---|---|
| `M3` | Were the parity artifacts under `platform/backend/parity` gitignored or lost? They are KNOWN-ABSENT from every clone. |
| `M8` | The frozen-holdout policy: what fraction, and what clearance thresholds. `holdout.ts` defaults to a fifth of the range with `minTrades: 30, minNetPct: 0`, and those are placeholders for a research decision, not recommendations. |
| `M8` | The objective universe rule. `OPT-13` records that the coin list came from a 2026-08-10 screenshot and that six coins were dropped **after** their results were seen, so every aggregate is survivorship-conditioned. |
| `M7` | Whether to wipe or formally retire `optimizer1y1h` (`OPT-03`, `2.12`). |
| — | A TradingView comparison to settle `BE-08`, using the procedure in §2. |
| — | Whether to re-run any tree at all. Nothing here has been re-run, and every correction that would require it is off by default. |
