# 5m MTF Lean — win-quality multi-objective audit

<!-- doc-status -->
> **HISTORICAL — a dated analysis artifact.** Produced on the date in this
> file's name from the optimizer results as they stood then. The underlying
> result data is gitignored and absent from clones (`OPT-08`), so nothing here
> is reproducible from source. Configurations named here were selected under
> the procedure recorded as `OPT-01` (the out-of-sample window was itself
> maximised over), so IS/OOS agreement in these tables is a selection artefact,
> not evidence of robustness. Do not deploy from this document.

**Research shortlist only.** OOS was included in selection and is no longer an independent validation set. A fresh forward/paper period is mandatory.

Score priority: confidence-adjusted per-entry win rate on the weaker side (55%), weaker-side PF (15%), weaker-side net (15%), worst DD (10%), IS/OOS win-rate consistency (5%).

| Coin | Verdict | IS net/DD/WR/PF/T | OOS net/DD/WR/PF/T | Robust WR floor | Quality |
|---|---|---:|---:|---:|---:|
| DEXEUSDT | STRONG FORWARD-TEST CANDIDATE | 5.4/2.3/57.7/1.55/137 | 8.1/1.8/58.5/1.50/188 | 49.3% | 54.5 |
| SYNUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 4.2/2.1/67.0/1.51/112 | 7.9/3.5/63.0/1.48/162 | 55.3% | 54.3 |
| 币安人生USDT | NO QUALIFYING CONFIG | — | — | — | — |
| ZECUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 22.1/4.6/60.7/1.95/112 | 10.7/2.8/60.5/1.93/76 | 49.3% | 60.4 |
| RIFUSDT | NO QUALIFYING CONFIG | — | — | — | — |
| ALLOUSDT | BALANCED PAPER CANDIDATE | 3.5/7.7/46.3/1.13/108 | 15.0/6.8/41.2/1.43/136 | 33.3% | 32.9 |
| NEARUSDT | NO QUALIFYING CONFIG | — | — | — | — |
| KAITOUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 4.2/2.9/56.2/1.47/146 | 2.9/1.9/61.7/1.49/120 | 48.1% | 48.6 |
| JTOUSDT | BALANCED PAPER CANDIDATE | 1.3/2.4/50.4/1.11/117 | 2.6/2.8/55.6/1.14/171 | 41.5% | 37.9 |
| TAOUSDT | NO LIVE CONFIG — BEST DIAGNOSTIC ONLY | 0.8/4.9/30.0/1.04/100 | 2.3/5.1/28.7/1.13/87 | 20.3% | 23.0 |
| PUMPUSDT | HIGH-WR FORWARD-TEST CANDIDATE | 3.1/2.2/62.0/1.46/100 | 1.5/2.5/61.1/1.31/72 | 49.6% | 46.3 |
| EIGENUSDT | NO QUALIFYING CONFIG | — | — | — | — |
| MORPHOUSDT | NO QUALIFYING CONFIG | — | — | — | — |
| JSTUSDT | BALANCED PAPER CANDIDATE | 2.7/1.8/43.6/1.29/140 | 3.1/1.9/49.3/1.33/144 | 35.6% | 40.5 |
| ENAUSDT | NO QUALIFYING CONFIG | — | — | — | — |
| JUPUSDT | NO QUALIFYING CONFIG | — | — | — | — |
| INJUSDT | NO QUALIFYING CONFIG | — | — | — | — |
| PYTHUSDT | NO QUALIFYING CONFIG | — | — | — | — |
| TIAUSDT | NO QUALIFYING CONFIG | — | — | — | — |

## DEXEUSDT — STRONG FORWARD-TEST CANDIDATE

- Per-entry win rate held at 57.7% IS and 58.5% OOS (95% conservative floor 49.3%).
- The weaker side retained 5.37% net and PF 1.50; worst drawdown was 2.34%.
- Exit behavior uses partial profit-taking and a 2.5% trailing stop.
- Active selective confirmations: G1 momentum, G3 flow, S4 structure.

```json
{
  "atrLenRisk": 4,
  "s1_len": 3,
  "s1_maxAge": 40,
  "volMultMin": 1.1,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 3,
  "rrSwingLb": 18,
  "rrBufAtr": 0.5,
  "rrRatio": 2,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 2.5,
  "useG1": true,
  "g1_mult": 4,
  "useS4": true,
  "s4_mult": 4,
  "useS5": false
}
```

## SYNUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Per-entry win rate held at 67.0% IS and 63.0% OOS (95% conservative floor 55.3%).
- The weaker side retained 4.16% net and PF 1.48; worst drawdown was 3.48%.
- Exit behavior uses a 0.8% trailing stop.
- Active selective confirmations: G1 momentum.

```json
{
  "atrLenRisk": 20,
  "s1_len": 1,
  "s1_maxAge": 10,
  "volMultMin": 1.1,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 8,
  "rrSwingLb": 18,
  "rrBufAtr": 4,
  "rrRatio": 2,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 3,
  "useS4": false,
  "s4_mult": 1.5,
  "useS5": false
}
```

## ZECUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Per-entry win rate held at 60.7% IS and 60.5% OOS (95% conservative floor 49.3%).
- The weaker side retained 10.71% net and PF 1.93; worst drawdown was 4.59%.
- The result uses a simple full-position exit without partial or trailing bookkeeping.
- Active selective confirmations: G3 flow.

```json
{
  "atrLenRisk": 2,
  "s1_len": 3,
  "s1_maxAge": 26,
  "volMultMin": 1.1,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 5,
  "rrSwingLb": 4,
  "rrBufAtr": 4,
  "rrRatio": 1,
  "rrUsePartialTp": false,
  "rrUseTrailSl": false,
  "rrTrailPct": 4,
  "useG1": false,
  "g1_mult": 2.5,
  "useS4": false,
  "s4_mult": 2,
  "useS5": false
}
```

## ALLOUSDT — BALANCED PAPER CANDIDATE

- Per-entry win rate held at 46.3% IS and 41.2% OOS (95% conservative floor 33.3%).
- The weaker side retained 3.52% net and PF 1.13; worst drawdown was 7.69%.
- The result uses a simple full-position exit without partial or trailing bookkeeping.
- Active selective confirmations: G1 momentum, S4 structure.

```json
{
  "atrLenRisk": 4,
  "s1_len": 2,
  "s1_maxAge": 40,
  "volMultMin": 0.3,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 4,
  "rrSwingLb": 8,
  "rrBufAtr": 0.5,
  "rrRatio": 1.5,
  "rrUsePartialTp": false,
  "rrUseTrailSl": false,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 1.5,
  "useS4": true,
  "s4_mult": 4,
  "useS5": false
}
```

## KAITOUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Per-entry win rate held at 56.2% IS and 61.7% OOS (95% conservative floor 48.1%).
- The weaker side retained 2.94% net and PF 1.47; worst drawdown was 2.87%.
- Exit behavior uses partial profit-taking and a 0.8% trailing stop.
- Active selective confirmations: G1 momentum, S4 structure.

```json
{
  "atrLenRisk": 8,
  "s1_len": 1,
  "s1_maxAge": 18,
  "volMultMin": 2.5,
  "useG3": false,
  "s6_prox": 12,
  "s6_len": 4,
  "rrSwingLb": 18,
  "rrBufAtr": 0.5,
  "rrRatio": 1,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 1.5,
  "useS4": true,
  "s4_mult": 1.5,
  "useS5": false
}
```

## JTOUSDT — BALANCED PAPER CANDIDATE

- Per-entry win rate held at 50.4% IS and 55.6% OOS (95% conservative floor 41.5%).
- The weaker side retained 1.27% net and PF 1.11; worst drawdown was 2.84%.
- Exit behavior uses partial profit-taking and a 4% trailing stop.
- Active selective confirmations: G1 momentum, S4 structure, S5 structure.

```json
{
  "atrLenRisk": 20,
  "s1_len": 2,
  "s1_maxAge": 40,
  "volMultMin": 0.7,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 5,
  "rrSwingLb": 20,
  "rrBufAtr": 1,
  "rrRatio": 1,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 4,
  "useG1": true,
  "g1_mult": 3,
  "useS4": true,
  "s4_mult": 1.5,
  "useS5": true
}
```

## TAOUSDT — NO LIVE CONFIG — BEST DIAGNOSTIC ONLY

- Per-entry win rate held at 30.0% IS and 28.7% OOS (95% conservative floor 20.3%).
- The weaker side retained 0.82% net and PF 1.04; worst drawdown was 5.12%.
- The result uses a simple full-position exit without partial or trailing bookkeeping.
- Active selective confirmations: S5 structure.

```json
{
  "atrLenRisk": 16,
  "s1_len": 1,
  "s1_maxAge": 34,
  "volMultMin": 2.5,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 3,
  "rrSwingLb": 18,
  "rrBufAtr": 1,
  "rrRatio": 3,
  "rrUsePartialTp": false,
  "rrUseTrailSl": false,
  "rrTrailPct": 0.8,
  "useG1": false,
  "g1_mult": 2.5,
  "useS4": false,
  "s4_mult": 4,
  "useS5": true
}
```

## PUMPUSDT — HIGH-WR FORWARD-TEST CANDIDATE

- Per-entry win rate held at 62.0% IS and 61.1% OOS (95% conservative floor 49.6%).
- The weaker side retained 1.53% net and PF 1.31; worst drawdown was 2.51%.
- Exit behavior uses partial profit-taking and a 2.5% trailing stop.
- Active selective confirmations: G1 momentum, G3 flow, S4 structure.

```json
{
  "atrLenRisk": 12,
  "s1_len": 2,
  "s1_maxAge": 40,
  "volMultMin": 1.4,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 10,
  "rrSwingLb": 18,
  "rrBufAtr": 1.8,
  "rrRatio": 1,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 2.5,
  "useG1": true,
  "g1_mult": 1.5,
  "useS4": true,
  "s4_mult": 4,
  "useS5": false
}
```

## JSTUSDT — BALANCED PAPER CANDIDATE

- Per-entry win rate held at 43.6% IS and 49.3% OOS (95% conservative floor 35.6%).
- The weaker side retained 2.74% net and PF 1.29; worst drawdown was 1.85%.
- Exit behavior uses a 1.5% trailing stop.
- Active selective confirmations: S5 structure.

```json
{
  "atrLenRisk": 2,
  "s1_len": 2,
  "s1_maxAge": 26,
  "volMultMin": 0.7,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 5,
  "rrSwingLb": 8,
  "rrBufAtr": 4,
  "rrRatio": 5,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 1.5,
  "useG1": false,
  "g1_mult": 3,
  "useS4": false,
  "s4_mult": 2.5,
  "useS5": true
}
```
