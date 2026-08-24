# 15m / 1-Year Optimizer — Deep Multi-Factor Analysis

Same method as `ANALYSIS_1H_MULTIFACTOR.md`, applied to `optimizer1y15m` (the "optyear-results" tree). Engine: MA + R:R v9, long-only spot, **15m**. Window 2025-07-20 → 2026-07-30. $1,000 start, 0.1%/side commission, **0 slippage**, **100% of equity per trade**.

> **The sqlite leaderboard index in this tree is stale and incomplete** — 9 of 17 coins have zero rows and the rest are missing 30–64% of their results (last rebuilt 2026-07-31 while the optimizer kept writing through 2026-08-12). Every number below comes from a direct scan of `results/*.jsonl` — **5,908,986 evaluations** across the 17 active coins — not from the index. Any dashboard or tooling reading that sqlite is currently showing you a partial picture.

Active coins are the same 17 as the 1h tree. Same six factors, same Pareto-front constraint, same implied risk-per-trade estimator.

## 1. Master ranking — balanced configs

| # | Coin | Net % | DD % | Win % | PF | RR | Risk/trade | W/L | Trades | MAR | Geo/trade | Spike | % configs profitable | Agreement |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **SYNUSDT** | 4343% | 31.0% | 61.9% | 13.96 | 2.5 | 0.76% | 8.6 | 105 | 140.2 | 3.68% | 1.96 | 97.8% | 25/31 |
| 2 | **ALLOUSDT** | 1721% | 20.3% | 75.0% | 8.35 | 2.5 | 2.96% | 2.8 | 56 | 85.0 | 5.32% | 1.50 | 99.0% | 22/31 |
| 3 | **TAOUSDT** | 352% | 12.8% | 74.6% | 4.26 | 2.5 | 3.20% | 1.5 | 59 | 27.6 | 2.59% | 1.38 | 86.7% | 26/31 |
| 4 | **ZECUSDT** | 3256% | 27.7% | 65.4% | 2.57 | 2.0 | 4.50% | 1.4 | 153 | 117.6 | 2.32% | 1.79 | 98.3% | 24/31 |
| 5 | **DEXEUSDT** | 2144% | 35.5% | 67.3% | 4.52 | 1.5 | 2.50% | 2.2 | 113 | 60.4 | 2.79% | 2.15 | 98.1% | 20/31 |
| 6 | **NEARUSDT** | 327% | 12.1% | 72.5% | 3.47 | 1.5 | 3.20% | 1.3 | 69 | 27.1 | 2.13% | 1.28 | 93.2% | 24/31 |
| 7 | **RIFUSDT** | 474% | 23.3% | 60.5% | 5.32 | 2.5 | 1.40% | 3.5 | 76 | 20.4 | 2.33% | 1.96 | 92.6% | 19/31 |
| 8 | **币安人生USDT** | 2604% | 31.9% | 84.4% | 4.59 | 0.75 | 9.85% | 0.8 | 64 | 81.6 | 5.29% | 1.89 | 94.2% | 24/31 |
| 9 | **JTOUSDT** | 552% | 26.9% | 57.5% | 2.23 | 2.5 | 2.60% | 1.6 | 146 | 20.5 | 1.29% | 1.66 | 93.8% | 23/31 |
| 10 | **JSTUSDT** | 146% | 8.8% | 63.2% | 2.04 | 2.0 | 1.45% | 1.2 | 166 | 16.6 | 0.54% | 1.42 | 70.0% | 21/31 |
| 11 | **MORPHOUSDT** | 241% | 14.1% | 64.9% | 2.33 | 2.5 | 3.60% | 1.3 | 77 | 17.1 | 1.61% | 1.47 | 79.7% | 24/31 |
| 12 | **PUMPUSDT** | 338% | 20.2% | 70.1% | 2.28 | 1.0 | 5.40% | 1.0 | 77 | 16.7 | 1.94% | 1.59 | 72.8% | 22/31 |
| 13 | **KAITOUSDT** | 149% | 14.2% | 39.5% | 1.97 | 2.0 | 1.30% | 3.0 | 124 | 10.4 | 0.74% | 1.72 | 71.4% | 22/31 |
| 14 | **EIGENUSDT** | 189% | 16.2% | 74.0% | 2.02 | 0.75 | 5.55% | 0.7 | 77 | 11.7 | 1.39% | 1.54 | 68.0% | 23/31 |
| 15 | **ENAUSDT** | 253% | 16.4% | 60.5% | 1.97 | 1.5 | 4.75% | 1.3 | 76 | 15.4 | 1.67% | 1.36 | 68.0% | 26/31 |
| 16 | **JUPUSDT** | 179% | 15.5% | 71.0% | 1.85 | 1.5 | 6.00% | 0.8 | 76 | 11.6 | 1.36% | 1.44 | 63.6% | 21/31 |
| 17 | **INJUSDT** | 93% | 14.1% | 61.7% | 1.40 | 1.0 | 3.35% | 0.9 | 141 | 6.6 | 0.47% | 3.69 | 25.5% | 24/31 |

## 2. Cost sensitivity — the 15m system's defining weakness

15m fires 56–166 trades per coin versus 31–108 on 1h, and the per-trade edge is correspondingly thinner. Backtests assume **zero slippage**, so the columns below recompound each config's geometric per-trade return after deducting an extra 0.1% and 0.2% round-trip.

| Coin | Trades | Geo/trade | Net as tested | Net at +0.1% | Net at +0.2% | Lost to +0.2% |
|---|---|---|---|---|---|---|
| SYNUSDT | 105 | 3.68% | 4343% | 3915% | 3528% | 19% |
| ALLOUSDT | 56 | 5.32% | 1721% | 1627% | 1537% | 11% |
| TAOUSDT | 59 | 2.59% | 352% | 326% | 302% | 14% |
| ZECUSDT | 153 | 2.32% | 3256% | 2790% | 2388% | 27% |
| DEXEUSDT | 113 | 2.79% | 2144% | 1911% | 1701% | 21% |
| NEARUSDT | 69 | 2.13% | 327% | 299% | 273% | 17% |
| RIFUSDT | 76 | 2.33% | 474% | 433% | 395% | 17% |
| 币安人生USDT | 64 | 5.29% | 2604% | 2445% | 2294% | 12% |
| JTOUSDT | 146 | 1.29% | 552% | 465% | 389% | 30% |
| JSTUSDT | 166 | 0.54% | 146% | 109% | 77% | 47% |
| MORPHOUSDT | 77 | 1.61% | 241% | 216% | 193% | 20% |
| PUMPUSDT | 77 | 1.94% | 338% | 306% | 276% | 18% |
| KAITOUSDT | 124 | 0.74% | 149% | 120% | 94% | 37% |
| EIGENUSDT | 77 | 1.39% | 189% | 168% | 148% | 22% |
| ENAUSDT | 76 | 1.67% | 253% | 227% | 204% | 19% |
| JUPUSDT | 76 | 1.36% | 179% | 159% | 140% | 22% |
| INJUSDT | 141 | 0.47% | 93% | 68% | 46% | 51% |

## 3. Fragility — breakeven win rate

| Coin | Win % | W/L | Breakeven win % | Margin |
|---|---|---|---|---|
| SYNUSDT | 61.9% | 8.6 | 10.4% | 51.5 pts |
| ALLOUSDT | 75.0% | 2.8 | 26.4% | 48.6 pts |
| TAOUSDT | 74.6% | 1.5 | 40.8% | 33.8 pts |
| ZECUSDT | 65.4% | 1.4 | 42.4% | 23.0 pts |
| DEXEUSDT | 67.3% | 2.2 | 31.2% | 36.0 pts |
| NEARUSDT | 72.5% | 1.3 | 43.2% | 29.3 pts |
| RIFUSDT | 60.5% | 3.5 | 22.4% | 38.1 pts |
| 币安人生USDT | 84.4% | 0.8 | 54.1% | 30.3 pts |
| JTOUSDT | 57.5% | 1.6 | 37.8% | 19.8 pts |
| JSTUSDT | 63.2% | 1.2 | 45.8% | 17.4 pts |
| MORPHOUSDT | 64.9% | 1.3 | 44.3% | 20.7 pts |
| PUMPUSDT | 70.1% | 1.0 | 50.8% | 19.4 pts |
| KAITOUSDT | 39.5% | 3.0 | 24.9% | 14.6 pts |
| EIGENUSDT | 74.0% | 0.7 | 58.5% | 15.5 pts |
| ENAUSDT | 60.5% | 1.3 | 43.8% | 16.8 pts |
| JUPUSDT | 71.0% | 0.8 | 57.1% | 14.0 pts |
| INJUSDT | 61.7% | 0.9 | 53.5% | 8.2 pts |

## 4. Conservative variant — lowest drawdown and risk per trade

| # | Coin | Net % | DD % | Win % | PF | RR | Risk/trade | Trades | MAR | vs balanced DD |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | SYNUSDT | 5056% | **31.0%** | 58.9% | 13.17 | 2.5 | **0.76%** | 107 | 163.3 | +0.0 pts |
| 2 | ALLOUSDT | 1692% | **21.1%** | 75.4% | 9.95 | 2.5 | **2.41%** | 57 | 80.3 | +0.8 pts |
| 3 | TAOUSDT | 352% | **12.8%** | 74.6% | 4.26 | 2.5 | **3.20%** | 59 | 27.6 | +0.0 pts |
| 4 | ZECUSDT | 1906% | **18.1%** | 73.3% | 2.42 | 2.5 | **6.50%** | 131 | 105.6 | -9.6 pts |
| 5 | DEXEUSDT | 1393% | **25.3%** | 64.9% | 4.29 | 2.5 | **2.20%** | 111 | 55.2 | -10.2 pts |
| 6 | NEARUSDT | 295% | **9.6%** | 71.2% | 3.18 | 1.0 | **3.10%** | 73 | 30.9 | -2.5 pts |
| 7 | RIFUSDT | 414% | **17.8%** | 63.9% | 4.19 | 1.5 | **2.05%** | 72 | 23.2 | -5.5 pts |
| 8 | 币安人生USDT | 1545% | **31.9%** | 84.9% | 7.89 | 0.75 | **5.32%** | 53 | 48.4 | +0.0 pts |
| 9 | JTOUSDT | 532% | **19.8%** | 55.6% | 2.12 | 2.5 | **2.75%** | 142 | 26.9 | -7.2 pts |
| 10 | JSTUSDT | 146% | **8.8%** | 63.2% | 2.04 | 2.0 | **1.45%** | 166 | 16.6 | +0.0 pts |
| 11 | MORPHOUSDT | 243% | **14.1%** | 66.2% | 2.33 | 2.5 | **4.10%** | 71 | 17.3 | +0.0 pts |
| 12 | PUMPUSDT | 185% | **15.1%** | 80.7% | 3.41 | 1.5 | **4.10%** | 57 | 12.2 | -5.1 pts |
| 13 | KAITOUSDT | 104% | **7.7%** | 44.3% | 2.18 | 1.0 | **1.15%** | 97 | 13.5 | -6.6 pts |
| 14 | EIGENUSDT | 189% | **16.2%** | 74.0% | 2.02 | 0.75 | **5.55%** | 77 | 11.7 | +0.0 pts |
| 15 | ENAUSDT | 253% | **16.4%** | 60.5% | 1.97 | 1.5 | **4.75%** | 76 | 15.4 | +0.0 pts |
| 16 | JUPUSDT | 161% | **13.5%** | 68.3% | 1.85 | 1.5 | **4.85%** | 79 | 11.9 | -1.9 pts |
| 17 | INJUSDT | 93% | **14.1%** | 61.7% | 1.40 | 1.0 | **3.35%** | 141 | 6.6 | +0.0 pts |

## 5. 15m vs 1h — same strategy, same coins, same window

| Coin | 1h net% | 15m net% | 1h PF | 15m PF | 1h risk/tr | 15m risk/tr | 1h spike | 15m spike | Better TF |
|---|---|---|---|---|---|---|---|---|---|
| SYNUSDT | 2078% | 4343% | 25.89 | 13.96 | 0.58% | 0.76% | 1.51 | 1.96 | mixed |
| ALLOUSDT | 921% | 1721% | 10.36 | 8.35 | 3.75% | 2.96% | 1.53 | 1.50 | mixed |
| TAOUSDT | 377% | 352% | 7.16 | 4.26 | 5.28% | 3.20% | 1.22 | 1.38 | mixed |
| ZECUSDT | 1430% | 3256% | 6.49 | 2.57 | 7.50% | 4.50% | 1.64 | 1.79 | mixed |
| DEXEUSDT | 3032% | 2144% | 7.99 | 4.52 | 2.30% | 2.50% | 1.58 | 2.15 | 1h |
| NEARUSDT | 491% | 327% | 10.35 | 3.47 | 3.95% | 3.20% | 1.42 | 1.28 | 1h |
| RIFUSDT | 990% | 474% | 9.99 | 5.32 | 1.61% | 1.40% | 1.71 | 1.96 | 1h |
| 币安人生USDT | 1785% | 2604% | 9.04 | 4.59 | 6.60% | 9.85% | 1.59 | 1.89 | mixed |
| JTOUSDT | 433% | 552% | 3.97 | 2.23 | 6.00% | 2.60% | 1.43 | 1.66 | 1h |
| JSTUSDT | 261% | 146% | 8.72 | 2.04 | 3.40% | 1.45% | 1.23 | 1.42 | 1h |
| MORPHOUSDT | 291% | 241% | 6.90 | 2.33 | 3.40% | 3.60% | 1.41 | 1.47 | 1h |
| PUMPUSDT | 243% | 338% | 3.13 | 2.28 | 6.25% | 5.40% | 1.80 | 1.59 | mixed |
| KAITOUSDT | 439% | 149% | 11.61 | 1.97 | 2.76% | 1.30% | 1.39 | 1.72 | 1h |
| EIGENUSDT | 257% | 189% | 4.09 | 2.02 | 8.70% | 5.55% | 2.47 | 1.54 | 1h |
| ENAUSDT | 122% | 253% | 6.24 | 1.97 | 0.95% | 4.75% | 2.70 | 1.36 | mixed |
| JUPUSDT | 163% | 179% | 3.13 | 1.85 | 5.90% | 6.00% | 1.50 | 1.44 | 1h |
| INJUSDT | 130% | 93% | 4.23 | 1.40 | 3.80% | 3.35% | 1.50 | 3.69 | 1h |

## 6. Balanced configs — full parameters

| # | Coin | ma1_len | ma1_slopeLb | ma2_len | ma2_slopeLb | ma3_len | ma3_slopeLb | ma4_len | ma4_slopeLb | volMaLen | volMultMin | hhPivotLen | entryBodyAtrMult | atrLenExit | rrSwingLb | rrBufAtr | rrRatio | minSlDistAtr | extMaxPct | runLb | runMaxPct | wickMaxAtr | hlBreakPivLen | hlBreakMinR | useRunLimit | useSuperTrend | useLocalTrend | at_coeff | at_ap | hac_length | hac_emaLen | hac_csf |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | SYNUSDT | 100 | 10 | 150 | 20 | 34 | 15 | 21 | 10 | 20 | 1 | 16 | 0.2 | 1 | 20 | 0.5 | 2.5 | 0.5 | 3 | 12 | 18 | 1.2 | 22 | 0.25 | False | True | False | 1 | 50 | 89 | 40 | 0.8 |
| 2 | ALLOUSDT | 150 | 50 | 300 | 10 | 14 | 21 | 21 | 13 | 20 | 1 | 16 | 0.6 | 2 | 20 | 0.5 | 2.5 | 0.5 | 2 | 12 | 19 | 0.6 | 10 | 0.25 | False | False | False | 1.5 | 150 | 55 | 100 | 1.4 |
| 3 | TAOUSDT | 400 | 20 | 200 | 30 | 14 | 15 | 200 | 13 | 50 | 1.6 | 14 | 0.2 | 4 | 20 | 0.4 | 2.5 | 0.5 | 3 | 12 | 10 | 0.6 | 9 | 0.5 | False | True | False | 2 | 50 | 34 | 100 | 1.4 |
| 4 | ZECUSDT | 200 | 15 | 50 | 20 | 50 | 15 | 21 | 6 | 50 | 1.5 | 6 | 0.4 | 7 | 14 | 0.4 | 2 | 0.25 | 2 | 12 | 18 | 2 | 10 | 0.5 | False | False | False | 1 | 50 | 34 | 40 | 0.8 |
| 5 | DEXEUSDT | 150 | 10 | 100 | 10 | 14 | 15 | 50 | 6 | 100 | 1 | 10 | 0.2 | 5 | 20 | 0.5 | 1.5 | 0.05 | 2 | 12 | 19 | 0.8 | 15 | 0.5 | True | False | False | 2 | 100 | 34 | 60 | 1.1 |
| 6 | NEARUSDT | 400 | 5 | 150 | 30 | 50 | 13 | 100 | 10 | 50 | 2 | 25 | 0.8 | 7 | 20 | 1 | 1.5 | 0.25 | 5 | 12 | 19 | 0.8 | 9 | 0.5 | True | True | True | 2 | 50 | 89 | 100 | 1.1 |
| 7 | RIFUSDT | 150 | 50 | 300 | 10 | 34 | 30 | 50 | 15 | 50 | 1.3 | 15 | 0.3 | 4 | 10 | 1 | 2.5 | 0.5 | 5 | 30 | 19 | 0.6 | 15 | 0.25 | True | False | False | 1 | 150 | 55 | 60 | 1.1 |
| 8 | 币安人生USDT | 100 | 20 | 150 | 30 | 50 | 30 | 100 | 6 | 100 | 1.5 | 8 | 0.6 | 4 | 20 | 0.7 | 0.75 | 0.5 | 3 | 12 | 25 | 1.2 | 22 | 0.25 | False | False | False | 1 | 150 | 55 | 40 | 1.4 |
| 9 | JTOUSDT | 150 | 5 | 200 | 25 | 14 | 13 | 50 | 11 | 50 | 1 | 10 | 0.8 | 4 | 6 | 0.7 | 2.5 | 0.25 | 2 | 30 | 19 | 0.8 | 22 | 0.5 | True | True | False | 2 | 50 | 55 | 60 | 0.8 |
| 10 | JSTUSDT | 300 | 15 | 100 | 25 | 14 | 15 | 34 | 11 | 50 | 0.2 | 25 | 0.2 | 14 | 14 | 0.5 | 2 | 0.05 | 3 | 30 | 10 | 0.6 | 21 | 0.5 | True | False | False | 2 | 100 | 89 | 60 | 0.8 |
| 11 | MORPHOUSDT | 150 | 5 | 50 | 25 | 21 | 15 | 21 | 25 | 20 | 1 | 14 | 0.4 | 14 | 10 | 1 | 2.5 | 0.05 | 2 | 30 | 10 | 2 | 12 | 0.5 | True | True | False | 2 | 100 | 89 | 60 | 1.1 |
| 12 | PUMPUSDT | 400 | 30 | 100 | 25 | 14 | 13 | 50 | 13 | 50 | 2 | 8 | 0.3 | 2 | 14 | 0.7 | 1 | 0.5 | 3 | 20 | 17 | 0.9 | 15 | 0.5 | False | False | True | 1 | 100 | 89 | 40 | 1.4 |
| 13 | KAITOUSDT | 200 | 15 | 100 | 25 | 200 | 8 | 34 | 10 | 100 | 1.5 | 10 | 0.2 | 14 | 6 | 1 | 2 | 0.05 | 3 | 30 | 10 | 2 | 12 | 0 | False | False | True | 1.5 | 50 | 89 | 100 | 1.1 |
| 14 | EIGENUSDT | 400 | 10 | 150 | 30 | 50 | 21 | 21 | 10 | 20 | 2 | 10 | 0.2 | 1 | 9 | 0.7 | 0.75 | 0.25 | 5 | 30 | 17 | 0.6 | 15 | 0.25 | False | True | False | 1.5 | 150 | 55 | 60 | 1.4 |
| 15 | ENAUSDT | 100 | 5 | 100 | 5 | 34 | 9 | 100 | 10 | 50 | 2 | 14 | 0.2 | 2 | 10 | 0.5 | 1.5 | 0.05 | 3 | 20 | 10 | 2 | 21 | 0.5 | False | False | True | 1.5 | 50 | 34 | 60 | 0.8 |
| 16 | JUPUSDT | 300 | 5 | 150 | 30 | 21 | 13 | 200 | 25 | 100 | 2 | 15 | 0.6 | 2 | 20 | 0.3 | 1.5 | 0.5 | 5 | 12 | 13 | 2 | 15 | 0.5 | False | True | True | 1.5 | 100 | 55 | 40 | 1.4 |
| 17 | INJUSDT | 150 | 5 | 100 | 30 | 14 | 9 | 34 | 11 | 100 | 1.5 | 25 | 0.6 | 7 | 6 | 0.5 | 1 | 0.05 | 5 | 30 | 13 | 0.8 | 15 | 0.25 | False | False | True | 2 | 100 | 89 | 100 | 1.1 |

## 7. Conservative configs — full parameters

| # | Coin | ma1_len | ma1_slopeLb | ma2_len | ma2_slopeLb | ma3_len | ma3_slopeLb | ma4_len | ma4_slopeLb | volMaLen | volMultMin | hhPivotLen | entryBodyAtrMult | atrLenExit | rrSwingLb | rrBufAtr | rrRatio | minSlDistAtr | extMaxPct | runLb | runMaxPct | wickMaxAtr | hlBreakPivLen | hlBreakMinR | useRunLimit | useSuperTrend | useLocalTrend | at_coeff | at_ap | hac_length | hac_emaLen | hac_csf |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | SYNUSDT | 400 | 5 | 150 | 20 | 14 | 15 | 21 | 10 | 20 | 1 | 16 | 0.2 | 1 | 20 | 0.5 | 2.5 | 0.05 | 3 | 12 | 18 | 1.2 | 22 | 0.25 | False | True | False | 1.5 | 50 | 34 | 60 | 0.8 |
| 2 | ALLOUSDT | 100 | 50 | 300 | 10 | 14 | 8 | 21 | 6 | 20 | 1 | 16 | 0.6 | 2 | 20 | 0.7 | 2.5 | 0.25 | 2 | 20 | 25 | 0.6 | 10 | 0.25 | True | False | False | 1.5 | 150 | 55 | 40 | 0.8 |
| 3 | TAOUSDT | 400 | 20 | 200 | 30 | 14 | 15 | 200 | 13 | 50 | 1.6 | 14 | 0.2 | 4 | 20 | 0.4 | 2.5 | 0.5 | 3 | 12 | 10 | 0.6 | 9 | 0.5 | False | True | False | 2 | 50 | 34 | 100 | 1.4 |
| 4 | ZECUSDT | 300 | 15 | 50 | 20 | 14 | 9 | 21 | 25 | 50 | 1.5 | 6 | 0.2 | 7 | 20 | 0.4 | 2.5 | 0.25 | 2 | 20 | 13 | 2 | 12 | 0.25 | False | False | False | 2 | 100 | 55 | 40 | 0.8 |
| 5 | DEXEUSDT | 400 | 10 | 200 | 10 | 14 | 8 | 21 | 6 | 100 | 1.5 | 8 | 0.3 | 2 | 20 | 1 | 2.5 | 0.05 | 2 | 12 | 13 | 0.8 | 21 | 0.25 | False | False | False | 2 | 50 | 89 | 40 | 1.1 |
| 6 | NEARUSDT | 150 | 15 | 150 | 20 | 50 | 13 | 100 | 13 | 50 | 2 | 25 | 0.8 | 7 | 20 | 0.7 | 1 | 0.25 | 2 | 30 | 25 | 1.2 | 30 | 0.5 | True | True | True | 1 | 150 | 89 | 40 | 1.1 |
| 7 | RIFUSDT | 100 | 50 | 300 | 5 | 21 | 8 | 200 | 15 | 50 | 1.6 | 15 | 0.5 | 7 | 10 | 1 | 1.5 | 0.5 | 5 | 30 | 19 | 0.6 | 15 | 0.5 | False | False | False | 1 | 150 | 55 | 40 | 1.1 |
| 8 | 币安人生USDT | 200 | 20 | 300 | 20 | 50 | 9 | 34 | 25 | 20 | 1.3 | 8 | 0.6 | 4 | 20 | 0.7 | 0.75 | 0.25 | 3 | 12 | 25 | 1.2 | 22 | 0.25 | False | False | True | 1 | 150 | 34 | 40 | 0.8 |
| 9 | JTOUSDT | 300 | 5 | 200 | 20 | 50 | 8 | 21 | 11 | 50 | 1 | 10 | 0.5 | 4 | 6 | 0.7 | 2.5 | 0.25 | 2 | 30 | 19 | 0.8 | 15 | 0.5 | True | False | True | 1.5 | 50 | 55 | 60 | 1.4 |
| 10 | JSTUSDT | 300 | 15 | 100 | 25 | 14 | 15 | 34 | 11 | 50 | 0.2 | 25 | 0.2 | 14 | 14 | 0.5 | 2 | 0.05 | 3 | 30 | 10 | 0.6 | 21 | 0.5 | True | False | False | 2 | 100 | 89 | 60 | 0.8 |
| 11 | MORPHOUSDT | 150 | 5 | 50 | 10 | 21 | 9 | 21 | 11 | 20 | 1 | 15 | 0.5 | 14 | 10 | 1 | 2.5 | 0.05 | 2 | 30 | 10 | 0.9 | 12 | 0.5 | True | True | True | 2 | 100 | 89 | 60 | 0.8 |
| 12 | PUMPUSDT | 400 | 30 | 100 | 20 | 50 | 8 | 200 | 11 | 20 | 2 | 8 | 0.6 | 2 | 14 | 0.7 | 1.5 | 0.25 | 5 | 12 | 17 | 0.9 | 9 | 0.25 | True | True | False | 1 | 150 | 55 | 40 | 1.4 |
| 13 | KAITOUSDT | 200 | 5 | 150 | 30 | 50 | 30 | 200 | 10 | 100 | 1.5 | 10 | 0.8 | 4 | 14 | 0.7 | 1 | 0.05 | 3 | 30 | 10 | 0.6 | 12 | 0 | False | False | True | 1.5 | 100 | 34 | 100 | 1.1 |
| 14 | EIGENUSDT | 400 | 10 | 150 | 30 | 50 | 21 | 21 | 10 | 20 | 2 | 10 | 0.2 | 1 | 9 | 0.7 | 0.75 | 0.25 | 5 | 30 | 17 | 0.6 | 15 | 0.25 | False | True | False | 1.5 | 150 | 55 | 60 | 1.4 |
| 15 | ENAUSDT | 100 | 5 | 100 | 5 | 34 | 9 | 100 | 10 | 50 | 2 | 14 | 0.2 | 2 | 10 | 0.5 | 1.5 | 0.05 | 3 | 20 | 10 | 2 | 21 | 0.5 | False | False | True | 1.5 | 50 | 34 | 60 | 0.8 |
| 16 | JUPUSDT | 100 | 30 | 200 | 30 | 200 | 30 | 21 | 15 | 100 | 2 | 15 | 0.6 | 2 | 20 | 0.3 | 1.5 | 0.05 | 2 | 12 | 17 | 2 | 15 | 0.5 | False | True | False | 1.5 | 100 | 55 | 40 | 1.4 |
| 17 | INJUSDT | 150 | 5 | 100 | 30 | 14 | 9 | 34 | 11 | 100 | 1.5 | 25 | 0.6 | 7 | 6 | 0.5 | 1 | 0.05 | 5 | 30 | 13 | 0.8 | 15 | 0.25 | False | False | True | 2 | 100 | 89 | 100 | 1.1 |
## 8. Reading the 15m results

**a) 15m gives you a better sample and a worse edge.** Averaged across the 17 balanced configs:

| | 1h | 15m |
|---|---|---|
| Trades per coin | 45 | **97** |
| Profit factor | 8.19 | **3.83** |
| Win rate | 78.5% | **66.1%** |
| Win/loss size ratio | 3.17 | **1.98** |
| Geometric return per trade | 4.45% | **2.20%** |
| Spike ratio (lower = less curve-fit) | 1.63 | **1.75** |

More than twice the trades is genuinely valuable — 97 trades is a much firmer estimate than 45. But every quality measure moved the wrong way, and the spike ratio got worse rather than better. You are paying for sample size with edge.

**b) Commission is the 15m system's real enemy.** Halving the per-trade edge while doubling the trade count means the fixed 0.2% round-trip commission takes twice the bite. And the backtests assume **zero slippage**, which is not a rounding error on this timeframe. Adding just 0.2% of round-trip cost destroys an average of **23.6%** of net profit across the 17 coins, and over 50% on the worst:

- JSTUSDT: 146% → **77%** (−47%) — 166 trades at 0.54% geometric edge each
- INJUSDT: 93% → **46%** (−51%) — 141 trades at 0.47% each
- KAITOUSDT: 149% → **94%** (−37%) — 124 trades at 0.74% each
- ZECUSDT: 3256% → 2388% (−27%) — 153 trades

Any config whose geometric per-trade return is under ~1% is not a strategy, it is a fee-generation machine waiting for realistic fills. On 1h only JUP fell in that zone; on 15m it is **JST, INJ, KAITO** outright and JTO/EIGEN marginally.

**c) INJUSDT on 15m is the clearest overfit in either system.** Only **25.5% of 347,550 tested configs were profitable** — three quarters of the search space loses money — and the spike ratio is **3.69**, the worst number anywhere in this analysis. The best config makes 93% net at 0.47% per trade with an 8.2-point margin over its breakeven win rate. Every single indicator says this is noise that the optimizer mined. Do not trade INJ on 15m.

**d) KAITOUSDT's balanced config wins only 39.5% of its trades.** It survives on a 3.0 win/loss ratio. That is a legitimate trend-following profile, but it is a completely different psychological proposition from the 1h KAITO config (81.2% win rate) — and at 0.74% per trade it is the third most cost-fragile config in the set.

**e) 币安人生USDT looks great and is not.** 2604% net, 84.4% win rate — but **risk per trade is 9.85%**, the highest anywhere, its W/L is 0.8 (average win smaller than average loss), and it needs a 54.1% win rate just to break even. It also has only 6.7 months of candle history. Big number, thin foundation.

**f) The genuine 15m standouts are ALLO and TAO.** ALLOUSDT: 1721% net, 20.3% DD, **99.0% of all configs profitable**, spike 1.50, PF 8.35, and a 48.6-point margin over breakeven. TAOUSDT: modest 352% but spike **1.38**, agreement 26/31, 12.8% DD and a 2.59% per-trade edge that survives cost. NEARUSDT is the third (spike 1.28, DD 12.1%). These three are where the 15m plateau evidence is strongest.

**g) SYNUSDT repeats its 1h pattern, more extremely.** 4343% net on a 61.9% win rate with W/L 8.6 — the return is concentrated in a small number of very large winners, and the RR setting is 2.5 while realised W/L is 8.6. Lowest risk per trade in the set (0.76%) and the widest safety margin, so it is not fragile — but it is a bet on outliers recurring, not on a steady edge.

## 9. 15m vs 1h — which timeframe to trade

**1h wins on 10 of 17 coins** by combined MAR and profit factor; 15m wins on 7. But the aggregate picture is more one-sided than that count suggests, because the 15m advantages are concentrated in coins whose edge is cost-fragile, while the 1h advantages sit in the coins with the widest per-trade margins.

| Verdict | Coins |
|---|---|
| **Trade on 1h** | NEAR, KAITO, RIF, DEXE, JST, ENA, JUP, INJ, MORPHO, EIGEN — all have materially better PF and per-trade edge on 1h |
| **Trade on 15m** | ALLO (1721% vs 921%, DD 20.3% vs 25.3%), ZEC, TAO, JTO, PUMP, SYN, 币安人生 — but only ALLO and TAO are clean wins; the rest trade higher net for worse fragility |
| **Trade on neither** | INJ (25.5% profitable on 15m, thin on 1h) |

If you are running one system, run the **1h**. Its edges are wider per trade, its spike ratios are lower, its cost sensitivity is far better, and its 45-trade samples — while thinner — are measuring something more durable. Use 15m only for ALLO and TAO, where the 15m evidence is actually stronger than the 1h evidence.

## 10. Recommendation

| Tier | Coins (15m) | Config |
|---|---|---|
| **Core** | ALLOUSDT, TAOUSDT, NEARUSDT | Best spike ratios (1.50 / 1.38 / 1.28), healthy per-trade edge, DD 12–20%. Use balanced; conservative for ALLO if you want DD under 20%. |
| **Satellite** | SYNUSDT, ZECUSDT, DEXEUSDT | Large returns, real plateau support (97.8% / 98.3% / 98.1% profitable), but DD 28–36% and SYN's concentration caveat. Half size. |
| **Avoid on 15m** | INJUSDT, JSTUSDT, KAITOUSDT, EIGENUSDT, JUPUSDT, 币安人生USDT, PUMPUSDT, MORPHOUSDT, JTOUSDT, ENAUSDT, RIFUSDT | Sub-1% per-trade edges, breakeven-win-rate margins under 20 points, or risk per trade above 5%. Most of these are better on 1h. |

Everything here is **in-sample**, exactly as with the 1h analysis. The walk-forward now running covers the 1h system only. Once it reports, the same fold machinery can be pointed at 15m by copying `optimizer1y1h_wf/` with `timeframe: "15m"` — the driver reads the timeframe from config and needs no other change.
