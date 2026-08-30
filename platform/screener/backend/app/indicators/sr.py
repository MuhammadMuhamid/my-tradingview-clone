"""Support & Resistance — §4.8. A reimplementation, not a port.

The Flux Charts MTF script in `screener.rtf` is a ~600-line drawing engine: line
and box pools, break/retest labels, ephemeral flipped levels, `dynamic_requests`,
timeframe-string bookkeeping. All of that exists to render on one chart. This
needs level *extraction* across 36 symbols, so only the level-finding core is
reimplemented, following the five steps §4.8 lays out.

Two places where the spec and the source disagree, spec followed in both:

* **Strength.** §4.8 defines it as the number of pivots in a cluster. The source
  instead starts every level at 1 and increments on retests, and never clusters —
  it *discards* a new pivot that lands within `tooCloseATR` of an existing level.
  (Its resistance branch also compares against `pivotLow` where `pivotHigh` was
  meant, so near-duplicate resistances are rejected against the wrong series.
  Not reproduced.)
* **Type.** The source types a level by the pivot that made it and keeps broken
  levels around as flipped "ephemeral" ones. Here a surviving level is a support
  or a resistance purely by which side of the current close it sits on, which is
  what `position_in_range` needs.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .. import ta
from .base import clean, require_bars

DEFAULTS = {
    "pivot_length": 15,
    "min_strength": 1,
    "invalidation": "Close",     # or "Wick"
    "max_distance_bars": 500,
    "atr_length": 20,
    "too_close_atr": 1.0 / 8.0,  # the source's `tooCloseATR`
}


@dataclass
class Level:
    price: float
    strength: int                       # pivots in the cluster
    formed_at: int                      # bar index where the last pivot confirmed
    pivot_indices: list[int] = field(default_factory=list)
    kinds: list[str] = field(default_factory=list)  # "high" / "low" of each pivot

    def to_json(self, close: float, atr: float | None) -> dict:
        return {
            "price": self.price,
            "strength": self.strength,
            "side": "resistance" if self.price > close else "support",
            "formed_at": self.formed_at,
            "dist_pct": (self.price - close) / close * 100.0 if close else None,
            "dist_atr": (self.price - close) / atr if atr else None,
        }


def find_pivots(df: pd.DataFrame, length: int) -> tuple[list[int], list[int]]:
    """`ta.pivothigh(length, length)` / `ta.pivotlow(length, length)` indices.

    A pivot at bar `i` needs `length` bars on each side, so it is not confirmed
    until bar `i + length`. Bars within `length` of the end are therefore never
    pivots here — that lag is what keeps the module from repainting.
    """
    high = df["high"].to_numpy(dtype="float64")
    low = df["low"].to_numpy(dtype="float64")
    n = len(df)

    highs: list[int] = []
    lows: list[int] = []
    for i in range(length, n - length):
        window_h = high[i - length : i + length + 1]
        if high[i] == window_h.max() and (window_h == high[i]).sum() == 1:
            highs.append(i)
        window_l = low[i - length : i + length + 1]
        if low[i] == window_l.min() and (window_l == low[i]).sum() == 1:
            lows.append(i)
    return highs, lows


def _cluster(pivots: list[tuple[int, float, str]], too_close: float) -> list[Level]:
    """Single-linkage clustering on price. Pivots within `too_close` merge."""
    if not pivots:
        return []

    ordered = sorted(pivots, key=lambda p: p[1])
    groups: list[list[tuple[int, float, str]]] = [[ordered[0]]]
    for pivot in ordered[1:]:
        if pivot[1] - groups[-1][-1][1] <= too_close:
            groups[-1].append(pivot)
        else:
            groups.append([pivot])

    levels: list[Level] = []
    for group in groups:
        levels.append(Level(
            price=float(np.mean([p[1] for p in group])),
            strength=len(group),
            formed_at=max(p[0] for p in group),
            pivot_indices=sorted(p[0] for p in group),
            kinds=[p[2] for p in group],
        ))
    return levels


def _survives(level: Level, df: pd.DataFrame, length: int, invalidation: str) -> bool:
    """§4.8 step 4 — a level dies when price closes (or wicks) through it.

    Direction is fixed at the level's confirmation bar: a level that sat above
    price then is a resistance and dies on a close above it, and the mirror for a
    support. The source keeps broken levels as flipped "ephemeral" ones, but only
    behind an option that is off by default, so they are simply dropped here.
    """
    start = level.formed_at + length          # the bar the last pivot confirmed on
    if start >= len(df):
        return False

    close = df["close"].to_numpy(dtype="float64")
    ref_close = close[start]
    if ref_close == level.price:
        return False

    was_resistance = level.price > ref_close
    after = slice(start + 1, None)

    if invalidation == "Wick":
        breached = df["high"].to_numpy()[after] if was_resistance else df["low"].to_numpy()[after]
    else:
        breached = close[after]

    if len(breached) == 0:
        return True
    return not (breached > level.price).any() if was_resistance else not (breached < level.price).any()


def levels(df: pd.DataFrame, params: dict | None = None) -> list[Level]:
    """Every surviving level, nearest-price-first ordering left to the caller."""
    p = {**DEFAULTS, **(params or {})}
    length = int(p["pivot_length"])
    atr_now = ta.last(ta.atr(df, int(p["atr_length"])))
    if not atr_now:
        return []

    too_close = atr_now * float(p["too_close_atr"])
    n = len(df)
    horizon = n - int(p["max_distance_bars"])   # §4.8 step 5

    highs, lows = find_pivots(df, length)
    pivots: list[tuple[int, float, str]] = []
    for i in highs:
        if i >= horizon:
            pivots.append((i, float(df["high"].iloc[i]), "high"))
    for i in lows:
        if i >= horizon:
            pivots.append((i, float(df["low"].iloc[i]), "low"))

    found = _cluster(pivots, too_close)
    min_strength = int(p["min_strength"])
    invalidation = str(p["invalidation"])

    return [
        lvl for lvl in found
        if lvl.strength >= min_strength and _survives(lvl, df, length, invalidation)
    ]


def compute(df: pd.DataFrame, params: dict | None = None) -> dict:
    p = {**DEFAULTS, **(params or {})}
    require_bars(df, 2 * int(p["pivot_length"]) + int(p["atr_length"]) + 2)

    close = float(df["close"].iloc[-1])
    atr_now = ta.last(ta.atr(df, int(p["atr_length"])))
    too_close = (atr_now or 0.0) * float(p["too_close_atr"])

    found = levels(df, p)
    supports = sorted((l for l in found if l.price <= close), key=lambda l: close - l.price)
    resistances = sorted((l for l in found if l.price > close), key=lambda l: l.price - close)

    nearest_support = supports[0] if supports else None
    nearest_resistance = resistances[0] if resistances else None

    def dist_pct(level: Level | None) -> float | None:
        return None if level is None else abs(close - level.price) / close * 100.0

    def dist_atr(level: Level | None) -> float | None:
        if level is None or not atr_now:
            return None
        return abs(close - level.price) / atr_now

    position = None
    if nearest_support is not None and nearest_resistance is not None:
        span = nearest_resistance.price - nearest_support.price
        if span > 0:
            position = (close - nearest_support.price) / span

    in_zone = any(abs(close - l.price) <= too_close for l in found) if too_close else False

    return clean({
        "nearest_support": None if nearest_support is None else nearest_support.price,
        "nearest_resistance": None if nearest_resistance is None else nearest_resistance.price,
        "dist_to_support_pct": dist_pct(nearest_support),
        "dist_to_resistance_pct": dist_pct(nearest_resistance),
        "dist_to_support_atr": dist_atr(nearest_support),
        "dist_to_resistance_atr": dist_atr(nearest_resistance),
        "support_strength": None if nearest_support is None else nearest_support.strength,
        "resistance_strength": None if nearest_resistance is None else nearest_resistance.strength,
        "in_zone": in_zone,
        "position_in_range": position,
        "level_count": len(found),
        "levels": [l.to_json(close, atr_now) for l in sorted(found, key=lambda l: l.price)],
    })
