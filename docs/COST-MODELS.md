# Cost models

**Status:** current. Generated from each tree's own `config.json` file; verified in CI
by `scripts/ci/check-docs.sh`.

Finding `X-09` recorded a three-way contradiction between
`OPTIMIZATION_SYSTEM_BLUEPRINT.md` ("0.05 % commission, 2 ticks"),
`CLAUDE_HANDOFF.md` ("0.1 %, 0 ticks") and the backtest API default
(`commissionPct: 0.05`). Those documents were describing intent, not the
configuration the trees actually ran.

This page records what the configurations actually contain. It deliberately does
**not** force one figure onto every tree: the trees answer different questions
and some were built to be non-comparable on purpose. What matters is that each
tree's model is stated, and that a comparison across trees is only made between
rows that agree.

## Per-tree model, read from each tree's `config.json`

| Tree | Timeframe | Initial capital | Commission % / side | Slippage ticks | Sizing | IS/OOS split |
|---|---|---|---|---|---|---|
| `lean_optimizer15m` | 15m | 10 000 | 0.1 | 2 | fixed $1 000 cash (`qty_pct_equity` pinned to 0) | `range.split` |
| `optimizer1y15m` | 15m | 10 000 | 0.1 | 2 | fixed $1 000 cash | `range.split` |
| `optimizer1y5m` | 5m | 10 000 | 0.1 | 2 | fixed $1 000 cash | `range.split` |
| `optimizer1y5m_ma` | 5m | 10 000 | 0.1 | 2 | fixed $1 000 cash | `range.split` |
| `optimizer1y1h` | 1h | 1 000 | 0.1 | **0** | `qty_pct_equity: 100` (full compounding) | **none** |
| `lean_wf_15m` | 15m | 1 000 | 0.1 | 2 | searched (see note) | walk-forward folds |
| `lean_wf_fixedsize` | 15m | 1 000 | 0.1 | 2 | fixed 20 % of equity | walk-forward folds |
| `optimizer1y15m_wf` | 15m | 1 000 | 0.1 | 2 | searched | walk-forward folds |
| `optimizer1y1h_wf_trail` | 1h | 1 000 | 0.1 | 2 | searched | walk-forward folds |
| `wf6m_1h` | 1h | 1 000 | 0.1 | 2 | fixed $1 000 cash | walk-forward folds (6-month blocks) |
| `holdout1h` | 1h | 1 000 | 0.1 | 2 | fixed $1 000 cash | pre-optimizer holdout |
| `full3y1h` | 1h | 1 000 | 0.1 | 2 | fixed $1 000 cash | `splitDate` |
| `lean3y15m` | 15m | 1 000 | 0.1 | 2 | fixed $1 000 cash | `splitDate` |

**Commission is 0.1 % per side — 0.2 % round trip — in every tree.** No tree uses
0.05 % or 0.075 %. Those figures appear only in prose.

## The two rows that are not comparable with the rest

- **`optimizer1y1h`** is the only tree with `slippageTicks: 0`, the only one with
  no in-sample/out-of-sample split, and the only one that compounds
  (`qty_pct_equity: 100`). Its headline numbers — including the +3114 % for
  DEXEUSDT in `ANALYSIS_1H_1Y.md` — are fully in-sample, zero-slippage and fully
  compounded. `BACKTESTING_SYSTEMS.md` already quarantines it; treat every figure
  from it as non-comparable rather than merely optimistic. (`OPT-03`)
- **`lean_wf_15m`** states in its own `config.json` that its search space is
  "exactly as `lean_optimizer15m` has it". Measured directly, the production tree
  searches 18 parameters and the walk-forward searches 30, including
  `qty_pct_equity`. The current production search space therefore has no
  walk-forward evidence. (`OPT-02`)

## Slippage is per tick, not per cent

`slippageTicks: 2` costs a different percentage on every symbol, because a tick
is the symbol's `PRICE_FILTER.tickSize`. `platform/backend/lean_optimizer15m/config.json` records
the spread itself: roughly 0.217 % on RIFUSDT against 0.004 % on ZECUSDT for the
same two ticks. Two coins under one "identical" cost model are not paying the
same cost.

## Platform backtest API

`POST /api/backtests` now defaults `commissionPct` to **0.1**, the same figure
every tree runs, alongside `slippageTicks: 2` and `initialCapital: 1000`. The
three defaults are named constants in
`platform/backend/src/api/routes/backtests.ts` and the chart's
`DEFAULT_PROPERTIES` states the same commission; a test asserts all of them
against the trees' own `config.json` files.

It previously defaulted to 0.05 — half the real friction — so an app backtest
could not reproduce the leaderboard row it was meant to check, and nothing on
screen said so. Runs already stored keep the cost model they actually ran under,
because each row records its own `commissionPct`; a chart backtest run before
this change is therefore still a 0.05 % run and is not comparable with one run
after it.

`POST /api/pine/run` is a script editor rather than a strategy reproduction and
keeps its own defaults (`commissionPct: 0.1`, `slippageTicks: 0`, `qtyCash:
930`). `930` is not a stray figure: it mirrors `default_qty_value = 930` in the
Pine strategy declaration, and the engine's `ma_rr_v9` / `srtrend_v10` parameter
defaults mirror it too.

## The tree registry

Each tree owns a `tree.json` naming its id, strategy, timeframe, system, kind
(`search` / `walk-forward` / `holdout` / `replay`) and status (`current` /
`historical` / `not-comparable`). `platform/backend/src/optimizer/registry.ts`
discovers them under `OPTIMIZER_ROOT` — or, unset, the backend directory rather
than the process working directory — and the optimizer API and the UI's tree
list are both driven from it.

Before this, four hardcoded directory names were mapped, all four were absent,
and nine trees that exist had no route at all: the default optimizer view
returned an **empty leaderboard with HTTP 200** (`X-04`). An unknown or absent
tree now answers 404 naming the trees that do exist, and a tree that is
registered but has produced no results yet says exactly that.
`scripts/ci/check-docs.sh` fails when a tree has a `config.json` but no
registry entry.

## Where the numbers come from

Machine-checked by `scripts/ci/check-docs.sh`, which reads every
`platform/backend/*/config.json` and fails when this table disagrees with it, or
when a tree named here is absent from disk.
