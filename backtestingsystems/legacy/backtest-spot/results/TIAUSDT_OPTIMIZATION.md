# TIAUSDT 5m optimization (2026-04-16 → 2026-05-16)

**4,000 combinations** | Local sim (confirm on TradingView)

## Locked (your last 4 screenshot groups — unchanged)
- **MA:** TF1 1m×200, TF3 1h×400, SMA, block-when-na OFF
- **SuperTrend:** 5m, ATR 15, mult 2.5
- **LinReg:** 5m, length **9**, signal 11, EMA
- **VWMA:** 4h×200
- **Exit MA:** 4h×100 SMA, long exit ON (Pine only — not in Python sim)

## Best profit (applied to Pine defaults)
| Metric | Sim | Your TV baseline |
|--------|-----|------------------|
| Net | **+34.0%** | +42.0% |
| Trades | 42 | 33 |
| Win rate | 42.9% | **60.6%** |
| Profit factor | 2.09 | **2.58** |

## Optimized S/R + risk (now Pine defaults)
| Input | Value |
|--------|-------|
| touchAtrMult | 0.85 |
| pivLen5 / 15 / 60 / 240 | 13 / 15 / 7 / 5 |
| retestConfirmBars | 12 |
| priorAboveLb | 7 |
| atrLenExit | 7 |
| slAtrMult | 0.8 |
| structBuff | 2.0 |
| tpR | 1.75 |
| trailTriggerR | 2.0 |
| trailAtrMult | 0.6 |
| minSlDistAtr | 0.15 |

Also restored your other TIA inputs: cooldown 10, requireBounce ON, reclaim 0.5, HTF break buf 1.05, HTF trail 2, indicator exits OFF.

Full JSON: `best_tiausdt.json`
