"""
SR+Trend v5 — Python simulator (long-only, 5m execution chart).

Matches Pine logic for: S/R retest latch, MTF MA/VWMA/SuperTrend/LinReg filters,
plus the new filters added in v5.1: MA slope, local EMA stack, volume, HH structure.
Soft exits (4h MA cross, ST flip, TF1 MA flip) are NOT simulated — bracket SL/TP
and trailing are the only exits, matching how most trades actually close.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd


@dataclass
class StrategyParams:
    # ── S/R structure ────────────────────────────────────────────────────────
    touch_atr: float = 0.65          # touch zone width (× ATR)
    piv_len_5: int = 9
    piv_len_15: int = 13
    piv_len_60: int = 7
    piv_len_240: int = 7
    retest_confirm_bars: int = 6     # bars after touch for entry window
    prior_above_lb: int = 3          # bars price must be above support before touch

    # ── Risk / exits ──────────────────────────────────────────────────────────
    atr_len: int = 7
    sl_atr: float = 1.2              # SL = entry − sl_atr × ATR (fallback)
    struct_buff: float = 2.0         # SL = support − struct_buff × ATR
    tp_r: float = 2.25               # TP = entry + risk × tp_r
    trail_trigger_r: float = 1.0     # arm trail after +trail_trigger_r unrealised
    trail_atr: float = 1.4           # trail distance (× ATR)
    trail_style: str = "ratchet"     # "ratchet" | "chandelier"
    min_sl_atr: float = 0.15         # floor: SL never closer than this × ATR
    fee_pct: float = 0.05            # commission per side (%)

    # ── Baseline trend filters (locked ON) ───────────────────────────────────
    use_ma_trend: bool = True
    ma1_len: int = 200               # 1m × 200 SMA
    ma3_len: int = 200               # 1h × 200 SMA
    use_vwma: bool = False
    vwma_len: int = 200              # 4h × 200 VWMA
    use_supertrend: bool = True
    st_atr_len: int = 15             # 5m SuperTrend ATR period
    st_mult: float = 2.5
    use_linreg: bool = True
    lr_len: int = 8                  # LinReg length (on 1m or 5m based on lr_tf)
    lr_tf: str = "1"                 # "1" = 1m LinReg, "5" = 5m

    # ── NEW: MA slope filter ──────────────────────────────────────────────────
    require_ma_slope: bool = False   # each enabled MA must be rising
    ma_slope_lb: int = 5             # compare MA to this many bars ago

    # ── NEW: Local 5m EMA stack ───────────────────────────────────────────────
    use_local_trend: bool = False    # require fast EMA > slow EMA on 5m
    local_ema_fast: int = 21
    local_ema_slow: int = 55

    # ── NEW: Volume filter ────────────────────────────────────────────────────
    use_volume_filter: bool = True   # require above-average volume on entry bar
    vol_ma_len: int = 100
    vol_mult_min: float = 1.0        # entry volume ≥ vol_mult × SMA(volume)

    # ── NEW: Higher-high structure (15m) ─────────────────────────────────────
    use_hh_structure: bool = False   # last 15m pivot high > prior pivot high
    hh_pivot_len: int = 7

    # ── TradingView-matching fixed params ────────────────────────────────────
    sl_swing_lb: int = 26            # "Swing low lookback bars" in Pine (SL calc)
    reclaim_pierce_atr: float = 0.5  # "Pierce below support (× ATR) = reclaim block"
    require_bounce: bool = True      # close ≥ latched support level at entry (Pine retestLvlOk)

    # ── Soft exit flags (each guards a strategy.close() condition) ────────────
    use_exit_below_st: bool = False  # exit when close < SuperTrend line
    use_exit_below_ma1: bool = False # exit when close < TF1 MA
    use_exit_below_lr: bool = False  # exit when close < LinReg close
    use_exit_ma: bool = True         # exit on MA crossunder (exit_ma_tf × exit_ma_len)
    exit_ma_tf: str = "1h"
    exit_ma_len: int = 100
    exit_ma_type: str = "VWMA"      # "SMA" | "EMA" | "VWMA"

    # ── HTF break trail (runner mode) ────────────────────────────────────────
    use_htf_break_trail: bool = True
    htf_res_pivot_len: int = 9       # pivot left/right on 1h for break detection (Pine default: 9)
    htf_break_buf_atr: float = 0.25  # 1h close > 1h_piv_high + buf × 1h_ATR  (Pine default: 0.25)
    htf_trail_atr_mult: float = 1.0  # trail = chandelier_hi − mult × 5m_ATR   (Pine default: 1.0)
    htf_reset_trail_anchor: bool = True  # reset chandelier anchor to entry on break


# ─────────────────────────────────────────────────────────────────────────────
# Indicator helpers
# ─────────────────────────────────────────────────────────────────────────────

def rma(s: pd.Series, length: int) -> pd.Series:
    """Wilder RMA (same as Pine ta.rma)."""
    return s.ewm(alpha=1 / length, adjust=False).mean()


def atr(df: pd.DataFrame, length: int) -> pd.Series:
    prev = df["close"].shift(1)
    tr = pd.concat(
        [df["high"] - df["low"],
         (df["high"] - prev).abs(),
         (df["low"] - prev).abs()],
        axis=1,
    ).max(axis=1)
    return rma(tr, length)


def sma(s: pd.Series, length: int) -> pd.Series:
    return s.rolling(length, min_periods=length).mean()


def ema(s: pd.Series, length: int) -> pd.Series:
    """Exponential moving average (same as Pine ta.ema)."""
    return s.ewm(span=length, adjust=False).mean()


def vwma(close: pd.Series, vol: pd.Series, length: int) -> pd.Series:
    num = (close * vol).rolling(length, min_periods=length).sum()
    den = vol.rolling(length, min_periods=length).sum()
    return num / den


def linreg_series(s: pd.Series, length: int) -> pd.Series:
    """
    Vectorized linear regression — end-value of best-fit line (matches Pine ta.linreg).
    Uses numpy stride_tricks for a ~100x speedup vs the old pure-Python loop.
    """
    y = s.values.astype(float)
    n = len(y)
    if n < length:
        return pd.Series(np.nan, index=s.index, dtype=float)

    x      = np.arange(length, dtype=float)
    x_mean = x.mean()
    x_ss   = ((x - x_mean) ** 2).sum()
    x_end  = float(length - 1)

    # Fixed linear weights: value = sum(w_j * y_j) over window
    # Derived from: value_at_end = y_mean + slope*(x_end - x_mean)
    weights = 1.0 / length + (x - x_mean) * (x_end - x_mean) / x_ss  # shape (length,)

    # Sliding window view — zero-copy read-only strided array
    m       = n - length + 1
    strides = (y.strides[0], y.strides[0])
    windows = np.lib.stride_tricks.as_strided(y, shape=(m, length), strides=strides)

    result          = np.full(m, np.nan)
    valid           = ~np.any(np.isnan(windows), axis=1)
    result[valid]   = windows[valid] @ weights       # vectorised dot product

    out             = np.full(n, np.nan)
    out[length - 1:] = result
    return pd.Series(out, index=s.index)


def supertrend(df: pd.DataFrame, atr_len: int, mult: float):
    """Returns (support_line_series, trend_series) where trend=1 bull, -1 bear."""
    src = (df["high"] + df["low"]) / 2
    atrv = atr(df, atr_len)
    up_arr = (src - mult * atrv).values.astype(float)
    dn_arr = (src + mult * atrv).values.astype(float)
    close  = df["close"].values.astype(float)
    n = len(close)
    up_f = up_arr.copy()
    dn_f = dn_arr.copy()
    tr_arr = np.ones(n, dtype=np.int8)
    for i in range(1, n):
        up1, dn1, c1 = up_f[i - 1], dn_f[i - 1], close[i - 1]
        up_f[i] = max(up_arr[i], up1) if c1 > up1 else up_arr[i]
        dn_f[i] = min(dn_arr[i], dn1) if c1 < dn1 else dn_arr[i]
        tr = tr_arr[i - 1]
        c  = close[i]
        if tr == -1 and c > dn1:
            tr = 1
        elif tr == 1 and c < up1:
            tr = -1
        tr_arr[i] = tr
    line = np.where(tr_arr == 1, up_f, dn_f)
    return pd.Series(line, index=df.index), pd.Series(tr_arr, index=df.index)


def last_pivot_low(df: pd.DataFrame, left: int, right: int) -> pd.Series:
    """Forward-filled latest confirmed pivot low (published `right` bars late)."""
    lows = df["low"].values.astype(float)
    n = len(lows)
    win_size = left + right + 1
    if n < win_size:
        return pd.Series(np.nan, index=df.index)

    m = n - win_size + 1
    strides = (lows.strides[0], lows.strides[0])
    windows = np.lib.stride_tricks.as_strided(lows, shape=(m, win_size), strides=strides)
    centers = lows[left : n - right]
    win_min = np.nanmin(windows, axis=1)
    is_piv = centers == win_min

    out = np.full(n, np.nan)
    # confirmed index = left + right + k where k is window offset
    confirmed_idx = np.arange(left + right, n)
    out[confirmed_idx[is_piv]] = centers[is_piv]
    return pd.Series(out, index=df.index).ffill()


def _pivot_high_series(arr: np.ndarray, left: int, right: int) -> np.ndarray:
    """Return array with pivot high values at their confirmation bars, NaN elsewhere."""
    n = len(arr)
    win_size = left + right + 1
    if n < win_size:
        return np.full(n, np.nan)
    m = n - win_size + 1
    strides = (arr.strides[0], arr.strides[0])
    windows = np.lib.stride_tricks.as_strided(arr, shape=(m, win_size), strides=strides)
    centers = arr[left : n - right]
    win_max = np.nanmax(windows, axis=1)
    is_piv = centers == win_max
    out = np.full(n, np.nan)
    confirmed_idx = np.arange(left + right, n)
    out[confirmed_idx[is_piv]] = centers[is_piv]
    return out


def last_pivot_high(df: pd.DataFrame, left: int, right: int) -> pd.Series:
    """Forward-filled latest confirmed pivot high (published `right` bars late)."""
    highs = df["high"].values.astype(float)
    piv = _pivot_high_series(highs, left, right)
    return pd.Series(piv, index=df.index).ffill()


def hh_structure_bool(df: pd.DataFrame, left: int, right: int) -> pd.Series:
    """
    Returns True at each bar if the last confirmed pivot HIGH is greater than
    the prior confirmed pivot HIGH — i.e., the market is making higher highs.
    Confirmed `right` bars after the actual pivot bar.
    """
    highs = df["high"].values.astype(float)
    piv = _pivot_high_series(highs, left, right)

    # Forward-fill to get current pivot high at every bar
    ph0 = pd.Series(piv, index=df.index).ffill().values

    # Prior pivot high: use numpy to propagate the previous pivot value
    ph_prior = np.full(len(piv), np.nan)
    prev_val = np.nan
    piv_locs = np.where(~np.isnan(piv))[0]
    for idx in piv_locs:
        ph_prior[idx] = prev_val
        prev_val = piv[idx]
    ph_prior = pd.Series(ph_prior, index=df.index).ffill().values

    result = (~np.isnan(ph0)) & (~np.isnan(ph_prior)) & (ph0 > ph_prior)
    return pd.Series(result, index=df.index)


def align_htf_to_5m(
    df5: pd.DataFrame,
    df_htf: pd.DataFrame,
    col: str,
    close_offset: pd.Timedelta | None = None,
) -> pd.Series:
    """Merge-asof: carry last HTF value forward onto 5m bars.

    close_offset: when supplied, the 5m bar's lookup key is shifted by this
    amount so we match the HTF bar whose close falls within the 5m period rather
    than the bar at the 5m bar's open.  Example: close_offset=pd.Timedelta("4min")
    makes the 5m bar at 09:00 pick up the 1m bar at 09:04 (the bar active just
    before the 5m bar closes at 09:05), matching Pine's request.security() semantics.
    """
    left = df_htf[[col]].copy()
    left.index.name = "ts"
    right = df5[["close"]].copy()
    right.index.name = "ts"

    if close_offset is not None:
        right_lookup = right.copy()
        right_lookup.index = right_lookup.index + close_offset
    else:
        right_lookup = right

    m = pd.merge_asof(
        right_lookup.reset_index().sort_values("ts"),
        left.reset_index().sort_values("ts"),
        on="ts",
        direction="backward",
    )
    # Restore original 5m timestamps
    m["ts"] = right.index
    return m.set_index("ts")[col]


def retest_support(
    low: pd.Series,
    close: pd.Series,
    sup: pd.Series,
    band: pd.Series,
    prior_lb: int,
    atrv: pd.Series | None = None,
    reclaim_pierce_atr: float = 0.05,
) -> pd.Series:
    """True when low touches support zone and price was above it for prior_lb bars.
    Optionally blocks pierce-and-reclaim bars (matches Pine blockBreakReclaim=true).
    """
    from_above = close.shift(1).rolling(prior_lb, min_periods=prior_lb).min() > sup
    in_zone = low <= sup + band
    result = in_zone & from_above & sup.notna()
    if atrv is not None and reclaim_pierce_atr > 0:
        # Block bars where price dipped below support by > threshold and closed back above
        pierced  = low < sup - reclaim_pierce_atr * atrv
        reclaimed = close > sup
        result &= ~(pierced & reclaimed)
    return result
