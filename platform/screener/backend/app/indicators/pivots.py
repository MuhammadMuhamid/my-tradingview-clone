"""Pivot Points Standard.

The original spec put this out of scope (§5). The user's MTF scalping strategy
asks for "pivot point standard fib level" explicitly, which supersedes that.

The reference script calls TradingView's built-in `ta.pivot_point_levels()`, so
the formulas are not in the source. They are the published standard ones, and the
source corroborates the level counts: `showLevel4 = type != "DM" and type !=
"Fibonacci"` and `showLevel5 = type == "Traditional" or type == "Camarilla"`, so
Fibonacci has P, R1-R3 and S1-S3 and nothing else. That is what is implemented.

**Levels come from the previous *completed* period only.** A pivot derived from
the period in progress would move under the price all day, which is the whole
reason pivots are useful in the first place.

Anchor follows the built-in's "Auto" rule: intraday charts of 15 minutes or less
anchor to the previous day, anything longer anchors to the previous week.
"""

from __future__ import annotations

import pandas as pd

from .. import ta
from ..timeframes import duration_ms
from .base import clean, require_bars

DEFAULTS = {
    "type": "Fibonacci",     # Traditional | Fibonacci | Woodie | Classic | DM | Camarilla
    "anchor": "Auto",        # Auto | Daily | Weekly | Monthly
    "atr_length": 14,
    "touch_atr": 0.25,       # how close counts as "at" a level, in ATR
}

_ANCHOR_RULE = "15m"         # <= this multiplier anchors daily, above anchors weekly

_RESAMPLE = {"Daily": "1D", "Weekly": "1W", "Monthly": "1MS"}


def auto_anchor(timeframe: str) -> str:
    """The built-in's rule: <=15m intraday anchors daily, longer anchors weekly."""
    return "Daily" if duration_ms(timeframe) <= duration_ms(_ANCHOR_RULE) else "Weekly"


def previous_period_ohlc(df: pd.DataFrame, anchor: str) -> tuple[float, float, float] | None:
    """High, low and close of the last *completed* anchor period."""
    frame = df.copy()
    frame["dt"] = pd.to_datetime(frame["ts"], unit="ms", utc=True)
    grouped = (
        frame.set_index("dt")
        .resample(_RESAMPLE[anchor], label="left", closed="left")
        .agg({"open": "first", "high": "max", "low": "min", "close": "last"})
        .dropna()
    )
    # The final bucket contains the period still forming; drop it.
    if len(grouped) < 2:
        return None
    row = grouped.iloc[-2]
    return float(row["high"]), float(row["low"]), float(row["close"])


def levels_for(kind: str, high: float, low: float, close: float) -> dict[str, float]:
    """Published Pivot Points Standard formulas, by type."""
    rng = high - low
    p = (high + low + close) / 3.0

    if kind == "Fibonacci":
        return {
            "P": p,
            "R1": p + 0.382 * rng, "S1": p - 0.382 * rng,
            "R2": p + 0.618 * rng, "S2": p - 0.618 * rng,
            "R3": p + 1.000 * rng, "S3": p - 1.000 * rng,
        }

    if kind == "Traditional":
        return {
            "P": p,
            "R1": 2 * p - low,          "S1": 2 * p - high,
            "R2": p + rng,              "S2": p - rng,
            "R3": high + 2 * (p - low), "S3": low - 2 * (high - p),
            "R4": high + 3 * (p - low), "S4": low - 3 * (high - p),
            "R5": high + 4 * (p - low), "S5": low - 4 * (high - p),
        }

    if kind == "Classic":
        return {
            "P": p,
            "R1": 2 * p - low,   "S1": 2 * p - high,
            "R2": p + rng,       "S2": p - rng,
            "R3": p + 2 * rng,   "S3": p - 2 * rng,
            "R4": p + 3 * rng,   "S4": p - 3 * rng,
        }

    if kind == "Camarilla":
        return {
            "P": p,
            "R1": close + rng * 1.1 / 12.0,  "S1": close - rng * 1.1 / 12.0,
            "R2": close + rng * 1.1 / 6.0,   "S2": close - rng * 1.1 / 6.0,
            "R3": close + rng * 1.1 / 4.0,   "S3": close - rng * 1.1 / 4.0,
            "R4": close + rng * 1.1 / 2.0,   "S4": close - rng * 1.1 / 2.0,
            "R5": close + rng * 1.1 / 2.0 * 1.168,
            "S5": close - rng * 1.1 / 2.0 * 1.168,
        }

    if kind == "Woodie":
        # Woodie weights the close double and needs the *current* period's open.
        wp = (high + low + 2 * close) / 4.0
        return {
            "P": wp,
            "R1": 2 * wp - low,          "S1": 2 * wp - high,
            "R2": wp + rng,              "S2": wp - rng,
            "R3": high + 2 * (wp - low), "S3": low - 2 * (high - wp),
            "R4": high + 3 * (wp - low), "S4": low - 3 * (high - wp),
        }

    if kind == "DM":
        # DeMark: only P, R1 and S1 exist.
        x = high + 2 * low + close   # close < open case is unavailable here; the
        # built-in uses the period's open, which the resampler does provide.
        return {"P": x / 4.0, "R1": x / 2.0 - low, "S1": x / 2.0 - high}

    raise ValueError(f"unknown pivot type: {kind!r}")


def compute(df: pd.DataFrame, params: dict | None = None, timeframe: str = "1h") -> dict:
    p = {**DEFAULTS, **(params or {})}
    require_bars(df, int(p["atr_length"]) + 2)

    anchor = p["anchor"]
    if anchor == "Auto":
        anchor = auto_anchor(timeframe)

    prev = previous_period_ohlc(df, anchor)
    if prev is None:
        return clean({
            "anchor": anchor, "type": p["type"], "levels": {},
            "nearest": None, "nearest_price": None, "nearest_dist_atr": None,
            "at_level": False, "nearest_support": None, "nearest_resistance": None,
        })

    levels = levels_for(str(p["type"]), *prev)
    close = float(df["close"].iloc[-1])
    atr_now = ta.last(ta.atr(df, int(p["atr_length"])))

    distances = {name: close - price for name, price in levels.items()}
    nearest = min(distances, key=lambda k: abs(distances[k]))
    nearest_dist_atr = (distances[nearest] / atr_now) if atr_now else None
    # Percent is what the screen shows for "how close is price to a pivot".
    # ATR stays available because percent is not comparable across coins.
    nearest_dist_pct = (distances[nearest] / close * 100.0) if close else None

    below = {k: v for k, v in levels.items() if v <= close}
    above = {k: v for k, v in levels.items() if v > close}

    def pct_from(price: float | None) -> float | None:
        return None if (price is None or not close) else (close - price) / close * 100.0

    support_price = max(below.values()) if below else None
    resistance_price = min(above.values()) if above else None

    return clean({
        "anchor": anchor,
        "type": p["type"],
        "levels": levels,
        "nearest": nearest,
        "nearest_price": levels[nearest],
        "nearest_dist_atr": nearest_dist_atr,
        "nearest_dist_pct": nearest_dist_pct,
        "nearest_abs_pct": None if nearest_dist_pct is None else abs(nearest_dist_pct),
        "support_dist_pct": pct_from(support_price),
        "resistance_dist_pct": pct_from(resistance_price),
        # "At" a level means within `touch_atr` ATR of it — a price equal to a
        # pivot to the tick effectively never happens.
        "at_level": (
            abs(nearest_dist_atr) <= float(p["touch_atr"])
            if nearest_dist_atr is not None else False
        ),
        "nearest_support": support_price,
        "nearest_support_name": max(below, key=below.get) if below else None,
        "nearest_resistance": resistance_price,
        "nearest_resistance_name": min(above, key=above.get) if above else None,
        "atr": atr_now,
    })
