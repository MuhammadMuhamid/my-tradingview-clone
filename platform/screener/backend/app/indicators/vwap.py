"""VWAP, session-anchored.

Crypto trades continuously, so "session" means the UTC day unless configured
otherwise. The anchor matters: a VWAP computed over the whole cached window is a
different line from the one a chart shows, and the strategy rule "candles must be
above vwap" is meaningless if the two disagree.

Typical price is `hlc3`, matching TradingView's built-in.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .. import ta
from .base import clean, require_bars

DEFAULTS = {"anchor": "Daily", "source": "hlc3", "atr_length": 14, "bands": [1.0, 2.0]}

_FLOOR = {"Daily": "1D", "Weekly": "1W", "Monthly": "1MS"}


def series(df: pd.DataFrame, params: dict | None = None) -> pd.DataFrame:
    """Running VWAP and its standard-deviation bands, reset at each anchor."""
    p = {**DEFAULTS, **(params or {})}
    src = ta.source(df, p["source"])
    volume = df["volume"].astype("float64")

    dt = pd.to_datetime(df["ts"], unit="ms", utc=True)
    session = dt.dt.floor("D") if p["anchor"] == "Daily" else dt.dt.to_period(
        "W" if p["anchor"] == "Weekly" else "M"
    ).dt.start_time

    pv = (src * volume).groupby(session).cumsum()
    cum_v = volume.groupby(session).cumsum()
    vwap = pv / cum_v.where(cum_v != 0)

    # Variance of price around the running VWAP, same session grouping.
    pv2 = ((src ** 2) * volume).groupby(session).cumsum()
    variance = (pv2 / cum_v.where(cum_v != 0)) - vwap ** 2
    stdev = np.sqrt(variance.clip(lower=0.0))

    out = pd.DataFrame({"vwap": vwap, "stdev": stdev}, index=df.index)
    for mult in p["bands"]:
        out[f"upper_{mult}"] = vwap + mult * stdev
        out[f"lower_{mult}"] = vwap - mult * stdev
    return out


def compute(df: pd.DataFrame, params: dict | None = None) -> dict:
    p = {**DEFAULTS, **(params or {})}
    require_bars(df, int(p["atr_length"]) + 2)

    s = series(df, p)
    value = ta.last(s["vwap"])
    close = float(df["close"].iloc[-1])
    atr_now = ta.last(ta.atr(df, int(p["atr_length"])))

    above = None if value is None else close > value

    return clean({
        "vwap": value,
        "anchor": p["anchor"],
        "above_vwap": above,
        # The user's rule: above VWAP reads bullish, below reads bearish. Stated
        # as a bias so the column shows a word rather than a boolean.
        "bias": None if above is None else ("bull" if above else "bear"),
        "dist_pct": None if not value else (close - value) / value * 100.0,
        "dist_atr": None if (value is None or not atr_now) else (close - value) / atr_now,
        "bars_in_session": int((
            pd.to_datetime(df["ts"], unit="ms", utc=True).dt.floor("D")
            == pd.to_datetime(df["ts"].iloc[-1], unit="ms", utc=True).floor("D")
        ).sum()),
    })
