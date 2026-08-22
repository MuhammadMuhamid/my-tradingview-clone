# MORPHOUSDT 5m optimization (2026-04-09 → 2026-05-14)

**Fixed (screenshot):** MA 1m×200 + 1h×400, VWMA 4h×200, SuperTrend 5m×15×2.5, LinReg **1m ON**, exit MA 4h×100, HTF break 1h×20.

**Searched:** 3,000 random combos (S/R + risk + LinReg length only).

## Constraints requested

- Win rate ≥ **60%**
- Profit factor ≥ **3**
- Min 15 trades

## Result

**0 configs** met WR≥60% AND PF≥3 in this simplified Python sim.

### Best net profit (applied to Pine defaults)


| Metric        | Value       |
| ------------- | ----------- |
| Net           | **+13.89%** |
| Trades        | 53          |
| Win rate      | 35.8%       |
| Profit factor | 1.42        |
| Max DD        | 11.6%       |


### Closest to high win rate (alternative — not applied)


| Metric        | Value     |
| ------------- | --------- |
| Net           | +7.12%    |
| Trades        | 47        |
| Win rate      | **55.3%** |
| Profit factor | 1.55      |


Use TradingView Strategy Tester for authoritative WR/PF (full Pine logic).