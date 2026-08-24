# MTF Confluence Lean — provisional live-candidate audit

<!-- doc-status -->
> **HISTORICAL — a dated analysis artifact.** Produced on the date in this
> file's name from the optimizer results as they stood then. The underlying
> result data is gitignored and absent from clones (`OPT-08`), so nothing here
> is reproducible from source. Configurations named here were selected under
> the procedure recorded as `OPT-01` (the out-of-sample window was itself
> maximised over), so IS/OOS agreement in these tables is a selection artefact,
> not evidence of robustness. Do not deploy from this document.

**Important:** these are not promises of future profit. The OOS window has now been used as a selection veto, so it is no longer untouched. Every candidate must pass a later forward/paper-trading window before real money.

## 5m system

| Coin | Verdict | IS net/DD/PF/trades | OOS net/DD/PF/trades | Held breadth | IS rank |
|---|---|---:|---:|---:|---:|
| DEXEUSDT | STRONG PAPER CANDIDATE | 6.8/1.4/1.63/136 | 8.5/1.8/1.61/142 | 35.1% (22,880) | 3 |
| SYNUSDT | PAPER CANDIDATE | 4.2/2.1/1.51/112 | 7.9/3.5/1.48/162 | 2.5% (963) | 1 |
| 币安人生USDT | NO LIVE CONFIG | — | — | 0.0% (0) | — |
| ZECUSDT | STRONG PAPER CANDIDATE | 25.9/3.1/1.92/119 | 4.8/5.8/1.48/54 | 86.7% (64,488) | 1 |
| RIFUSDT | NO LIVE CONFIG | — | — | 0.0% (0) | — |
| ALLOUSDT | NO LIVE CONFIG | 3.5/7.7/1.13/108 | 15.0/6.8/1.43/136 | 0.1% (46) | 3,851 |
| NEARUSDT | NO LIVE CONFIG | — | — | 0.0% (0) | — |
| KAITOUSDT | PAPER CANDIDATE | 3.5/2.5/1.28/104 | 3.4/2.4/1.26/103 | 3.2% (1,911) | 11 |
| JTOUSDT | NO LIVE CONFIG | 2.1/2.3/1.17/113 | 3.6/4.0/1.22/165 | 0.5% (255) | 6 |
| TAOUSDT | NO LIVE CONFIG | — | — | 0.0% (1) | — |
| PUMPUSDT | PAPER CANDIDATE | 5.5/1.9/1.46/103 | 1.1/3.8/1.10/89 | 1.3% (784) | 35 |
| EIGENUSDT | NO LIVE CONFIG | — | — | 0.0% (0) | — |
| MORPHOUSDT | NO LIVE CONFIG | — | — | 0.0% (0) | — |
| JSTUSDT | PAPER CANDIDATE | 2.2/0.8/1.44/101 | 0.6/1.2/1.19/48 | 2.9% (1,548) | 60 |
| ENAUSDT | NO LIVE CONFIG | — | — | 0.0% (0) | — |
| JUPUSDT | NO LIVE CONFIG | — | — | 0.0% (0) | — |
| INJUSDT | NO LIVE CONFIG | — | — | 0.0% (0) | — |
| PYTHUSDT | NO LIVE CONFIG | — | — | 0.0% (0) | — |
| TIAUSDT | NO LIVE CONFIG | — | — | 0.0% (0) | — |

### 5m — DEXEUSDT: STRONG PAPER CANDIDATE

IS rank 3; IS 6.83% net / 1.36% DD / PF 1.629 / 136 entries. OOS 8.53% net / 1.78% DD / PF 1.607 / 142 entries.
Survival breadth: 22,880/65,218 (35.1%).

```json
{
  "atrLenRisk": 16,
  "s1_len": 3,
  "s1_maxAge": 40,
  "volMultMin": 1.4,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 3,
  "rrSwingLb": 20,
  "rrBufAtr": 0.5,
  "rrRatio": 2,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 4,
  "useG1": false,
  "g1_mult": 3,
  "useS4": false,
  "s4_mult": 4,
  "useS5": true
}
```

### 5m — SYNUSDT: PAPER CANDIDATE

IS rank 1; IS 4.16% net / 2.14% DD / PF 1.51 / 112 entries. OOS 7.88% net / 3.48% DD / PF 1.478 / 162 entries.
Survival breadth: 963/39,038 (2.5%).

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

### 5m — ZECUSDT: STRONG PAPER CANDIDATE

IS rank 1; IS 25.92% net / 3.06% DD / PF 1.924 / 119 entries. OOS 4.75% net / 5.81% DD / PF 1.478 / 54 entries.
Survival breadth: 64,488/74,409 (86.7%).

```json
{
  "atrLenRisk": 2,
  "s1_len": 3,
  "s1_maxAge": 40,
  "volMultMin": 0.7,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 13,
  "rrSwingLb": 10,
  "rrBufAtr": 0.1,
  "rrRatio": 1.5,
  "rrUsePartialTp": false,
  "rrUseTrailSl": false,
  "rrTrailPct": 4,
  "useG1": false,
  "g1_mult": 2,
  "useS4": true,
  "s4_mult": 2,
  "useS5": true
}
```

### 5m — ALLOUSDT: NO LIVE CONFIG

IS rank 3,851; IS 3.52% net / 7.69% DD / PF 1.134 / 108 entries. OOS 14.96% net / 6.75% DD / PF 1.432 / 136 entries.
Survival breadth: 46/49,896 (0.1%).

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

### 5m — KAITOUSDT: PAPER CANDIDATE

IS rank 11; IS 3.51% net / 2.55% DD / PF 1.285 / 104 entries. OOS 3.4% net / 2.43% DD / PF 1.265 / 103 entries.
Survival breadth: 1,911/59,908 (3.2%).

```json
{
  "atrLenRisk": 8,
  "s1_len": 2,
  "s1_maxAge": 18,
  "volMultMin": 1.1,
  "useG3": false,
  "s6_prox": 8,
  "s6_len": 4,
  "rrSwingLb": 4,
  "rrBufAtr": 0.5,
  "rrRatio": 2,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 4,
  "useG1": true,
  "g1_mult": 4,
  "useS4": true,
  "s4_mult": 2.5,
  "useS5": false
}
```

### 5m — JTOUSDT: NO LIVE CONFIG

IS rank 6; IS 2.09% net / 2.33% DD / PF 1.167 / 113 entries. OOS 3.6% net / 3.98% DD / PF 1.215 / 165 entries.
Survival breadth: 255/54,372 (0.5%).

```json
{
  "atrLenRisk": 16,
  "s1_len": 3,
  "s1_maxAge": 40,
  "volMultMin": 1.4,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 5,
  "rrSwingLb": 8,
  "rrBufAtr": 1,
  "rrRatio": 2,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 2.5,
  "useG1": false,
  "g1_mult": 2.5,
  "useS4": true,
  "s4_mult": 4,
  "useS5": true
}
```

### 5m — PUMPUSDT: PAPER CANDIDATE

IS rank 35; IS 5.47% net / 1.92% DD / PF 1.464 / 103 entries. OOS 1.07% net / 3.78% DD / PF 1.1 / 89 entries.
Survival breadth: 784/58,125 (1.3%).

```json
{
  "atrLenRisk": 2,
  "s1_len": 2,
  "s1_maxAge": 40,
  "volMultMin": 0.7,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 6,
  "rrSwingLb": 18,
  "rrBufAtr": 1.8,
  "rrRatio": 1,
  "rrUsePartialTp": true,
  "rrUseTrailSl": false,
  "rrTrailPct": 1.5,
  "useG1": true,
  "g1_mult": 4,
  "useS4": false,
  "s4_mult": 2.5,
  "useS5": false
}
```

### 5m — JSTUSDT: PAPER CANDIDATE

IS rank 60; IS 2.18% net / 0.77% DD / PF 1.436 / 101 entries. OOS 0.57% net / 1.19% DD / PF 1.193 / 48 entries.
Survival breadth: 1,548/53,443 (2.9%).

```json
{
  "atrLenRisk": 2,
  "s1_len": 2,
  "s1_maxAge": 34,
  "volMultMin": 1.9,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 10,
  "rrSwingLb": 8,
  "rrBufAtr": 0.1,
  "rrRatio": 3,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 1.5,
  "useG1": false,
  "g1_mult": 3,
  "useS4": false,
  "s4_mult": 4,
  "useS5": true
}
```

## 15m system

| Coin | Verdict | IS net/DD/PF/trades | OOS net/DD/PF/trades | Held breadth | IS rank |
|---|---|---:|---:|---:|---:|
| DEXEUSDT | PAPER CANDIDATE | 10.9/1.3/3.17/59 | 1.9/3.7/1.15/109 | 76.8% (74,759) | 1 |
| SYNUSDT | STRONG PAPER CANDIDATE | 7.9/2.4/1.82/82 | 7.4/4.5/1.34/112 | 16.9% (10,605) | 2 |
| 币安人生USDT | PAPER CANDIDATE | 4.5/1.5/4.50/51 | 4.4/2.6/1.45/134 | 1.3% (876) | 1 |
| ZECUSDT | STRONG PAPER CANDIDATE | 38.3/4.9/3.14/50 | 8.6/6.3/2.30/21 | 85.5% (85,324) | 1 |
| RIFUSDT | NO LIVE CONFIG | — | — | 0.0% (0) | — |
| ALLOUSDT | NO LIVE CONFIG | 3.3/1.7/1.61/53 | 1.5/1.7/1.23/71 | 0.9% (751) | 728 |
| NEARUSDT | NO LIVE CONFIG | 2.1/2.9/1.28/52 | 0.4/3.4/1.05/56 | 0.1% (71) | 679 |
| KAITOUSDT | STRONG PAPER CANDIDATE | 6.9/2.0/1.59/80 | 4.6/2.4/1.48/68 | 23.9% (22,539) | 1 |
| JTOUSDT | PAPER CANDIDATE | 5.0/1.3/2.12/54 | 2.0/1.5/1.32/71 | 8.4% (7,139) | 10 |
| TAOUSDT | NO LIVE CONFIG | 4.9/0.8/4.63/59 | 0.3/2.2/1.05/57 | 0.7% (640) | 15 |
| PUMPUSDT | PAPER CANDIDATE | 7.7/1.4/2.39/58 | 1.2/2.6/1.16/49 | 6.3% (5,310) | 6 |
| EIGENUSDT | NO LIVE CONFIG | 2.0/1.2/1.50/65 | 0.4/2.1/1.06/82 | 0.1% (52) | 178 |
| MORPHOUSDT | NO LIVE CONFIG | — | — | 0.0% (0) | — |
| JSTUSDT | PAPER CANDIDATE | 3.5/0.7/2.18/50 | 0.2/0.9/1.12/20 | 4.9% (4,060) | 201 |
| ENAUSDT | NO LIVE CONFIG | 0.4/1.4/1.11/51 | 0.2/0.8/1.06/37 | 0.0% (2) | 370 |
| JUPUSDT | NO LIVE CONFIG | 1.5/1.1/1.72/50 | 0.8/0.6/1.94/19 | 0.2% (209) | 12 |
| INJUSDT | NO LIVE CONFIG | 3.4/1.7/2.23/56 | 0.3/2.3/1.07/60 | 0.1% (64) | 1 |
| PYTHUSDT | NO LIVE CONFIG | 2.0/1.5/1.59/54 | 0.5/1.1/1.26/35 | 0.0% (19) | 1 |
| TIAUSDT | NO LIVE CONFIG | 1.9/1.1/1.59/52 | 0.5/2.1/1.11/53 | 0.1% (66) | 75 |

### 15m — DEXEUSDT: PAPER CANDIDATE

IS rank 1; IS 10.94% net / 1.34% DD / PF 3.172 / 59 entries. OOS 1.93% net / 3.7% DD / PF 1.154 / 109 entries.
Survival breadth: 74,759/97,306 (76.8%).

```json
{
  "atrLenRisk": 2,
  "s1_len": 2,
  "s1_maxAge": 18,
  "volMultMin": 0.7,
  "useG3": true,
  "s6_prox": 8,
  "s6_len": 3,
  "rrSwingLb": 8,
  "rrBufAtr": 0.5,
  "rrRatio": 2,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 2.5,
  "useG1": false,
  "g1_mult": 2.5,
  "useS4": true,
  "s4_mult": 2,
  "useS5": false
}
```

### 15m — SYNUSDT: STRONG PAPER CANDIDATE

IS rank 2; IS 7.87% net / 2.37% DD / PF 1.821 / 82 entries. OOS 7.42% net / 4.49% DD / PF 1.336 / 112 entries.
Survival breadth: 10,605/62,781 (16.9%).

```json
{
  "atrLenRisk": 16,
  "s1_len": 1,
  "s1_maxAge": 26,
  "volMultMin": 0.7,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 5,
  "rrSwingLb": 14,
  "rrBufAtr": 1,
  "rrRatio": 1.5,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 2.5,
  "useG1": true,
  "g1_mult": 2,
  "useS4": false,
  "s4_mult": 1.5,
  "useS5": false
}
```

### 15m — 币安人生USDT: PAPER CANDIDATE

IS rank 1; IS 4.45% net / 1.48% DD / PF 4.499 / 51 entries. OOS 4.4% net / 2.63% DD / PF 1.447 / 134 entries.
Survival breadth: 876/67,675 (1.3%).

```json
{
  "atrLenRisk": 12,
  "s1_len": 6,
  "s1_maxAge": 40,
  "volMultMin": 0.7,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 3,
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

### 15m — ZECUSDT: STRONG PAPER CANDIDATE

IS rank 1; IS 38.34% net / 4.91% DD / PF 3.137 / 50 entries. OOS 8.59% net / 6.31% DD / PF 2.299 / 21 entries.
Survival breadth: 85,324/99,795 (85.5%).

```json
{
  "atrLenRisk": 8,
  "s1_len": 3,
  "s1_maxAge": 40,
  "volMultMin": 0.3,
  "useG3": false,
  "s6_prox": 12,
  "s6_len": 6,
  "rrSwingLb": 4,
  "rrBufAtr": 0.1,
  "rrRatio": 6,
  "rrUsePartialTp": false,
  "rrUseTrailSl": false,
  "rrTrailPct": 1.5,
  "useG1": false,
  "g1_mult": 2,
  "useS4": false,
  "s4_mult": 1.5,
  "useS5": false
}
```

### 15m — ALLOUSDT: NO LIVE CONFIG

IS rank 728; IS 3.26% net / 1.67% DD / PF 1.614 / 53 entries. OOS 1.51% net / 1.74% DD / PF 1.234 / 71 entries.
Survival breadth: 751/83,562 (0.9%).

```json
{
  "atrLenRisk": 2,
  "s1_len": 12,
  "s1_maxAge": 40,
  "volMultMin": 0.3,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 5,
  "rrSwingLb": 4,
  "rrBufAtr": 2.8,
  "rrRatio": 5,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 1.5,
  "useG1": false,
  "g1_mult": 2.5,
  "useS4": true,
  "s4_mult": 2,
  "useS5": false
}
```

### 15m — NEARUSDT: NO LIVE CONFIG

IS rank 679; IS 2.09% net / 2.87% DD / PF 1.279 / 52 entries. OOS 0.44% net / 3.41% DD / PF 1.05 / 56 entries.
Survival breadth: 71/75,123 (0.1%).

```json
{
  "atrLenRisk": 6,
  "s1_len": 2,
  "s1_maxAge": 40,
  "volMultMin": 1.4,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 8,
  "rrSwingLb": 4,
  "rrBufAtr": 0.1,
  "rrRatio": 1,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 4,
  "useG1": true,
  "g1_mult": 1.5,
  "useS4": true,
  "s4_mult": 1.5,
  "useS5": true
}
```

### 15m — KAITOUSDT: STRONG PAPER CANDIDATE

IS rank 1; IS 6.94% net / 2% DD / PF 1.593 / 80 entries. OOS 4.6% net / 2.38% DD / PF 1.484 / 68 entries.
Survival breadth: 22,539/94,142 (23.9%).

```json
{
  "atrLenRisk": 6,
  "s1_len": 3,
  "s1_maxAge": 18,
  "volMultMin": 0.3,
  "useG3": false,
  "s6_prox": 12,
  "s6_len": 4,
  "rrSwingLb": 4,
  "rrBufAtr": 0.5,
  "rrRatio": 1.5,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 4,
  "useG1": false,
  "g1_mult": 2,
  "useS4": true,
  "s4_mult": 2.5,
  "useS5": true
}
```

### 15m — JTOUSDT: PAPER CANDIDATE

IS rank 10; IS 4.99% net / 1.3% DD / PF 2.121 / 54 entries. OOS 2.04% net / 1.47% DD / PF 1.318 / 71 entries.
Survival breadth: 7,139/84,805 (8.4%).

```json
{
  "atrLenRisk": 2,
  "s1_len": 1,
  "s1_maxAge": 10,
  "volMultMin": 0.3,
  "useG3": false,
  "s6_prox": 12,
  "s6_len": 5,
  "rrSwingLb": 10,
  "rrBufAtr": 0.1,
  "rrRatio": 4,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 2.5,
  "useG1": true,
  "g1_mult": 1.5,
  "useS4": true,
  "s4_mult": 1.5,
  "useS5": true
}
```

### 15m — TAOUSDT: NO LIVE CONFIG

IS rank 15; IS 4.9% net / 0.76% DD / PF 4.63 / 59 entries. OOS 0.26% net / 2.23% DD / PF 1.055 / 57 entries.
Survival breadth: 640/91,086 (0.7%).

```json
{
  "atrLenRisk": 6,
  "s1_len": 1,
  "s1_maxAge": 34,
  "volMultMin": 2.5,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 4,
  "rrSwingLb": 8,
  "rrBufAtr": 4,
  "rrRatio": 1,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": false,
  "g1_mult": 1.5,
  "useS4": true,
  "s4_mult": 4,
  "useS5": true
}
```

### 15m — PUMPUSDT: PAPER CANDIDATE

IS rank 6; IS 7.66% net / 1.45% DD / PF 2.393 / 58 entries. OOS 1.23% net / 2.65% DD / PF 1.16 / 49 entries.
Survival breadth: 5,310/84,550 (6.3%).

```json
{
  "atrLenRisk": 2,
  "s1_len": 2,
  "s1_maxAge": 34,
  "volMultMin": 0.3,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 6,
  "rrSwingLb": 18,
  "rrBufAtr": 1.8,
  "rrRatio": 1,
  "rrUsePartialTp": true,
  "rrUseTrailSl": false,
  "rrTrailPct": 4,
  "useG1": false,
  "g1_mult": 2,
  "useS4": false,
  "s4_mult": 2.5,
  "useS5": false
}
```

### 15m — EIGENUSDT: NO LIVE CONFIG

IS rank 178; IS 1.96% net / 1.22% DD / PF 1.5 / 65 entries. OOS 0.39% net / 2.06% DD / PF 1.061 / 82 entries.
Survival breadth: 52/71,929 (0.1%).

```json
{
  "atrLenRisk": 2,
  "s1_len": 2,
  "s1_maxAge": 34,
  "volMultMin": 0.3,
  "useG3": true,
  "s6_prox": 4,
  "s6_len": 3,
  "rrSwingLb": 10,
  "rrBufAtr": 4,
  "rrRatio": 2.5,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": false,
  "g1_mult": 3,
  "useS4": false,
  "s4_mult": 2,
  "useS5": true
}
```

### 15m — JSTUSDT: PAPER CANDIDATE

IS rank 201; IS 3.48% net / 0.7% DD / PF 2.182 / 50 entries. OOS 0.17% net / 0.89% DD / PF 1.123 / 20 entries.
Survival breadth: 4,060/82,956 (4.9%).

```json
{
  "atrLenRisk": 4,
  "s1_len": 3,
  "s1_maxAge": 40,
  "volMultMin": 1.9,
  "useG3": false,
  "s6_prox": 20,
  "s6_len": 13,
  "rrSwingLb": 10,
  "rrBufAtr": 0.1,
  "rrRatio": 4,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 1.5,
  "useG1": true,
  "g1_mult": 4,
  "useS4": true,
  "s4_mult": 4,
  "useS5": false
}
```

### 15m — ENAUSDT: NO LIVE CONFIG

IS rank 370; IS 0.42% net / 1.37% DD / PF 1.115 / 51 entries. OOS 0.18% net / 0.85% DD / PF 1.063 / 37 entries.
Survival breadth: 2/79,789 (0.0%).

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

### 15m — JUPUSDT: NO LIVE CONFIG

IS rank 12; IS 1.5% net / 1.1% DD / PF 1.72 / 50 entries. OOS 0.78% net / 0.62% DD / PF 1.944 / 19 entries.
Survival breadth: 209/87,104 (0.2%).

```json
{
  "atrLenRisk": 6,
  "s1_len": 6,
  "s1_maxAge": 34,
  "volMultMin": 0.3,
  "useG3": false,
  "s6_prox": 12,
  "s6_len": 13,
  "rrSwingLb": 10,
  "rrBufAtr": 2.8,
  "rrRatio": 2.5,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 2.5,
  "useS4": true,
  "s4_mult": 3,
  "useS5": true
}
```

### 15m — INJUSDT: NO LIVE CONFIG

IS rank 1; IS 3.43% net / 1.74% DD / PF 2.227 / 56 entries. OOS 0.28% net / 2.29% DD / PF 1.072 / 60 entries.
Survival breadth: 64/82,505 (0.1%).

```json
{
  "atrLenRisk": 8,
  "s1_len": 1,
  "s1_maxAge": 40,
  "volMultMin": 1.1,
  "useG3": false,
  "s6_prox": 4,
  "s6_len": 3,
  "rrSwingLb": 20,
  "rrBufAtr": 4,
  "rrRatio": 3,
  "rrUsePartialTp": false,
  "rrUseTrailSl": true,
  "rrTrailPct": 0.8,
  "useG1": true,
  "g1_mult": 1.5,
  "useS4": false,
  "s4_mult": 2.5,
  "useS5": true
}
```

### 15m — PYTHUSDT: NO LIVE CONFIG

IS rank 1; IS 2.01% net / 1.52% DD / PF 1.591 / 54 entries. OOS 0.54% net / 1.05% DD / PF 1.259 / 35 entries.
Survival breadth: 19/71,035 (0.0%).

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

### 15m — TIAUSDT: NO LIVE CONFIG

IS rank 75; IS 1.85% net / 1.05% DD / PF 1.587 / 52 entries. OOS 0.5% net / 2.07% DD / PF 1.114 / 53 entries.
Survival breadth: 66/82,410 (0.1%).

```json
{
  "atrLenRisk": 2,
  "s1_len": 3,
  "s1_maxAge": 26,
  "volMultMin": 1.4,
  "useG3": true,
  "s6_prox": 20,
  "s6_len": 3,
  "rrSwingLb": 14,
  "rrBufAtr": 1,
  "rrRatio": 6,
  "rrUsePartialTp": true,
  "rrUseTrailSl": true,
  "rrTrailPct": 1.5,
  "useG1": true,
  "g1_mult": 3,
  "useS4": false,
  "s4_mult": 4,
  "useS5": true
}
```

