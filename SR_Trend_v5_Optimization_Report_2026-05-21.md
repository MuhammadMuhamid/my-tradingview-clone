# SR+Trend v5 — Strategy Optimization Report

**Document date:** May 21, 2026  
**Strategy:** SR+Trend v5 (Pine Script v6)  
**Execution timeframe:** 5 minutes  
**Analysis basis:** TradingView charts + strategy CSV exports (LDO, ENA, NEAR, APT)

---

## 1. Executive Summary

Your current uptrend stack — **1m×200 MA, 1h×400 MA, 4h×200 VWMA, 5m SuperTrend, 1m LinReg** — correctly filters **macro uptrends** and produces strong results on trending altcoins (e.g. LDO ~47% net, APT ~41%, ENA ~32% on chart overlays).

The main performance drag is **not** “wrong macro trend” but:

1. **5-minute chop inside an HTF uptrend** — entries on S/R retests while local structure is flat or down.
2. **Multiple competing soft exits** — 4h MA, SuperTrend, 1m MA, and LinReg can close trades before trailing profit or HTF runners help.
3. **Stop/target asymmetry** — wide structure stops on volatile coins vs. sensitive micro exits on 5m noise.

**Primary goal (your request):** Find more accurate per-coin uptrend defaults, avoid false trades in uptrends, tighten stop logic, and maximize gain capture — **without changing Pine code until you approve.**

---

## 2. Your Current Setup

| Layer | Setting | Role |
|-------|---------|------|
| TF1 MA | 1m × 200 SMA | Short-term trend filter |
| TF3 MA | 1h × 400 SMA | Medium HTF trend |
| VWMA | 4h × 200 | Volume-weighted HTF trend |
| SuperTrend | 5m, ATR 15, mult 2.5 | Chart-TF direction |
| LinReg | 1m, length 6 (typical) | Entry candle filter (green / signal) |
| Entries | MTF S/R retest + strength | 5m buy timing |
| Exits | Structure SL, TP ~1.75R, trail, HTF break runner, 4h MA exit, ST/1m MA/LinReg exits | Risk + regime + micro |

**Trading remains on 5m** — all recommendations below only gate *when* 5m entries fire or *how* 5m exits behave.

---

## 3. Trade Data Summary (CSV Analysis)

Paired entry/exit rows from exported reports:

| Coin | Trades | Win Rate | Profit Factor | Avg Win | Avg Loss | Net P/L % (CSV) |
|------|--------|----------|---------------|---------|----------|-----------------|
| LDO | 54 | 55.6% | 2.90 | +3.14% | −1.35% | 57.3% |
| ENA | 26 | 61.5% | 2.99 | +4.68% | −2.50% | 46.4% |
| NEAR | 27 | 63.0% | 2.30 | +2.94% | −2.17% | 26.3% |
| APT | 23 | 78.3% | 7.46 | +2.58% | −1.24% | 38.3% |

*Note: Chart overlays may show different trade counts or net % if report date range or position size differs from CSV export.*

### Key patterns

| Pattern | LDO | ENA | NEAR | APT |
|---------|-----|-----|------|-----|
| Quick false losses (&lt;6h, never green) | 31% of all trades | 8% | 22% | 22% |
| Losses &gt;2% (of all losses) | 21% | **80%** | 50% | 0% |
| Chop cluster (3+ losses in 48h) | Yes (−10.8%, −8.0%) | Yes (−9.8%) | Yes (**−17%**) | Minimal |
| Gave back ≥1.5% peak profit | 6 trades | 6 trades | 2 trades | Rare |

**Exit signals (CSV):** Almost all exits are `Long X` (bracket/trail/soft); `MTF MA exit` appears occasionally on ENA/APT/LDO.

---

## 4. How the Strategy Decides (Logic Map)

### Entry (5m)

1. Valid **support retest** (touch window + pullback from above + optional reclaim block).
2. **`filtLong` all true:** MA uptrend (1m/1h/4h), 5m ST bull, LinReg long rule, VWMA, optional ADX/RSI/MACD.
3. Optional **pivot strength** near level.
4. **Confirmed bar** + cooldown + bar-close entry gate.

### Exit (multiple paths — often overlap)

| # | Mechanism | Typical effect |
|---|-----------|----------------|
| 1 | Bracket SL (structure + ATR + swing) | Hard stop |
| 2 | TP at ~1.75R | Caps winners early |
| 3 | Trail after +1.75R unrealized | Late profit protection |
| 4 | 4h×100 MA cross down | Regime exit |
| 5 | Close below 5m SuperTrend | Micro exit |
| 6 | Close below 1m×200 MA | Very sensitive on 5m |
| 7 | Close below 1m LinReg close | Micro exit |
| 8 | HTF resistance break | Drop TP, trail runner |

**Problem:** Paths 5–7 fire frequently in chop before trail or HTF runner helps (visible on NEAR/LDO charts).

---

## 5. Root Causes of False Trades

### 5.1 Macro uptrend ≠ 5m tradable uptrend (NEAR, parts of LDO)

HTF MAs can slope up while 5m makes lower highs. Entries pass because `close > MA` on 1m/1h/4h. NEAR May 12–19 loss cluster is the clearest example.

### 5.2 Too many sensitive soft exits

`useExitBelowMa1` (1m×200) and `useExitBelowLinReg` on a **5m chart** react to noise. Many losses had **favorable excursion ≥1.5%** then closed red — profit given back.

### 5.3 Stop placement vs. volatility

`structBuff = 3.25 × ATR` under support can place SL far away; when hit on ENA/NEAR, losses are **−2.5% to −5%**.

### 5.4 Trail arms late vs. TP

`trailTriggerR = 1.75` with `tpR = 1.75` — trail often starts only at TP zone; soft exits cut trades before runner develops.

### 5.5 Stale retest window (LDO churn)

`retestConfirmBars = 12` (~1 hour on 5m) + `priorAboveLb = 2` allows entries on old touches in ranges.

---

## 6. Recommendations: Stronger Uptrend Detection

Keep core stack. Add **one or two** layers per coin (test in TradingView first).

### 6.1 HTF slope + separation (high value)

| Rule | Timeframe | Suggested logic |
|------|-----------|-----------------|
| MA slope up | 1h & 4h | MA &gt; MA[3] or MA[5] on HTF |
| Price separation | 1h | close &gt; 1h MA + 0.3–0.5 × ATR(5m) |
| VWMA vs SMA | 4h (optional) | 4h VWMA &gt; 4h SMA |

**Why:** Blocks flat/grinding “uptrends” and MA-hugging chop.

### 6.2 5m / 15m micro-trend (best for NEAR/LDO)

| Tool | Settings | Role |
|------|----------|------|
| EMA stack | 5m EMA 21 &gt; EMA 55, close &gt; EMA 21 | Local direction |
| 15m SuperTrend | ATR 10, mult 2–3 | Fewer whips than 5m alone |
| LinReg rule | **Close &gt; signal** or **Both** | Stricter than green candle only |
| 15m structure | Last pivot high &gt; prior pivot high | Simple higher-high filter |

### 6.3 Regime strength (optional inputs already in script)

| Filter | Use on |
|--------|--------|
| HTF ADX (1h/4h, min 20–25, +DI &gt; −DI) | ENA, NEAR |
| RSI MTF (1h RSI 45–65 for longs) | Block weak/overbought |
| MACD MTF (1h line &gt; signal) | NEAR optional |

**APT:** Base stack often sufficient (78% WR in CSV).

### 6.4 Volume & relative strength (optional)

| Tool | Rule |
|------|------|
| 5m volume | Entry bar volume &gt; SMA(20) of volume |
| vs BTC | Coin 4h outperform BTC 4h — long leaders only |

### 6.5 Additional indicators to test

- **Aroon (1h):** Up &gt; 70 and Up &gt; Down  
- **Hull MA (15m, 55):** Smoother slope filter  
- **Chandelier exit (15m):** Visual trend persistence  

**Rule:** Add at most **2 layers** — HTF slope + one micro filter.

---

## 7. Per-Coin Default Profiles (TradingView Saved Layouts)

Use separate **Save as default** presets per symbol.

### APT (low volatility, clean retests)

| Category | Suggested values |
|----------|------------------|
| Trend | Current stack; ADX off |
| Entry | Touch 0.7–0.8 ATR; retest window 8–10 |
| Exits | 4h MA ON; **OFF** exit below 1m MA |
| SL/TP | structBuff 2.0; tpR 2.25; trailTriggerR 1.0 |

### LDO (medium vol, higher trade count)

| Category | Suggested values |
|----------|------------------|
| Trend | + 1h MA slope; + 15m ST bull |
| Entry | priorAboveLb 4–6; retestConfirmBars 6–8; srStrengthMin 2 |
| Exits | 4h MA ON; **OFF** 1m MA exit; limit LinReg exit in chop |
| SL/TP | structBuff 2.0–2.5; cooldownBarsAfterExit 2 |

### ENA (high volatility, large losers)

| Category | Suggested values |
|----------|------------------|
| Trend | Base + 1h ADX ≥ 22 + 5m EMA 21&gt;55 |
| Entry | LinReg **Both**; touch 0.75 ATR; strength min 2 |
| Exits | Chandelier trail; HTF break ON; soft: ST + 4h MA only |
| SL/TP | minSlDistAtr 0.25; test Percent SL 1.8% cap; trailTriggerR 1.0 |

### NEAR (choppy inside HTF up)

| Category | Suggested values |
|----------|------------------|
| Trend | Base + 15m HH structure + 5m EMA 21&gt;55 **required** |
| Entry | retestConfirmBars 5–6; priorAboveLb 5; cooldown 3 |
| Exits | **OFF** 1m MA & LinReg exits; 4h MA + bracket + trail |
| SL/TP | slSwingLb 12–15; structBuff 1.75–2.0 |

---

## 8. Stop Loss, Take Profit & Trailing

### 8.1 Stop loss

| Parameter | Issue | Test range | Explanation |
|-----------|-------|------------|-------------|
| structBuff | 3.25× ATR often wide | 1.75–2.5 by coin | Smaller losses when wrong |
| slSwingLb | 25 bars = 2h on 5m | 12–18 | Tighter swing anchor |
| minSlDistAtr | Too tight on ENA | 0.15 APT/LDO; 0.25 ENA/NEAR | Balance noise vs. risk |
| Max loss cap | Not in script | 1.2–1.8% entry (Percent SL test) | Ceiling on worst trades |

**Principle:** Tighter stop under retest low; failed retest should fail fast (~0.8–1.2% on 5m alts).

### 8.2 Take profit

| Parameter | Suggested | Explanation |
|-----------|-----------|-------------|
| tpR | 2.25–3.0 | APT/LDO 2.5; ENA 3.0 |
| HTF break runner | ON for LDO/APT/ENA | Captures extension moves |

### 8.3 Trailing

| Parameter | Suggested | Explanation |
|-----------|-----------|-------------|
| trailTriggerR | **1.0–1.25** (not 1.75) | Protect profit before full TP |
| trailAtrMult | 1.4–1.6 trend; 1.0–1.2 after HTF break | Volatility-adjusted |
| trailStyle | **Chandelier** on ENA/NEAR/LDO | Reduces 5m wick stop-outs |
| Soft exits | Delay until +0.5R or +1R (concept) | Stops green-then-red |

**Alignment:** If tpR stays 1.75, set trailTriggerR to **1.0** so trail can arm before TP fills.

---

## 9. Recommended Exit Hierarchy

Test manually in TradingView before any code change:

```
In long on 5m
  → If unrealized < +1R: rely mainly on bracket SL (+ optional tight emergency)
  → If unrealized ≥ +1R: enable Chandelier / HTF trail
  → Regime exit: 4h MA bearish cross → close
  → Micro exit (per coin): 5m ST flip — optional on ENA only
  → Hold for HTF break runner when trend strong
```

### Concrete toggle tests (no code)

1. **OFF:** Exit long below TF1 1m MA *(largest churn reducer)*  
2. **OFF or last:** Exit below LinReg on NEAR/LDO  
3. **ON:** 4h MA exit (regime)  
4. **ON:** 5m ST exit for ENA only  
5. **ON:** HTF break trail on LDO/APT/ENA  

---

## 10. Entry Quality Parameters

| Input | Direction | Why |
|-------|-----------|-----|
| retestConfirmBars | 6–8 LDO/NEAR; 10–12 APT | Fresher retests |
| priorAboveLb | 4–6 | Real pullback from above |
| srStrengthMin | 2 on NEAR/ENA | Pivot confluence |
| lrLongRule | **Both** on NEAR/ENA | Momentum, not color only |
| cooldownBarsAfterExit | 2–3 NEAR/LDO | Stops re-entry loops |
| useContLong | OFF until base tuned | Breakouts add chop risk |
| touchAtrMult | 0.65–0.80 by coin | APT tighter; ENA slightly wider |

---

## 11. Chart Observations by Coin

| Coin | What works | What hurts |
|------|------------|------------|
| **LDO** | Sustained trends, large +% runners | Sideways clusters; many small Long X; soft exits cut winners |
| **ENA** | Fewer trades, big +6–9% wins | Large −2.5%+ losses when wrong; needs ADX + trail |
| **NEAR** | Good WR% but low net vs. trades | Local downtrend still buys; 8 losses in 48h ≈ −17% |
| **APT** | Highest WR & PF; small losses | Light tuning only; don’t over-filter |

---

## 12. Suggested Testing Order (TradingView)

1. **One change per coin:** Disable “exit below TF1 MA” → Update report.  
2. Overlay **1h MA slope** — skip entries when 1h MA flat/down.  
3. Overlay **5m EMA 21 &gt; 55** — skip when false.  
4. Tune **structBuff** + **trailTriggerR** together.  
5. Save **per-coin input presets** (APT / LDO / ENA / NEAR).  

### Future Pine inputs (when you approve code changes)

- `requireHtfMaSlope`  
- `require5mEmaStack`  
- `minUnrealizedRForSoftExit`  
- `maxRiskPctCap`  

All should default **OFF** so live behavior unchanged until enabled.

---

## 13. Bottom Line

| Finding | Action |
|---------|--------|
| HTF uptrend stack works | Keep 1m/1h/4h/VWMA/ST/LinReg core |
| Losses are 5m timing + exit stacking | Add micro-trend gate; reduce soft exits |
| Biggest wins need runners | Earlier trail + HTF break; higher tpR |
| Per-coin volatility differs | Separate TV defaults — do not use one global preset |
| NEAR needs strictest filters | 5m EMA + structure HH; disable 1m/LinReg exits |
| APT needs lightest touch | Modest SL/TP tune only |

---

## 14. Disclaimer

This report is based on strategy CSV exports and chart review as of May 21, 2026. Backtest results vary with date range, commission, slippage, and TradingView “Recalculate after order is filled” setting. All parameter changes should be validated on your exact report range before live trading.

---

*Generated for SR+Trend v5 optimization workflow. Pine Script file: `SR_Uptrend_Strategy.pine`*
