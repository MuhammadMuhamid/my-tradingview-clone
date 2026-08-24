# 15m MTF Lean — win-quality multi-objective audit

<!-- doc-status -->
> **HISTORICAL — a dated analysis artifact.** Produced on the date in this
> file's name from the optimizer results as they stood then. The underlying
> result data is gitignored and absent from clones (`OPT-08`), so nothing here
> is reproducible from source. Configurations named here were selected under
> the procedure recorded as `OPT-01` (the out-of-sample window was itself
> maximised over), so IS/OOS agreement in these tables is a selection artefact,
> not evidence of robustness. Do not deploy from this document.

**Research shortlist only.** OOS was included in selection and is therefore no longer an independent validation set. A fresh forward/paper period is mandatory.

Score priority: confidence-adjusted win rate on the weaker side (55%), weaker-side PF (15%), weaker-side net (15%), worst DD (10%), IS/OOS win-rate consistency (5%).

| Coin | Verdict | IS net/DD/WR/PF/T | OOS net/DD/WR/PF/T | Robust WR floor | Quality |
|---|---|---:|---:|---:|---:|
| DEXEUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 15.2/4.1/74.1/2.91/58 | 21.9/5.0/73.5/2.99/49 | 59.7% | 70.9 |
| SYNUSDT | STRONG FORWARD-TEST CANDIDATE | 6.1/3.6/58.3/1.90/72 | 6.6/4.5/60.2/1.86/83 | 46.8% | 55.0 |
| 币安人生USDT | HIGH-WR FORWARD-TEST CANDIDATE | 2.8/1.7/58.7/1.64/75 | 7.3/2.4/58.9/1.59/180 | 47.4% | 50.6 |
| ZECUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 8.9/2.0/80.2/3.68/101 | 5.7/1.8/80.0/3.53/55 | 67.6% | 74.3 |
| RIFUSDT | NO QUALIFYING CONFIG | — | — | — | — |
| ALLOUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 1.6/1.9/63.0/1.29/54 | 1.5/2.6/60.5/1.20/76 | 49.3% | 44.4 |
| NEARUSDT | BALANCED PAPER CANDIDATE | 0.9/2.9/40.4/1.11/57 | 1.4/1.6/58.8/1.37/34 | 28.6% | 27.8 |
| KAITOUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 3.9/1.6/69.0/1.79/58 | 3.4/2.1/67.4/1.76/46 | 53.0% | 56.2 |
| JTOUSDT | BALANCED PAPER CANDIDATE | 3.8/1.5/56.0/1.78/50 | 4.3/1.5/52.5/1.79/59 | 40.0% | 50.2 |
| TAOUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 1.9/1.8/63.5/1.66/52 | 1.6/1.4/65.6/1.33/64 | 49.9% | 47.3 |
| PUMPUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 4.1/1.2/62.3/1.94/53 | 4.0/1.5/64.2/1.83/53 | 48.8% | 56.0 |
| EIGENUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 1.3/1.5/64.8/1.27/71 | 1.0/1.7/60.9/1.16/87 | 50.4% | 44.3 |
| MORPHOUSDT | NO QUALIFYING CONFIG | — | — | — | — |
| JSTUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 0.9/1.0/61.8/1.38/55 | 2.1/1.1/64.4/1.74/59 | 48.6% | 46.4 |
| ENAUSDT | NO LIVE CONFIG — BEST DIAGNOSTIC ONLY | 0.4/1.4/51.0/1.11/51 | 0.2/0.8/48.6/1.06/37 | 33.4% | 32.8 |
| JUPUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 2.0/1.7/58.0/1.35/50 | 1.2/2.0/59.2/1.23/49 | 44.2% | 42.2 |
| INJUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 1.0/1.3/60.3/1.31/58 | 1.4/1.8/60.4/1.49/53 | 46.9% | 44.6 |
| PYTHUSDT | BALANCED PAPER CANDIDATE | 2.0/1.5/59.3/1.59/54 | 0.5/1.1/54.3/1.26/35 | 38.2% | 37.8 |
| TIAUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 1.0/1.1/62.3/1.35/53 | 1.5/1.4/59.4/1.40/64 | 47.1% | 45.1 |

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

## 币安人生USDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 58.7% IS and 58.9% OOS (95% conservative floor 47.4%).
- The weaker side still produced 2.76% net and PF 1.59; worst drawdown was 2.35%.
- Exit behavior uses partial profit-taking and a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: S4 structure.

```json
{
  "atrLenRisk": 12,
  "s1_len": 3,
  "s1_maxAge": 40,
  "volMultMin": 0.7,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 4,
  "rrSwingLb": 10,
  "rrBufAtr": 4,
  "rrRatio": 6,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": false,
  "g1_mult": 4,
  "useS4": true,
  "s4_mult": 1.5,
  "useS5": false
}
```

## ZECUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 80.2% IS and 80.0% OOS (95% conservative floor 67.6%).
- The weaker side still produced 5.73% net and PF 3.53; worst drawdown was 1.99%.
- Exit behavior uses partial profit-taking and a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: S4 structure.

```json
{
  "atrLenRisk": 2,
  "s1_len": 3,
  "s1_maxAge": 40,
  "volMultMin": 2.5,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 13,
  "rrSwingLb": 20,
  "rrBufAtr": 4,
  "rrRatio": 5,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": false,
  "g1_mult": 2,
  "useS4": true,
  "s4_mult": 2.5,
  "useS5": false
}
```

## ALLOUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 63.0% IS and 60.5% OOS (95% conservative floor 49.3%).
- The weaker side still produced 1.51% net and PF 1.20; worst drawdown was 2.58%.
- Exit behavior uses partial profit-taking and a 1.5% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: S4 structure.

```json
{
  "atrLenRisk": 4,
  "s1_len": 2,
  "s1_maxAge": 10,
  "volMultMin": 0.3,
  "useG3": false,
  "s6_prox": 8,
  "s6_len": 5,
  "rrSwingLb": 10,
  "rrBufAtr": 1.8,
  "rrRatio": 3,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 1.5,
  "useG1": false,
  "g1_mult": 2.5,
  "useS4": true,
  "s4_mult": 2.5,
  "useS5": false
}
```

## NEARUSDT — BALANCED PAPER CANDIDATE

- Win rate held at 40.4% IS and 58.8% OOS (95% conservative floor 28.6%).
- The weaker side still produced 0.91% net and PF 1.11; worst drawdown was 2.91%.
- Exit behavior uses partial profit-taking, which can protect the higher hit rate during reversals.
- Active selective confirmations: G1 momentum, S4 structure.

```json
{
  "atrLenRisk": 6,
  "s1_len": 2,
  "s1_maxAge": 40,
  "volMultMin": 1.4,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 6,
  "rrSwingLb": 8,
  "rrBufAtr": 0.1,
  "rrRatio": 3,
  "rrUsePartialTp": true,
  "rrUseTrailSl": false,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 2.5,
  "useS4": true,
  "s4_mult": 2,
  "useS5": false
}
```

## KAITOUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 69.0% IS and 67.4% OOS (95% conservative floor 53.0%).
- The weaker side still produced 3.36% net and PF 1.76; worst drawdown was 2.14%.
- Exit behavior uses partial profit-taking and a 2.5% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: S5 structure.

```json
{
  "atrLenRisk": 6,
  "s1_len": 2,
  "s1_maxAge": 18,
  "volMultMin": 1.1,
  "useG3": false,
  "s6_prox": 12,
  "s6_len": 10,
  "rrSwingLb": 18,
  "rrBufAtr": 0.5,
  "rrRatio": 2.5,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 2.5,
  "useG1": false,
  "g1_mult": 4,
  "useS4": false,
  "s4_mult": 4,
  "useS5": true
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

- Win rate held at 62.3% IS and 64.2% OOS (95% conservative floor 48.8%).
- The weaker side still produced 3.97% net and PF 1.83; worst drawdown was 1.49%.
- Exit behavior uses partial profit-taking and a 4% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G3 flow, S4 structure, S5 structure.

```json
{
  "atrLenRisk": 8,
  "s1_len": 2,
  "s1_maxAge": 26,
  "volMultMin": 1.1,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 6,
  "rrSwingLb": 10,
  "rrBufAtr": 2.8,
  "rrRatio": 1,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 4,
  "useG1": false,
  "g1_mult": 4,
  "useS4": true,
  "s4_mult": 1.5,
  "useS5": true
}
```

## EIGENUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 64.8% IS and 60.9% OOS (95% conservative floor 50.4%).
- The weaker side still produced 1.02% net and PF 1.16; worst drawdown was 1.74%.
- Exit behavior uses partial profit-taking and a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G3 flow, S5 structure.

```json
{
  "atrLenRisk": 4,
  "s1_len": 1,
  "s1_maxAge": 40,
  "volMultMin": 0.3,
  "useG3": true,
  "s6_prox": 4,
  "s6_len": 3,
  "rrSwingLb": 10,
  "rrBufAtr": 4,
  "rrRatio": 1,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": false,
  "g1_mult": 2,
  "useS4": false,
  "s4_mult": 2.5,
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

## ENAUSDT — NO LIVE CONFIG — BEST DIAGNOSTIC ONLY

- Win rate held at 51.0% IS and 48.6% OOS (95% conservative floor 33.4%).
- The weaker side still produced 0.18% net and PF 1.06; worst drawdown was 1.37%.
- Exit behavior uses partial profit-taking and a 1.5% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G1 momentum, G3 flow, S5 structure.

```json
{
  "atrLenRisk": 8,
  "s1_len": 4,
  "s1_maxAge": 18,
  "volMultMin": 0.3,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 4,
  "rrSwingLb": 18,
  "rrBufAtr": 0.5,
  "rrRatio": 2,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 1.5,
  "useG1": true,
  "g1_mult": 2.5,
  "useS4": false,
  "s4_mult": 2,
  "useS5": true
}
```

## JUPUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 58.0% IS and 59.2% OOS (95% conservative floor 44.2%).
- The weaker side still produced 1.19% net and PF 1.23; worst drawdown was 2.04%.
- Exit behavior uses partial profit-taking and a 4% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G1 momentum, G3 flow, S4 structure.

```json
{
  "atrLenRisk": 4,
  "s1_len": 3,
  "s1_maxAge": 34,
  "volMultMin": 0.7,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 3,
  "rrSwingLb": 14,
  "rrBufAtr": 2.8,
  "rrRatio": 5,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 4,
  "useG1": true,
  "g1_mult": 2,
  "useS4": true,
  "s4_mult": 2.5,
  "useS5": false
}
```

## INJUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Win rate held at 60.3% IS and 60.4% OOS (95% conservative floor 46.9%).
- The weaker side still produced 0.96% net and PF 1.31; worst drawdown was 1.79%.
- Exit behavior uses partial profit-taking and a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G1 momentum, S5 structure.

```json
{
  "atrLenRisk": 20,
  "s1_len": 1,
  "s1_maxAge": 40,
  "volMultMin": 1.1,
  "useG3": false,
  "s6_prox": 4,
  "s6_len": 3,
  "rrSwingLb": 4,
  "rrBufAtr": 4,
  "rrRatio": 2.5,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 2.5,
  "useS4": false,
  "s4_mult": 2.5,
  "useS5": true
}
```

## PYTHUSDT — BALANCED PAPER CANDIDATE

- Win rate held at 59.3% IS and 54.3% OOS (95% conservative floor 38.2%).
- The weaker side still produced 0.54% net and PF 1.26; worst drawdown was 1.52%.
- Exit behavior uses partial profit-taking and a 0.8% trailing stop, which can protect the higher hit rate during reversals.
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
  "rrBufAtr": 1.8,
  "rrRatio": 6,
  "rrUsePartialTp": true,
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

- Win rate held at 62.3% IS and 59.4% OOS (95% conservative floor 47.1%).
- The weaker side still produced 0.97% net and PF 1.35; worst drawdown was 1.39%.
- Exit behavior uses partial profit-taking and a 0.8% trailing stop, which can protect the higher hit rate during reversals.
- Active selective confirmations: G1 momentum, G3 flow, S5 structure.

```json
{
  "atrLenRisk": 8,
  "s1_len": 4,
  "s1_maxAge": 34,
  "volMultMin": 1.4,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 6,
  "rrSwingLb": 10,
  "rrBufAtr": 1,
  "rrRatio": 3,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 4,
  "useS4": false,
  "s4_mult": 1.5,
  "useS5": true
}
```
