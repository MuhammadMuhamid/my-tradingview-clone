# MA + R:R Strategy v5 — 1h optimizer (`optimizer1y1h`)

_Generated 2026-08-22 from this tree's own `config.json` and `params.json`._

## Status

- **Service**: `com.alphaweb.ma-1y1h` — RUNNING
- **Leaderboard**: `opt1hyear-results`  ·  per-coin drill-down: `opt1hyear-results <COIN> [sort]`
- **Evaluations stored**: 369,750 across 17 coins

## Window and cost model

- Range: `2025-07-20` → `now`  **(no IS/OOS split)**
- Initial capital: 1000
- Commission: 0.1% per side
- Slippage: 0 ticks

## Objective

```
score = net_pct - 1.0*|dd_pct| - 0.05*max(0, trades - 600)
min_trades = 30   (below this, score = -inf)
```

## Search space — 31 tunables, 14,765,025,303,000,000,000 combinations

| parameter | values |
|---|---|
| `ma1_len` | 100, 150, 200, 300, 400 |
| `ma1_slopeLb` | 10, 20, 30, 50, 5, 15 |
| `ma2_len` | 100, 150, 200, 300, 50 |
| `ma2_slopeLb` | 5, 10, 20, 25, 30 |
| `ma3_len` | 14, 21, 34, 50, 200 |
| `ma3_slopeLb` | 8, 13, 21, 15, 30, 9 |
| `ma4_len` | 34, 50, 100, 200, 21 |
| `ma4_slopeLb` | 10, 15, 25, 6, 13, 11 |
| `volMaLen` | 20, 50, 100 |
| `volMultMin` | 1.0, 1.3, 1.6, 2.0, 1.5, 0.2, 0.4 |
| `hhPivotLen` | 6, 10, 15, 25, 16, 14, 8 |
| `entryBodyAtrMult` | 0.3, 0.5, 0.8, 0.2, 0.6, 0.4 |
| `atrLenExit` | 4, 7, 14, 2, 5, 1 |
| `rrSwingLb` | 6, 9, 14, 20, 10 |
| `rrBufAtr` | 0.3, 0.5, 0.7, 1.0, 0.4 |
| `rrRatio` | 0.75, 1.0, 1.5, 2.0, 2.5 |
| `minSlDistAtr` | 0.05, 0.25, 0.5 |
| `extMaxPct` | 2.0, 3.0, 5.0 |
| `runLb` | 12, 20, 30 |
| `runMaxPct` | 10.0, 17.0, 25.0, 13.0, 19.0, 18.0 |
| `wickMaxAtr` | 0.6, 1.2, 2.0, 0.8, 0.9 |
| `hlBreakPivLen` | 9, 15, 21, 22, 12, 10, 30 |
| `hlBreakMinR` | 0.0, 0.25, 0.5 |
| `useRunLimit` | off, on |
| `useSuperTrend` | off, on |
| `useLocalTrend` | off, on |
| `at_coeff` | 1.0, 1.5, 2.0 |
| `at_ap` | 50, 100, 150 |
| `hac_length` | 34, 55, 89 |
| `hac_emaLen` | 40, 60, 100 |
| `hac_csf` | 0.8, 1.1, 1.4 |

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
- **This tree has no IS/OOS split and no SL metrics** — it predates that work.
  Its `win_rate` is leg-based, so it is not comparable to the other trees.
