# MA + R:R 15m one-year win-quality audit

<!-- doc-status -->
> **HISTORICAL — a dated analysis artifact.** Produced on the date in this
> file's name from the optimizer results as they stood then. The underlying
> result data is gitignored and absent from clones (`OPT-08`), so nothing here
> is reproducible from source. Configurations named here were selected under
> the procedure recorded as `OPT-01` (the out-of-sample window was itself
> maximised over), so IS/OOS agreement in these tables is a selection artefact,
> not evidence of robustness. Do not deploy from this document.

Generated: 2026-08-22T04:24:19.966714+05:00

**Research shortlist only.** IS and OOS were both used to select these rows, so OOS is no longer independent. Paper/forward-test before risking capital.

Execution model: $10,000 initial capital, $1,000 fixed cash/trade, 0.1% commission/side, 2 ticks slippage.

Search space: 370,440 combinations/coin. Current indexed coverage varies by coin and the optimizer remains live.

| Coin | Verdict | IS net/DD/WR/PF/T | OOS net/DD/WR/PF/T | Conservative WR | Coverage | Orig rank |
|---|---|---:|---:|---:|---:|---:|
| SYNUSDT | BALANCED PAPER CANDIDATE | 12.8/3.0/53.0/2.00/66 | 15.9/5.9/54.0/2.08/37 | 38.4% | 6.7% | 64 |
| 币安人生USDT | NO ROBUST TWO-WINDOW CONFIG | — | — | — | 0.0% | — |
| ALLOUSDT | STRONG PAPER CANDIDATE | 7.2/4.9/66.7/1.43/72 | 11.1/4.9/65.8/1.52/79 | 54.8% | 4.5% | 1,246 |
| DEXEUSDT | BALANCED PAPER CANDIDATE | 11.6/3.8/57.1/1.76/84 | 17.8/4.0/62.8/2.31/51 | 46.5% | 7.0% | 2 |
| RIFUSDT | NO ROBUST TWO-WINDOW CONFIG | — | — | — | 6.2% | — |
| ZECUSDT | STRONG PAPER CANDIDATE | 20.2/3.1/65.4/2.28/78 | 12.0/2.4/71.7/2.49/46 | 54.3% | 7.0% | 592 |
| JTOUSDT | HIGH-WR PAPER CANDIDATE | 2.2/2.8/65.8/1.16/73 | 6.7/2.8/71.7/1.55/60 | 54.3% | 6.8% | 38 |
| NEARUSDT | HIGH-WR PAPER CANDIDATE | 3.8/3.0/60.0/1.31/60 | 3.9/1.6/60.0/1.66/35 | 43.6% | 6.9% | 645 |
| INJUSDT | HIGH-WR PAPER CANDIDATE | 1.6/2.0/61.4/1.16/70 | 2.1/1.9/62.0/1.25/50 | 48.2% | 7.0% | 1 |
| MORPHOUSDT | HIGH-WR PAPER CANDIDATE | 2.6/3.1/65.4/1.26/52 | 2.4/2.5/65.5/1.28/55 | 51.8% | 4.9% | 2,780 |
| KAITOUSDT | BALANCED PAPER CANDIDATE | 4.0/4.0/55.6/1.20/90 | 3.5/5.2/59.1/1.23/71 | 45.3% | 6.8% | 57 |
| EIGENUSDT | DIAGNOSTIC ONLY — GATES FAILED | 0.4/5.6/56.9/1.02/65 | 0.4/4.3/58.5/1.03/53 | 44.8% | 6.6% | 732 |
| TAOUSDT | HIGH-WR PAPER CANDIDATE | 2.6/2.4/61.1/1.25/54 | 2.8/2.0/63.2/1.42/38 | 47.3% | 6.6% | 584 |
| JUPUSDT | BALANCED PAPER CANDIDATE | 2.4/2.6/53.2/1.18/62 | 2.1/2.5/52.4/1.23/42 | 37.7% | 7.0% | 111 |
| JSTUSDT | STRONG PAPER CANDIDATE | 4.4/1.5/60.0/1.47/105 | 5.0/1.7/63.3/1.89/60 | 50.4% | 7.0% | 13 |
| ENAUSDT | BALANCED PAPER CANDIDATE | 3.0/5.7/58.8/1.24/51 | 2.0/2.5/57.6/1.30/33 | 40.8% | 6.4% | 1,857 |
| PUMPUSDT | HIGH-WR PAPER CANDIDATE | 3.4/4.2/61.8/1.20/68 | 3.3/3.2/67.3/1.41/49 | 49.9% | 6.6% | 149 |

## SYNUSDT — BALANCED PAPER CANDIDATE

- WR 53.0% IS / 54.0% OOS; weaker 95% Wilson floor 38.4%.
- Weaker PF 2.00, weaker net 12.79%, worst DD 5.94%.
- 53 eligible rows sit within 3 quality points of the winner; this is a broader plateau.

Tuned inputs:

```json
{
  "ma1_slopeLb": 50,
  "volMaLen": 20,
  "volMultMin": 1.3,
  "hhPivotLen": 16,
  "rrRatio": 2.5,
  "runMaxPct": 18,
  "hlBreakPivLen": 10,
  "useSuperTrend": false
}
```

## ALLOUSDT — STRONG PAPER CANDIDATE

- WR 66.7% IS / 65.8% OOS; weaker 95% Wilson floor 54.8%.
- Weaker PF 1.43, weaker net 7.15%, worst DD 4.93%.
- 77 eligible rows sit within 3 quality points of the winner; this is a broader plateau.

Tuned inputs:

```json
{
  "ma1_slopeLb": 50,
  "volMaLen": 50,
  "volMultMin": 0.4,
  "hhPivotLen": 10,
  "rrRatio": 0.75,
  "runMaxPct": 13,
  "hlBreakPivLen": 10,
  "useSuperTrend": false
}
```

## DEXEUSDT — BALANCED PAPER CANDIDATE

- WR 57.1% IS / 62.8% OOS; weaker 95% Wilson floor 46.5%.
- Weaker PF 1.76, weaker net 11.56%, worst DD 3.95%.
- 251 eligible rows sit within 3 quality points of the winner; this is a broader plateau.

Tuned inputs:

```json
{
  "ma1_slopeLb": 50,
  "volMaLen": 50,
  "volMultMin": 0.2,
  "hhPivotLen": 8,
  "rrRatio": 2,
  "runMaxPct": 25,
  "hlBreakPivLen": 10,
  "useSuperTrend": true
}
```

## ZECUSDT — STRONG PAPER CANDIDATE

- WR 65.4% IS / 71.7% OOS; weaker 95% Wilson floor 54.3%.
- Weaker PF 2.28, weaker net 12.02%, worst DD 3.15%.
- 24 eligible rows sit within 3 quality points of the winner; this is a broader plateau.

Tuned inputs:

```json
{
  "ma1_slopeLb": 50,
  "volMaLen": 100,
  "volMultMin": 2,
  "hhPivotLen": 6,
  "rrRatio": 1.5,
  "runMaxPct": 19,
  "hlBreakPivLen": 10,
  "useSuperTrend": false
}
```

## JTOUSDT — HIGH-WR PAPER CANDIDATE

- WR 65.8% IS / 71.7% OOS; weaker 95% Wilson floor 54.3%.
- Weaker PF 1.16, weaker net 2.20%, worst DD 2.79%.
- 45 eligible rows sit within 3 quality points of the winner; this is a broader plateau.

Tuned inputs:

```json
{
  "ma1_slopeLb": 5,
  "volMaLen": 20,
  "volMultMin": 1.6,
  "hhPivotLen": 6,
  "rrRatio": 0.75,
  "runMaxPct": 13,
  "hlBreakPivLen": 12,
  "useSuperTrend": true
}
```

## NEARUSDT — HIGH-WR PAPER CANDIDATE

- WR 60.0% IS / 60.0% OOS; weaker 95% Wilson floor 43.6%.
- Weaker PF 1.31, weaker net 3.76%, worst DD 3.00%.
- 109 eligible rows sit within 3 quality points of the winner; this is a broader plateau.

Tuned inputs:

```json
{
  "ma1_slopeLb": 15,
  "volMaLen": 20,
  "volMultMin": 1.6,
  "hhPivotLen": 16,
  "rrRatio": 2.5,
  "runMaxPct": 19,
  "hlBreakPivLen": 9,
  "useSuperTrend": true
}
```

## INJUSDT — HIGH-WR PAPER CANDIDATE

- WR 61.4% IS / 62.0% OOS; weaker 95% Wilson floor 48.2%.
- Weaker PF 1.16, weaker net 1.56%, worst DD 2.00%.
- 1 eligible rows sit within 3 quality points of the winner; this is a narrow result requiring extra caution.

Tuned inputs:

```json
{
  "ma1_slopeLb": 10,
  "volMaLen": 20,
  "volMultMin": 2,
  "hhPivotLen": 16,
  "rrRatio": 0.75,
  "runMaxPct": 10,
  "hlBreakPivLen": 12,
  "useSuperTrend": false
}
```

## MORPHOUSDT — HIGH-WR PAPER CANDIDATE

- WR 65.4% IS / 65.5% OOS; weaker 95% Wilson floor 51.8%.
- Weaker PF 1.26, weaker net 2.39%, worst DD 3.15%.
- 1 eligible rows sit within 3 quality points of the winner; this is a narrow result requiring extra caution.

Tuned inputs:

```json
{
  "ma1_slopeLb": 50,
  "volMaLen": 50,
  "volMultMin": 2,
  "hhPivotLen": 10,
  "rrRatio": 0.75,
  "runMaxPct": 19,
  "hlBreakPivLen": 12,
  "useSuperTrend": false
}
```

## KAITOUSDT — BALANCED PAPER CANDIDATE

- WR 55.6% IS / 59.1% OOS; weaker 95% Wilson floor 45.3%.
- Weaker PF 1.20, weaker net 3.52%, worst DD 5.18%.
- 16 eligible rows sit within 3 quality points of the winner; this is a broader plateau.

Tuned inputs:

```json
{
  "ma1_slopeLb": 50,
  "volMaLen": 20,
  "volMultMin": 1.5,
  "hhPivotLen": 10,
  "rrRatio": 1,
  "runMaxPct": 17,
  "hlBreakPivLen": 15,
  "useSuperTrend": false
}
```

## EIGENUSDT — DIAGNOSTIC ONLY — GATES FAILED

- WR 56.9% IS / 58.5% OOS; weaker 95% Wilson floor 44.8%.
- Weaker PF 1.02, weaker net 0.41%, worst DD 5.57%.
- 2 eligible rows sit within 3 quality points of the winner; this is a narrow result requiring extra caution.

Tuned inputs:

```json
{
  "ma1_slopeLb": 50,
  "volMaLen": 100,
  "volMultMin": 1.5,
  "hhPivotLen": 6,
  "rrRatio": 1,
  "runMaxPct": 10,
  "hlBreakPivLen": 30,
  "useSuperTrend": true
}
```

## TAOUSDT — HIGH-WR PAPER CANDIDATE

- WR 61.1% IS / 63.2% OOS; weaker 95% Wilson floor 47.3%.
- Weaker PF 1.25, weaker net 2.60%, worst DD 2.38%.
- 6 eligible rows sit within 3 quality points of the winner; this is a narrow result requiring extra caution.

Tuned inputs:

```json
{
  "ma1_slopeLb": 10,
  "volMaLen": 100,
  "volMultMin": 1.3,
  "hhPivotLen": 25,
  "rrRatio": 2,
  "runMaxPct": 10,
  "hlBreakPivLen": 9,
  "useSuperTrend": true
}
```

## JUPUSDT — BALANCED PAPER CANDIDATE

- WR 53.2% IS / 52.4% OOS; weaker 95% Wilson floor 37.7%.
- Weaker PF 1.18, weaker net 2.11%, worst DD 2.63%.
- 33 eligible rows sit within 3 quality points of the winner; this is a broader plateau.

Tuned inputs:

```json
{
  "ma1_slopeLb": 20,
  "volMaLen": 20,
  "volMultMin": 1.3,
  "hhPivotLen": 14,
  "rrRatio": 1.5,
  "runMaxPct": 19,
  "hlBreakPivLen": 30,
  "useSuperTrend": true
}
```

## JSTUSDT — STRONG PAPER CANDIDATE

- WR 60.0% IS / 63.3% OOS; weaker 95% Wilson floor 50.4%.
- Weaker PF 1.47, weaker net 4.36%, worst DD 1.72%.
- 18 eligible rows sit within 3 quality points of the winner; this is a broader plateau.

Tuned inputs:

```json
{
  "ma1_slopeLb": 5,
  "volMaLen": 100,
  "volMultMin": 1,
  "hhPivotLen": 8,
  "rrRatio": 2.5,
  "runMaxPct": 10,
  "hlBreakPivLen": 30,
  "useSuperTrend": false
}
```

## ENAUSDT — BALANCED PAPER CANDIDATE

- WR 58.8% IS / 57.6% OOS; weaker 95% Wilson floor 40.8%.
- Weaker PF 1.24, weaker net 2.02%, worst DD 5.68%.
- 11 eligible rows sit within 3 quality points of the winner; this is a broader plateau.

Tuned inputs:

```json
{
  "ma1_slopeLb": 5,
  "volMaLen": 50,
  "volMultMin": 1.6,
  "hhPivotLen": 14,
  "rrRatio": 1.5,
  "runMaxPct": 13,
  "hlBreakPivLen": 15,
  "useSuperTrend": true
}
```

## PUMPUSDT — HIGH-WR PAPER CANDIDATE

- WR 61.8% IS / 67.3% OOS; weaker 95% Wilson floor 49.9%.
- Weaker PF 1.20, weaker net 3.29%, worst DD 4.24%.
- 48 eligible rows sit within 3 quality points of the winner; this is a broader plateau.

Tuned inputs:

```json
{
  "ma1_slopeLb": 20,
  "volMaLen": 20,
  "volMultMin": 2,
  "hhPivotLen": 14,
  "rrRatio": 0.75,
  "runMaxPct": 25,
  "hlBreakPivLen": 15,
  "useSuperTrend": false
}
```
