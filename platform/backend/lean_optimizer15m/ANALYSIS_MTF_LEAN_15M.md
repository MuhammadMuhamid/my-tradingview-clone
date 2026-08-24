# MTF Confluence Lean — 15m System Deep Analysis

Read-only review of `platform/backend/lean_optimizer15m` (the "lean15m-results" tree), the strategy module `src/engine/strategies/mtf_lean/`, and the current leaderboard. Nothing in the running optimizer or the strategy code was modified.

**Run state at time of analysis:** ~11,950 evaluations per coin across 19 coins (~227k total), window **2025-08-11 → 2026-07-30** (≈11.6 months), 15m chart, $1,000 start, 0.1%/side commission, **0 slippage**. Objective: `score = net% − 2.5×|dd%| − 0` with `min_trades: 50`, trades counted as distinct **entries**.

---

## 1. What the strategy actually does

### Entry — a pure AND conjunction

`signals.ts:494-502` combines everything with logical AND. There is no scoring, weighting, or "k of n" voting:

```
gatesOk  = (!useG1 || G1) && (!useG2 || G2) && (!useG3 || G3) && (!useG4 || G4)
structOk = (!useS1 || S1) && (!useS4 || S4) && (!useS5 || S5) && (!useS6 || S6) && (!useS7 || S7)
longSetup = long_en && gatesOk && structOk && volOk && hhOk && bodyOk && primaryFired
```

| Component | What it tests | TF | State |
|---|---|---|---|
| **G1** Supertrend regime | Supertrend(10, 3.0) is bullish | 15m | **fixed ON** |
| **G2** RSI regime | RSI(50) > 50 and ≤ 100 | 15m | **fixed ON** |
| **G3** VFI regime | Volume Flow Index(130) > 0, warmed up | 15m | searched on/off |
| **G4** SR support | price ≥ SR support box bottom − 1×ATR | 15m | searched on/off |
| **S1** Liquidity sweep | a sweep low exists, age ≤ `s1_maxAge` | 15m | **fixed ON** |
| **S4** Supertrend structure | Supertrend(10, 3.0) bullish | **5m** | **fixed ON** |
| **S5** Pivot Point Supertrend | PP-Supertrend bullish | 15m | **fixed ON** |
| **S6** Sellside liquidity | price above level, within `s6_prox`×ATR | 15m | searched on/off |
| **S7** Pivot low | price > pivot low | 15m | fixed OFF |
| **Volume** | vol ≥ `volMultMin` × SMA(volMaLen) | 15m | **fixed ON** |
| **HH structure** | last higher-high > prior | 1m | fixed OFF |
| **Body filter** | bearish body ≤ `entryBodyAtrMult`×ATR | chart | **fixed ON** |
| **Trigger** (BB reclaim / ST) | entry timing pattern | — | fixed OFF |

So **seven conditions are always required** (G1, G2, S1, S4, S5, volume, body) and three more are searchable.

### Risk and exits (`index.ts:109-183`)

```
plannedStop = MIN( swingLow(rrSwingLb) − rrBufAtr×ATR ,  close − minSlDistAtr×ATR )
R           = entry − plannedStop
TP3         = entry + R × rrRatio
```

`MIN` takes the **wider** of the two stops. Optional layers: break-even lift after `rrBeAfterR`, a % trailing ratchet, and partial TPs at **fixed price percentages** (`rrTp1Pct`, `rrTp2Pct`) — not R multiples.

**All signal exits are disabled**: `exitOnG1Flip`, `exitOnS4Flip`, `maxBarsTrade`, `useHlBreakExit` are all fixed false. A position rides to TP, stop, or trail — never to a regime flip.

---

## 2. Current results, and what they actually say

| Coin | Net % | DD % | Win% | Entries | PF | Size % | %configs profitable | Spike |
|---|---|---|---|---|---|---|---|---|
| DEXEUSDT | 4142 | 29.2 | 78.2 | 133 | 5.31 | 100 | **93.9** | **1.54** |
| ZECUSDT | 2444 | 49.8 | 42.9 | 56 | 1.90 | 100 | **88.3** | 1.74 |
| SYNUSDT | 885 | 63.5 | 49.2 | 63 | 2.22 | 80 | 55.1 | 3.36 |
| 币安人生USDT | 811 | 41.0 | 80.2 | 126 | 2.44 | 100 | **91.8** | **1.25** |
| RIFUSDT | 198 | 27.7 | 97.5 | 213 | 2.20 | 100 | 64.8 | 2.27 |
| KAITOUSDT | 134 | 18.2 | 28.4 | 81 | 2.00 | 60 | 73.9 | 3.19 |
| JSTUSDT | 109 | 9.9 | 89.1 | 190 | 1.63 | 80 | **85.8** | **1.25** |
| PUMPUSDT | 74 | 14.8 | 94.5 | 114 | 2.05 | 100 | 41.8 | 2.53 |
| TAOUSDT | 57 | 15.5 | 39.7 | 68 | 1.54 | 80 | 29.9 | 3.76 |
| MORPHOUSDT | 53 | 14.4 | 93.7 | 61 | 1.50 | 60 | 23.1 | **30.05** |
| INJUSDT | 51 | 12.4 | 94.1 | 69 | 1.71 | 60 | 29.9 | 9.89 |
| JUPUSDT | 41 | 8.1 | 98.4 | 63 | 3.45 | 100 | 33.3 | 7.90 |
| TIAUSDT | 34 | 10.0 | 84.2 | 67 | 1.55 | 100 | 28.8 | 8.94 |
| ALLOUSDT | 32 | 7.2 | 28.9 | 52 | 2.22 | 15 | 61.4 | 3.00 |
| NEAR / ENA / JTO / EIGEN / PYTH | 2–8 | <3 | — | 62–205 | — | 10 | 13.7–39.8 | — |

Only **four coins have genuine search-space support**: DEXE (93.9% of all configs profitable, spike 1.54), 币安人生 (91.8%, 1.25), ZEC (88.3%, 1.74), JST (85.8%, 1.25). Everything below RIF is thin — MORPHO's best config is **30× the median of its own top 50**, which is the signature of a single lucky sample, and INJ (9.89), TIA (8.94), JUP (7.90) are not much better.

---

## 3. What is good about this strategy

**1. The multi-timeframe plumbing is correct and repaint-safe.** `signals.ts:66` applies `lookahead_off` semantics and, with `htfClosed: true`, shifts every HTF series by one bar before merging. This is the single most common way MTF strategies produce fake backtests, and yours does not have it.

**2. It is conceptually well-rounded.** Trend (Supertrend), momentum (RSI), volume flow (VFI), *location* (SR support box), and liquidity (sweep, sellside) — five genuinely different families. Most retail strategies stack three variations of the same momentum idea. The intent here is sound.

**3. Risk is defined by structure, not by a fixed percentage.** The stop sits under a real swing low with an ATR buffer. That is the right way to place a stop.

**4. The objective has already been hardened.** `dd_weight: 2.5` and `min_trades: 50` came from your earlier 618k-eval analysis, and the comment shows you diagnosed the exact failure — 8-to-19-trade flukes with PF 73. Counting `trades` as distinct entries so partial TPs cannot game the gate (`evalWorker.ts:106`) is a genuinely good catch.

**5. Long-only plus regime gates means it goes flat in downtrends** rather than fighting them — the same protective property the MA+R:R walk-forward measured at 11% downside capture.

**6. The module structure supports ablation.** Every filter has a toggle, so you can measure each one's contribution. Most of this analysis was only possible because of that.

---

## 4. What is wrong

### 4.1 Position size is in the search space — this invalidates the ranking

`qty_pct_equity` is a **searched parameter** with values `[10, 15, 25, 40, 60, 80, 100]`, and the objective is net-based. So the GA is optimising leverage alongside strategy logic.

- Correlation between position size and log net% across the 19 leaderboard winners: **+0.78**
- DEXE's **top 200 configs by score are 100% at `qty_pct_equity=100`** — all 200, unanimously — out of an eval pool where only 51% used size 100.
- Every coin at the bottom of the board (NEAR, ENA, JTO, EIGEN, PYTH: 2–8% net) is sized at **10%**.

The leaderboard is substantially ranking **how much leverage a config was assigned**, not how good its edge is. DEXE at 4142% and NEAR at 8% are not 500× apart in quality; they are 10× apart in position size before anything else is considered.

### 4.2 Partial take-profits cascade, and the reported win rates are per-leg

`index.ts:173-179` re-arms the TP legs every bar using `pos`, the **current** position, rather than the original fill quantity (the code comment says it intends "absolute fractions of the original fill"). Once price is above `posTp1`, each bar takes another `rrTp1Size%` of what remains — a geometric cascade.

Observed legs per entry:

| Config type | Legs / entry | Reported win rate |
|---|---|---|
| Partial TP **off** (7 coins) | exactly **1.0** | 28–80% (honest) |
| Partial TP **on** (12 coins) | **3.1 – 35.1** | 84–98% (inflated) |

RIFUSDT: 213 entries → **3,921 closed legs**. Its "97.5% win rate" is the fraction of *legs* that were profitable, not trades. Same for JUP (98.4%, 33 legs/entry), EIGEN (96.8%, 35), PYTH (96.9%, 15), INJ (94.1%, 19).

Reconstructing the economics from PF and leg counts, these configs have an average win/average loss ratio of **0.05 to 0.3** — RIF's average winning leg is ~$17 against an average loss of ~$329. That is a pick-up-pennies profile: about 19 wins to fund one loss. It has not blown up in-sample, but that is the shape of a distribution whose tail hasn't arrived yet.

Note the top four performers all have partial TP **off**, so the headline results are not contaminated — but the win rates and PFs shown for the other twelve coins are not comparable to them.

### 4.3 Three of the always-on filters are redundant with each other

G1 (Supertrend 10/3.0 on 15m), S4 (Supertrend 10/3.0 on **5m**), and S5 (Pivot Point Supertrend on 15m) are three variants of the same indicator. They are highly correlated by construction. They multiply selectivity without adding independent information — you pay in signal count and in three sets of parameters, and you buy very little.

### 4.4 The AND-conjunction makes the system brittle and starves it of trades

Seven always-on conditions plus up to three more, all ANDed. If each is independently true ~50% of the time, the joint probability is under 1%. Over ~33,000 15m bars in the window you get **52–213 entries**. Any single filter being slightly mis-tuned collapses the whole thing to zero trades, and no filter can ever compensate for another.

The word "confluence" implies weighing evidence. This is a veto chain.

### 4.5 The search has barely begun

30 tunable parameters give a space of **8.7 × 10²³** combinations. At 11,950 evaluations per coin you have sampled **1.4 × 10⁻²⁰** of it. The GA has had roughly 850 generations at population 14 — enough for local hill-climbing, nowhere near enough to characterise the space. Current results are a small sample plus a little local search, which is exactly why the spike ratios on the thin coins are 8–30.

### 4.6 Filters the optimizer is already rejecting

- **S6 (sellside liquidity) is switched OFF in 18 of 19 winners.** The only coin keeping it is PYTH — the worst on the board at 2% net.
- **The volume filter is being neutered**: `volMultMin` in the top four is 1.1, 0.7, 0.5, 0.7. At 0.5–0.7× the moving average the condition is true almost always. The optimizer is paying to turn it off.
- **G3 (VFI) is off in three of the top four.**

The search is telling you these components do not earn their place.

### 4.7 Risk settings that will not survive contact

`minSlDistAtr` is searchable up to **10 ATR**. Combined with `qty_pct_equity: 100`, a single stop-out at 10 ATR is catastrophic. The top four sit at 5.0, 5.0, 6.5, 2.5 ATR — DEXE's reconstructed average loss is roughly **33% of the position**. The 29.2% drawdown looks survivable only because equity grew ~40× while losses stayed proportional; early in the sequence those same losses were near-account-ending.

### 4.8 The usual two

**Zero slippage** on a 15m system, and **no walk-forward validation**. The MA+R:R walk-forward I ran on the other strategy showed 99% of an apparently strong in-sample edge evaporating out-of-sample, with win rate falling 68% → 44%. There is no reason to assume this system is different until tested.

---

## 5. Recommendations

### Tier 1 — fix the measurement before changing the strategy

**1. Remove `qty_pct_equity` from the search space.** Fix it at a single value (25% is a reasonable default) in `base_params.json`. Position sizing is a capital-allocation decision, not a strategy parameter, and leaving it searchable means your objective rewards leverage. This one change will re-order the leaderboard substantially and is the highest-value edit in this list.

**2. Report per-entry win rate and profit factor**, by aggregating closed legs on `entryBar` before computing metrics — the same grouping `evalWorker.ts:106` already uses for the trade count. Until then, treat every win rate above ~85% on the board as an artifact.

**3. Either fix the partial-TP quantity basis or disable partial TP during search.** Sizing each leg off the original fill quantity rather than the current position would stop the cascade. Disabling it (`rrUsePartialTp: false`, removed from the grid) is the zero-risk option and costs you nothing — no top-four config uses it.

**4. Add `slippageTicks: 2`** to `config.json`. On a 15m system with 50–200 trades this matters.

**5. Walk-forward it before trusting any of it.** The harness in `optimizer1y1h_wf/` is strategy-agnostic apart from the module import — pointing it at `mtf_lean` is a config copy plus one import swap. Given what it just revealed about MA+R:R, this is the highest-information thing you can do with the compute.

### Tier 2 — structural changes to raise trade count and robustness

**6. Replace the AND chain with a k-of-n score.** Count how many gates pass and require `score ≥ k`, with `k` searched:

```
gateScore = G1 + G2 + G3 + G4 + S1 + S4 + S5 + S6
longSetup = gateScore >= k   (k searched over 4..8)
```

This is the single biggest structural improvement available. It converts a brittle veto chain into a genuine confluence measure, lifts trade counts from ~100 toward ~500 (which is where statistics start to mean something), and lets a strong signal survive one filter disagreeing.

**7. Cut two of the three Supertrends.** Keep G1 (15m) as the regime gate, make S4 and S5 searchable on/off instead of fixed on, and expect the search to drop at least one. Replace the freed slot with something orthogonal — a higher-timeframe trend (1h or 4h Supertrend/EMA) would add real information; a third Supertrend does not.

**8. Default S6 off and remove it from the grid** — the optimizer has already rejected it 18 times out of 19. That frees search budget for parameters that matter.

**9. Make partial TPs R-based** (`0.5R`, `1.0R`) rather than fixed price percentages. A fixed 1.2% TP1 means completely different things on a coin with 0.4% ATR versus 3% ATR, so the parameter cannot generalise across your universe.

**10. Enable `exitOnG1Flip` as a searched option.** The premise of the strategy is that G1 defines a tradeable regime. Not exiting when that regime ends is internally inconsistent — currently a position taken in a bull regime rides all the way to a wide stop through a confirmed trend reversal.

### Tier 3 — profit and risk

**11. Cap `minSlDistAtr` at ~3.0.** Ten-ATR stops with meaningful position size are the largest tail risk in the system and they distort R, which distorts every R-based target downstream.

**12. Favour trailing exits over fixed R targets for the winners.** The MA+R:R walk-forward measured **6.4% upside capture** against underlying moves averaging 88% — fixed TPs at 1–2.5R systematically cap the trades that should pay for everything else. Your top config (DEXE) already uses `rrUseTrailSl` with `rrRatio: 1`, which is the right shape: take the structural exit, let the trail run. Consider making the trail **ATR-based** rather than a fixed % so it adapts across coins, and test partial-TP-at-1R + trail-the-rest as the default archetype.

**13. Trade only the four coins with search-space support** — DEXE, 币安人生, ZEC, JST. The other fifteen do not yet have enough evidence to distinguish edge from noise, and five of them (MORPHO, INJ, TIA, JUP, plus SYN at spike 3.36) show active signs of noise-mining.

**14. Let it search much longer before drawing conclusions.** At 12k evals you are 20 orders of magnitude from covering the space. The MA+R:R tree ran 300k–450k per coin, and its convergence curve only flattened after ~50k. Expect the current leaderboard to change materially.

---

## 6. If you only do three things

1. **Take position size out of the search space** — the leaderboard currently ranks leverage, not edge (§4.1).
2. **Switch the entry from AND-conjunction to k-of-n scoring** — this is the change most likely to turn a brittle, trade-starved system into a robust one (§5.6).
3. **Walk-forward it** — everything above is in-sample, and the other strategy just showed what that is worth (§5.5).

The core idea here is better than MA+R:R: it is genuinely multi-factor, the MTF handling is correct, and the SR-location and liquidity-sweep components are the kind of orthogonal information that momentum stacks lack. The problems are in measurement and combination logic, and both are fixable without touching the underlying premise.
