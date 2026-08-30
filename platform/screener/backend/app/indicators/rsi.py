"""RSI — §4.2. Wilder's smoothing (`ta.rma`), matching the Pine reference."""

from __future__ import annotations

import pandas as pd

from .. import ta
from .base import clean, require_bars

DEFAULTS = {"length": 14, "source": "close", "oversold": 30.0, "overbought": 70.0}


def compute(df: pd.DataFrame, params: dict | None = None) -> dict:
    p = {**DEFAULTS, **(params or {})}
    length = int(p["length"])
    require_bars(df, length + 2)

    series = ta.rsi(ta.source(df, p["source"]), length)
    now = ta.last(series)
    prev = ta.last(series, 1)

    state = None
    if now is not None:
        if now < float(p["oversold"]):
            state = "oversold"
        elif now > float(p["overbought"]):
            state = "overbought"
        else:
            state = "neutral"

    return clean({
        "rsi": now,
        "rsi_prev": prev,
        "slope": None if now is None or prev is None else now - prev,
        "state": state,
    })
