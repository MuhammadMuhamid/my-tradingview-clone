# 15m MTF Lean — full-exit win-quality audit

**Research shortlist only.** OOS was included in selection and is therefore no longer an independent validation set. A fresh forward/paper period is mandatory.

Score priority: confidence-adjusted win rate on the weaker side (55%), weaker-side PF (15%), weaker-side net (15%), worst DD (10%), IS/OOS win-rate consistency (5%).

| Coin | Verdict | IS net/DD/WR/PF/T | OOS net/DD/WR/PF/T | Robust WR floor | Quality |
|---|---|---:|---:|---:|---:|
| DEXEUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 15.2/4.1/74.1/2.91/58 | 21.9/5.0/73.5/2.99/49 | 59.7% | 70.9 |
| SYNUSDT | STRONG FORWARD-TEST CANDIDATE | 6.1/3.6/58.3/1.90/72 | 6.6/4.5/60.2/1.86/83 | 46.8% | 55.0 |
| 币安人生USDT | BALANCED PAPER CANDIDATE | 2.2/1.9/51.0/1.75/51 | 2.5/2.9/52.9/1.24/136 | 37.7% | 39.7 |
| ZECUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 9.5/2.1/59.1/2.78/115 | 8.0/1.2/63.2/3.29/76 | 50.0% | 64.9 |
| RIFUSDT | NO QUALIFYING CONFIG | — | — | — | — |
| ALLOUSDT | BALANCED PAPER CANDIDATE | 5.2/5.7/54.1/1.28/61 | 14.5/7.6/54.3/1.57/81 | 41.7% | 42.6 |
| NEARUSDT | BALANCED PAPER CANDIDATE | 1.1/3.6/32.8/1.10/61 | 1.1/4.1/32.8/1.10/58 | 22.1% | 26.4 |
| KAITOUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 3.1/2.2/61.1/1.38/108 | 3.3/2.1/63.9/1.44/108 | 51.7% | 51.2 |
| JTOUSDT | BALANCED PAPER CANDIDATE | 3.8/1.5/56.0/1.78/50 | 4.3/1.5/52.5/1.79/59 | 40.0% | 50.2 |
| TAOUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 1.9/1.8/63.5/1.66/52 | 1.6/1.4/65.6/1.33/64 | 49.9% | 47.3 |
| PUMPUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 2.2/1.5/58.0/1.93/50 | 1.7/0.8/65.0/1.99/40 | 44.2% | 49.4 |
| EIGENUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 0.9/1.6/60.6/1.18/71 | 3.1/1.8/59.0/1.46/100 | 48.9% | 43.9 |
| MORPHOUSDT | NO QUALIFYING CONFIG | — | — | — | — |
| JSTUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 0.9/1.0/61.8/1.38/55 | 2.1/1.1/64.4/1.74/59 | 48.6% | 46.4 |
| ENAUSDT | NO QUALIFYING CONFIG | — | — | — | — |
| JUPUSDT | BALANCED PAPER CANDIDATE | 1.8/2.8/37.7/1.19/53 | 1.0/2.7/41.0/1.19/39 | 25.9% | 30.2 |
| INJUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 0.6/1.4/56.0/1.18/50 | 1.4/1.9/62.0/1.48/50 | 42.3% | 38.7 |
| PYTHUSDT | BALANCED PAPER CANDIDATE | 0.8/2.0/57.1/1.18/56 | 0.2/1.1/45.7/1.10/35 | 30.5% | 29.5 |
| TIAUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 0.8/1.1/58.0/1.33/50 | 0.9/1.3/55.3/1.30/47 | 41.2% | 41.0 |

## DEXEUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 74.1% IS and 73.5% OOS (95% conservative floor 59.7%).
- The weaker side still produced 15.23% net and PF 2.91; worst drawdown was 5.03%.
- The result does not depend on partial exits or trailing-stop bookkeeping, making execution simpler to reproduce.
- Active selective confirmations: G3 flow, S4 structure.

```json
{
  "atrLenRisk": 4,
  "s1_len": 1,
  "s1_maxAge": 18,
  "volMultMin": 1.1,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 3,
  "rrSwingLb": 18,
  "rrBufAtr": 0.5,
  "rrRatio": 1,
  "rrUsePartialTp": false,
  "rrUseTrailSl": false,
  "rrTrailPct": 2.5,
  "useG1": false,
  "g1_mult": 3,
  "useS4": true,
  "s4_mult": 3,
  "useS5": false
}
```

## SYNUSDT — STRONG FORWARD-TEST CANDIDATE

- Win rate held at 58.3% IS and 60.2% OOS (95% conservative floor 46.8%).
- The weaker side still produced 6.06% net and PF 1.86; worst drawdown was 4.46%.
- Exit behavior uses a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G1 momentum, G3 flow.

```json
{
  "atrLenRisk": 16,
  "s1_len": 1,
  "s1_maxAge": 40,
  "volMultMin": 0.7,
  "useG3": true,
  "s6_prox": 12,
  "s6_len": 8,
  "rrSwingLb": 18,
  "rrBufAtr": 4,
  "rrRatio": 4,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 2,
  "useS4": false,
  "s4_mult": 4,
  "useS5": false
}
```

## 币安人生USDT — BALANCED PAPER CANDIDATE

- Win rate held at 51.0% IS and 52.9% OOS (95% conservative floor 37.7%).
- The weaker side still produced 2.22% net and PF 1.24; worst drawdown was 2.93%.
- Exit behavior uses a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G1 momentum, S4 structure.

```json
{
  "atrLenRisk": 12,
  "s1_len": 3,
  "s1_maxAge": 26,
  "volMultMin": 0.7,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 4,
  "rrSwingLb": 20,
  "rrBufAtr": 1,
  "rrRatio": 4,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 2,
  "useS4": true,
  "s4_mult": 1.5,
  "useS5": false
}
```

## ZECUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 59.1% IS and 63.2% OOS (95% conservative floor 50.0%).
- The weaker side still produced 7.97% net and PF 2.78; worst drawdown was 2.10%.
- Exit behavior uses a 1.5% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G1 momentum, S5 structure.

```json
{
  "atrLenRisk": 2,
  "s1_len": 3,
  "s1_maxAge": 40,
  "volMultMin": 2.5,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 3,
  "rrSwingLb": 20,
  "rrBufAtr": 4,
  "rrRatio": 1.5,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 1.5,
  "useG1": true,
  "g1_mult": 2,
  "useS4": false,
  "s4_mult": 3,
  "useS5": true
}
```

## ALLOUSDT — BALANCED PAPER CANDIDATE

- Win rate held at 54.1% IS and 54.3% OOS (95% conservative floor 41.7%).
- The weaker side still produced 5.16% net and PF 1.28; worst drawdown was 7.61%.
- The result does not depend on partial exits or trailing-stop bookkeeping, making execution simpler to reproduce.
- Active selective confirmations: S4 structure.

```json
{
  "atrLenRisk": 4,
  "s1_len": 2,
  "s1_maxAge": 40,
  "volMultMin": 0.3,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 5,
  "rrSwingLb": 4,
  "rrBufAtr": 0.5,
  "rrRatio": 1,
  "rrUsePartialTp": false,
  "rrUseTrailSl": false,
  "rrTrailPct": 4,
  "useG1": false,
  "g1_mult": 2.5,
  "useS4": true,
  "s4_mult": 2,
  "useS5": false
}
```

## NEARUSDT — BALANCED PAPER CANDIDATE

- Win rate held at 32.8% IS and 32.8% OOS (95% conservative floor 22.1%).
- The weaker side still produced 1.05% net and PF 1.10; worst drawdown was 4.06%.
- Exit behavior uses a 4% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G1 momentum, S4 structure, S5 structure.

```json
{
  "atrLenRisk": 8,
  "s1_len": 2,
  "s1_maxAge": 34,
  "volMultMin": 1.4,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 6,
  "rrSwingLb": 4,
  "rrBufAtr": 2.8,
  "rrRatio": 2,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 4,
  "useG1": true,
  "g1_mult": 1.5,
  "useS4": true,
  "s4_mult": 4,
  "useS5": true
}
```

## KAITOUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 61.1% IS and 63.9% OOS (95% conservative floor 51.7%).
- The weaker side still produced 3.15% net and PF 1.38; worst drawdown was 2.16%.
- Exit behavior uses a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G1 momentum.

```json
{
  "atrLenRisk": 12,
  "s1_len": 2,
  "s1_maxAge": 18,
  "volMultMin": 1.9,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 4,
  "rrSwingLb": 18,
  "rrBufAtr": 0.5,
  "rrRatio": 2.5,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 4,
  "useS4": false,
  "s4_mult": 3,
  "useS5": false
}
```

## JTOUSDT — BALANCED PAPER CANDIDATE

- Win rate held at 56.0% IS and 52.5% OOS (95% conservative floor 40.0%).
- The weaker side still produced 3.76% net and PF 1.78; worst drawdown was 1.51%.
- Exit behavior uses a 1.5% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: S4 structure.

```json
{
  "atrLenRisk": 4,
  "s1_len": 3,
  "s1_maxAge": 40,
  "volMultMin": 2.5,
  "useG3": false,
  "s6_prox": 12,
  "s6_len": 5,
  "rrSwingLb": 20,
  "rrBufAtr": 1,
  "rrRatio": 4,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 1.5,
  "useG1": false,
  "g1_mult": 3,
  "useS4": true,
  "s4_mult": 1.5,
  "useS5": false
}
```

## TAOUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 63.5% IS and 65.6% OOS (95% conservative floor 49.9%).
- The weaker side still produced 1.56% net and PF 1.33; worst drawdown was 1.75%.
- Exit behavior uses a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G1 momentum, S5 structure.

```json
{
  "atrLenRisk": 6,
  "s1_len": 1,
  "s1_maxAge": 40,
  "volMultMin": 2.5,
  "useG3": false,
  "s6_prox": 6,
  "s6_len": 3,
  "rrSwingLb": 10,
  "rrBufAtr": 4,
  "rrRatio": 1.5,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 4,
  "useS4": false,
  "s4_mult": 2,
  "useS5": true
}
```

## PUMPUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 58.0% IS and 65.0% OOS (95% conservative floor 44.2%).
- The weaker side still produced 1.67% net and PF 1.93; worst drawdown was 1.52%.
- Exit behavior uses a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: S4 structure, S5 structure.

```json
{
  "atrLenRisk": 20,
  "s1_len": 2,
  "s1_maxAge": 10,
  "volMultMin": 1.4,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 5,
  "rrSwingLb": 4,
  "rrBufAtr": 0.1,
  "rrRatio": 3,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": false,
  "g1_mult": 4,
  "useS4": true,
  "s4_mult": 4,
  "useS5": true
}
```

## EIGENUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 60.6% IS and 59.0% OOS (95% conservative floor 48.9%).
- The weaker side still produced 0.94% net and PF 1.18; worst drawdown was 1.79%.
- Exit behavior uses a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G3 flow, S5 structure.

```json
{
  "atrLenRisk": 2,
  "s1_len": 1,
  "s1_maxAge": 40,
  "volMultMin": 0.3,
  "useG3": true,
  "s6_prox": 4,
  "s6_len": 3,
  "rrSwingLb": 10,
  "rrBufAtr": 4,
  "rrRatio": 1.5,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": false,
  "g1_mult": 3,
  "useS4": false,
  "s4_mult": 2,
  "useS5": true
}
```

## JSTUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 61.8% IS and 64.4% OOS (95% conservative floor 48.6%).
- The weaker side still produced 0.92% net and PF 1.38; worst drawdown was 1.13%.
- Exit behavior uses a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G3 flow, S4 structure.

```json
{
  "atrLenRisk": 20,
  "s1_len": 4,
  "s1_maxAge": 34,
  "volMultMin": 0.7,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 6,
  "rrSwingLb": 20,
  "rrBufAtr": 4,
  "rrRatio": 1.5,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": false,
  "g1_mult": 3,
  "useS4": true,
  "s4_mult": 4,
  "useS5": false
}
```

## JUPUSDT — BALANCED PAPER CANDIDATE

- Win rate held at 37.7% IS and 41.0% OOS (95% conservative floor 25.9%).
- The weaker side still produced 1.04% net and PF 1.19; worst drawdown was 2.83%.
- Exit behavior uses a 4% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G3 flow, S4 structure.

```json
{
  "atrLenRisk": 8,
  "s1_len": 1,
  "s1_maxAge": 26,
  "volMultMin": 0.7,
  "useG3": true,
  "s6_prox": 12,
  "s6_len": 5,
  "rrSwingLb": 18,
  "rrBufAtr": 2.8,
  "rrRatio": 5,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 4,
  "useG1": false,
  "g1_mult": 4,
  "useS4": true,
  "s4_mult": 4,
  "useS5": false
}
```

## INJUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 56.0% IS and 62.0% OOS (95% conservative floor 42.3%).
- The weaker side still produced 0.55% net and PF 1.18; worst drawdown was 1.86%.
- Exit behavior uses a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G1 momentum, S5 structure.

```json
{
  "atrLenRisk": 20,
  "s1_len": 2,
  "s1_maxAge": 40,
  "volMultMin": 1.1,
  "useG3": false,
  "s6_prox": 4,
  "s6_len": 3,
  "rrSwingLb": 4,
  "rrBufAtr": 4,
  "rrRatio": 2.5,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 2.5,
  "useS4": false,
  "s4_mult": 4,
  "useS5": true
}
```

## PYTHUSDT — BALANCED PAPER CANDIDATE

- Win rate held at 57.1% IS and 45.7% OOS (95% conservative floor 30.5%).
- The weaker side still produced 0.21% net and PF 1.10; worst drawdown was 2.01%.
- Exit behavior uses a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G1 momentum, S4 structure, S5 structure.

```json
{
  "atrLenRisk": 12,
  "s1_len": 1,
  "s1_maxAge": 18,
  "volMultMin": 0.3,
  "useG3": false,
  "s6_prox": 12,
  "s6_len": 10,
  "rrSwingLb": 14,
  "rrBufAtr": 1,
  "rrRatio": 6,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 2,
  "useS4": true,
  "s4_mult": 2,
  "useS5": true
}
```

## TIAUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 58.0% IS and 55.3% OOS (95% conservative floor 41.2%).
- The weaker side still produced 0.78% net and PF 1.30; worst drawdown was 1.26%.
- Exit behavior uses a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G1 momentum, G3 flow, S5 structure.

```json
{
  "atrLenRisk": 4,
  "s1_len": 3,
  "s1_maxAge": 18,
  "volMultMin": 1.1,
  "useG3": true,
  "s6_prox": 12,
  "s6_len": 3,
  "rrSwingLb": 10,
  "rrBufAtr": 0.1,
  "rrRatio": 6,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 2.5,
  "useS4": false,
  "s4_mult": 4,
  "useS5": true
}
```
