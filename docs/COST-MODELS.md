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

`POST /api/backtests` defaults `commissionPct` to 0.05 — half what every
optimizer tree uses. A backtest run through the app is therefore *not* directly
comparable to a leaderboard row unless the caller passes `commissionPct: 0.1`
explicitly. This is a live defect and is tracked in the remediation ledger.

## Where the numbers come from

Machine-checked by `scripts/ci/check-docs.sh`, which reads every
`platform/backend/*/config.json` and fails when this table disagrees with it, or
when a tree named here is absent from disk.
