"""ADX / DI — §4.5, ported from the Pine v6 built-in in the reference file.

    dirmov(len) =>
        up      = ta.change(high)
        down    = -ta.change(low)
        plusDM  = na(up)   ? na : (up > down and up > 0     ? up   : 0)
        minusDM = na(down) ? na : (down > up and down > 0   ? down : 0)
        trur    = ta.rma(ta.tr, len)
        plus    = fixnan(100 * ta.rma(plusDM, len) / trur)
        minus   = fixnan(100 * ta.rma(minusDM, len) / trur)
    adx = 100 * ta.rma(abs(plus - minus) / (sum == 0 ? 1 : sum), adxlen)

`regime` is a gate in §6, not just a display column: trend signals read in chop
are the main source of false positives, so ADX below 20 scales the trend and
trigger buckets down rather than adding a vote of its own.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .. import ta
from .base import clean, require_bars

DEFAULTS = {"adxLen": 14, "diLen": 14, "ranging_below": 20.0, "trending_above": 25.0}


def _dirmov(df: pd.DataFrame, length: int) -> tuple[pd.Series, pd.Series]:
    up = ta.change(df["high"])
    down = -ta.change(df["low"])

    plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=df.index)
    # Pine's `na(up) ? na : ...` — bar 0 has no change, so both DMs are na there.
    plus_dm[up.isna()] = np.nan
    minus_dm[down.isna()] = np.nan

    truerange = ta.rma(ta.true_range(df), length)
    plus = 100.0 * ta.rma(plus_dm, length) / truerange
    minus = 100.0 * ta.rma(minus_dm, length) / truerange
    # `fixnan` carries the last non-na value forward across a zero true range.
    return plus.ffill(), minus.ffill()


def compute(df: pd.DataFrame, params: dict | None = None) -> dict:
    p = {**DEFAULTS, **(params or {})}
    adx_len, di_len = int(p["adxLen"]), int(p["diLen"])
    require_bars(df, adx_len + di_len + 2)

    plus, minus = _dirmov(df, di_len)
    total = plus + minus
    dx = (plus - minus).abs() / total.where(total != 0.0, 1.0)
    adx_series = 100.0 * ta.rma(dx, adx_len)

    adx_now = ta.last(adx_series)
    plus_now, minus_now = ta.last(plus), ta.last(minus)

    direction = None
    if plus_now is not None and minus_now is not None:
        direction = "bull" if plus_now > minus_now else "bear"

    regime = None
    if adx_now is not None:
        if adx_now < float(p["ranging_below"]):
            regime = "ranging"
        elif adx_now > float(p["trending_above"]):
            regime = "trending"
        else:
            regime = "transitional"

    return clean({
        "adx": adx_now,
        "plus_di": plus_now,
        "minus_di": minus_now,
        "direction": direction,
        "regime": regime,
    })
