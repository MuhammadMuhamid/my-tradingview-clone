# MTF Confluence Lean — 5m optimizer (`optimizer1y5m`)

_Generated 2026-08-22 from this tree's own `config.json` and `params.json`._

## Status

- **Service**: `com.alphaweb.lean-1y5m` — RUNNING
- **Leaderboard**: `lean5m-results`  ·  per-coin drill-down: `lean5m-results <COIN> [sort]`
- **Evaluations stored**: 3,476,704 across 19 coins

## Window and cost model

- Range: `2025-08-11` → `now`, IS/OOS split at `2026-03-11`
- Initial capital: 10000
- Commission: 0.1% per side
- Slippage: 2 ticks

## Objective

```
score = net_pct - 2.5*|dd_pct| - 0.0*max(0, trades - 1000000)
min_trades = 100   (below this, score = -inf)
```

## Search space — 18 tunables, 132,765,696,000 combinations

| parameter | values |
|---|---|
| `atrLenRisk` | 2, 4, 6, 8, 12, 16, 20 |
| `s1_len` | 1, 2, 3, 4, 6, 8, 12 |
| `s1_maxAge` | 10, 18, 26, 34, 40 |
| `volMultMin` | 0.3, 0.7, 1.1, 1.4, 1.9, 2.5 |
| `useG3` | off, on |
| `s6_prox` | 1.0, 2.0, 4.0, 6.0, 8.0, 12.0, 20.0 |
| `s6_len` | 3, 4, 5, 6, 8, 10, 13 |
| `rrSwingLb` | 4, 8, 10, 14, 18, 20 |
| `rrBufAtr` | 0.1, 0.5, 1.0, 1.8, 2.8, 4.0 |
| `rrRatio` | 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0 |
| `rrUsePartialTp` | off, on |
| `rrUseTrailSl` | off, on |
| `rrTrailPct` | 0.8, 1.5, 2.5, 4.0 |
| `useG1` | off, on |
| `g1_mult` | 1.5, 2.0, 2.5, 3.0, 4.0 |
| `useS4` | off, on |
| `s4_mult` | 1.5, 2.0, 2.5, 3.0, 4.0 |
| `useS5` | off, on |

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
