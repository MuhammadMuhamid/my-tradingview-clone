"""MACD — §4.3.

`bars_since_cross` is the output that matters. A bullish cross thirty bars ago is
a state, not a signal, and the scoring in §6 decays the momentum bucket on it.
"""

from __future__ import annotations

import pandas as pd

from .. import ta
from .base import clean, require_bars

DEFAULTS = {"fast": 12, "slow": 26, "signal": 9, "source": "close"}


def compute(df: pd.DataFrame, params: dict | None = None) -> dict:
    p = {**DEFAULTS, **(params or {})}
    fast, slow, sig = int(p["fast"]), int(p["slow"]), int(p["signal"])
    require_bars(df, slow + sig + 2)

    src = ta.source(df, p["source"])
    macd_line = ta.ema(src, fast) - ta.ema(src, slow)
    signal_line = ta.ema(macd_line, sig)
    hist = macd_line - signal_line

    macd_now, signal_now = ta.last(macd_line), ta.last(signal_line)
    hist_now, hist_prev = ta.last(hist), ta.last(hist, 1)

    # MACD is a difference of two EMAs, so it carries the price's units: ~366 on
    # BTC and ~0.00064 on a sub-cent coin. Unreadable in a shared column and
    # meaningless to compare across symbols. Dividing by price gives the EMA
    # spread as a fraction of price — dimensionless, same sign, and legible at
    # two or three decimals for every coin on the list.
    close = float(df["close"].iloc[-1])

    cross_state = None
    if macd_now is not None and signal_now is not None:
        cross_state = "bull" if macd_now > signal_now else "bear"

    # A cross is a bar where the sign of (macd - signal) differs from the bar
    # before. `bars_since` on that condition gives 0 for a cross on this bar.
    above = macd_line > signal_line
    crossed = above.ne(above.shift(1)) & above.shift(1).notna() & macd_line.notna()
    bars_since_cross = ta.bars_since(crossed)

    def as_pct(value: float | None) -> float | None:
        return None if (value is None or not close) else value / close * 100.0

    return clean({
        "macd": macd_now,
        "signal": signal_now,
        "hist": hist_now,
        "macd_pct": as_pct(macd_now),
        "signal_pct": as_pct(signal_now),
        "hist_pct": as_pct(hist_now),
        "hist_slope": None if hist_now is None or hist_prev is None else hist_now - hist_prev,
        "cross_state": cross_state,
        "bars_since_cross": bars_since_cross,
        "above_zero": None if macd_now is None else macd_now > 0.0,
    })
