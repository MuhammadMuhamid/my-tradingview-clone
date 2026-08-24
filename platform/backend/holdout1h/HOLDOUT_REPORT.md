# opt1hyear-results — Holdout Validation (pre-optimizer history)

Every config below was chosen by the optimizer on **2025-07-20 → 2026-07-30**, then
replayed here over history it never saw, ending **2025-07-19**.

Sizing is a **fixed $1,000 per trade** (no compounding, no leverage effect), commission
0.1%/side, slippage 2 ticks. The live leaderboard compounds at 100% of equity, so its
net% figures are not comparable with these and are far larger by construction.

Coins with a usable holdout: **13** · configs replayed: **13,000**

## 1. Did the top-1000 population survive?

| Coin | Configs | Holdout months | Mean net | Median net | % profitable | Buy & hold | Median vs B&H | Beat B&H |
|---|---|---|---|---|---|---|---|---|
| **TAOUSDT** | 1000 |  | +128.1% | +131.5% | 100% | -40.1% | +171.6 pts | 100% |
| **KAITOUSDT** | 1000 |  | +62.9% | +70.3% | 94% | +46.2% | +24.1 pts | 69% |
| **SYNUSDT** | 1000 |  | +53.9% | +51.1% | 100% | -77.6% | +128.7 pts | 100% |
| **ZECUSDT** | 1000 |  | +46.0% | +43.1% | 90% | +47.6% | -4.5 pts | 44% |
| **ENAUSDT** | 1000 |  | +33.5% | +40.1% | 79% | -31.1% | +71.3 pts | 93% |
| **INJUSDT** | 1000 |  | +38.9% | +39.9% | 91% | +79.3% | -39.4 pts | 5% |
| **JSTUSDT** | 1000 |  | +13.4% | +16.9% | 81% | +55.2% | -38.4 pts | 0% |
| **JUPUSDT** | 1000 |  | +4.9% | +7.2% | 58% | -21.1% | +28.3 pts | 79% |
| **RIFUSDT** | 1000 |  | +3.5% | +3.3% | 55% | -21.4% | +24.8 pts | 80% |
| **DEXEUSDT** | 1000 |  | +1.9% | +1.6% | 52% | +223.2% | -221.6 pts | 0% |
| **NEARUSDT** | 1000 |  | -4.8% | -4.4% | 40% | +111.3% | -115.7 pts | 0% |
| **JTOUSDT** | 1000 |  | -37.7% | -37.4% | 11% | -9.5% | -27.9 pts | 18% |
| **EIGENUSDT** | 1000 |  | -41.4% | -40.4% | 13% | -61.2% | +20.8 pts | 71% |

## 2. Does the leaderboard ordering predict holdout performance?

Spearman rank correlation between in-sample rank (1 = best) and holdout net%.
Positive means better in-sample rank → better holdout result. ~0 means the ordering is noise.

| Coin | rank vs holdout net | Top-50 median | Bottom-50 median | Top-50 better? |
|---|---|---|---|---|
| DEXEUSDT | **-0.02** | +0.1% | -2.6% | yes |
| EIGENUSDT | **+0.06** | -25.8% | -47.2% | yes |
| ENAUSDT | **+0.06** | +30.2% | +27.3% | yes |
| INJUSDT | **-0.09** | +46.8% | +42.7% | yes |
| JSTUSDT | **+0.02** | +18.1% | +14.9% | yes |
| JTOUSDT | **+0.01** | -40.2% | -38.6% | no |
| JUPUSDT | **+0.03** | +10.2% | +5.8% | yes |
| KAITOUSDT | **+0.10** | +87.1% | +76.4% | yes |
| NEARUSDT | **+0.02** | -1.7% | -4.3% | yes |
| RIFUSDT | **+0.05** | +13.9% | -0.3% | yes |
| SYNUSDT | **+0.06** | +64.1% | +39.5% | yes |
| TAOUSDT | **+0.07** | +139.8% | +146.5% | no |
| ZECUSDT | **+0.03** | +61.3% | +36.7% | yes |

**Mean rank correlation across coins: +0.03**

## 3. Best config per coin on the holdout

Ranked four ways, as requested. Read §2 first — where the rank correlation is near zero,
these winners are the luckiest of 1000 draws rather than the best strategies.

### Highest net %

| Coin | In-sample rank | Holdout net | DD | Win% | PF | Trades | B&H |
|---|---|---|---|---|---|---|---|
| DEXEUSDT | #86 | +85.6% | 35.0% | 62.3% | 1.38 | 77 | +223.2% |
| EIGENUSDT | #452 | +91.0% | 41.0% | 65.4% | 1.95 | 26 | -61.2% |
| ENAUSDT | #894 | +153.8% | 32.6% | 46.1% | 2.12 | 26 | -31.1% |
| INJUSDT | #530 | +119.8% | 20.6% | 67.5% | 2.20 | 40 | +79.3% |
| JSTUSDT | #769 | +48.5% | 14.1% | 70.3% | 1.96 | 37 | +55.2% |
| JTOUSDT | #970 | +50.4% | 23.7% | 42.9% | 1.34 | 35 | -9.5% |
| JUPUSDT | #536 | +153.5% | 17.1% | 51.9% | 3.01 | 27 | -21.1% |
| KAITOUSDT | #865 | +143.5% | 12.2% | 63.6% | 5.83 | 11 | +46.2% |
| NEARUSDT | #263 | +70.3% | 28.4% | 48.5% | 1.48 | 33 | +111.3% |
| RIFUSDT | #278 | +123.9% | 22.2% | 56.5% | 1.76 | 69 | -21.4% |
| SYNUSDT | #438 | +149.3% | 38.7% | 35.9% | 1.57 | 39 | -77.6% |
| TAOUSDT | #814 | +215.7% | 18.8% | 55.8% | 2.22 | 43 | -40.1% |
| ZECUSDT | #541 | +186.5% | 25.7% | 47.8% | 2.04 | 46 | +47.6% |

### Highest profit factor

| Coin | In-sample rank | Holdout net | DD | Win% | PF | Trades | B&H |
|---|---|---|---|---|---|---|---|
| DEXEUSDT | #301 | +84.8% | 33.5% | 64.1% | 1.42 | 92 | +223.2% |
| EIGENUSDT | #452 | +91.0% | 41.0% | 65.4% | 1.95 | 26 | -61.2% |
| ENAUSDT | #978 | +149.4% | 23.9% | 48.0% | 2.34 | 25 | -31.1% |
| INJUSDT | #851 | +115.3% | 16.5% | 77.3% | 2.56 | 44 | +79.3% |
| JSTUSDT | #769 | +48.5% | 14.1% | 70.3% | 1.96 | 37 | +55.2% |
| JTOUSDT | #970 | +50.4% | 23.7% | 42.9% | 1.34 | 35 | -9.5% |
| JUPUSDT | #536 | +153.5% | 17.1% | 51.9% | 3.01 | 27 | -21.1% |
| KAITOUSDT | #865 | +143.5% | 12.2% | 63.6% | 5.83 | 11 | +46.2% |
| NEARUSDT | #430 | +69.8% | 31.1% | 37.0% | 1.50 | 27 | +111.3% |
| RIFUSDT | #278 | +123.9% | 22.2% | 56.5% | 1.76 | 69 | -21.4% |
| SYNUSDT | #21 | +149.0% | 38.8% | 36.8% | 1.58 | 38 | -77.6% |
| TAOUSDT | #361 | +211.4% | 21.4% | 59.0% | 2.29 | 39 | -40.1% |
| ZECUSDT | #47 | +165.3% | 30.4% | 50.0% | 2.16 | 24 | +47.6% |

### Lowest drawdown (net > 0)

| Coin | In-sample rank | Holdout net | DD | Win% | PF | Trades | B&H |
|---|---|---|---|---|---|---|---|
| DEXEUSDT | #463 | +72.8% | 27.8% | 44.6% | 1.35 | 56 | +223.2% |
| EIGENUSDT | #710 | +6.1% | 31.0% | 57.1% | 1.05 | 28 | -61.2% |
| ENAUSDT | #363 | +99.0% | 15.8% | 68.4% | 1.91 | 38 | -31.1% |
| INJUSDT | #851 | +115.3% | 16.5% | 77.3% | 2.56 | 44 | +79.3% |
| JSTUSDT | #556 | +33.5% | 13.6% | 61.0% | 1.44 | 41 | +55.2% |
| JTOUSDT | #970 | +50.4% | 23.7% | 42.9% | 1.34 | 35 | -9.5% |
| JUPUSDT | #123 | +102.7% | 14.8% | 57.1% | 2.07 | 35 | -21.1% |
| KAITOUSDT | #178 | +137.0% | 12.2% | 60.0% | 5.54 | 10 | +46.2% |
| NEARUSDT | #263 | +70.3% | 28.4% | 48.5% | 1.48 | 33 | +111.3% |
| RIFUSDT | #289 | +96.1% | 20.8% | 55.9% | 1.55 | 59 | -21.4% |
| SYNUSDT | #192 | +142.5% | 33.1% | 35.9% | 1.54 | 39 | -77.6% |
| TAOUSDT | #117 | +181.6% | 18.7% | 53.3% | 1.93 | 45 | -40.1% |
| ZECUSDT | #628 | +129.6% | 16.9% | 45.6% | 1.74 | 46 | +47.6% |

### Highest win rate (net > 0)

| Coin | In-sample rank | Holdout net | DD | Win% | PF | Trades | B&H |
|---|---|---|---|---|---|---|---|
| DEXEUSDT | #837 | +84.7% | 31.8% | 64.4% | 1.42 | 87 | +223.2% |
| EIGENUSDT | #206 | +45.2% | 43.2% | 66.7% | 1.42 | 24 | -61.2% |
| ENAUSDT | #328 | +133.7% | 19.3% | 75.6% | 2.21 | 45 | -31.1% |
| INJUSDT | #606 | +56.7% | 23.1% | 77.8% | 2.15 | 27 | +79.3% |
| JSTUSDT | #769 | +48.5% | 14.1% | 70.3% | 1.96 | 37 | +55.2% |
| JTOUSDT | #970 | +50.4% | 23.7% | 42.9% | 1.34 | 35 | -9.5% |
| JUPUSDT | #751 | +81.4% | 21.5% | 70.3% | 1.73 | 64 | -21.1% |
| KAITOUSDT | #304 | +93.2% | 33.1% | 70.0% | 2.42 | 20 | +46.2% |
| NEARUSDT | #541 | +18.3% | 41.8% | 51.5% | 1.13 | 33 | +111.3% |
| RIFUSDT | #278 | +123.9% | 22.2% | 56.5% | 1.76 | 69 | -21.4% |
| SYNUSDT | #41 | +119.2% | 37.1% | 41.0% | 1.41 | 39 | -77.6% |
| TAOUSDT | #32 | +185.0% | 21.5% | 71.2% | 1.91 | 59 | -40.1% |
| ZECUSDT | #408 | +40.7% | 33.7% | 56.1% | 1.15 | 82 | +47.6% |
