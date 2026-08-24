# MTF Confluence Lean — 15m: best config per coin (robustness-screened)

Source: `lean_optimizer15m/results/*.jsonl` — **19 coins x 133,250 evaluated configs = 2,531,750 backtests**, 
window 2025-08-11 -> 2026-07-30 (~11.6 months), 15m chart, $1,000 start, 0.1%/side commission, 0 slippage.

Machine-readable companion: `BEST_CONFIGS_15M.json`.


## How these were picked

1. **Eligibility**: >= 50 entries, net > 0, PF >= 1.4, max DD <= 25%.

2. **Risk-first ranking**: primary metric is **MAR = net% / maxDD%** (net alone is meaningless here because `qty_pct_equity` ranges 10-100% and scales net and DD together), then PF, win rate, trade count.

3. **Robustness gate (the important step)**: every candidate is scored by its *neighbourhood* in parameter space (all configs within L1 distance <= 6 and <= 5 differing genes). A config is only recommended if its neighbours are also profitable — `nbPos` = share of neighbours with net > 0, `nbP25` = 25th-percentile net of the neighbourhood. This is what separates a real parameter plateau from a lucky single sample.

4. **Win-rate honesty**: `win_rate` and `profit_factor` in the result files are computed over **closed legs**, not entries (`metrics.ts:37`, `evalWorker.ts:101-107`). With `rrUsePartialTp` on, one entry closes as up to three legs and the TP1 leg almost always wins, so 96-99% win rates are an artefact of partial exits, not skill. Configs are therefore split into two universes:

   - **Conservative** — `rrUsePartialTp = false` (legs == entries), so win rate is a true per-trade win rate.

   - **Aggressive** — partial TPs allowed; higher headline WR/PF, but read WR as 'share of legs closed green'.


## Recommended config per coin

`MAR` = net%/DD%. `nb` = neighbourhood size, `nbPos` = % of neighbours profitable, `nbP25` = 25th pct net of neighbourhood.


### A. Conservative (true win rate, no partial TPs)

| Coin | Net % | DD % | MAR | True WR % | Entries | PF | Size % | nb | nbPos | nbP25 |
|---|---|---|---|---|---|---|---|---|---|---|
| DEXEUSDT | 867.9 | 22.02 | 39.4 | 80.7 | 114 | 3.99 | 60 | 26 | 100% | 541.5 |
| ZECUSDT | 654.9 | 22.03 | 29.7 | 63.4 | 93 | 2.08 | 100 | 7 | 100% | 596.0 |
| JSTUSDT | 137.4 | 14.44 | 9.5 | 41.5 | 94 | 2.20 | 80 | 14 | 100% | 134.0 |
| 币安人生USDT | 38.5 | 6.15 | 6.3 | 81.4 | 113 | 2.43 | 15 | 33 | 100% | 34.0 |
| JTOUSDT | 10.0 | 1.84 | 5.4 | 51.0 | 96 | 1.90 | 10 | 9 | 100% | 7.7 |
| INJUSDT | 9.3 | 2.05 | 4.6 | 53.1 | 64 | 1.60 | 10 | 8 | 88% | 1.8 |
| SYNUSDT | 40.2 | 10.29 | 3.9 | 62.7 | 67 | 2.88 | 10 | 48 | 100% | 28.8 |
| KAITOUSDT | 15.8 | 5.36 | 3.0 | 23.3 | 86 | 1.63 | 10 | 13 | 100% | 11.9 |
| ALLOUSDT | 17.4 | 5.97 | 2.9 | 55.0 | 60 | 1.66 | 15 | 27 | 100% | 5.9 |
| RIFUSDT | 10.2 | 3.50 | 2.9 | 58.7 | 75 | 1.54 | 15 | 14 | 100% | 4.5 |
| TAOUSDT | 13.4 | 4.67 | 2.9 | 43.1 | 51 | 1.70 | 25 | 38 | 100% | 7.0 |
| TIAUSDT | 2.7 | 1.11 | 2.4 | 69.8 | 63 | 1.52 | 10 | 7 | 100% | 1.9 |
| ENAUSDT | 3.5 | 1.50 | 2.4 | 53.3 | 180 | 1.64 | 10 | 10 | 90% | 2.3 |
| JUPUSDT | 6.3 | 3.23 | 2.0 | 67.7 | 68 | 1.52 | 15 | 7 | 86% | 1.0 |
| NEARUSDT | 1.9 | 1.20 | 1.5 | 58.0 | 69 | 1.40 | 10 | 8 | 100% | 1.0 |
| PUMPUSDT | 2.2 | 1.54 | 1.4 | 58.8 | 80 | 1.76 | 10 | 10 | 90% | 0.9 |
| EIGENUSDT | 2.3 | 2.09 | 1.1 | 51.6 | 93 | 1.65 | 10 | 20 | 40% | -0.7 |
| MORPHOUSDT | 1.1 | 2.50 | 0.5 | 70.0 | 60 | 1.43 | 10 | 14 | 86% | 0.3 |
| PYTHUSDT | — | — | — | — | — | — | — | — | — | no config passes the filters |

### B. Aggressive (partial TPs on — highest PF/WR/net, leg-based WR)

| Coin | Net % | DD % | MAR | Leg WR % | Entries | Legs | PF | Size % | nb | nbPos | nbP25 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ZECUSDT | 654.9 | 22.03 | 29.7 | 63.4 | 93 | 93 | 2.08 | 100 | 7 | 100% | 596.0 |
| DEXEUSDT | 338.5 | 17.39 | 19.5 | 79.0 | 205 | 205 | 3.74 | 60 | 33 | 100% | 299.2 |
| JSTUSDT | 143.5 | 10.86 | 13.2 | 93.5 | 138 | 3154 | 1.80 | 80 | 10 | 100% | 89.2 |
| RIFUSDT | 43.3 | 4.60 | 9.4 | 98.8 | 110 | 2235 | 7.23 | 40 | 8 | 100% | 21.6 |
| SYNUSDT | 120.9 | 16.40 | 7.4 | 97.9 | 66 | 2489 | 2.59 | 80 | 7 | 100% | 120.6 |
| ALLOUSDT | 8.4 | 1.27 | 6.6 | 95.1 | 80 | 471 | 7.72 | 15 | 17 | 100% | 5.0 |
| 币安人生USDT | 134.7 | 21.47 | 6.3 | 95.9 | 122 | 1158 | 2.66 | 100 | 10 | 100% | 225.5 |
| JTOUSDT | 10.0 | 1.84 | 5.4 | 51.0 | 96 | 96 | 1.90 | 10 | 9 | 100% | 7.7 |
| JUPUSDT | 40.7 | 8.26 | 4.9 | 98.3 | 63 | 2043 | 3.45 | 100 | 7 | 57% | -3.7 |
| PUMPUSDT | 31.3 | 6.47 | 4.8 | 98.6 | 147 | 4353 | 3.24 | 60 | 6 | 100% | 31.3 |
| KAITOUSDT | 10.2 | 2.37 | 4.3 | 96.4 | 216 | 5032 | 1.79 | 10 | 12 | 100% | 9.4 |
| INJUSDT | 4.5 | 1.05 | 4.3 | 98.6 | 89 | 3434 | 2.01 | 10 | 63 | 100% | 2.1 |
| TAOUSDT | 7.2 | 1.74 | 4.1 | 98.3 | 75 | 2096 | 2.60 | 15 | 7 | 100% | 6.8 |
| ENAUSDT | 5.3 | 1.90 | 2.8 | 62.6 | 203 | 644 | 1.81 | 10 | 17 | 100% | 1.2 |
| TIAUSDT | 3.7 | 1.45 | 2.6 | 92.7 | 67 | 951 | 1.68 | 10 | 6 | 100% | 1.5 |
| MORPHOUSDT | 1.5 | 0.61 | 2.4 | 98.6 | 68 | 1386 | 2.38 | 10 | 6 | 100% | 1.5 |
| EIGENUSDT | 3.4 | 1.63 | 2.1 | 96.8 | 50 | 1689 | 1.78 | 10 | 7 | 100% | 2.7 |
| NEARUSDT | 3.9 | 1.88 | 2.1 | 61.1 | 133 | 386 | 1.41 | 10 | 8 | 100% | 2.9 |
| PYTHUSDT | 2.0 | 1.64 | 1.2 | 96.2 | 119 | 2587 | 1.52 | 10 | 17 | 94% | 1.3 |

## Search-space support (trust ranking)

| Coin | % of 133k configs profitable | Best net % in file | Verdict |
|---|---|---|---|
| 币安人生USDT | 93.9% | 1112 | strong plateau — tradeable |
| DEXEUSDT | 93.3% | 5414 | strong plateau — tradeable |
| ZECUSDT | 89.5% | 2991 | strong plateau — tradeable |
| JSTUSDT | 89.5% | 218 | strong plateau — tradeable |
| KAITOUSDT | 81.8% | 145 | strong plateau — tradeable |
| RIFUSDT | 71.3% | 346 | strong plateau — tradeable |
| ALLOUSDT | 70.2% | 157 | strong plateau — tradeable |
| SYNUSDT | 56.7% | 918 | usable, thinner |
| JTOUSDT | 49.5% | 87 | usable, thinner |
| PUMPUSDT | 45.4% | 74 | usable, thinner |
| TAOUSDT | 38.2% | 106 | weak edge — paper only |
| JUPUSDT | 37.0% | 94 | weak edge — paper only |
| INJUSDT | 33.7% | 70 | weak edge — paper only |
| TIAUSDT | 31.8% | 67 | weak edge — paper only |
| NEARUSDT | 28.5% | 71 | weak edge — paper only |
| MORPHOUSDT | 22.1% | 150 | weak edge — paper only |
| EIGENUSDT | 20.2% | 53 | weak edge — paper only |
| ENAUSDT | 17.4% | 29 | weak edge — paper only |
| PYTHUSDT | 7.2% | 24 | weak edge — paper only |

## Full parameters — conservative pick per coin


### DEXEUSDT  — net 867.93% / DD 22.02% / WR 80.7% / 114 entries / PF 3.986

```json
{
  "atrLenRisk": 4,
  "s1_len": 3,
  "s1_maxAge": 34,
  "volMaLen": 100,
  "volMultMin": 1.3,
  "useG3": false,
  "g3_tf": "60",
  "rrSwingLb": 6,
  "rrBufAtr": 4,
  "rrRatio": 1.25,
  "minSlDistAtr": 8,
  "entryBodyAtrMult": 0.25,
  "s6_prox": 8,
  "s6_len": 7,
  "s6_margin": 8,
  "s6_vis": 5,
  "useS6": false,
  "useG4": true,
  "g4_lb": 24,
  "g4_volLen": 13,
  "g4_boxW": 2,
  "g4_atrMult": 1,
  "qty_pct_equity": 60,
  "rrUsePartialTp": false,
  "rrTp1Pct": 3.5,
  "rrTp2Pct": 7,
  "rrUseBE": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "rrTrailActPct": 6
}
```

### ZECUSDT  — net 654.94% / DD 22.03% / WR 63.44% / 93 entries / PF 2.082

```json
{
  "atrLenRisk": 20,
  "s1_len": 1,
  "s1_maxAge": 14,
  "volMaLen": 100,
  "volMultMin": 3,
  "useG3": true,
  "g3_tf": "15",
  "rrSwingLb": 4,
  "rrBufAtr": 1.4,
  "rrRatio": 1.25,
  "minSlDistAtr": 0.1,
  "entryBodyAtrMult": 0.35,
  "s6_prox": 4,
  "s6_len": 6,
  "s6_margin": 7,
  "s6_vis": 5,
  "useS6": false,
  "useG4": false,
  "g4_lb": 18,
  "g4_volLen": 16,
  "g4_boxW": 4,
  "g4_atrMult": 5,
  "qty_pct_equity": 100,
  "rrUsePartialTp": false,
  "rrTp1Pct": 5,
  "rrTp2Pct": 10,
  "rrUseBE": true,
  "rrUseTrailSl": false,
  "rrTrailPct": 2.5,
  "rrTrailActPct": 6
}
```

### JSTUSDT  — net 137.44% / DD 14.44% / WR 41.49% / 94 entries / PF 2.204

```json
{
  "atrLenRisk": 6,
  "s1_len": 2,
  "s1_maxAge": 10,
  "volMaLen": 100,
  "volMultMin": 0.1,
  "useG3": false,
  "g3_tf": "60",
  "rrSwingLb": 18,
  "rrBufAtr": 0.5,
  "rrRatio": 3.5,
  "minSlDistAtr": 0.6,
  "entryBodyAtrMult": 0.3,
  "s6_prox": 8,
  "s6_len": 13,
  "s6_margin": 9,
  "s6_vis": 2,
  "useS6": false,
  "useG4": false,
  "g4_lb": 40,
  "g4_volLen": 2,
  "g4_boxW": 3,
  "g4_atrMult": 8,
  "qty_pct_equity": 80,
  "rrUsePartialTp": false,
  "rrTp1Pct": 1.2,
  "rrTp2Pct": 8,
  "rrUseBE": false,
  "rrUseTrailSl": false,
  "rrTrailPct": 1.2,
  "rrTrailActPct": 3
}
```

### 币安人生USDT  — net 38.45% / DD 6.15% / WR 81.42% / 113 entries / PF 2.433

```json
{
  "atrLenRisk": 4,
  "s1_len": 2,
  "s1_maxAge": 18,
  "volMaLen": 50,
  "volMultMin": 1.1,
  "useG3": false,
  "g3_tf": "15",
  "rrSwingLb": 20,
  "rrBufAtr": 2.2,
  "rrRatio": 2,
  "minSlDistAtr": 2.5,
  "entryBodyAtrMult": 0.3,
  "s6_prox": 12,
  "s6_len": 3,
  "s6_margin": 5,
  "s6_vis": 50,
  "useS6": false,
  "useG4": false,
  "g4_lb": 20,
  "g4_volLen": 4,
  "g4_boxW": 4,
  "g4_atrMult": 10,
  "qty_pct_equity": 15,
  "rrUsePartialTp": false,
  "rrTp1Pct": 1.2,
  "rrTp2Pct": 3.5,
  "rrUseBE": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "rrTrailActPct": 4
}
```

### JTOUSDT  — net 9.98% / DD 1.84% / WR 51.04% / 96 entries / PF 1.902

```json
{
  "atrLenRisk": 12,
  "s1_len": 5,
  "s1_maxAge": 34,
  "volMaLen": 50,
  "volMultMin": 1.3,
  "useG3": false,
  "g3_tf": "15",
  "rrSwingLb": 12,
  "rrBufAtr": 0.3,
  "rrRatio": 1.25,
  "minSlDistAtr": 0.1,
  "entryBodyAtrMult": 0.45,
  "s6_prox": 20,
  "s6_len": 7,
  "s6_margin": 9,
  "s6_vis": 25,
  "useS6": true,
  "useG4": true,
  "g4_lb": 32,
  "g4_volLen": 16,
  "g4_boxW": 1,
  "g4_atrMult": 1,
  "qty_pct_equity": 10,
  "rrUsePartialTp": false,
  "rrTp1Pct": 6,
  "rrTp2Pct": 5,
  "rrUseBE": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 4,
  "rrTrailActPct": 1
}
```

### INJUSDT  — net 9.33% / DD 2.05% / WR 53.13% / 64 entries / PF 1.597

```json
{
  "atrLenRisk": 20,
  "s1_len": 2,
  "s1_maxAge": 18,
  "volMaLen": 100,
  "volMultMin": 1.3,
  "useG3": true,
  "g3_tf": "15",
  "rrSwingLb": 4,
  "rrBufAtr": 0.5,
  "rrRatio": 1.5,
  "minSlDistAtr": 6.5,
  "entryBodyAtrMult": 0.2,
  "s6_prox": 8,
  "s6_len": 6,
  "s6_margin": 8.5,
  "s6_vis": 50,
  "useS6": false,
  "useG4": true,
  "g4_lb": 32,
  "g4_volLen": 10,
  "g4_boxW": 5,
  "g4_atrMult": 2,
  "qty_pct_equity": 10,
  "rrUsePartialTp": false,
  "rrTp1Pct": 3.5,
  "rrTp2Pct": 10,
  "rrUseBE": true,
  "rrUseTrailSl": false,
  "rrTrailPct": 4,
  "rrTrailActPct": 6
}
```

### SYNUSDT  — net 40.21% / DD 10.29% / WR 62.69% / 67 entries / PF 2.885

```json
{
  "atrLenRisk": 2,
  "s1_len": 1,
  "s1_maxAge": 10,
  "volMaLen": 50,
  "volMultMin": 2.5,
  "useG3": false,
  "g3_tf": "60",
  "rrSwingLb": 6,
  "rrBufAtr": 2.8,
  "rrRatio": 1,
  "minSlDistAtr": 2.5,
  "entryBodyAtrMult": 0.35,
  "s6_prox": 6,
  "s6_len": 13,
  "s6_margin": 7.5,
  "s6_vis": 5,
  "useS6": false,
  "useG4": false,
  "g4_lb": 18,
  "g4_volLen": 4,
  "g4_boxW": 2,
  "g4_atrMult": 6.5,
  "qty_pct_equity": 10,
  "rrUsePartialTp": false,
  "rrTp1Pct": 6,
  "rrTp2Pct": 8,
  "rrUseBE": true,
  "rrUseTrailSl": false,
  "rrTrailPct": 5,
  "rrTrailActPct": 2
}
```

### KAITOUSDT  — net 15.83% / DD 5.36% / WR 23.26% / 86 entries / PF 1.629

```json
{
  "atrLenRisk": 2,
  "s1_len": 6,
  "s1_maxAge": 40,
  "volMaLen": 50,
  "volMultMin": 0.5,
  "useG3": false,
  "g3_tf": "15",
  "rrSwingLb": 16,
  "rrBufAtr": 0.1,
  "rrRatio": 6,
  "minSlDistAtr": 2.5,
  "entryBodyAtrMult": 0.45,
  "s6_prox": 0.5,
  "s6_len": 11,
  "s6_margin": 8,
  "s6_vis": 1,
  "useS6": false,
  "useG4": false,
  "g4_lb": 32,
  "g4_volLen": 8,
  "g4_boxW": 6.5,
  "g4_atrMult": 4,
  "qty_pct_equity": 10,
  "rrUsePartialTp": false,
  "rrTp1Pct": 1.2,
  "rrTp2Pct": 2.5,
  "rrUseBE": true,
  "rrUseTrailSl": false,
  "rrTrailPct": 4,
  "rrTrailActPct": 4
}
```

### ALLOUSDT  — net 17.43% / DD 5.97% / WR 55% / 60 entries / PF 1.658

```json
{
  "atrLenRisk": 8,
  "s1_len": 2,
  "s1_maxAge": 18,
  "volMaLen": 100,
  "volMultMin": 3,
  "useG3": false,
  "g3_tf": "60",
  "rrSwingLb": 6,
  "rrBufAtr": 0.8,
  "rrRatio": 1.25,
  "minSlDistAtr": 1.5,
  "entryBodyAtrMult": 0.5,
  "s6_prox": 3,
  "s6_len": 9,
  "s6_margin": 7,
  "s6_vis": 2,
  "useS6": false,
  "useG4": true,
  "g4_lb": 20,
  "g4_volLen": 2,
  "g4_boxW": 3,
  "g4_atrMult": 8,
  "qty_pct_equity": 15,
  "rrUsePartialTp": false,
  "rrTp1Pct": 1.8,
  "rrTp2Pct": 1.5,
  "rrUseBE": false,
  "rrUseTrailSl": false,
  "rrTrailPct": 5,
  "rrTrailActPct": 4
}
```

### RIFUSDT  — net 10.16% / DD 3.5% / WR 58.67% / 75 entries / PF 1.539

```json
{
  "atrLenRisk": 8,
  "s1_len": 1,
  "s1_maxAge": 30,
  "volMaLen": 100,
  "volMultMin": 1.1,
  "useG3": false,
  "g3_tf": "60",
  "rrSwingLb": 4,
  "rrBufAtr": 0.3,
  "rrRatio": 1.5,
  "minSlDistAtr": 0.6,
  "entryBodyAtrMult": 0.5,
  "s6_prox": 20,
  "s6_len": 9,
  "s6_margin": 4,
  "s6_vis": 2,
  "useS6": true,
  "useG4": true,
  "g4_lb": 14,
  "g4_volLen": 3,
  "g4_boxW": 1.5,
  "g4_atrMult": 1,
  "qty_pct_equity": 15,
  "rrUsePartialTp": false,
  "rrTp1Pct": 0.8,
  "rrTp2Pct": 2.5,
  "rrUseBE": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 1.9,
  "rrTrailActPct": 6
}
```

### TAOUSDT  — net 13.45% / DD 4.67% / WR 43.14% / 51 entries / PF 1.702

```json
{
  "atrLenRisk": 18,
  "s1_len": 1,
  "s1_maxAge": 30,
  "volMaLen": 50,
  "volMultMin": 3,
  "useG3": true,
  "g3_tf": "60",
  "rrSwingLb": 8,
  "rrBufAtr": 2.2,
  "rrRatio": 1.25,
  "minSlDistAtr": 10,
  "entryBodyAtrMult": 0.15,
  "s6_prox": 4,
  "s6_len": 11,
  "s6_margin": 6,
  "s6_vis": 25,
  "useS6": false,
  "useG4": false,
  "g4_lb": 28,
  "g4_volLen": 10,
  "g4_boxW": 1.5,
  "g4_atrMult": 10,
  "qty_pct_equity": 25,
  "rrUsePartialTp": false,
  "rrTp1Pct": 1.2,
  "rrTp2Pct": 1,
  "rrUseBE": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 4,
  "rrTrailActPct": 0.5
}
```

### TIAUSDT  — net 2.71% / DD 1.11% / WR 69.84% / 63 entries / PF 1.517

```json
{
  "atrLenRisk": 5,
  "s1_len": 5,
  "s1_maxAge": 22,
  "volMaLen": 50,
  "volMultMin": 1.1,
  "useG3": true,
  "g3_tf": "60",
  "rrSwingLb": 6,
  "rrBufAtr": 1,
  "rrRatio": 3,
  "minSlDistAtr": 2.5,
  "entryBodyAtrMult": 0.1,
  "s6_prox": 12,
  "s6_len": 3,
  "s6_margin": 4.5,
  "s6_vis": 2,
  "useS6": false,
  "useG4": true,
  "g4_lb": 40,
  "g4_volLen": 1,
  "g4_boxW": 10,
  "g4_atrMult": 1.5,
  "qty_pct_equity": 10,
  "rrUsePartialTp": false,
  "rrTp1Pct": 3.5,
  "rrTp2Pct": 10,
  "rrUseBE": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.5,
  "rrTrailActPct": 2
}
```

### ENAUSDT  — net 3.54% / DD 1.5% / WR 53.33% / 180 entries / PF 1.643

```json
{
  "atrLenRisk": 6,
  "s1_len": 2,
  "s1_maxAge": 18,
  "volMaLen": 100,
  "volMultMin": 1.1,
  "useG3": true,
  "g3_tf": "15",
  "rrSwingLb": 18,
  "rrBufAtr": 1,
  "rrRatio": 6,
  "minSlDistAtr": 10,
  "entryBodyAtrMult": 0.1,
  "s6_prox": 20,
  "s6_len": 10,
  "s6_margin": 7.5,
  "s6_vis": 25,
  "useS6": false,
  "useG4": false,
  "g4_lb": 36,
  "g4_volLen": 10,
  "g4_boxW": 1,
  "g4_atrMult": 2,
  "qty_pct_equity": 10,
  "rrUsePartialTp": false,
  "rrTp1Pct": 1.2,
  "rrTp2Pct": 3.5,
  "rrUseBE": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.5,
  "rrTrailActPct": 0
}
```

### JUPUSDT  — net 6.32% / DD 3.23% / WR 67.65% / 68 entries / PF 1.518

```json
{
  "atrLenRisk": 10,
  "s1_len": 4,
  "s1_maxAge": 22,
  "volMaLen": 100,
  "volMultMin": 3,
  "useG3": false,
  "g3_tf": "60",
  "rrSwingLb": 6,
  "rrBufAtr": 1,
  "rrRatio": 0.75,
  "minSlDistAtr": 0.6,
  "entryBodyAtrMult": 0.15,
  "s6_prox": 4,
  "s6_len": 10,
  "s6_margin": 8,
  "s6_vis": 35,
  "useS6": false,
  "useG4": true,
  "g4_lb": 20,
  "g4_volLen": 6,
  "g4_boxW": 8,
  "g4_atrMult": 1,
  "qty_pct_equity": 15,
  "rrUsePartialTp": false,
  "rrTp1Pct": 0.8,
  "rrTp2Pct": 3.5,
  "rrUseBE": false,
  "rrUseTrailSl": false,
  "rrTrailPct": 1.9,
  "rrTrailActPct": 6
}
```

### NEARUSDT  — net 1.85% / DD 1.2% / WR 57.97% / 69 entries / PF 1.402

```json
{
  "atrLenRisk": 20,
  "s1_len": 5,
  "s1_maxAge": 18,
  "volMaLen": 50,
  "volMultMin": 0.5,
  "useG3": true,
  "g3_tf": "60",
  "rrSwingLb": 14,
  "rrBufAtr": 0.8,
  "rrRatio": 0.75,
  "minSlDistAtr": 3.9,
  "entryBodyAtrMult": 0.35,
  "s6_prox": 4,
  "s6_len": 9,
  "s6_margin": 7.5,
  "s6_vis": 1,
  "useS6": false,
  "useG4": true,
  "g4_lb": 20,
  "g4_volLen": 4,
  "g4_boxW": 1.5,
  "g4_atrMult": 10,
  "qty_pct_equity": 10,
  "rrUsePartialTp": false,
  "rrTp1Pct": 1.8,
  "rrTp2Pct": 3.5,
  "rrUseBE": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 1.2,
  "rrTrailActPct": 1
}
```

### PUMPUSDT  — net 2.23% / DD 1.54% / WR 58.75% / 80 entries / PF 1.762

```json
{
  "atrLenRisk": 1,
  "s1_len": 10,
  "s1_maxAge": 18,
  "volMaLen": 50,
  "volMultMin": 0.3,
  "useG3": false,
  "g3_tf": "60",
  "rrSwingLb": 16,
  "rrBufAtr": 3.4,
  "rrRatio": 1,
  "minSlDistAtr": 10,
  "entryBodyAtrMult": 0.15,
  "s6_prox": 6,
  "s6_len": 13,
  "s6_margin": 4.5,
  "s6_vis": 5,
  "useS6": false,
  "useG4": true,
  "g4_lb": 32,
  "g4_volLen": 8,
  "g4_boxW": 10,
  "g4_atrMult": 5,
  "qty_pct_equity": 10,
  "rrUsePartialTp": false,
  "rrTp1Pct": 5,
  "rrTp2Pct": 7,
  "rrUseBE": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.5,
  "rrTrailActPct": 0.5
}
```

### EIGENUSDT  — net 2.27% / DD 2.09% / WR 51.61% / 93 entries / PF 1.651

```json
{
  "atrLenRisk": 2,
  "s1_len": 4,
  "s1_maxAge": 30,
  "volMaLen": 100,
  "volMultMin": 1.8,
  "useG3": true,
  "g3_tf": "15",
  "rrSwingLb": 18,
  "rrBufAtr": 0.5,
  "rrRatio": 3,
  "minSlDistAtr": 0.6,
  "entryBodyAtrMult": 0.5,
  "s6_prox": 8,
  "s6_len": 10,
  "s6_margin": 4.5,
  "s6_vis": 35,
  "useS6": false,
  "useG4": true,
  "g4_lb": 20,
  "g4_volLen": 16,
  "g4_boxW": 8,
  "g4_atrMult": 1,
  "qty_pct_equity": 10,
  "rrUsePartialTp": false,
  "rrTp1Pct": 1.8,
  "rrTp2Pct": 1.5,
  "rrUseBE": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.5,
  "rrTrailActPct": 0
}
```

### MORPHOUSDT  — net 1.15% / DD 2.5% / WR 70% / 60 entries / PF 1.428

```json
{
  "atrLenRisk": 20,
  "s1_len": 6,
  "s1_maxAge": 34,
  "volMaLen": 50,
  "volMultMin": 2.1,
  "useG3": false,
  "g3_tf": "60",
  "rrSwingLb": 20,
  "rrBufAtr": 2.2,
  "rrRatio": 1.25,
  "minSlDistAtr": 10,
  "entryBodyAtrMult": 0.15,
  "s6_prox": 20,
  "s6_len": 9,
  "s6_margin": 7.5,
  "s6_vis": 3,
  "useS6": false,
  "useG4": false,
  "g4_lb": 36,
  "g4_volLen": 8,
  "g4_boxW": 3,
  "g4_atrMult": 6.5,
  "qty_pct_equity": 10,
  "rrUsePartialTp": false,
  "rrTp1Pct": 1.2,
  "rrTp2Pct": 10,
  "rrUseBE": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "rrTrailActPct": 1
}
```

## Full parameters — aggressive pick per coin


### ZECUSDT  — net 654.94% / DD 22.03% / legWR 63.44% / 93 entries (93 legs) / PF 2.082

```json
{
  "atrLenRisk": 20,
  "s1_len": 1,
  "s1_maxAge": 14,
  "volMaLen": 100,
  "volMultMin": 3,
  "useG3": true,
  "g3_tf": "15",
  "rrSwingLb": 4,
  "rrBufAtr": 1.4,
  "rrRatio": 1.25,
  "minSlDistAtr": 0.1,
  "entryBodyAtrMult": 0.35,
  "s6_prox": 4,
  "s6_len": 6,
  "s6_margin": 7,
  "s6_vis": 5,
  "useS6": false,
  "useG4": false,
  "g4_lb": 18,
  "g4_volLen": 16,
  "g4_boxW": 4,
  "g4_atrMult": 5,
  "qty_pct_equity": 100,
  "rrUsePartialTp": false,
  "rrTp1Pct": 5,
  "rrTp2Pct": 10,
  "rrUseBE": true,
  "rrUseTrailSl": false,
  "rrTrailPct": 2.5,
  "rrTrailActPct": 6
}
```

### DEXEUSDT  — net 338.54% / DD 17.39% / legWR 79.02% / 205 entries (205 legs) / PF 3.743

```json
{
  "atrLenRisk": 18,
  "s1_len": 3,
  "s1_maxAge": 34,
  "volMaLen": 100,
  "volMultMin": 1.1,
  "useG3": true,
  "g3_tf": "15",
  "rrSwingLb": 12,
  "rrBufAtr": 4,
  "rrRatio": 1.25,
  "minSlDistAtr": 8,
  "entryBodyAtrMult": 0.4,
  "s6_prox": 8,
  "s6_len": 13,
  "s6_margin": 8,
  "s6_vis": 5,
  "useS6": false,
  "useG4": true,
  "g4_lb": 24,
  "g4_volLen": 13,
  "g4_boxW": 2,
  "g4_atrMult": 1,
  "qty_pct_equity": 60,
  "rrUsePartialTp": false,
  "rrTp1Pct": 3.5,
  "rrTp2Pct": 7,
  "rrUseBE": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "rrTrailActPct": 2
}
```

### JSTUSDT  — net 143.53% / DD 10.86% / legWR 93.47% / 138 entries (3154 legs) / PF 1.797

```json
{
  "atrLenRisk": 5,
  "s1_len": 2,
  "s1_maxAge": 26,
  "volMaLen": 50,
  "volMultMin": 0.1,
  "useG3": false,
  "g3_tf": "60",
  "rrSwingLb": 18,
  "rrBufAtr": 0.8,
  "rrRatio": 3.5,
  "minSlDistAtr": 0.6,
  "entryBodyAtrMult": 0.3,
  "s6_prox": 8,
  "s6_len": 7,
  "s6_margin": 9,
  "s6_vis": 50,
  "useS6": false,
  "useG4": false,
  "g4_lb": 36,
  "g4_volLen": 2,
  "g4_boxW": 3,
  "g4_atrMult": 8,
  "qty_pct_equity": 80,
  "rrUsePartialTp": true,
  "rrTp1Pct": 3.5,
  "rrTp2Pct": 8,
  "rrUseBE": false,
  "rrUseTrailSl": false,
  "rrTrailPct": 4,
  "rrTrailActPct": 4
}
```

### RIFUSDT  — net 43.27% / DD 4.6% / legWR 98.79% / 110 entries (2235 legs) / PF 7.228

```json
{
  "atrLenRisk": 8,
  "s1_len": 1,
  "s1_maxAge": 18,
  "volMaLen": 100,
  "volMultMin": 1.3,
  "useG3": false,
  "g3_tf": "15",
  "rrSwingLb": 16,
  "rrBufAtr": 2.8,
  "rrRatio": 1,
  "minSlDistAtr": 3.9,
  "entryBodyAtrMult": 0.2,
  "s6_prox": 20,
  "s6_len": 8,
  "s6_margin": 8,
  "s6_vis": 8,
  "useS6": true,
  "useG4": false,
  "g4_lb": 24,
  "g4_volLen": 1,
  "g4_boxW": 8,
  "g4_atrMult": 1.5,
  "qty_pct_equity": 40,
  "rrUsePartialTp": true,
  "rrTp1Pct": 3.5,
  "rrTp2Pct": 1,
  "rrUseBE": true,
  "rrUseTrailSl": false,
  "rrTrailPct": 1.2,
  "rrTrailActPct": 3
}
```

### SYNUSDT  — net 120.92% / DD 16.4% / legWR 97.91% / 66 entries (2489 legs) / PF 2.591

```json
{
  "atrLenRisk": 8,
  "s1_len": 1,
  "s1_maxAge": 10,
  "volMaLen": 50,
  "volMultMin": 2.5,
  "useG3": false,
  "g3_tf": "60",
  "rrSwingLb": 6,
  "rrBufAtr": 0.3,
  "rrRatio": 6,
  "minSlDistAtr": 6.5,
  "entryBodyAtrMult": 0.35,
  "s6_prox": 3,
  "s6_len": 3,
  "s6_margin": 7.5,
  "s6_vis": 35,
  "useS6": false,
  "useG4": false,
  "g4_lb": 18,
  "g4_volLen": 1,
  "g4_boxW": 1,
  "g4_atrMult": 8,
  "qty_pct_equity": 80,
  "rrUsePartialTp": true,
  "rrTp1Pct": 2.5,
  "rrTp2Pct": 5,
  "rrUseBE": true,
  "rrUseTrailSl": false,
  "rrTrailPct": 5,
  "rrTrailActPct": 2
}
```

### ALLOUSDT  — net 8.35% / DD 1.27% / legWR 95.12% / 80 entries (471 legs) / PF 7.723

```json
{
  "atrLenRisk": 8,
  "s1_len": 2,
  "s1_maxAge": 18,
  "volMaLen": 100,
  "volMultMin": 2.5,
  "useG3": true,
  "g3_tf": "60",
  "rrSwingLb": 6,
  "rrBufAtr": 1,
  "rrRatio": 1.25,
  "minSlDistAtr": 0.1,
  "entryBodyAtrMult": 0.25,
  "s6_prox": 3,
  "s6_len": 9,
  "s6_margin": 8.5,
  "s6_vis": 5,
  "useS6": false,
  "useG4": true,
  "g4_lb": 20,
  "g4_volLen": 13,
  "g4_boxW": 3,
  "g4_atrMult": 8,
  "qty_pct_equity": 15,
  "rrUsePartialTp": true,
  "rrTp1Pct": 0.8,
  "rrTp2Pct": 5,
  "rrUseBE": true,
  "rrUseTrailSl": false,
  "rrTrailPct": 5,
  "rrTrailActPct": 1
}
```

### 币安人生USDT  — net 134.73% / DD 21.47% / legWR 95.94% / 122 entries (1158 legs) / PF 2.657

```json
{
  "atrLenRisk": 6,
  "s1_len": 2,
  "s1_maxAge": 14,
  "volMaLen": 100,
  "volMultMin": 1.1,
  "useG3": false,
  "g3_tf": "15",
  "rrSwingLb": 20,
  "rrBufAtr": 0.8,
  "rrRatio": 4,
  "minSlDistAtr": 2.5,
  "entryBodyAtrMult": 0.3,
  "s6_prox": 8,
  "s6_len": 8,
  "s6_margin": 5,
  "s6_vis": 12,
  "useS6": false,
  "useG4": false,
  "g4_lb": 20,
  "g4_volLen": 4,
  "g4_boxW": 6.5,
  "g4_atrMult": 6.5,
  "qty_pct_equity": 100,
  "rrUsePartialTp": true,
  "rrTp1Pct": 1.2,
  "rrTp2Pct": 3.5,
  "rrUseBE": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "rrTrailActPct": 4
}
```

### JTOUSDT  — net 9.98% / DD 1.84% / legWR 51.04% / 96 entries (96 legs) / PF 1.902

```json
{
  "atrLenRisk": 12,
  "s1_len": 5,
  "s1_maxAge": 34,
  "volMaLen": 50,
  "volMultMin": 1.3,
  "useG3": false,
  "g3_tf": "15",
  "rrSwingLb": 12,
  "rrBufAtr": 0.3,
  "rrRatio": 1.25,
  "minSlDistAtr": 0.1,
  "entryBodyAtrMult": 0.45,
  "s6_prox": 20,
  "s6_len": 7,
  "s6_margin": 9,
  "s6_vis": 25,
  "useS6": true,
  "useG4": true,
  "g4_lb": 32,
  "g4_volLen": 16,
  "g4_boxW": 1,
  "g4_atrMult": 1,
  "qty_pct_equity": 10,
  "rrUsePartialTp": false,
  "rrTp1Pct": 6,
  "rrTp2Pct": 5,
  "rrUseBE": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 4,
  "rrTrailActPct": 1
}
```

### JUPUSDT  — net 40.67% / DD 8.26% / legWR 98.34% / 63 entries (2043 legs) / PF 3.448

```json
{
  "atrLenRisk": 16,
  "s1_len": 4,
  "s1_maxAge": 22,
  "volMaLen": 100,
  "volMultMin": 2.1,
  "useG3": true,
  "g3_tf": "15",
  "rrSwingLb": 6,
  "rrBufAtr": 0.1,
  "rrRatio": 3.5,
  "minSlDistAtr": 8,
  "entryBodyAtrMult": 0.4,
  "s6_prox": 4,
  "s6_len": 10,
  "s6_margin": 8,
  "s6_vis": 8,
  "useS6": false,
  "useG4": true,
  "g4_lb": 28,
  "g4_volLen": 4,
  "g4_boxW": 1.5,
  "g4_atrMult": 4,
  "qty_pct_equity": 100,
  "rrUsePartialTp": true,
  "rrTp1Pct": 0.8,
  "rrTp2Pct": 3.5,
  "rrUseBE": false,
  "rrUseTrailSl": false,
  "rrTrailPct": 3,
  "rrTrailActPct": 2
}
```

### PUMPUSDT  — net 31.3% / DD 6.47% / legWR 98.64% / 147 entries (4353 legs) / PF 3.245

```json
{
  "atrLenRisk": 20,
  "s1_len": 3,
  "s1_maxAge": 14,
  "volMaLen": 50,
  "volMultMin": 0.9,
  "useG3": false,
  "g3_tf": "60",
  "rrSwingLb": 20,
  "rrBufAtr": 2.2,
  "rrRatio": 2.5,
  "minSlDistAtr": 10,
  "entryBodyAtrMult": 0.15,
  "s6_prox": 8,
  "s6_len": 7,
  "s6_margin": 6.5,
  "s6_vis": 8,
  "useS6": false,
  "useG4": false,
  "g4_lb": 20,
  "g4_volLen": 13,
  "g4_boxW": 4,
  "g4_atrMult": 3,
  "qty_pct_equity": 60,
  "rrUsePartialTp": true,
  "rrTp1Pct": 0.5,
  "rrTp2Pct": 10,
  "rrUseBE": true,
  "rrUseTrailSl": false,
  "rrTrailPct": 4,
  "rrTrailActPct": 0.5
}
```

### KAITOUSDT  — net 10.21% / DD 2.37% / legWR 96.4% / 216 entries (5032 legs) / PF 1.789

```json
{
  "atrLenRisk": 2,
  "s1_len": 2,
  "s1_maxAge": 40,
  "volMaLen": 100,
  "volMultMin": 0.5,
  "useG3": false,
  "g3_tf": "60",
  "rrSwingLb": 20,
  "rrBufAtr": 0.1,
  "rrRatio": 5,
  "minSlDistAtr": 2.5,
  "entryBodyAtrMult": 0.4,
  "s6_prox": 0.5,
  "s6_len": 4,
  "s6_margin": 8,
  "s6_vis": 8,
  "useS6": false,
  "useG4": true,
  "g4_lb": 36,
  "g4_volLen": 8,
  "g4_boxW": 6.5,
  "g4_atrMult": 4,
  "qty_pct_equity": 10,
  "rrUsePartialTp": true,
  "rrTp1Pct": 1.2,
  "rrTp2Pct": 2.5,
  "rrUseBE": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 4,
  "rrTrailActPct": 4
}
```

### INJUSDT  — net 4.51% / DD 1.05% / legWR 98.63% / 89 entries (3434 legs) / PF 2.01

```json
{
  "atrLenRisk": 10,
  "s1_len": 2,
  "s1_maxAge": 18,
  "volMaLen": 100,
  "volMultMin": 1.1,
  "useG3": true,
  "g3_tf": "15",
  "rrSwingLb": 14,
  "rrBufAtr": 0.5,
  "rrRatio": 1,
  "minSlDistAtr": 10,
  "entryBodyAtrMult": 0.2,
  "s6_prox": 8,
  "s6_len": 13,
  "s6_margin": 8.5,
  "s6_vis": 50,
  "useS6": false,
  "useG4": true,
  "g4_lb": 10,
  "g4_volLen": 10,
  "g4_boxW": 5,
  "g4_atrMult": 3,
  "qty_pct_equity": 10,
  "rrUsePartialTp": true,
  "rrTp1Pct": 3.5,
  "rrTp2Pct": 1,
  "rrUseBE": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 1.9,
  "rrTrailActPct": 6
}
```

### TAOUSDT  — net 7.17% / DD 1.74% / legWR 98.28% / 75 entries (2096 legs) / PF 2.598

```json
{
  "atrLenRisk": 10,
  "s1_len": 1,
  "s1_maxAge": 40,
  "volMaLen": 100,
  "volMultMin": 3,
  "useG3": true,
  "g3_tf": "60",
  "rrSwingLb": 20,
  "rrBufAtr": 1.8,
  "rrRatio": 3,
  "minSlDistAtr": 3.9,
  "entryBodyAtrMult": 0.15,
  "s6_prox": 4,
  "s6_len": 11,
  "s6_margin": 6,
  "s6_vis": 5,
  "useS6": false,
  "useG4": false,
  "g4_lb": 28,
  "g4_volLen": 10,
  "g4_boxW": 1.5,
  "g4_atrMult": 6.5,
  "qty_pct_equity": 15,
  "rrUsePartialTp": true,
  "rrTp1Pct": 1.8,
  "rrTp2Pct": 1,
  "rrUseBE": false,
  "rrUseTrailSl": false,
  "rrTrailPct": 3,
  "rrTrailActPct": 6
}
```

### ENAUSDT  — net 5.28% / DD 1.9% / legWR 62.58% / 203 entries (644 legs) / PF 1.809

```json
{
  "atrLenRisk": 2,
  "s1_len": 2,
  "s1_maxAge": 18,
  "volMaLen": 50,
  "volMultMin": 1.1,
  "useG3": true,
  "g3_tf": "15",
  "rrSwingLb": 14,
  "rrBufAtr": 1,
  "rrRatio": 6,
  "minSlDistAtr": 10,
  "entryBodyAtrMult": 0.1,
  "s6_prox": 20,
  "s6_len": 10,
  "s6_margin": 7.5,
  "s6_vis": 25,
  "useS6": false,
  "useG4": false,
  "g4_lb": 36,
  "g4_volLen": 10,
  "g4_boxW": 3,
  "g4_atrMult": 2,
  "qty_pct_equity": 10,
  "rrUsePartialTp": true,
  "rrTp1Pct": 1.2,
  "rrTp2Pct": 3.5,
  "rrUseBE": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.5,
  "rrTrailActPct": 0
}
```

### TIAUSDT  — net 3.71% / DD 1.45% / legWR 92.74% / 67 entries (951 legs) / PF 1.684

```json
{
  "atrLenRisk": 5,
  "s1_len": 5,
  "s1_maxAge": 22,
  "volMaLen": 50,
  "volMultMin": 1.1,
  "useG3": true,
  "g3_tf": "15",
  "rrSwingLb": 6,
  "rrBufAtr": 2.2,
  "rrRatio": 1,
  "minSlDistAtr": 2.5,
  "entryBodyAtrMult": 0.1,
  "s6_prox": 3,
  "s6_len": 3,
  "s6_margin": 5,
  "s6_vis": 2,
  "useS6": false,
  "useG4": true,
  "g4_lb": 40,
  "g4_volLen": 1,
  "g4_boxW": 10,
  "g4_atrMult": 8,
  "qty_pct_equity": 10,
  "rrUsePartialTp": true,
  "rrTp1Pct": 1.8,
  "rrTp2Pct": 10,
  "rrUseBE": true,
  "rrUseTrailSl": false,
  "rrTrailPct": 5,
  "rrTrailActPct": 2
}
```

### MORPHOUSDT  — net 1.45% / DD 0.61% / legWR 98.56% / 68 entries (1386 legs) / PF 2.377

```json
{
  "atrLenRisk": 8,
  "s1_len": 2,
  "s1_maxAge": 26,
  "volMaLen": 100,
  "volMultMin": 3,
  "useG3": false,
  "g3_tf": "15",
  "rrSwingLb": 12,
  "rrBufAtr": 2.2,
  "rrRatio": 1.25,
  "minSlDistAtr": 10,
  "entryBodyAtrMult": 0.15,
  "s6_prox": 20,
  "s6_len": 12,
  "s6_margin": 7.5,
  "s6_vis": 3,
  "useS6": false,
  "useG4": true,
  "g4_lb": 14,
  "g4_volLen": 13,
  "g4_boxW": 3,
  "g4_atrMult": 5,
  "qty_pct_equity": 10,
  "rrUsePartialTp": true,
  "rrTp1Pct": 0.5,
  "rrTp2Pct": 2.5,
  "rrUseBE": false,
  "rrUseTrailSl": false,
  "rrTrailPct": 0.8,
  "rrTrailActPct": 4
}
```

### EIGENUSDT  — net 3.38% / DD 1.63% / legWR 96.8% / 50 entries (1689 legs) / PF 1.78

```json
{
  "atrLenRisk": 2,
  "s1_len": 3,
  "s1_maxAge": 30,
  "volMaLen": 50,
  "volMultMin": 1.8,
  "useG3": true,
  "g3_tf": "60",
  "rrSwingLb": 6,
  "rrBufAtr": 2.2,
  "rrRatio": 3,
  "minSlDistAtr": 1.5,
  "entryBodyAtrMult": 0.5,
  "s6_prox": 0.5,
  "s6_len": 10,
  "s6_margin": 6.9,
  "s6_vis": 8,
  "useS6": false,
  "useG4": false,
  "g4_lb": 14,
  "g4_volLen": 13,
  "g4_boxW": 1.5,
  "g4_atrMult": 4,
  "qty_pct_equity": 10,
  "rrUsePartialTp": true,
  "rrTp1Pct": 1.8,
  "rrTp2Pct": 5,
  "rrUseBE": true,
  "rrUseTrailSl": false,
  "rrTrailPct": 2.5,
  "rrTrailActPct": 0
}
```

### NEARUSDT  — net 3.89% / DD 1.88% / legWR 61.14% / 133 entries (386 legs) / PF 1.412

```json
{
  "atrLenRisk": 20,
  "s1_len": 5,
  "s1_maxAge": 34,
  "volMaLen": 50,
  "volMultMin": 0.5,
  "useG3": true,
  "g3_tf": "60",
  "rrSwingLb": 14,
  "rrBufAtr": 0.1,
  "rrRatio": 0.75,
  "minSlDistAtr": 3.9,
  "entryBodyAtrMult": 0.5,
  "s6_prox": 0.5,
  "s6_len": 4,
  "s6_margin": 4.5,
  "s6_vis": 35,
  "useS6": false,
  "useG4": true,
  "g4_lb": 20,
  "g4_volLen": 8,
  "g4_boxW": 1.5,
  "g4_atrMult": 10,
  "qty_pct_equity": 10,
  "rrUsePartialTp": true,
  "rrTp1Pct": 1.8,
  "rrTp2Pct": 3.5,
  "rrUseBE": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 1.2,
  "rrTrailActPct": 1
}
```

### PYTHUSDT  — net 2.04% / DD 1.64% / legWR 96.25% / 119 entries (2587 legs) / PF 1.525

```json
{
  "atrLenRisk": 5,
  "s1_len": 1,
  "s1_maxAge": 14,
  "volMaLen": 50,
  "volMultMin": 0.5,
  "useG3": true,
  "g3_tf": "60",
  "rrSwingLb": 4,
  "rrBufAtr": 0.3,
  "rrRatio": 2.5,
  "minSlDistAtr": 6.5,
  "entryBodyAtrMult": 0.4,
  "s6_prox": 1,
  "s6_len": 6,
  "s6_margin": 9,
  "s6_vis": 8,
  "useS6": false,
  "useG4": false,
  "g4_lb": 36,
  "g4_volLen": 6,
  "g4_boxW": 6.5,
  "g4_atrMult": 2,
  "qty_pct_equity": 10,
  "rrUsePartialTp": true,
  "rrTp1Pct": 0.5,
  "rrTp2Pct": 7,
  "rrUseBE": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 4,
  "rrTrailActPct": 2
}
```