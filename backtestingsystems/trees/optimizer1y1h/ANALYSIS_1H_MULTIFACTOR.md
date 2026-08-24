# 1h / 1-Year Optimizer — Deep Multi-Factor Analysis (Top-1000 configs per coin)

Supersedes `ANALYSIS_1H_1Y.md`. Pool widened from top-200 to **top-1000 configs per coin** (17,000 configs read from the result files), and config selection now optimises **six factors simultaneously** instead of the optimizer's two-term score.

Engine: MA + R:R v9, long-only spot, 1h. Window **2025-07-20 → 2026-07-30** (12.3 months — candle data ends 2026-07-30). $1,000 start, 0.1%/side commission, **0 slippage**, **100% of equity per trade (fully compounding)**.

## 1. The two new metrics

**Risk per trade (`risk%`)** — the average loss on a losing trade, as a percentage of account equity. Not stored by the optimizer, so I solved for it from the recorded numbers. With w wins, l losses, and the observed win/loss size ratio `k = PF × l ÷ w`, the compounding identity is:

```
(1 + k·L)^w  ×  (1 − L)^l  =  1 + net%/100
```

Solved numerically for `L` per config. This is the real per-trade risk you carry, and it is the number that decides whether a losing streak is survivable. Note it is the *average realised loss*, not the stop distance — trades that exit before the stop pull it down.

**W/L** — average win ÷ average loss, in return terms. Distinct from the `rrRatio` *setting*: RR is the take-profit target you configure, W/L is what the trades actually delivered. Where W/L greatly exceeds RR, the profit came from a few outsized runners, which is less repeatable than a high W/L that matches the RR setting.

**Pareto front** — configs that no other config beats on *all six* of net%, DD%, win%, PF, RR and risk/trade. Every recommended config below is drawn from its coin's front, so nothing on this list is strictly beaten by another config in the pool.

## 2. Master ranking — balanced configs

Weights: MAR 22%, risk/trade 16%, PF 14%, win% 12%, net% 10%, DD 8%, RR 6%, trades 5%, robustness 4%, search-space health 3%.

| # | Coin | Net % | DD % | Win % | PF | RR | Risk/trade | W/L | Trades | MAR | Geo/trade | Front size | Agreement |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **SYNUSDT** | 2078% | 23.9% | 50.0% | 25.89 | 2.5 | 0.58% | 25.9 | 46 | 87.0 | 6.93% | 36 | 26/31 |
| 2 | **NEARUSDT** | 491% | 12.2% | 86.1% | 10.35 | 2.5 | 3.95% | 1.7 | 36 | 40.1 | 5.06% | 94 | 28/31 |
| 3 | **DEXEUSDT** | 3032% | 30.3% | 79.6% | 7.99 | 0.75 | 2.30% | 2.0 | 108 | 100.0 | 3.24% | 94 | 16/31 |
| 4 | **KAITOUSDT** | 439% | 13.2% | 81.2% | 11.61 | 2.5 | 2.76% | 2.7 | 32 | 33.1 | 5.40% | 28 | 24/31 |
| 5 | **JSTUSDT** | 261% | 10.4% | 89.6% | 8.72 | 1.0 | 3.40% | 1.0 | 48 | 25.2 | 2.71% | 47 | 26/31 |
| 6 | **RIFUSDT** | 990% | 33.3% | 73.8% | 9.99 | 1.5 | 1.61% | 3.5 | 65 | 29.8 | 3.74% | 50 | 27/31 |
| 7 | **ALLOUSDT** | 921% | 25.3% | 79.4% | 10.36 | 2.0 | 3.75% | 2.7 | 34 | 36.4 | 7.07% | 30 | 21/31 |
| 8 | **ZECUSDT** | 1430% | 19.9% | 85.4% | 6.49 | 2.0 | 7.50% | 1.1 | 48 | 71.8 | 5.85% | 44 | 16/31 |
| 9 | **TAOUSDT** | 377% | 15.1% | 86.1% | 7.16 | 2.5 | 5.28% | 1.2 | 36 | 25.1 | 4.44% | 38 | 29/31 |
| 10 | **币安人生USDT** | 1785% | 29.6% | 80.7% | 9.04 | 1.5 | 6.60% | 2.2 | 31 | 60.4 | 9.93% | 72 | 25/31 |
| 11 | **MORPHOUSDT** | 291% | 13.3% | 82.9% | 6.90 | 1.5 | 3.40% | 1.4 | 41 | 21.9 | 3.38% | 40 | 22/31 |
| 12 | **JTOUSDT** | 433% | 18.1% | 75.6% | 3.97 | 2.5 | 6.00% | 1.3 | 41 | 24.0 | 4.17% | 74 | 28/31 |
| 13 | **ENAUSDT** | 122% | 9.0% | 63.6% | 6.24 | 1.0 | 0.95% | 3.6 | 44 | 13.6 | 1.83% | 47 | 28/31 |
| 14 | **JUPUSDT** | 163% | 11.7% | 83.7% | 3.13 | 0.75 | 5.90% | 0.6 | 49 | 14.0 | 1.99% | 72 | 20/31 |
| 15 | **INJUSDT** | 130% | 14.1% | 80.6% | 4.23 | 1.0 | 3.80% | 1.0 | 36 | 9.2 | 2.34% | 32 | 24/31 |
| 16 | **PUMPUSDT** | 243% | 16.1% | 71.4% | 3.13 | 2.5 | 6.25% | 1.3 | 35 | 15.1 | 3.59% | 66 | 17/31 |
| 17 | **EIGENUSDT** | 257% | 19.4% | 84.4% | 4.09 | 0.75 | 8.70% | 0.8 | 32 | 13.3 | 4.06% | 86 | 25/31 |

## 3. Conservative variant — lowest drawdown and lowest risk per trade

Drawn from a wider pool (top 2,000 by net/DD across the entire search space, then filtered to below-median drawdown and scored risk-first). Use these if capital preservation matters more than headline return.

| # | Coin | Net % | DD % | Win % | PF | RR | Risk/trade | Trades | MAR | vs balanced: DD | vs balanced: net |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | SYNUSDT | 1657% | **17.8%** | 55.8% | 19.91 | 2.5 | **0.85%** | 43 | 93.3 | -6.1 pts | -421 pts |
| 2 | NEARUSDT | 353% | **10.2%** | 90.0% | 12.08 | 2.5 | **4.71%** | 30 | 34.6 | -2.0 pts | -138 pts |
| 3 | DEXEUSDT | 1338% | **18.0%** | 78.0% | 12.25 | 2.0 | **1.89%** | 59 | 74.3 | -12.3 pts | -1694 pts |
| 4 | KAITOUSDT | 494% | **13.2%** | 87.1% | 18.26 | 1.5 | **2.68%** | 31 | 37.3 | +0.0 pts | +55 pts |
| 5 | JSTUSDT | 230% | **10.4%** | 91.3% | 14.47 | 1.0 | **2.26%** | 46 | 22.2 | +0.0 pts | -31 pts |
| 6 | RIFUSDT | 427% | **12.8%** | 65.7% | 13.34 | 2.5 | **1.17%** | 35 | 33.3 | -20.4 pts | -563 pts |
| 7 | ALLOUSDT | 921% | **25.3%** | 79.4% | 10.36 | 2.0 | **3.75%** | 34 | 36.4 | +0.0 pts | +0 pts |
| 8 | ZECUSDT | 1092% | **18.4%** | 84.1% | 8.19 | 2.0 | **5.17%** | 44 | 59.2 | -1.5 pts | -338 pts |
| 9 | TAOUSDT | 377% | **15.1%** | 86.1% | 7.16 | 2.5 | **5.28%** | 36 | 25.1 | +0.0 pts | +0 pts |
| 10 | 币安人生USDT | 1785% | **29.6%** | 80.7% | 9.04 | 1.5 | **6.60%** | 31 | 60.4 | +0.0 pts | +0 pts |
| 11 | MORPHOUSDT | 291% | **13.3%** | 82.9% | 6.90 | 1.5 | **3.40%** | 41 | 21.9 | +0.0 pts | +0 pts |
| 12 | JTOUSDT | 335% | **13.5%** | 82.5% | 4.92 | 2.5 | **5.60%** | 40 | 24.9 | -4.6 pts | -98 pts |
| 13 | ENAUSDT | 110% | **9.0%** | 65.0% | 6.74 | 2.5 | **0.95%** | 40 | 12.3 | +0.0 pts | -12 pts |
| 14 | JUPUSDT | 144% | **8.8%** | 87.5% | 4.87 | 0.75 | **4.74%** | 40 | 16.4 | -2.9 pts | -19 pts |
| 15 | INJUSDT | 42% | **6.4%** | 52.6% | 3.07 | 0.75 | **0.95%** | 38 | 6.5 | -7.7 pts | -88 pts |
| 16 | PUMPUSDT | 205% | **14.6%** | 80.6% | 3.79 | 0.75 | **6.00%** | 36 | 14.0 | -1.4 pts | -38 pts |
| 17 | EIGENUSDT | 42% | **8.5%** | 60.0% | 2.55 | 0.75 | **1.95%** | 30 | 5.0 | -10.9 pts | -215 pts |

## 4. Balanced configs — full parameters

| # | Coin | ma1_len | ma1_slopeLb | ma2_len | ma2_slopeLb | ma3_len | ma3_slopeLb | ma4_len | ma4_slopeLb | volMaLen | volMultMin | hhPivotLen | entryBodyAtrMult | atrLenExit | rrSwingLb | rrBufAtr | rrRatio | minSlDistAtr | extMaxPct | runLb | runMaxPct | wickMaxAtr | hlBreakPivLen | hlBreakMinR | useRunLimit | useSuperTrend | useLocalTrend | at_coeff | at_ap | hac_length | hac_emaLen | hac_csf |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | SYNUSDT | 150 | 10 | 50 | 20 | 34 | 13 | 100 | 10 | 100 | 1 | 14 | 0.8 | 7 | 20 | 0.3 | 2.5 | 0.5 | 5 | 12 | 19 | 1.2 | 12 | 0 | False | True | False | 2 | 50 | 89 | 100 | 1.1 |
| 2 | NEARUSDT | 150 | 50 | 300 | 30 | 200 | 13 | 100 | 10 | 100 | 1.5 | 10 | 0.4 | 7 | 6 | 0.5 | 2.5 | 0.05 | 5 | 30 | 25 | 1.2 | 30 | 0.25 | False | True | False | 1.5 | 50 | 89 | 60 | 1.1 |
| 3 | DEXEUSDT | 300 | 30 | 50 | 10 | 14 | 15 | 21 | 11 | 100 | 0.2 | 6 | 0.4 | 7 | 14 | 0.3 | 0.75 | 0.25 | 2 | 30 | 25 | 1.2 | 21 | 0.25 | False | True | False | 1.5 | 50 | 89 | 60 | 1.1 |
| 4 | KAITOUSDT | 200 | 15 | 100 | 25 | 200 | 30 | 200 | 10 | 50 | 0.4 | 16 | 0.6 | 14 | 10 | 1 | 2.5 | 0.05 | 3 | 30 | 19 | 0.8 | 22 | 0.5 | False | False | True | 1.5 | 100 | 89 | 40 | 1.1 |
| 5 | JSTUSDT | 150 | 50 | 200 | 25 | 14 | 13 | 100 | 13 | 100 | 1.5 | 14 | 0.4 | 1 | 20 | 0.7 | 1 | 0.05 | 2 | 30 | 13 | 1.2 | 21 | 0.5 | True | False | False | 2 | 50 | 89 | 100 | 1.1 |
| 6 | RIFUSDT | 300 | 20 | 300 | 5 | 21 | 21 | 50 | 15 | 100 | 0.4 | 25 | 0.2 | 1 | 10 | 0.3 | 1.5 | 0.5 | 2 | 12 | 25 | 1.2 | 9 | 0.25 | False | True | False | 1 | 50 | 55 | 60 | 0.8 |
| 7 | ALLOUSDT | 100 | 30 | 200 | 5 | 21 | 9 | 50 | 11 | 100 | 0.4 | 10 | 0.4 | 2 | 20 | 0.4 | 2 | 0.5 | 2 | 12 | 25 | 0.6 | 9 | 0.25 | False | False | False | 1.5 | 50 | 34 | 40 | 1.4 |
| 8 | ZECUSDT | 400 | 30 | 50 | 20 | 14 | 9 | 200 | 6 | 50 | 1.5 | 10 | 0.2 | 5 | 20 | 0.7 | 2 | 0.5 | 2 | 12 | 19 | 2 | 12 | 0.25 | True | False | False | 1 | 50 | 55 | 60 | 0.8 |
| 9 | TAOUSDT | 100 | 50 | 300 | 5 | 14 | 15 | 34 | 13 | 100 | 1 | 14 | 0.4 | 5 | 20 | 0.3 | 2.5 | 0.05 | 5 | 12 | 18 | 2 | 9 | 0.25 | False | True | False | 1.5 | 50 | 55 | 100 | 0.8 |
| 10 | 币安人生USDT | 150 | 20 | 100 | 20 | 14 | 13 | 21 | 6 | 20 | 0.2 | 6 | 0.2 | 1 | 20 | 0.5 | 1.5 | 0.5 | 5 | 12 | 18 | 1.2 | 9 | 0.25 | False | True | False | 1.5 | 50 | 34 | 60 | 1.1 |
| 11 | MORPHOUSDT | 100 | 50 | 50 | 30 | 21 | 15 | 34 | 11 | 20 | 0.2 | 14 | 0.5 | 4 | 6 | 0.4 | 1.5 | 0.05 | 5 | 12 | 19 | 0.6 | 15 | 0.25 | True | True | False | 2 | 100 | 34 | 60 | 0.8 |
| 12 | JTOUSDT | 300 | 5 | 150 | 20 | 50 | 13 | 34 | 11 | 50 | 1 | 15 | 0.6 | 4 | 6 | 0.5 | 2.5 | 0.5 | 2 | 30 | 25 | 0.6 | 15 | 0.5 | False | True | True | 2 | 100 | 89 | 60 | 0.8 |
| 13 | ENAUSDT | 300 | 30 | 150 | 5 | 200 | 21 | 200 | 11 | 50 | 1 | 8 | 0.2 | 2 | 14 | 0.7 | 1 | 0.25 | 2 | 12 | 17 | 0.6 | 12 | 0 | False | False | True | 2 | 150 | 89 | 60 | 0.8 |
| 14 | JUPUSDT | 300 | 15 | 50 | 10 | 50 | 13 | 100 | 15 | 50 | 0.4 | 15 | 0.5 | 14 | 9 | 0.3 | 0.75 | 0.25 | 3 | 30 | 13 | 2 | 15 | 0.25 | True | True | True | 1.5 | 150 | 89 | 40 | 1.1 |
| 15 | INJUSDT | 300 | 15 | 100 | 20 | 14 | 8 | 21 | 11 | 100 | 2 | 8 | 0.8 | 14 | 10 | 0.5 | 1 | 0.25 | 5 | 30 | 13 | 0.6 | 30 | 0.25 | False | False | False | 1.5 | 50 | 34 | 100 | 1.4 |
| 16 | PUMPUSDT | 400 | 15 | 100 | 20 | 34 | 9 | 200 | 13 | 50 | 1 | 14 | 0.8 | 4 | 9 | 0.3 | 2.5 | 0.5 | 3 | 12 | 19 | 2 | 12 | 0.5 | True | True | True | 1 | 50 | 89 | 100 | 1.1 |
| 17 | EIGENUSDT | 150 | 20 | 200 | 5 | 14 | 13 | 50 | 10 | 20 | 1 | 10 | 0.4 | 7 | 20 | 0.7 | 0.75 | 0.25 | 5 | 20 | 17 | 2 | 15 | 0.25 | False | True | False | 1.5 | 150 | 55 | 60 | 1.4 |

## 5. Conservative configs — full parameters

| # | Coin | ma1_len | ma1_slopeLb | ma2_len | ma2_slopeLb | ma3_len | ma3_slopeLb | ma4_len | ma4_slopeLb | volMaLen | volMultMin | hhPivotLen | entryBodyAtrMult | atrLenExit | rrSwingLb | rrBufAtr | rrRatio | minSlDistAtr | extMaxPct | runLb | runMaxPct | wickMaxAtr | hlBreakPivLen | hlBreakMinR | useRunLimit | useSuperTrend | useLocalTrend | at_coeff | at_ap | hac_length | hac_emaLen | hac_csf |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | SYNUSDT | 150 | 5 | 50 | 20 | 21 | 9 | 100 | 10 | 100 | 1 | 14 | 0.4 | 7 | 20 | 0.3 | 2.5 | 0.05 | 5 | 12 | 17 | 1.2 | 30 | 0 | True | True | False | 2 | 50 | 89 | 40 | 1.1 |
| 2 | NEARUSDT | 150 | 10 | 300 | 30 | 50 | 9 | 100 | 10 | 100 | 1.5 | 10 | 0.4 | 7 | 6 | 0.5 | 2.5 | 0.25 | 5 | 12 | 25 | 1.2 | 30 | 0.25 | False | True | False | 2 | 100 | 34 | 100 | 1.4 |
| 3 | DEXEUSDT | 300 | 10 | 50 | 5 | 200 | 8 | 21 | 6 | 100 | 0.4 | 6 | 0.2 | 7 | 9 | 0.3 | 2 | 0.5 | 5 | 30 | 25 | 1.2 | 30 | 0.25 | True | True | True | 1.5 | 50 | 89 | 100 | 1.1 |
| 4 | KAITOUSDT | 300 | 10 | 200 | 25 | 200 | 30 | 50 | 10 | 50 | 0.4 | 16 | 0.4 | 14 | 10 | 1 | 1.5 | 0.05 | 5 | 30 | 13 | 0.6 | 22 | 0.5 | False | False | True | 1.5 | 100 | 34 | 60 | 0.8 |
| 5 | JSTUSDT | 150 | 50 | 200 | 25 | 50 | 15 | 100 | 13 | 100 | 1.5 | 16 | 0.4 | 1 | 20 | 0.7 | 1 | 0.5 | 2 | 30 | 17 | 0.6 | 21 | 0.5 | True | False | False | 2 | 50 | 55 | 100 | 1.1 |
| 6 | RIFUSDT | 150 | 50 | 100 | 10 | 34 | 8 | 50 | 15 | 20 | 1 | 25 | 0.2 | 7 | 6 | 0.3 | 2.5 | 0.5 | 2 | 12 | 25 | 1.2 | 10 | 0.25 | True | False | False | 1 | 150 | 34 | 60 | 0.8 |
| 7 | ALLOUSDT | 100 | 30 | 200 | 5 | 21 | 9 | 50 | 11 | 100 | 0.4 | 10 | 0.4 | 2 | 20 | 0.4 | 2 | 0.5 | 2 | 12 | 25 | 0.6 | 9 | 0.25 | False | False | False | 1.5 | 50 | 34 | 40 | 1.4 |
| 8 | ZECUSDT | 200 | 50 | 200 | 20 | 14 | 9 | 50 | 6 | 50 | 1.5 | 10 | 0.2 | 1 | 6 | 1 | 2 | 0.05 | 2 | 12 | 17 | 2 | 12 | 0.25 | True | False | True | 1 | 50 | 55 | 60 | 1.1 |
| 9 | TAOUSDT | 100 | 50 | 300 | 5 | 14 | 15 | 34 | 13 | 100 | 1 | 14 | 0.4 | 5 | 20 | 0.3 | 2.5 | 0.05 | 5 | 12 | 18 | 2 | 9 | 0.25 | False | True | False | 1.5 | 50 | 55 | 100 | 0.8 |
| 10 | 币安人生USDT | 150 | 20 | 100 | 20 | 14 | 13 | 21 | 6 | 20 | 0.2 | 6 | 0.2 | 1 | 20 | 0.5 | 1.5 | 0.5 | 5 | 12 | 18 | 1.2 | 9 | 0.25 | False | True | False | 1.5 | 50 | 34 | 60 | 1.1 |
| 11 | MORPHOUSDT | 100 | 50 | 50 | 30 | 21 | 15 | 34 | 11 | 20 | 0.2 | 14 | 0.5 | 4 | 6 | 0.4 | 1.5 | 0.05 | 5 | 12 | 19 | 0.6 | 15 | 0.25 | True | True | False | 2 | 100 | 34 | 60 | 0.8 |
| 12 | JTOUSDT | 150 | 5 | 100 | 20 | 50 | 13 | 21 | 11 | 50 | 1 | 6 | 0.8 | 14 | 6 | 1 | 2.5 | 0.5 | 5 | 30 | 19 | 0.6 | 15 | 0.25 | True | False | True | 2 | 50 | 89 | 100 | 0.8 |
| 13 | ENAUSDT | 300 | 30 | 150 | 5 | 200 | 21 | 50 | 6 | 50 | 1 | 8 | 0.2 | 2 | 14 | 0.7 | 2.5 | 0.25 | 2 | 12 | 17 | 0.6 | 12 | 0 | False | False | True | 2 | 150 | 89 | 60 | 0.8 |
| 14 | JUPUSDT | 100 | 15 | 100 | 10 | 34 | 9 | 100 | 25 | 50 | 0.4 | 15 | 0.8 | 14 | 9 | 0.4 | 0.75 | 0.25 | 3 | 30 | 10 | 1.2 | 22 | 0.25 | True | False | True | 1.5 | 150 | 89 | 60 | 1.4 |
| 15 | INJUSDT | 100 | 30 | 100 | 25 | 50 | 8 | 21 | 11 | 100 | 2 | 8 | 0.8 | 7 | 6 | 1 | 0.75 | 0.05 | 5 | 30 | 13 | 0.6 | 9 | 0 | False | False | False | 1.5 | 50 | 34 | 60 | 1.4 |
| 16 | PUMPUSDT | 100 | 30 | 100 | 30 | 14 | 8 | 200 | 13 | 50 | 1.5 | 14 | 0.6 | 4 | 9 | 0.3 | 0.75 | 0.05 | 2 | 20 | 19 | 0.9 | 9 | 0.5 | True | True | True | 1 | 50 | 89 | 100 | 1.1 |
| 17 | EIGENUSDT | 400 | 20 | 200 | 5 | 14 | 13 | 50 | 10 | 20 | 1 | 10 | 0.8 | 7 | 6 | 0.3 | 0.75 | 0.25 | 2 | 20 | 10 | 2 | 21 | 0 | True | True | False | 1.5 | 150 | 55 | 100 | 1.1 |

## 6. What changed vs the optimizer's own pick

| Coin | Optimizer peak (net/DD/PF/tr) | Balanced multi-factor | Net given up | DD saved | Risk/trade |
|---|---|---|---|---|---|
| SYNUSDT | 2799% / 24.9% / 26.92 / 31 | 2078% / 23.9% / 25.89 / 46 | -722 pts | +1.1 pts | 2.00% → 0.58% |
| NEARUSDT | 522% / 12.8% / 10.04 / 36 | 491% / 12.2% / 10.35 / 36 | -31 pts | +0.6 pts | 5.25% → 3.95% |
| DEXEUSDT | 3114% / 25.1% / 4.97 / 71 | 3032% / 30.3% / 7.99 / 108 | -82 pts | -5.2 pts | 3.90% → 2.30% |
| KAITOUSDT | 494% / 13.2% / 18.26 / 31 | 439% / 13.2% / 11.61 / 32 | -55 pts | +0.0 pts | 2.68% → 2.76% |
| JSTUSDT | 288% / 15.7% / 4.90 / 73 | 261% / 10.4% / 8.72 / 48 | -27 pts | +5.4 pts | 2.54% → 3.40% |
| RIFUSDT | 1013% / 33.3% / 6.02 / 64 | 990% / 33.3% / 9.99 / 65 | -23 pts | +0.0 pts | 2.80% → 1.61% |
| ALLOUSDT | 1010% / 35.2% / 3.42 / 42 | 921% / 25.3% / 10.36 / 34 | -89 pts | +9.8 pts | 83.50% → 3.75% |
| ZECUSDT | 1899% / 36.4% / 5.87 / 46 | 1430% / 19.9% / 6.49 / 48 | -468 pts | +16.4 pts | 8.24% → 7.50% |
| TAOUSDT | 395% / 15.8% / 6.76 / 38 | 377% / 15.1% / 7.16 / 36 | -18 pts | +0.8 pts | 5.78% → 5.28% |
| 币安人生USDT | 2052% / 33.5% / 3.51 / 32 | 1785% / 29.6% / 9.04 / 31 | -267 pts | +3.9 pts | 14.85% → 6.60% |
| MORPHOUSDT | 300% / 13.1% / 4.10 / 49 | 291% / 13.3% / 6.90 / 41 | -9 pts | -0.2 pts | 3.90% → 3.40% |
| JTOUSDT | 485% / 26.1% / 3.45 / 40 | 433% / 18.1% / 3.97 / 41 | -52 pts | +8.1 pts | 6.50% → 6.00% |
| ENAUSDT | 284% / 29.0% / 2.42 / 47 | 122% / 9.0% / 6.24 / 44 | -162 pts | +20.1 pts | 8.00% → 0.95% |
| JUPUSDT | 209% / 18.6% / 2.70 / 64 | 163% / 11.7% / 3.13 / 49 | -46 pts | +7.0 pts | 4.95% → 5.90% |
| INJUSDT | 158% / 19.9% / 3.16 / 35 | 130% / 14.1% / 4.23 / 36 | -29 pts | +5.8 pts | 5.80% → 3.80% |
| PUMPUSDT | 373% / 22.3% / 3.15 / 39 | 243% / 16.1% / 3.13 / 35 | -129 pts | +6.2 pts | 8.70% → 6.25% |
| EIGENUSDT | 342% / 25.8% / 5.53 / 31 | 257% / 19.4% / 4.09 / 32 | -85 pts | +6.4 pts | 6.92% → 8.70% |
## 7. Fragility test — how much can degrade before you lose money

With an average win/loss ratio of W/L, a system breaks even at a win rate of `1 ÷ (1 + W/L)`. The gap between the backtested win rate and that breakeven point is your margin of safety. It matters because **win rate is the least stable statistic out-of-sample** — a config that needs 62% to break even and backtested at 84% has far less room than one that needs 22%.

| Coin | Backtest win % | W/L | Breakeven win % | Margin | Risk/trade | Reading |
|---|---|---|---|---|---|---|
| SYNUSDT | 50.0% | 25.9 | 3.7% | 46.3 pts | 0.58% | Widest margin, lowest risk/trade — but see §8 |
| NEARUSDT | 86.1% | 1.7 | 37.5% | 48.6 pts | 3.95% | Excellent all-round |
| DEXEUSDT | 79.6% | 2.0 | 32.8% | 46.8 pts | 2.30% | Solid, best sample size (108 trades) |
| KAITOUSDT | 81.2% | 2.7 | 27.2% | 54.1 pts | 2.76% | Best margin of the realistic set |
| JSTUSDT | 89.6% | 1.0 | 49.6% | 39.9 pts | 3.40% | Needs ~50% win rate to survive |
| RIFUSDT | 73.8% | 3.5 | 22.0% | 51.8 pts | 1.61% | Strong: low risk, good W/L |
| ALLOUSDT | 79.4% | 2.7 | 27.1% | 52.3 pts | 3.75% | Good margin, short history |
| ZECUSDT | 85.4% | 1.1 | 47.4% | 38.0 pts | 7.50% | Needs ~47% and risks 7.5%/trade |
| TAOUSDT | 86.1% | 1.2 | 46.4% | 39.7 pts | 5.28% | Needs ~46% — carried by win rate |
| 币安人生USDT | 80.7% | 2.2 | 31.6% | 49.1 pts | 6.60% | OK margin but 6.6% risk/trade |
| MORPHOUSDT | 82.9% | 1.4 | 41.3% | 41.6 pts | 3.40% | Comfortable |
| JTOUSDT | 75.6% | 1.3 | 43.8% | 31.8 pts | 6.00% | Needs ~44%, 6.0% risk/trade |
| ENAUSDT | 63.6% | 3.6 | 21.9% | 41.7 pts | 0.95% | Good structure, tiny returns |
| JUPUSDT | 83.7% | 0.6 | 62.1% | 21.6 pts | 5.90% | Needs 62% to break even — most fragile |
| INJUSDT | 80.6% | 1.0 | 49.5% | 31.1 pts | 3.80% | Needs ~50%, thin returns |
| PUMPUSDT | 71.4% | 1.3 | 44.4% | 27.0 pts | 6.25% | Needs ~44%, 6.25% risk/trade |
| EIGENUSDT | 84.4% | 0.8 | 56.9% | 27.5 pts | 8.70% | Needs ~57% — highest risk/trade at 8.7% |

## 8. Reading the results — what the six factors reveal that net% alone hid

**a) SYNUSDT ranks #1 but is not what it looks like.** Its balanced config wins only **50% of trades** yet returns 2078% with PF 25.9. That means the average win is **25.9× the average loss** — the entire return sits in a handful of enormous trades. The `rrRatio` setting is 2.5, so the strategy targets 2.5R; delivering 25.9R means the profit came from trades that ran far past target. Risk per trade is genuinely tiny (0.58%) and the margin of safety is huge, so this is not fragile in the usual sense — but it is **concentrated**. Remove the three best trades and it is probably an ordinary result. Treat SYN as a lottery-ticket allocation, not a core holding.

**b) DEXEUSDT improved materially under multi-factor selection.** The optimizer's peak was 3114% / 25.1% DD / 71 trades. The balanced pick is 3032% / 30.3% DD / **108 trades**, win rate 79.6% (up from 66.2%), PF 7.99 (up from 4.97), risk/trade 2.30%. You give up 82 points of net and 5 points of DD to get **50% more trades and a much healthier trade profile**. More trades is worth more than 82 points of in-sample net — it is the difference between a 71-sample and a 108-sample estimate. Note the RR setting is 0.75 here: a low target hit often, rather than a high target hit rarely.

**c) High win rate is often a warning, not a feature.** ZEC (85.4% win, W/L 1.1, risk 7.5%), TAO (86.1%, W/L 1.2, risk 5.28%), EIGEN (84.4%, W/L 0.8, risk 8.7%) and JUP (83.7%, W/L 0.6, risk 5.9%) all make money by winning often on trades barely larger than their losses. JUP is the clearest case: **its average win is smaller than its average loss**, so it needs a 62% win rate simply to break even. A modest win-rate decay out-of-sample flips these to losers. Contrast RIF: 73.8% win rate but W/L 3.5 and risk 1.61% — a lower win rate that is far more durable.

**d) Risk per trade varies 15× across the set** — 0.58% (SYN) to 8.70% (EIGEN). This is the factor that was completely invisible in the previous analysis. At 100%-of-equity sizing, EIGEN's config loses 8.7% of the account on a typical losing trade; four in a row takes you down 30%. SYN's loses 0.58%. These are not comparable instruments even though both appeared on the same leaderboard.

**e) The conservative variant is a genuinely good trade-off on several coins.** DEXE: 30.3% → **18.0% DD** while keeping 1338% net and cutting risk/trade to 1.89% (MAR 74.3). RIF: 33.3% → **12.8% DD**, risk/trade 1.17%. SYN: 23.9% → **17.8% DD** at 1657% net. If you are running several of these together, the conservative column is probably the right choice — correlated alt drawdowns stack, and the balanced column's 25–33% DDs will compound into a portfolio drawdown you will not enjoy.

**f) Agreement scores fell.** Optimising six factors instead of two pushes the pick off the plateau centre: DEXE 16/31 and ZEC 16/31 agree with the modal parameter values, versus 29/31 and 26/31 for the top-200 plateau picks in the previous report. This is a real cost — **these configs are more finely selected and therefore more exposed to overfitting than the plateau-centre picks were.** TAO (29/31), JTO (28/31), NEAR (28/31), RIF (27/31), SYN (26/31) and JST (26/31) kept high agreement and are the safest of the new set.

## 9. Recommendation

| Tier | Coins | Config to use |
|---|---|---|
| **Core** | NEARUSDT, KAITOUSDT, RIFUSDT, DEXEUSDT | Best combination of margin of safety, low risk/trade and sample size. Use the **conservative** column for DEXE and RIF (their balanced DDs of 30% and 33% are the two worst in the core group). |
| **Satellite** | SYNUSDT, JSTUSDT, ALLOUSDT, MORPHOUSDT | Real edges with a specific caveat each — SYN concentration, ALLO short history, JST/MORPHO modest returns. Half size. |
| **Avoid** | JUPUSDT, EIGENUSDT, PUMPUSDT, INJUSDT, ENAUSDT, JTOUSDT, ZECUSDT, TAOUSDT, 币安人生USDT | JUP/EIGEN: negative-to-flat W/L needing very high win rates. ZEC/TAO/JTO/币安人生: 5–7.5% risk per trade with W/L near 1. PUMP/INJ/ENA: thin edges. 币安人生 also has only 6.7 months of data. |

Everything here remains **in-sample**. Six factors instead of two makes the *selection* better, not the *evidence* stronger — the walk-forward is still the test that would tell you how much of this survives.