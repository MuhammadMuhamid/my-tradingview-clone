# MA + R:R Strategy v5 — 15m optimizer (`optimizer1y15m`)

_Generated 2026-08-22 from this tree's own `config.json` and `params.json`._

## Status

- **Service**: `com.alphaweb.ma-1y15m` — RUNNING
- **Leaderboard**: `optyear-results`  ·  per-coin drill-down: `optyear-results <COIN> [sort]`
- **Evaluations stored**: 1,284,934 across 17 coins

## Window and cost model

- Range: `2025-07-20` → `now`, IS/OOS split at `2026-03-11`
- Initial capital: 10000
- Commission: 0.1% per side
- Slippage: 2 ticks

## Objective

```
score = net_pct - 2.5*|dd_pct| - 0.05*max(0, trades - 600)
min_trades = 50   (below this, score = -inf)
```

## Search space — 8 tunables, 370,440 combinations

| parameter | values |
|---|---|
| `ma1_slopeLb` | 10, 20, 30, 50, 5, 15 |
| `volMaLen` | 20, 50, 100 |
| `volMultMin` | 1.0, 1.3, 1.6, 2.0, 1.5, 0.2, 0.4 |
| `hhPivotLen` | 6, 10, 15, 25, 16, 14, 8 |
| `rrRatio` | 0.75, 1.0, 1.5, 2.0, 2.5 |
| `runMaxPct` | 10.0, 17.0, 25.0, 13.0, 19.0, 18.0 |
| `hlBreakPivLen` | 9, 15, 21, 22, 12, 10, 30 |
| `useSuperTrend` | off, on |

Everything not listed is pinned in `base_params.json`.

## Files

| file | purpose |
|---|---|
| `config.json` | window, cost model, timeframe |
| `params.json` | search space + objective |
| `base_params.json` | pinned (non-searched) parameters |
| `coins.txt` | symbol universe (`#` comments ignored) |
| `optimizer.ts` | GA driver / daemon |
| `evalWorker.ts` | runs one backtest, emits metrics |
| `show.py` | leaderboard viewer |
| `results/*.jsonl` | every evaluation (git-ignored, can be GBs) |
| `best/<COIN>.json` | best config per coin |

## Notes

- The genome is a **positional array**. Any edit to `params.json` invalidates
  every stored genome and requires wiping `results/`, `best/` and `index/`.
- Adding metric keys is additive and needs no wipe.
- Headline metrics are **in-sample**; `oos_*` keys come from the same run
  and are never seen by the search.
- `win_rate` and `sl_loss_rate` are **entry-based** and never overlap.
