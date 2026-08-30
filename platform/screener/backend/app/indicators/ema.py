"""EMA distance — §4.1.

`dist_pct` alone is not comparable across coins: 5% off the 200 EMA is noise on a
high-volatility alt and a dislocation on BTC. `dist_atr` divides by ATR(14)
instead, which is why it is the default sort key for these columns.
"""

from __future__ import annotations

import pandas as pd

from .. import ta
from .base import clean, require_bars

DEFAULTS = {"lengths": [21, 50, 100, 200], "source": "close", "atr_length": 14}


def compute(df: pd.DataFrame, params: dict | None = None) -> dict:
    p = {**DEFAULTS, **(params or {})}
    lengths = [int(n) for n in p["lengths"]]
    require_bars(df, max(lengths) + 1)

    src = ta.source(df, p["source"])
    close = float(df["close"].iloc[-1])
    atr_now = ta.last(ta.atr(df, int(p["atr_length"])))

    out: dict = {}
    dist_atr: dict[int, float] = {}
    values: dict[int, float] = {}

    for n in lengths:
        value = ta.last(ta.ema(src, n))
        out[f"ema_{n}"] = value
        if value is None or value == 0:
            out[f"dist_pct_{n}"] = None
            out[f"dist_atr_{n}"] = None
            continue
        values[n] = value
        out[f"dist_pct_{n}"] = (close - value) / value * 100.0
        if atr_now:
            d = (close - value) / atr_now
            out[f"dist_atr_{n}"] = d
            dist_atr[n] = d
        else:
            out[f"dist_atr_{n}"] = None

    ordered = [values.get(n) for n in sorted(lengths)]
    if all(v is not None for v in ordered) and len(ordered) > 1:
        if all(a > b for a, b in zip(ordered, ordered[1:])):
            out["stack"] = "bull"       # 21 > 50 > 100 > 200
        elif all(a < b for a, b in zip(ordered, ordered[1:])):
            out["stack"] = "bear"
        else:
            out["stack"] = "mixed"
    else:
        out["stack"] = None

    out["nearest_ema"] = min(dist_atr, key=lambda n: abs(dist_atr[n])) if dist_atr else None
    out["atr"] = atr_now
    return clean(out)
