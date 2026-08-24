"""
Fast numpy backtest loop for SR+Trend v5.

Exits: bracket SL/TP + ratchet or chandelier trailing.
Soft exits (regime MA, ST flip, LinReg) are NOT modelled here
(they account for a minority of actual exits in the Pine backtest).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from strategy_sim import StrategyParams


@dataclass
class SimResult:
    net_pct: float
    trades: int
    wins: int
    losses: int
    max_dd_pct: float
    profit_factor: float
    win_rate: float
    gross_profit: float
    gross_loss: float

    @property
    def composite_score(self) -> float:
        """
        Score targeting user goals (v2):
          - Max Net Profit %          (primary driver)
          - Profit Factor ≥ 1.5       (hard gate — filters weak edges)
          - Max Drawdown < 15 %       (hard gate — strict risk control)
          - Min 8 trades              (hard gate — statistical minimum)
          - Win Rate ≥ 35 %           (hard gate — blocks pure lottery setups)
          - Trade count               (rewarded — more frequency = better compounding)
          - PF quality                (capped — prevents degenerate 100%-WR 6-trade wins)

        Factors:
          dd_factor    : linear 0 % DD → 1.0,  15 % DD → 0.0  (harsh penalty)
          trade_factor : 8 trades → 1.0,  30 → 2.0,  50 → 2.7  (log-scale reward)
          pf_factor    : PF 1.5 → 1.0,  PF 3.0 → 2.0,  cap 2.0
        """
        if (self.net_pct <= 0
                or self.profit_factor < 1.5
                or self.trades < 8
                or self.max_dd_pct > 15.0
                or self.win_rate < 0.35):
            return 0.0

        dd_factor    = max(0.05, 1.0 - self.max_dd_pct / 15.0)
        trade_factor = 1.0 + min((self.trades - 8) / 22.0, 2.0)
        pf_factor    = min(self.profit_factor / 1.5, 2.0)

        return self.net_pct * pf_factor * dd_factor * trade_factor


def simulate(
    d: pd.DataFrame,
    p: StrategyParams,
    t0: pd.Timestamp,
    t1: pd.Timestamp,
    capital: float = 1000.0,
    order_usdt: float = 930.0,
    r_any: np.ndarray | None = None,
) -> SimResult:
    idx = d.index
    test_mask = (idx >= t0) & (idx < t1)
    if not test_mask.any():
        return SimResult(0, 0, 0, 0, 0, 0, 0, 0, 0)

    low       = d["low"].to_numpy()
    high      = d["high"].to_numpy()
    close     = d["close"].to_numpy()
    atrv      = d["atr"].to_numpy()
    volume    = d["volume"].to_numpy() if "volume" in d.columns else np.ones(len(d))
    swing_low = d["swing_low"].to_numpy() if "swing_low" in d.columns else low

    # Soft-exit arrays (guarded by StrategyParams flags)
    _st_line_arr   = d["st_line"].to_numpy()  if "st_line"   in d.columns else np.full(len(d), np.nan)
    _exit_ma_arr   = d["exit_ma_x"].to_numpy().astype(bool) if "exit_ma_x" in d.columns else np.zeros(len(d), dtype=bool)
    # HTF break trail trigger
    _htf_break_arr = d["htf_break"].to_numpy().astype(bool) if "htf_break" in d.columns else np.zeros(len(d), dtype=bool)

    sup_cols = (
        d["sup240"].to_numpy(),
        d["sup60"].to_numpy(),
        d["sup15"].to_numpy(),
        d["sup5"].to_numpy(),
    )
    band = atrv * p.touch_atr

    if r_any is None:
        r_any = np.zeros(len(d), dtype=bool)

    # ── Vectorised filter array (computed once per simulate() call) ──────────
    n = len(d)
    filt = np.ones(n, dtype=bool)

    # Extract unconditionally — also needed for soft exits below
    _m1  = d["ma1"].to_numpy() if "ma1" in d.columns else np.full(n, np.nan)
    _lr_c = d["lr"].to_numpy() if "lr"  in d.columns else np.full(n, np.nan)

    if p.use_ma_trend:
        m3 = d["ma3"].to_numpy()
        filt &= np.where(np.isnan(_m1), True, close > _m1)
        filt &= np.where(np.isnan(m3),  True, close > m3)

    if p.use_vwma:
        vw = d["vw"].to_numpy()
        filt &= np.where(np.isnan(vw), True, close > vw)

    if p.use_supertrend:
        filt &= d["st_tr"].to_numpy() == 1

    if p.use_linreg:
        # Pine "Green candle" rule: LinReg close > LinReg open (matches lrLongOk in Pine)
        lr_o = d["lr_open"].to_numpy() if "lr_open" in d.columns else np.full(n, np.nan)
        filt &= np.where(np.isnan(_lr_c) | np.isnan(lr_o), True, _lr_c > lr_o)

    # NEW: MA slope — each MA must be higher than N bars ago
    if p.require_ma_slope and p.ma_slope_lb > 0:
        lb = p.ma_slope_lb
        m3 = d["ma3"].to_numpy()
        m1_prev = np.empty(n); m1_prev[:] = np.nan
        m3_prev = np.empty(n); m3_prev[:] = np.nan
        if lb < n:
            m1_prev[lb:] = _m1[:-lb]
            m3_prev[lb:] = m3[:-lb]
        filt &= np.where(np.isnan(_m1) | np.isnan(m1_prev), True, _m1 > m1_prev)
        filt &= np.where(np.isnan(m3)  | np.isnan(m3_prev), True, m3 > m3_prev)

    # NEW: Local 5m EMA stack
    if p.use_local_trend and "local_ema_fast" in d.columns and "local_ema_slow" in d.columns:
        fast = d["local_ema_fast"].to_numpy()
        slow = d["local_ema_slow"].to_numpy()
        filt &= np.where(np.isnan(fast) | np.isnan(slow), True, fast > slow)
        filt &= np.where(np.isnan(fast), True, close > fast)

    # NEW: Volume filter
    if p.use_volume_filter and "vol_ma" in d.columns:
        vol_ma = d["vol_ma"].to_numpy()
        filt &= np.where(
            np.isnan(vol_ma) | (vol_ma <= 0),
            True,
            volume >= p.vol_mult_min * vol_ma,
        )

    # NEW: Higher-high structure on 15m
    if p.use_hh_structure and "hh_struct" in d.columns:
        filt &= d["hh_struct"].to_numpy().astype(bool)

    # ── Main simulation loop ─────────────────────────────────────────────────
    cash             = capital
    in_pos           = False
    entry            = stop = tp = 0.0
    units            = 0.0
    trail_on         = False
    trail_stop       = 0.0
    chandelier_hi    = 0.0   # tracks highest high since trail armed (chandelier mode)
    htf_break_active = False # True once HTF break trail has fired for this trade
    last_retest_i    = -10_000
    last_lvl         = np.nan
    wins = losses    = 0
    gross_profit     = gross_loss = 0.0
    peak             = capital
    max_dd           = 0.0

    test_start_i = int(np.argmax(test_mask))

    for i in range(test_start_i, n):
        if idx[i] >= t1:
            break

        # Latch retest
        if r_any[i]:
            last_retest_i = i
            for sup in sup_cols:
                lv = sup[i]
                if not np.isnan(lv) and low[i] <= lv + band[i]:
                    last_lvl = lv
                    break

        # Equity / drawdown tracking
        eq = cash + (units * close[i] if in_pos else 0.0)
        if eq > peak:
            peak = eq
        dd = (peak - eq) / peak if peak > 0 else 0.0
        if dd > max_dd:
            max_dd = dd

        # Entry
        if not in_pos and (0 <= i - last_retest_i <= p.retest_confirm_bars) and filt[i]:
            # Pierce+reclaim block: if current bar pierced latched level by > threshold and closed above → skip
            if (not np.isnan(last_lvl) and p.reclaim_pierce_atr > 0
                    and low[i] < last_lvl - p.reclaim_pierce_atr * atrv[i]
                    and close[i] > last_lvl):
                continue

            # Bounce check (Pine retestLvlOk): close must be at or above the latched level
            if p.require_bounce and not np.isnan(last_lvl) and close[i] < last_lvl:
                continue

            px  = close[i]
            lvl = last_lvl if not np.isnan(last_lvl) else px
            a   = atrv[i]
            # SL: min(ATR-stop, structure-stop, swing-stop) then floor — matches Pine "Below structure & ATR"
            sl_atr_stop    = px - p.sl_atr * a
            sl_struct_stop = lvl - p.struct_buff * a
            sl_swing_stop  = swing_low[i]
            stp = min(sl_atr_stop, min(sl_struct_stop, sl_swing_stop))
            stp = min(stp, px - p.min_sl_atr * a)   # floor: SL never closer than min_sl_atr × ATR
            risk = px - stp
            if risk <= 0:
                continue
            tp    = px + risk * p.tp_r
            alloc = order_usdt  # Pine: fixed cash qty, always 930 USDT regardless of equity
            fee   = alloc * (p.fee_pct / 100)
            units = alloc / px
            cash -= alloc + fee
            entry = px
            stop  = stp
            in_pos           = True
            trail_on         = False
            trail_stop       = stp
            chandelier_hi    = px
            htf_break_active = False
            last_retest_i    = -10_000
            continue

        # In position: manage trail + check exits
        if in_pos:
            risk = entry - stop

            # ── HTF break trail: arm once, hard-reset anchor, switch multiplier ──
            if p.use_htf_break_trail and _htf_break_arr[i] and not htf_break_active:
                tp               = np.inf   # cancel fixed TP; let trail run open-ended
                trail_on         = True
                htf_break_active = True
                if p.htf_reset_trail_anchor:
                    # Pine: trailSwingHiLong := na → resets to current high on same bar
                    chandelier_hi = high[i]        # hard reset (not max) — matches Pine
                # Compute initial HTF trail level on break bar
                if p.trail_style == "chandelier":
                    trail_stop = max(trail_stop, chandelier_hi - p.htf_trail_atr_mult * atrv[i])
                else:
                    trail_stop = close[i] - p.htf_trail_atr_mult * atrv[i]  # fresh ratchet start

            # ── Normal trail arm (only before HTF break takes over) ───────────
            if not htf_break_active and risk > 0 and high[i] >= entry + risk * p.trail_trigger_r:
                trail_on = True

            # ── Trail update ─────────────────────────────────────────────────
            # When HTF break is active, same style as normal but uses htf_trail_atr_mult.
            # Matches Pine: trMultEff = longHtfBreakMode ? htfTrailAtrMult : trailAtrMult
            if trail_on:
                mult = p.htf_trail_atr_mult if htf_break_active else p.trail_atr
                if p.trail_style == "chandelier":
                    chandelier_hi = max(chandelier_hi, high[i])
                    trail_stop    = max(trail_stop, chandelier_hi - mult * atrv[i])
                else:
                    trail_stop    = max(trail_stop, close[i] - mult * atrv[i])

            eff = max(stop, trail_stop) if trail_on else stop

            exit_px = None
            # ── Bracket exits: trigger intrabar (low/high), fill at bar close ──
            # Matches Pine "Fill orders on bar close: ON" — same trigger logic but
            # the fill price is the bar's close, not the exact stop/TP level.
            if low[i] <= eff:
                exit_px = close[i]
            elif np.isfinite(tp) and high[i] >= tp:
                exit_px = close[i]

            # ── Soft exits: close-of-bar regime checks (Pine strategy.close()) ─
            # Each is guarded by a StrategyParams flag; fires only if bracket didn't close.
            if exit_px is None:
                cl = close[i]
                if p.use_exit_below_st and not np.isnan(_st_line_arr[i]) and cl < _st_line_arr[i]:
                    exit_px = cl                                       # close < ST line
                elif p.use_exit_below_ma1 and not np.isnan(_m1[i]) and cl < _m1[i]:
                    exit_px = cl                                       # close < TF1 MA
                elif p.use_exit_below_lr and not np.isnan(_lr_c[i]) and cl < _lr_c[i]:
                    exit_px = cl                                       # close < LinReg close
                elif p.use_exit_ma and _exit_ma_arr[i]:
                    exit_px = cl                                       # 1h×100 VWMA crossunder

            if exit_px is not None:
                proceeds = units * exit_px
                fee      = proceeds * (p.fee_pct / 100)
                cash    += proceeds - fee
                pnl      = proceeds - fee - units * entry
                if pnl > 0:
                    wins += 1
                    gross_profit += pnl
                else:
                    losses += 1
                    gross_loss += abs(pnl)
                in_pos           = False
                units            = 0.0
                htf_break_active = False

    total = wins + losses
    pf    = (gross_profit / gross_loss if gross_loss > 0
             else (99.0 if gross_profit > 0 else 0.0))
    wr    = wins / total if total else 0.0

    return SimResult(
        net_pct      = (cash / capital - 1) * 100,
        trades       = total,
        wins         = wins,
        losses       = losses,
        max_dd_pct   = max_dd * 100,
        profit_factor= pf,
        win_rate     = wr,
        gross_profit = gross_profit,
        gross_loss   = gross_loss,
    )
