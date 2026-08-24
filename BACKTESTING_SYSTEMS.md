# Crypto backtesting systems — overview

_Generated 2026-08-22._

Five independent genetic-algorithm optimizers, each with its own window, cost
model, search space and result store. They share the backtest engine in
`platform/backend/src/engine/` but never share state.

| tree | strategy | TF | service | evals | coins | tunables | search space |
|---|---|---|---|---|---|---|---|
| [`lean_optimizer15m`](platform/backend/lean_optimizer15m/README.md) | MTF Confluence Lean | 15m | **running** | 4,671,836 | 19 | 18 | 132,765,696,000 |
| [`optimizer1y5m`](platform/backend/optimizer1y5m/README.md) | MTF Confluence Lean | 5m | **running** | 3,476,704 | 19 | 18 | 132,765,696,000 |
| [`optimizer1y15m`](platform/backend/optimizer1y15m/README.md) | MA + R:R Strategy v5 | 15m | **running** | 1,284,934 | 17 | 8 | 370,440 |
| [`optimizer1y5m_ma`](platform/backend/optimizer1y5m_ma/README.md) | MA + R:R Strategy v5 | 5m | stopped | 540,228 | 16 | 8 | 740,880 |
| [`optimizer1y1h`](platform/backend/optimizer1y1h/README.md) | MA + R:R Strategy v5 | 1h | **running** | 369,750 | 17 | 31 | 14,765,025,303,000,000,000 |

**Total: 10,343,452 evaluations.**

## Shared engine

| module | role |
|---|---|
| `src/engine/backtester.ts` | bar loop |
| `src/engine/broker.ts` | fills, commission, slippage, exit legs |
| `src/engine/metrics.ts` | net, drawdown, win rate, profit factor, SL split |
| `src/engine/mtf.ts` | multi-timeframe feed merge (no look-ahead) |
| `src/engine/strategies/` | `ma_rr_v9`, `mtf_lean`, `srtrend_v10` |

## Metric definitions (trees with an IS/OOS split)

`trades` counts **entries**, not exit legs. With partial take-profits one entry
closes as up to three legs; counting legs would inflate the number and make the
win rate incomparable. Win rate and profit factor use the same entry denominator.

The exit accounting closes exactly:

```
win_rate + sl_loss_rate + other_loss_rate = 100
```

- `win_rate` — entries that finished net-positive
- `sl_loss_rate` — entries stopped out **and** finished negative
- `other_loss_rate` — entries that lost without hitting the stop (a take-profit
  eaten by costs; on a wide-tick symbol the round trip can exceed a small target)

A stop that fills in profit (trailing/break-even) is counted separately as
`sl_profit_rate` and is **not** a loss.

## In-sample / out-of-sample

`range.split` is the boundary. The GA only ever scores the in-sample window;
out-of-sample metrics are computed from the same run and ride on every record,
so a curve-fitted config shows up as an IS→OOS collapse.

Splitting one run is exact here because sizing is fixed cash: trade outcomes do
not depend on account equity, so the later window is unaffected by the earlier
one's P&L.

> **`optimizer1y1h` has no split and no SL metrics.** It predates that work and
> still carries 31 unreduced parameters. Its numbers are not comparable to the
> others — see its README.

## Wiping rules

The genome is a **positional array** of indices into `params.json`. Editing that
file silently invalidates every stored genome, so it requires wiping `results/`,
`best/` and `index/`. Adding metric keys is additive and needs no wipe.

## Result data is not in git

`results/*.jsonl` reaches multiple GB per tree (~23 GB total). `.gitignore`
excludes the data directories; configs, code and docs are tracked.

## Commands

```bash
lean15m-results          # leaderboard
lean15m-results ZECUSDT  # per-coin drill-down
lean15m-results ZECUSDT robust   # parameter robustness (z vs chance)
lean15m-start | -stop | -status
```

Same pattern for `lean5m-results`, `optyear-results`, `opt1hyear-results`,
`ma5m-results`.

## Method notes worth reading

- [`optimizer1y15m/PARAMETER_REDUCTION.md`](platform/backend/optimizer1y15m/PARAMETER_REDUCTION.md)
  — how 31 parameters were cut to 7 using a permutation control, and why raw
  "pin cost" is an artifact of sample size rather than a measure of importance.
- [`lean_optimizer15m/BEST_CONFIGS.md`](platform/backend/lean_optimizer15m/BEST_CONFIGS.md)
  — per-coin config selection, including two earlier ranking methods that were
  wrong and why.
