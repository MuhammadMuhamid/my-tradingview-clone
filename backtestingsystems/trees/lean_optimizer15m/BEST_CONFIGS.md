# Best configs — 15m MTF Confluence Lean, 2026-08-21 (v3)

Goal: **win most of the time, with minimum risk.**

Selected from **3,924,397 backtests** across 19 coins.

## Method — and two earlier versions that were wrong

The goal is a *constrained maximisation*, not a weighted blend. Two earlier
attempts got this wrong, and the user caught it:

- **v1 (percentile ranking)** — normalised every criterion to its percentile
  within the coin's pool. In a 94,292-config pool the top few hundred all sit at
  ~100th percentile on win rate, so an **8-point win-rate gap compressed to 0.001
  of rank**. After weighting, two configs 8 points apart on the primary objective
  both scored exactly 0.350 on it. The decision fell to `net` and to an IS/OOS
  consistency term that penalised a 1.9-point wobble — noise deciding the
  outcome. Magnitude was destroyed.
- **v2 (value-based min-max, still blended)** — fixed the magnitude problem but
  still let a 3.9-point net advantage outrank an 11-point win-rate advantage.

**v3 — what is used here.** Risk and return are *constraints*; win rate is the
*objective*:

```
gates     : >=50 IS trades, >=30 OOS trades
            net > 0 on both sides
            profit factor >= 1.10 on both sides
            drawdown <= 3.0% on both sides
maximise  : min(WR_is, WR_oos)          <- the lower of the two win rates
tie-break : lower max-DD, then higher min-PF, then higher min-net
```

Taking the **lower** of the two win rates is what makes "on both sides" real —
a config cannot hide a weak out-of-sample half behind a strong in-sample half.

## Verified results — ALL coins (re-run against current data, 2026-08-21)

Sorted by the **lower** of the two win rates. `SL` = stopped-at-a-loss rate.

| coin | tier | pool | WR is | WR oos | **min WR** | DD is | DD oos | PF is | PF oos | net is | net oos | trades is | trades oos | SL is | SL oos |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ZECUSDT | A | 33,584 | 83.8% | 79.6% | **79.6%** | 1.99% | 1.58% | 6.25 | 3.48 | +9.3% | +5.1% | 80 | 49 | 16.3% | 20.4% |
| DEXEUSDT | A | 56,846 | 74.5% | 73.9% | **73.9%** | 1.75% | 1.58% | 2.48 | 4.48 | +5.2% | +12.6% | 51 | 92 | 25.5% | 26.1% |
| PUMPUSDT | B | 1,498 | 69.1% | 69.8% | **69.1%** | 1.53% | 2.66% | 1.65 | 1.41 | +1.8% | +1.3% | 55 | 43 | 30.9% | 30.2% |
| KAITOUSDT | A | 5,780 | 69% | 67.4% | **67.4%** | 1.56% | 2.14% | 1.79 | 1.76 | +3.9% | +3.4% | 58 | 46 | 31% | 32.6% |
| TAOUSDT | C | 175 | 64.2% | 64.9% | **64.2%** | 1.86% | 1.79% | 1.22 | 1.31 | +0.8% | +0.7% | 53 | 37 | 35.8% | 35.1% |
| JTOUSDT | B | 1,953 | 64.4% | 63.9% | **63.9%** | 1.63% | 2% | 1.27 | 1.28 | +1.4% | +2.2% | 59 | 72 | 35.6% | 36.1% |
| ALLOUSDT | C | 54 | 61.9% | 61.9% | **61.9%** | 2.3% | 2.5% | 1.14 | 1.22 | +1.1% | +2.3% | 84 | 97 | 38.1% | 38.1% |
| JSTUSDT | B | 1,512 | 61.8% | 62.9% | **61.8%** | 1.01% | 1.13% | 1.38 | 1.67 | +0.9% | +2.1% | 55 | 62 | 38.2% | 37.1% |
| 币安人生USDT | C | 118 | 64.3% | 61.6% | **61.6%** | 1.62% | 2.38% | 1.52 | 1.48 | +1.8% | +3.8% | 56 | 125 | 35.7% | 38.4% |
| EIGENUSDT | C | 15 | 64.8% | 61.1% | **61.1%** | 1.48% | 1.88% | 1.27 | 1.18 | +1.3% | +1.1% | 71 | 90 | 35.2% | 38.9% |
| INJUSDT | C | 20 | 60.3% | 61.8% | **60.3%** | 1.33% | 1.79% | 1.31 | 1.59 | +1% | +1.7% | 58 | 55 | 39.7% | 38.2% |
| TIAUSDT | C | 21 | 61.7% | 60.3% | **60.3%** | 1.16% | 1.55% | 1.26 | 1.12 | +0.9% | +0.5% | 60 | 58 | 38.3% | 39.7% |
| SYNUSDT | C | 17 | 59.7% | 64.7% | **59.7%** | 2.53% | 2.68% | 1.64 | 1.72 | +3.5% | +5.7% | 62 | 85 | 40.3% | 35.3% |
| JUPUSDT | C | 13 | 58% | 59.2% | **58%** | 1.7% | 2.04% | 1.35 | 1.23 | +2% | +1.2% | 50 | 49 | 42% | 40.8% |
| PYTHUSDT | C | 4 | 59.3% | 54.3% | **54.3%** | 1.52% | 1.05% | 1.59 | 1.26 | +2% | +0.5% | 54 | 35 | 40.7% | 45.7% |
| NEARUSDT | C | 1 | 40.4% | 55.9% | **40.4%** | 2.91% | 1.56% | 1.11 | 1.33 | +0.9% | +1.3% | 57 | 34 | 59.6% | 44.1% |

**ENAUSDT, MORPHOUSDT, RIFUSDT — zero qualifying configs.** Nothing on these
coins is profitable with PF >= 1.1 on both sides. They are not in the table
because there is nothing to put there.

### Tiers — by qualified pool (out of ~206,600 configs per coin)

- **A (>=5,000)** — ZEC, DEXE, KAITO. The edge survives almost any parameter
  choice, so the pick is a representative of a broad plateau rather than a lucky
  draw. Trade these.
- **B (>=1,000)** — JTO, JST, PUMP. Narrower but real.
- **C (<1,000)** — everything else. TAO 175, 币安人生 118, ALLO 54, TIA 21,
  INJ 20, SYN 17, EIGEN 15, JUP 13, PYTH 4, NEAR 1. Picking the best of 15
  survivors out of 206,600 is selecting a lottery winner. Configs are listed for
  completeness; they are **not** recommended for live trading.

Two specific warnings in tier C:

- **SYN is cap-limited, not weak.** Its strong configs run 3.4-3.5% drawdown and
  were excluded by the 3% cap. Raise the cap to 3.5% and SYN has 6,170
  qualifying configs at ~59% win rate — it would be tier A.
- **NEAR should be ignored entirely.** One config survived, at a 40.4% win rate.
  It passed only because a few large winners lifted PF above 1.1, which is the
  opposite of "win most of the time".

## Configs — tier A + B (tradeable)

| param | ZEC | DEXE | KAITO | JTO | JST | PUMP |
|---|---|---|---|---|---|---|
| atrLenRisk | 2 | 2 | 6 | 4 | 20 | 12 |
| g1_mult | 1.5 | 1.5 | 4 | 1.5 | 3 | 3 |
| rrBufAtr | 4 | 4 | 0.5 | 4 | 4 | 4 |
| rrRatio | 5 | 3 | 2.5 | 1 | 1.5 | 2 |
| rrSwingLb | 10 | 14 | 18 | 8 | 20 | 10 |
| rrTrailPct | 0.8 | 2.5 | 2.5 | 2.5 | 0.8 | 0.8 |
| rrUsePartialTp | on | on | on | on | off | on |
| rrUseTrailSl | on | on | on | on | on | on |
| s1_len | 3 | 3 | 2 | 3 | 4 | 4 |
| s1_maxAge | 40 | 18 | 18 | 34 | 34 | 26 |
| s4_mult | 2 | 4 | 4 | 2.5 | 4 | 2.5 |
| s6_len | 13 | 3 | 10 | 5 | 6 | 6 |
| s6_prox | 20 | 8 | 12 | 20 | 20 | 20 |
| useG1 | on | off | off | on | off | off |
| useG3 | off | on | off | off | on | on |
| useS4 | on | off | off | on | on | on |
| useS5 | on | off | on | on | off | on |
| volMultMin | 2.5 | 1.1 | 1.1 | 1.4 | 0.7 | 1.1 |

`rrUseTrailSl` is **on** for all six.

## Configs — tier C (thin evidence, listed for completeness)

| param | TAO | ALLO | 币安人生 | EIGEN | INJ | TIA | SYN | JUP | PYTH | NEAR |
|---|---|---|---|---|---|---|---|---|---|---|
| atrLenRisk | 6 | 2 | 20 | 4 | 20 | 4 | 20 | 4 | 12 | 6 |
| g1_mult | 4 | 2.5 | 4 | 2 | 2.5 | 4 | 3 | 2 | 2 | 2.5 |
| rrBufAtr | 4 | 4 | 4 | 4 | 4 | 2.8 | 4 | 2.8 | 1.8 | 0.1 |
| rrRatio | 1.5 | 3 | 4 | 1 | 2.5 | 2 | 4 | 5 | 6 | 3 |
| rrSwingLb | 10 | 18 | 20 | 10 | 4 | 10 | 18 | 14 | 14 | 8 |
| rrTrailPct | 0.8 | 1.5 | 0.8 | 0.8 | 0.8 | 0.8 | 0.8 | 4 | 0.8 | 0.8 |
| rrUsePartialTp | on | on | on | on | on | on | on | on | on | on |
| rrUseTrailSl | on | on | on | on | on | on | on | on | on | off |
| s1_len | 1 | 2 | 3 | 1 | 1 | 3 | 1 | 3 | 1 | 2 |
| s1_maxAge | 40 | 10 | 26 | 40 | 40 | 18 | 26 | 34 | 18 | 40 |
| s4_mult | 2.5 | 4 | 1.5 | 2.5 | 2.5 | 4 | 1.5 | 2.5 | 2 | 2 |
| s6_len | 13 | 5 | 3 | 3 | 3 | 3 | 8 | 3 | 10 | 6 |
| s6_prox | 20 | 20 | 20 | 4 | 4 | 12 | 12 | 20 | 12 | 20 |
| useG1 | on | off | on | off | on | on | on | on | on | on |
| useG3 | off | off | off | on | off | on | on | on | off | off |
| useS4 | on | on | on | off | off | off | off | on | on | on |
| useS5 | on | off | off | on | on | on | off | off | on | off |
| volMultMin | 2.5 | 0.3 | 0.7 | 0.3 | 1.1 | 1.1 | 0.7 | 0.7 | 0.3 | 1.4 |

## Caveats

**1. Selecting on OOS spends the OOS.** These were chosen partly *because* they
performed out-of-sample, so those figures are no longer an honest out-of-sample
estimate. Expect live results below the table. ZEC/DEXE/KAITO are least affected,
because their edge did not depend on finding a special config.

**2. Stored OOS drifts; these numbers are fresh re-runs.** `range.end` is
`"now"`, so each record's OOS was computed against a different end date. On
re-run, in-sample matched exactly for every pick while OOS moved (ZEC's OOS win
rate 81.8% -> 79.6%). Never compare stored OOS across records written days apart.

**3. Drawdown is flattered by fixed sizing.** $1000 per trade on $10,000 means
1.5% drawdown is 1.5% of the *account*, not of capital at risk.

**4. ~80% is the ceiling.** No config on any coin exceeded ZEC's ~84%/80% while
staying profitable on both sides. Going higher is a strategy-design change, not
a parameter search.
