# 1h One-Year Optimizer — Deep Analysis & Ranked Configs

Source: `platform/backend/optimizer1y1h` (the "opt1hyear-results" tree). Strategy: **MA + R:R v9, long-only spot**.
Window: **2025-07-20 → now (~12.7 months)**, 1h chart, initial capital $1,000, commission 0.1%/side, slippage 0 ticks, **position size = 100% of equity (fully compounding)**.
Search: genetic algorithm, 31 parameters, ~4.9M evaluated configs total across 17 coins (225k–448k per coin). Optimizer is still running (round 727).
Objective used by the optimizer: `score = net% − 1.0 × maxDD% − 0.05 × max(0, trades−600)`, configs with **<30 trades rejected**.

## 1. Active coins (17)

`SYNUSDT, 币安人生USDT, ALLOUSDT, DEXEUSDT, RIFUSDT, ZECUSDT, JTOUSDT, NEARUSDT, INJUSDT, MORPHOUSDT, KAITOUSDT, EIGENUSDT, TAOUSDT, JUPUSDT, JSTUSDT, ENAUSDT, PUMPUSDT`

Stopped 2026-07-30 and excluded here: TIAUSDT, ALGOUSDT, APEUSDT, PYTHUSDT, ARBUSDT, APTUSDT.

## 2. Master ranking

Composite weights: risk-adjusted return (MAR) 30%, robustness/spike 15%, net% 15%, profit factor 15%, sample size 10%, parameter stability 7.5%, % of search space profitable 7.5%. Lower composite = better.

| Rank | Coin | Net % | MaxDD % | MAR (net/DD) | PF | Trades | Win % | Spike ratio | Param stability | % of all configs profitable | Median net% of top-200 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **DEXEUSDT** | 3114% | 25.1% | 123.9 | 4.97 | 71 | 66.2% | 1.33 | 69% | 99.3% | 2335% |
| 2 | **SYNUSDT** | 2799% | 24.9% | 112.2 | 26.92 | 31 | 77.4% | 1.43 | 77% | 97.5% | 1952% |
| 3 | **NEARUSDT** | 522% | 12.8% | 40.8 | 10.04 | 36 | 88.9% | 1.29 | 73% | 99.0% | 403% |
| 4 | **KAITOUSDT** | 494% | 13.2% | 37.3 | 18.26 | 31 | 87.1% | 1.24 | 75% | 90.4% | 399% |
| 5 | **RIFUSDT** | 1013% | 33.3% | 30.5 | 6.02 | 64 | 71.9% | 1.41 | 73% | 96.7% | 720% |
| 6 | **币安人生USDT** | 2052% | 33.5% | 61.3 | 3.51 | 32 | 68.8% | 1.38 | 73% | 98.8% | 1491% |
| 7 | **ZECUSDT** | 1899% | 36.4% | 52.2 | 5.87 | 46 | 82.6% | 1.41 | 66% | 96.7% | 1342% |
| 8 | **TAOUSDT** | 395% | 15.8% | 24.9 | 6.76 | 38 | 86.8% | 1.13 | 71% | 95.0% | 350% |
| 9 | **JTOUSDT** | 485% | 26.1% | 18.5 | 3.45 | 40 | 70.0% | 1.26 | 74% | 91.4% | 385% |
| 10 | **JSTUSDT** | 288% | 15.7% | 18.3 | 4.90 | 73 | 80.8% | 1.15 | 71% | 88.3% | 250% |
| 11 | **ALLOUSDT** | 1010% | 35.2% | 28.7 | 3.42 | 42 | 76.2% | 1.34 | 64% | 95.7% | 753% |
| 12 | **MORPHOUSDT** | 300% | 13.1% | 23.0 | 4.10 | 49 | 75.5% | 1.28 | 67% | 94.3% | 234% |
| 13 | **JUPUSDT** | 209% | 18.6% | 11.2 | 2.70 | 64 | 78.1% | 1.30 | 69% | 78.6% | 161% |
| 14 | **EIGENUSDT** | 342% | 25.8% | 13.2 | 5.53 | 31 | 83.9% | 1.59 | 73% | 44.4% | 215% |
| 15 | **PUMPUSDT** | 373% | 22.3% | 16.7 | 3.15 | 39 | 76.9% | 1.50 | 66% | 64.6% | 249% |
| 16 | **INJUSDT** | 158% | 19.9% | 7.9 | 3.16 | 35 | 77.1% | 1.27 | 68% | 70.3% | 125% |
| 17 | **ENAUSDT** | 284% | 29.0% | 9.8 | 2.42 | 47 | 72.3% | 2.48 | 74% | 89.0% | 114% |

**Spike ratio** = best net% ÷ median net% of the top-200 configs. Near 1.0 = broad plateau (the result is not a lucky single point). Above ~1.5 = sharp peak, likely curve-fit.
**Param stability** = average share of the top-200 configs that agree on each parameter's most common value. Higher = the optimizer keeps rediscovering the same settings.

### Per-metric winners

| Metric | 1st | 2nd | 3rd |
|---|---|---|---|
| Highest net profit | DEXEUSDT (3113.74) | SYNUSDT (2799.38) | 币安人生USDT (2051.98) |
| Lowest drawdown | NEARUSDT (12.80) | MORPHOUSDT (13.05) | KAITOUSDT (13.25) |
| Best risk-adjusted (MAR) | DEXEUSDT (123.86) | SYNUSDT (112.24) | 币安人生USDT (61.27) |
| Best profit factor | SYNUSDT (26.92) | KAITOUSDT (18.26) | NEARUSDT (10.04) |
| Most trades (best sample) | JSTUSDT (73) | DEXEUSDT (71) | RIFUSDT (64) |
| Most robust (lowest spike) | TAOUSDT (1.13) | JSTUSDT (1.15) | KAITOUSDT (1.24) |
| Most stable parameters | SYNUSDT (0.77) | KAITOUSDT (0.75) | JTOUSDT (0.74) |

## 3. Recommended configs — plateau-centre ("robust") vs optimizer peak

For every coin I took the top-200 configs by score, found the most common value of each of the 31 parameters, then picked the **actually-backtested config that agrees with the most modal values**. That config sits in the middle of the plateau instead of on the peak, so it is far less curve-fit. Both sets are shown; **use the robust column for live trading.**

| Rank | Coin | Peak net% / DD% / PF / trades | Robust net% / DD% / PF / trades | Robust agreement |
|---|---|---|---|---|
| 1 | DEXEUSDT | 3114% / 25.1% / 4.97 / 71 | **2767% / 32.4% / 5.55 / 66** | 29/31 |
| 2 | SYNUSDT | 2799% / 24.9% / 26.92 / 31 | **2008% / 23.9% / 23.59 / 45** | 29/31 |
| 3 | NEARUSDT | 522% / 12.8% / 10.04 / 36 | **387% / 12.2% / 4.94 / 38** | 30/31 |
| 4 | KAITOUSDT | 494% / 13.2% / 18.26 / 31 | **436% / 14.8% / 13.20 / 30** | 30/31 |
| 5 | RIFUSDT | 1013% / 33.3% / 6.02 / 64 | **862% / 33.3% / 8.86 / 62** | 30/31 |
| 6 | 币安人生USDT | 2052% / 33.5% / 3.51 / 32 | **1556% / 31.6% / 8.48 / 31** | 29/31 |
| 7 | ZECUSDT | 1899% / 36.4% / 5.87 / 46 | **1343% / 33.4% / 2.35 / 49** | 26/31 |
| 8 | TAOUSDT | 395% / 15.8% / 6.76 / 38 | **377% / 15.1% / 7.16 / 36** | 28/31 |
| 9 | JTOUSDT | 485% / 26.1% / 3.45 / 40 | **437% / 18.1% / 4.06 / 39** | 29/31 |
| 10 | JSTUSDT | 288% / 15.7% / 4.90 / 73 | **261% / 10.4% / 8.72 / 48** | 29/31 |
| 11 | ALLOUSDT | 1010% / 35.2% / 3.42 / 42 | **749% / 41.2% / 8.04 / 35** | 27/31 |
| 12 | MORPHOUSDT | 300% / 13.1% / 4.10 / 49 | **231% / 14.9% / 3.68 / 38** | 28/31 |
| 13 | JUPUSDT | 209% / 18.6% / 2.70 / 64 | **173% / 18.5% / 2.51 / 62** | 29/31 |
| 14 | EIGENUSDT | 342% / 25.8% / 5.53 / 31 | **237% / 28.1% / 3.43 / 33** | 28/31 |
| 15 | PUMPUSDT | 373% / 22.3% / 3.15 / 39 | **256% / 28.1% / 2.14 / 43** | 27/31 |
| 16 | INJUSDT | 158% / 19.9% / 3.16 / 35 | **128% / 22.2% / 2.84 / 32** | 27/31 |
| 17 | ENAUSDT | 284% / 29.0% / 2.42 / 47 | **121% / 9.0% / 5.60 / 43** | 29/31 |

### Full robust parameter table

| # | Coin | ma1_len | ma1_slopeLb | ma2_len | ma2_slopeLb | ma3_len | ma3_slopeLb | ma4_len | ma4_slopeLb | volMaLen | volMultMin | hhPivotLen | entryBodyAtrMult | atrLenExit | rrSwingLb | rrBufAtr | rrRatio | minSlDistAtr | extMaxPct | runLb | runMaxPct | wickMaxAtr | hlBreakPivLen | hlBreakMinR | useRunLimit | useSuperTrend | useLocalTrend | at_coeff | at_ap | hac_length | hac_emaLen | hac_csf |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | DEXEUSDT | 300 | 30 | 50 | 5 | 21 | 8 | 50 | 25 | 100 | 0.4 | 14 | 0.2 | 1 | 10 | 0.3 | 1.5 | 0.05 | 2 | 30 | 25 | 1.2 | 30 | 0.5 | False | True | False | 1.5 | 50 | 89 | 60 | 1.1 |
| 2 | SYNUSDT | 150 | 5 | 50 | 20 | 21 | 8 | 100 | 10 | 100 | 1 | 14 | 0.4 | 7 | 20 | 0.3 | 2.5 | 0.5 | 5 | 12 | 19 | 1.2 | 10 | 0 | True | True | False | 2 | 50 | 89 | 60 | 1.1 |
| 3 | NEARUSDT | 150 | 50 | 300 | 30 | 200 | 13 | 100 | 10 | 100 | 1.5 | 10 | 0.4 | 7 | 6 | 0.5 | 2.5 | 0.25 | 5 | 30 | 25 | 1.2 | 30 | 0.25 | False | True | False | 1 | 50 | 89 | 100 | 1.1 |
| 4 | KAITOUSDT | 200 | 15 | 100 | 10 | 200 | 30 | 50 | 15 | 50 | 0.4 | 16 | 0.6 | 14 | 10 | 1 | 2 | 0.05 | 5 | 12 | 19 | 0.6 | 22 | 0.5 | False | False | True | 1.5 | 100 | 89 | 40 | 1.1 |
| 5 | RIFUSDT | 150 | 20 | 100 | 5 | 21 | 21 | 50 | 15 | 100 | 0.4 | 25 | 0.2 | 1 | 10 | 0.5 | 1.5 | 0.5 | 2 | 12 | 25 | 1.2 | 9 | 0.25 | False | True | False | 1 | 50 | 55 | 60 | 0.8 |
| 6 | 币安人生USDT | 150 | 20 | 100 | 20 | 14 | 13 | 34 | 15 | 20 | 0.2 | 8 | 0.2 | 1 | 20 | 0.5 | 1.5 | 0.5 | 5 | 12 | 18 | 1.2 | 9 | 0.25 | False | True | False | 1.5 | 50 | 89 | 40 | 1.4 |
| 7 | ZECUSDT | 400 | 15 | 300 | 10 | 34 | 9 | 21 | 6 | 50 | 1.5 | 10 | 0.4 | 5 | 20 | 0.7 | 2 | 0.25 | 2 | 12 | 25 | 1.2 | 10 | 0.5 | True | False | False | 1 | 50 | 55 | 100 | 1.4 |
| 8 | TAOUSDT | 100 | 50 | 300 | 5 | 14 | 15 | 34 | 13 | 100 | 1 | 14 | 0.4 | 5 | 20 | 0.3 | 2.5 | 0.05 | 5 | 12 | 18 | 2 | 9 | 0.25 | False | True | False | 1.5 | 50 | 55 | 100 | 0.8 |
| 9 | JTOUSDT | 300 | 5 | 150 | 20 | 50 | 13 | 50 | 11 | 50 | 1 | 15 | 0.6 | 4 | 6 | 0.5 | 2.5 | 0.5 | 2 | 30 | 25 | 0.6 | 15 | 0.5 | True | True | True | 2 | 100 | 89 | 60 | 0.8 |
| 10 | JSTUSDT | 150 | 50 | 200 | 25 | 14 | 13 | 21 | 13 | 100 | 1.5 | 14 | 0.4 | 1 | 20 | 0.7 | 1 | 0.05 | 2 | 30 | 13 | 0.9 | 21 | 0.5 | True | False | False | 2 | 50 | 55 | 100 | 1.1 |
| 11 | ALLOUSDT | 150 | 15 | 200 | 5 | 21 | 9 | 34 | 11 | 100 | 0.4 | 10 | 0.6 | 2 | 20 | 0.3 | 2 | 0.25 | 2 | 12 | 19 | 0.6 | 9 | 0.25 | False | False | False | 1.5 | 50 | 55 | 40 | 1.4 |
| 12 | MORPHOUSDT | 100 | 20 | 50 | 30 | 50 | 9 | 200 | 11 | 20 | 0.2 | 16 | 0.4 | 4 | 6 | 0.4 | 1.5 | 0.05 | 5 | 12 | 19 | 0.6 | 21 | 0.25 | False | True | True | 2 | 100 | 89 | 60 | 1.4 |
| 13 | JUPUSDT | 300 | 5 | 100 | 10 | 50 | 13 | 100 | 15 | 100 | 0.4 | 16 | 0.8 | 14 | 9 | 0.3 | 0.75 | 0.25 | 3 | 12 | 10 | 2 | 22 | 0.25 | True | True | False | 1.5 | 150 | 89 | 40 | 1.1 |
| 14 | EIGENUSDT | 400 | 50 | 150 | 5 | 14 | 13 | 21 | 6 | 20 | 1 | 10 | 0.2 | 7 | 20 | 0.5 | 0.75 | 0.05 | 2 | 20 | 17 | 2 | 9 | 0.25 | False | False | False | 1.5 | 150 | 55 | 100 | 1.4 |
| 15 | PUMPUSDT | 100 | 30 | 100 | 30 | 14 | 21 | 200 | 13 | 50 | 1 | 14 | 0.3 | 4 | 9 | 0.4 | 1 | 0.05 | 2 | 20 | 19 | 0.9 | 9 | 0.5 | True | False | False | 1 | 50 | 34 | 40 | 1.1 |
| 16 | INJUSDT | 150 | 20 | 100 | 25 | 50 | 8 | 21 | 11 | 100 | 2 | 8 | 0.3 | 7 | 10 | 0.5 | 1 | 0.25 | 3 | 30 | 19 | 0.6 | 9 | 0.5 | False | False | False | 1.5 | 50 | 34 | 60 | 1.4 |
| 17 | ENAUSDT | 300 | 30 | 150 | 5 | 200 | 21 | 200 | 15 | 50 | 1 | 8 | 0.2 | 2 | 14 | 1 | 1 | 0.25 | 2 | 12 | 17 | 0.6 | 12 | 0 | False | False | True | 2 | 150 | 89 | 60 | 0.8 |

### Optimizer peak parameter table (reference only)

| # | Coin | ma1_len | ma1_slopeLb | ma2_len | ma2_slopeLb | ma3_len | ma3_slopeLb | ma4_len | ma4_slopeLb | volMaLen | volMultMin | hhPivotLen | entryBodyAtrMult | atrLenExit | rrSwingLb | rrBufAtr | rrRatio | minSlDistAtr | extMaxPct | runLb | runMaxPct | wickMaxAtr | hlBreakPivLen | hlBreakMinR | useRunLimit | useSuperTrend | useLocalTrend | at_coeff | at_ap | hac_length | hac_emaLen | hac_csf |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | DEXEUSDT | 300 | 5 | 200 | 5 | 14 | 15 | 100 | 25 | 100 | 0.2 | 14 | 0.5 | 1 | 10 | 0.3 | 1.5 | 0.25 | 3 | 30 | 25 | 2 | 30 | 0.5 | True | False | False | 1 | 50 | 89 | 60 | 1.1 |
| 2 | SYNUSDT | 150 | 50 | 100 | 20 | 50 | 8 | 100 | 10 | 100 | 1 | 14 | 0.4 | 7 | 20 | 0.7 | 2.5 | 0.5 | 5 | 12 | 19 | 1.2 | 9 | 0.25 | True | True | False | 2 | 50 | 89 | 40 | 1.1 |
| 3 | NEARUSDT | 150 | 10 | 300 | 30 | 200 | 13 | 100 | 10 | 100 | 1.5 | 10 | 0.4 | 7 | 6 | 0.7 | 2.5 | 0.25 | 3 | 30 | 25 | 2 | 30 | 0.25 | False | True | False | 1.5 | 50 | 89 | 60 | 1.1 |
| 4 | KAITOUSDT | 300 | 10 | 200 | 25 | 200 | 30 | 50 | 10 | 50 | 0.4 | 16 | 0.4 | 14 | 10 | 1 | 1.5 | 0.05 | 5 | 30 | 13 | 0.6 | 22 | 0.5 | False | False | True | 1.5 | 100 | 34 | 60 | 0.8 |
| 5 | RIFUSDT | 300 | 20 | 100 | 10 | 21 | 21 | 50 | 15 | 50 | 0.4 | 25 | 0.2 | 2 | 10 | 0.5 | 1.5 | 0.5 | 2 | 12 | 25 | 1.2 | 9 | 0.25 | False | True | False | 1 | 50 | 55 | 60 | 0.8 |
| 6 | 币安人生USDT | 150 | 15 | 300 | 25 | 50 | 9 | 34 | 25 | 20 | 0.2 | 8 | 0.6 | 4 | 20 | 0.3 | 1.5 | 0.25 | 3 | 12 | 18 | 2 | 9 | 0.5 | False | True | False | 1.5 | 50 | 89 | 100 | 1.4 |
| 7 | ZECUSDT | 300 | 15 | 300 | 20 | 14 | 13 | 21 | 6 | 50 | 1.5 | 10 | 0.4 | 14 | 20 | 1 | 2 | 0.25 | 5 | 12 | 25 | 2 | 10 | 0.25 | True | False | False | 1 | 50 | 55 | 100 | 1.1 |
| 8 | TAOUSDT | 100 | 30 | 300 | 5 | 14 | 8 | 21 | 25 | 100 | 1 | 14 | 0.4 | 5 | 20 | 0.7 | 1.5 | 0.05 | 5 | 12 | 25 | 2 | 9 | 0.25 | True | False | False | 1.5 | 50 | 55 | 100 | 1.1 |
| 9 | JTOUSDT | 300 | 5 | 50 | 20 | 14 | 13 | 50 | 6 | 50 | 1 | 6 | 0.6 | 4 | 6 | 1 | 2.5 | 0.25 | 2 | 30 | 19 | 0.6 | 15 | 0.5 | True | True | False | 2 | 100 | 34 | 60 | 0.8 |
| 10 | JSTUSDT | 300 | 10 | 200 | 25 | 14 | 9 | 50 | 13 | 100 | 0.2 | 14 | 0.3 | 1 | 20 | 0.7 | 1 | 0.5 | 3 | 30 | 17 | 1.2 | 12 | 0.5 | True | False | False | 2 | 50 | 55 | 100 | 0.8 |
| 11 | ALLOUSDT | 150 | 15 | 300 | 5 | 14 | 15 | 100 | 6 | 50 | 0.2 | 10 | 0.8 | 1 | 20 | 0.5 | 1.5 | 0.25 | 2 | 30 | 25 | 0.6 | 15 | 0.25 | False | True | False | 1 | 50 | 89 | 60 | 1.4 |
| 12 | MORPHOUSDT | 100 | 20 | 50 | 10 | 21 | 15 | 34 | 11 | 20 | 0.2 | 15 | 0.5 | 4 | 6 | 0.4 | 1.5 | 0.05 | 3 | 12 | 19 | 0.6 | 15 | 0.25 | True | True | True | 1 | 100 | 89 | 60 | 1.1 |
| 13 | JUPUSDT | 300 | 5 | 100 | 5 | 50 | 13 | 21 | 15 | 100 | 0.4 | 16 | 0.8 | 4 | 9 | 0.3 | 0.75 | 0.05 | 5 | 12 | 10 | 2 | 22 | 0.25 | True | True | False | 2 | 150 | 89 | 40 | 1.4 |
| 14 | EIGENUSDT | 400 | 10 | 200 | 5 | 21 | 13 | 21 | 10 | 20 | 1 | 10 | 0.2 | 1 | 20 | 0.5 | 0.75 | 0.05 | 2 | 12 | 17 | 0.8 | 21 | 0.5 | False | False | False | 2 | 150 | 55 | 60 | 1.4 |
| 15 | PUMPUSDT | 100 | 15 | 100 | 20 | 200 | 21 | 200 | 25 | 50 | 1 | 14 | 0.4 | 4 | 9 | 0.3 | 1 | 0.25 | 2 | 20 | 19 | 1.2 | 9 | 0.5 | True | False | False | 1 | 50 | 34 | 40 | 1.1 |
| 16 | INJUSDT | 150 | 20 | 100 | 20 | 14 | 30 | 21 | 25 | 100 | 2 | 8 | 0.8 | 7 | 10 | 0.5 | 0.75 | 0.5 | 3 | 30 | 19 | 0.6 | 9 | 0.5 | False | True | False | 1.5 | 50 | 34 | 40 | 1.4 |
| 17 | ENAUSDT | 150 | 20 | 150 | 5 | 34 | 21 | 200 | 15 | 20 | 0.2 | 8 | 0.3 | 5 | 6 | 1 | 2 | 0.25 | 5 | 20 | 25 | 0.9 | 10 | 0.5 | True | True | False | 2 | 50 | 89 | 60 | 0.8 |

## 4. Deep analysis — will you actually be profitable on these coins with these configs?

### 4.1 What genuinely supports the edge

**a) The plateau is broad, not a single lucky point.** This is the strongest evidence in the whole dataset. Across 4.9M evaluated configs:

- On 11 of 17 coins, **90%+ of every config ever tried was net profitable** (DEXE 99.3%, NEAR 99.0%, 币安人生 98.8%, SYN 97.5%, ZEC/RIF 96.7%, ALLO 95.7%, TAO 95.0%, MORPHO 94.3%, JTO 91.4%, KAITO 90.4%).
- The **spike ratio** (best net ÷ median net of the top 200) sits between **1.13 and 1.50** on 16 of 17 coins. A curve-fit result typically shows 3–10×. Here, if you pick a *random* good config instead of the optimizer's peak, you still capture ~70–80% of the return.
- **Parameter stability is 64–77%** — the top 200 configs independently converge on the same values for roughly 2 out of every 3 parameters. The optimizer is not wandering; it is repeatedly rediscovering the same structural setup.

Read together, these three say the same thing: **the returns come from the strategy's structure (trend filter + swing-low stop + fixed R:R target), not from a specific number tuned to noise.** That is the single most important reason to believe part of this survives live.

**b) The strategy logic matches the regime it made money in.** MA + R:R v9 is a long-only, multi-MA trend-alignment breakout with an ATR/swing-low stop and a fixed reward:risk take-profit. It only fires when several MAs are sloping up, volume confirms, and price is not over-extended. Combined with `useRunLimit` and `extMaxPct` it explicitly refuses to chase. Consequently:
- Win rates of 66–89% with PF 2.4–27 are **not implausible** for a 1.5–2.5 R:R trend-continuation system on assets that trended hard.
- The average per-trade geometric return is **1.6%–9.5%**, which is realistic — the eye-watering 3114% headline is purely **compounding at 100% of equity over 66 trades**, not an unrealistic per-trade edge.

**c) Costs are modelled, not ignored.** 0.1% commission per side is charged and included in net. That is Binance spot taker without any fee discount, so the fee assumption is conservative.

### 4.2 What will make live results worse than these numbers — every one of them

**1. There is no out-of-sample test. This is the biggest hole.** Every number above is in-sample: the optimizer saw the entire 2025-07-20 → 2026-08 window while choosing the parameters. There is no walk-forward, no holdout, no cross-validation. The plateau evidence mitigates this but does not remove it. **Expect a haircut of 40–60% on net return and expect drawdown to run 1.3–1.5× the backtested figure.**

**2. Sample sizes are small.** 30–73 trades per coin over 12.7 months (2.4–5.2 trades/month). The standard error on those win rates is **±4.4 to ±7.9 percentage points**. An 88% win rate on 38 trades is statistically compatible with a true 75% win rate. Coins that only just clear the 30-trade floor (SYNUSDT 31, KAITOUSDT 31, EIGENUSDT 31, 币安人生 32) are the least trustworthy numbers on the board, regardless of how good they look.

**3. Regime selection bias in the coin universe.** The window covers a period in which these specific alt-coins trended up. A long-only strategy on DEXE/SYN/ZEC in a market that went up is partly measuring beta, not alpha. **In a sustained downtrend this strategy makes roughly nothing** — the MA alignment filter simply stops firing, which is a safe failure mode (flat, not bleeding), but it means these returns are not repeatable on demand.

**4. Survivorship in the coin list.** Several of these are recent listings (PUMP, ALLO, KAITO, MORPHO, DEXE, SYN, 币安人生). Coins that listed and *died* are not in the universe. The list itself was chosen from a screenshot of coins that had already performed.

**5. Zero slippage is assumed.** `slippageTicks: 0`. On low-liquidity names — RIFUSDT, JSTUSDT, SYNUSDT, 币安人生USDT, DEXEUSDT — real fills on a stop-loss exit during a fast move will be materially worse. Budget 0.1–0.3% extra round-trip on those, which on a 1.5 R:R system is a meaningful bite.

**6. The 100%-of-equity sizing does not survive contact with a 17-coin portfolio.** Every backtest independently assumes the full $1,000 goes into that one coin. You cannot run 17 of these at 100% each. Whatever you allocate per coin, **divide the net% by that allocation fraction** — 6 coins at ~16% each turns a 2767% coin-level result into roughly a 1/6 contribution, and the portfolio drawdown depends on how correlated the coins' drawdowns are (alt-coins in a crash: highly correlated, so portfolio DD will be closer to the *average* coin DD than to a diversified ideal).

**7. Long-only spot has no hedge.** Max drawdown of 25–36% on the top names is real equity pain, and it is all directional.

### 4.3 Coin-by-coin verdict

| Tier | Coins | Why |
|---|---|---|
| **Trade these** | DEXEUSDT, SYNUSDT, NEARUSDT, KAITOUSDT, RIFUSDT | Best combination of risk-adjusted return, plateau breadth, and parameter stability. NEAR and KAITO are the standouts on *risk*: 12.8% and 13.2% DD with PF 10.0 and 18.3 — those are the two you want if capital preservation matters more than the headline. DEXE and SYN are the return engines but carry ~25% DD and, in SYN's case, only 31 trades. |
| **Trade smaller** | 币安人生USDT, ZECUSDT, TAOUSDT, JTOUSDT, JSTUSDT, ALLOUSDT, MORPHOUSDT | Real edge but with a caveat each: 币安人生 and ZEC and ALLO carry 33–36% drawdown; JST/MORPHO have modest returns; TAO and JST are actually the *most robust* of the whole set (spike 1.13 and 1.15) and deserve a place for that reason alone. |
| **Skip for now** | JUPUSDT, EIGENUSDT, PUMPUSDT, INJUSDT, ENAUSDT | JUP (PF 2.70) and INJ (PF 3.16, only 70.3% of configs profitable) have thin edges. EIGEN is the red flag of the set: **only 44.4% of all tested configs were profitable** and its spike ratio is 1.59 — the edge exists in a narrow corner of parameter space, which is the signature of curve-fitting. PUMP: 64.6% profitable, spike 1.50, and it is a very young asset. ENA is the worst — **spike ratio 2.48**, meaning the peak result is 2.5× the typical good config; its plateau-centre config drops from 284% to 121% net. |

### 4.4 What "profitable" realistically looks like

Take the five Tier-1 coins on their **robust** configs, equal-weight at 20% of capital each, apply a 50% haircut for the in-sample bias and slippage:

| Coin | Robust net% (in-sample) | After 50% haircut | × 20% allocation |
|---|---|---|---|
| DEXEUSDT | 2767% | ~1384% | ~277% |
| SYNUSDT | 2008% | ~1004% | ~201% |
| RIFUSDT | 862% | ~431% | ~86% |
| KAITOUSDT | 436% | ~218% | ~44% |
| NEARUSDT | 387% | ~194% | ~39% |

That is not additive in a compounding sense and the two big contributors are exactly the two most regime-dependent names — but even a heavily discounted version of this is a strongly positive expectancy portfolio, with an expected portfolio drawdown in the **30–45%** range once you scale the backtested 13–33% DDs by 1.3–1.5×. Trade frequency across all 17 coins is ~58 trades/month, so across a 5-coin portfolio expect **15–20 trades a month** — enough to know within 3–4 months whether the live numbers track the backtest.

**Bottom line:** yes, this is a genuine, structurally-supported edge — the plateau evidence is unusually strong and rules out simple curve-fitting on 11 of the 17 coins. But it is an edge measured entirely in-sample, on 30–73 trades, in an up-trending window, on a long-only system, with zero slippage and impossible 100%-equity sizing. You should expect to be profitable; you should **not** expect anything close to 3114%.

## 5. What to do before risking money — in priority order

1. **Run a walk-forward split.** Re-optimize on 2025-07-20 → 2026-03-31 only, then measure the resulting config on 2026-04-01 → now, untouched. This is the one test that would convert "probably real" into "demonstrated." Everything else on this list is secondary.
2. **Use the robust configs, not the peak configs.** The tables in §3 give both. The peak column is what the optimizer found; the robust column is what the parameter space actually agrees on.
3. **Add slippage.** Re-run the top configs with `slippageTicks: 2–5` in `config.json` and see what survives. The low-liquidity names will move the most.
4. **Fix the sizing model.** Set `qty_pct_equity` to your real per-coin allocation (e.g. 20) and re-run, so the reported DD is a portfolio DD rather than a single-coin one.
5. **Raise the trade floor.** `min_trades: 30` in `params.json` is too low for confidence. Lifting it to 50 would drop SYN, KAITO, EIGEN and 币安人生 from consideration on statistical grounds — worth knowing which coins still look good at that bar.
6. **Paper trade the 5 Tier-1 coins for 6–8 weeks** (≈15–20 trades) and compare live win rate to the backtested one. If live win rate lands more than ~10pp below backtest, the edge was fit.
