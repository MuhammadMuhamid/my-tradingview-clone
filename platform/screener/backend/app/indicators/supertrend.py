"""Supertrend — §4.7, ported from the Pine v4 source in `screener.rtf`:

    atr2 = sma(tr, Periods)
    atr  = changeATR ? atr(Periods) : atr2
    up   = src - (Multiplier * atr)
    up1  = nz(up[1], up)
    up  := close[1] > up1 ? max(up, up1) : up
    dn   = src + (Multiplier * atr)
    dn1  = nz(dn[1], dn)
    dn  := close[1] < dn1 ? min(dn, dn1) : dn
    trend = 1
    trend := nz(trend[1], trend)
    trend := trend == -1 and close > dn1 ? 1 : trend == 1 and close < up1 ? -1 : trend

Three things make this the port most likely to be silently wrong, and all three
are why the loop below is scalar rather than vectorised:

1. **`up1` reads the previous bar's *reassigned* `up`, not the raw `src - m*atr`.**
   The band ratchets: it can only move in the trend's favour while price holds.
   Vectorising the raw band and taking a cumulative max afterwards is the classic
   wrong answer — it ratchets across trend flips, which the `close[1]` guard exists
   to prevent.
2. **The comparison is against `close[1]`, not `close`.** One bar of offset flips
   trades.
3. **`nz(x[1], x)` seeds from the *current* bar**, so the first usable bar
   compares the band against itself and cannot ratchet.

Pine treats any comparison involving `na` as false; the loop reproduces that
rather than letting NaN propagate.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .. import ta
from .base import clean, require_bars

DEFAULTS = {"period": 10, "multiplier": 3.0, "src": "hl2", "changeATR": True, "atr_length": 14}


def bands(df: pd.DataFrame, params: dict | None = None) -> pd.DataFrame:
    """The full `up` / `dn` / `trend` series. Exposed so tests can walk the ratchet."""
    p = {**DEFAULTS, **(params or {})}
    period, mult = int(p["period"]), float(p["multiplier"])

    src = ta.source(df, p["src"]).to_numpy(dtype="float64")
    close = df["close"].to_numpy(dtype="float64")

    tr = ta.true_range(df)
    atr_series = (ta.rma(tr, period) if p["changeATR"] else ta.sma(tr, period))
    atr_arr = atr_series.to_numpy(dtype="float64")

    n = len(df)
    up = np.full(n, np.nan)
    dn = np.full(n, np.nan)
    trend = np.ones(n, dtype="int64")

    prev_up = prev_dn = np.nan
    prev_trend = 1

    for i in range(n):
        a = atr_arr[i]
        raw_up = src[i] - mult * a
        raw_dn = src[i] + mult * a

        # nz(up[1], up): fall back to this bar's own raw band.
        up1 = prev_up if not np.isnan(prev_up) else raw_up
        dn1 = prev_dn if not np.isnan(prev_dn) else raw_dn

        prev_close = close[i - 1] if i > 0 else np.nan

        cur_up = raw_up
        if not np.isnan(prev_close) and not np.isnan(up1) and prev_close > up1:
            cur_up = max(raw_up, up1) if not np.isnan(raw_up) else up1

        cur_dn = raw_dn
        if not np.isnan(prev_close) and not np.isnan(dn1) and prev_close < dn1:
            cur_dn = min(raw_dn, dn1) if not np.isnan(raw_dn) else dn1

        t = prev_trend
        if prev_trend == -1 and not np.isnan(dn1) and close[i] > dn1:
            t = 1
        elif prev_trend == 1 and not np.isnan(up1) and close[i] < up1:
            t = -1

        up[i], dn[i], trend[i] = cur_up, cur_dn, t
        prev_up, prev_dn, prev_trend = cur_up, cur_dn, t

    return pd.DataFrame(
        {"up": up, "dn": dn, "trend": trend, "atr": atr_arr}, index=df.index
    )


def compute(df: pd.DataFrame, params: dict | None = None) -> dict:
    p = {**DEFAULTS, **(params or {})}
    require_bars(df, int(p["period"]) + 2)

    b = bands(df, p)
    direction = int(b["trend"].iloc[-1])
    line = float(b["up"].iloc[-1] if direction == 1 else b["dn"].iloc[-1])
    close = float(df["close"].iloc[-1])

    # Distance uses the shared ATR(14) so the column is comparable with the EMA
    # ones, not the Supertrend's own period-10 ATR.
    atr_now = ta.last(ta.atr(df, int(p["atr_length"])))

    flips = b["trend"].ne(b["trend"].shift(1)) & b["trend"].shift(1).notna()
    bars_since_flip = ta.bars_since(flips)

    return clean({
        "direction": direction,
        "line": line,
        "dist_pct": None if not line else (close - line) / line * 100.0,
        "dist_atr": None if not atr_now else (close - line) / atr_now,
        "bars_since_flip": bars_since_flip,
        "flipped_this_bar": bool(flips.iloc[-1]),
    })
