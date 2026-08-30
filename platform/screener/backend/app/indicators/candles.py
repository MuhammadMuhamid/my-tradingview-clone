"""Candle patterns — §4.6. No source in the reference file; written from scratch.

Two rules govern the design:

**Every threshold is a named parameter.** There are no bare numbers inside the
conditionals. Anything that compares a size against the market — the noise
filter, the tweezer tolerance — is expressed in ATR, because a 40-point body is
a marubozu on one symbol and a rounding error on another.

**`strength` is a documented function of the bar's own ratios**, not an invented
0-100 score. Every pattern's strength is a value in `[0, 1]` measuring how far
past its own detection threshold the bar sits: **0.0 means the bar only just
qualified, 1.0 means the ideal form of the pattern.** The exact ratio used is
named in `STRENGTH_BASIS` and returned with each hit, so a reader can always see
what produced the number. Strengths are comparable *within* a pattern, and only
loosely across patterns — they measure textbook-ness, not predictive power.

Hammer vs Hanging Man, and Inverted Hammer vs Shooting Star, are the same shape
distinguished only by what came before. That context is an explicit parameter
(`trend_lookback`), not a hidden assumption: prior trend is the sign of
`close[i-1] - close[i-1-trend_lookback]`.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .. import ta
from .base import clean, require_bars

DEFAULTS = {
    # --- thresholds named by the spec ---
    "doji_body_ratio": 0.10,      # |body| / range below this is a doji
    "long_wick_ratio": 2.00,      # wick / body for the hammer family
    "opposite_wick_max": 0.30,    # opposite wick / range
    "marubozu_wick_max": 0.05,    # both wicks / range
    "min_body_atr": 0.30,         # noise filter, x ATR(14) — see note below
    # --- thresholds this implementation needs, also explicit ---
    "trend_lookback": 5,          # bars used to classify the prior trend
    "tweezer_tol_atr": 0.05,      # how equal two highs/lows must be, x ATR
    "star_body_ratio": 0.50,      # star body relative to the first bar's body
    "soldier_wick_max": 0.30,     # upper/lower wick / range for soldiers & crows
    "harami_containment": 1.00,   # inner body must be this fraction inside the outer
    "lookback": 5,                # how many closed bars back to search
    "atr_length": 14,
}

BULL, BEAR, NEUTRAL = "bull", "bear", "none"

#: What each pattern's `strength` is computed from. Returned with every hit.
STRENGTH_BASIS = {
    "Doji": "1 - body_ratio / doji_body_ratio",
    "Dragonfly Doji": "lower_wick / range, rescaled from (1 - opposite_wick_max) to 1",
    "Gravestone Doji": "upper_wick / range, rescaled from (1 - opposite_wick_max) to 1",
    "Hammer": "lower_wick / body, rescaled from long_wick_ratio to 3x it",
    "Hanging Man": "lower_wick / body, rescaled from long_wick_ratio to 3x it",
    "Inverted Hammer": "upper_wick / body, rescaled from long_wick_ratio to 3x it",
    "Shooting Star": "upper_wick / body, rescaled from long_wick_ratio to 3x it",
    "Marubozu": "1 - max(upper_wick, lower_wick) / range / marubozu_wick_max",
    "Bullish Engulfing": "body / previous body, rescaled from 1 to 3",
    "Bearish Engulfing": "body / previous body, rescaled from 1 to 3",
    "Piercing Line": "penetration of the previous body, rescaled from 0.5 to 1.0",
    "Dark Cloud Cover": "penetration of the previous body, rescaled from 0.5 to 1.0",
    "Bullish Harami": "1 - body / previous body",
    "Bearish Harami": "1 - body / previous body",
    "Tweezer Top": "1 - |high - previous high| / (tweezer_tol_atr * ATR)",
    "Tweezer Bottom": "1 - |low - previous low| / (tweezer_tol_atr * ATR)",
    "Morning Star": "close's penetration of the first body, rescaled from 0.5 to 1.0",
    "Evening Star": "close's penetration of the first body, rescaled from 0.5 to 1.0",
    "Three White Soldiers": "mean body_ratio of the three bars",
    "Three Black Crows": "mean body_ratio of the three bars",
}


@dataclass(frozen=True)
class Bar:
    o: float
    h: float
    l: float
    c: float

    @property
    def body(self) -> float:
        return abs(self.c - self.o)

    @property
    def range(self) -> float:
        return self.h - self.l

    @property
    def body_ratio(self) -> float:
        return self.body / self.range if self.range > 0 else 0.0

    @property
    def upper_wick(self) -> float:
        return self.h - max(self.o, self.c)

    @property
    def lower_wick(self) -> float:
        return min(self.o, self.c) - self.l

    @property
    def bullish(self) -> bool:
        return self.c > self.o

    @property
    def bearish(self) -> bool:
        return self.c < self.o

    @property
    def body_top(self) -> float:
        return max(self.o, self.c)

    @property
    def body_bottom(self) -> float:
        return min(self.o, self.c)

    @property
    def body_mid(self) -> float:
        return (self.o + self.c) / 2.0


def _scale(value: float, at_zero: float, at_one: float) -> float:
    """Map `value` onto [0, 1]: 0.0 at the detection threshold, 1.0 at the ideal."""
    if at_one == at_zero:
        return 0.0
    return float(np.clip((value - at_zero) / (at_one - at_zero), 0.0, 1.0))


def _bars(df: pd.DataFrame, i: int) -> Bar:
    row = df.iloc[i]
    return Bar(float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"]))


def _prior_trend(df: pd.DataFrame, i: int, lookback: int) -> str:
    """Trend *before* bar `i`, from closes only. `none` when there is no history."""
    j = i - 1
    if j - lookback < 0:
        return NEUTRAL
    delta = float(df["close"].iloc[j]) - float(df["close"].iloc[j - lookback])
    if delta > 0:
        return BULL
    if delta < 0:
        return BEAR
    return NEUTRAL


def _detect_at(df: pd.DataFrame, i: int, p: dict, atr: float) -> list[dict]:
    """Every pattern whose final bar is `i`."""
    hits: list[dict] = []

    def add(name: str, direction: str, strength: float) -> None:
        hits.append({
            "name": name,
            "direction": direction,
            "strength": round(float(np.clip(strength, 0.0, 1.0)), 4),
            "basis": STRENGTH_BASIS[name],
        })

    c0 = _bars(df, i)
    if c0.range <= 0:
        return hits

    doji_max = float(p["doji_body_ratio"])
    opp_max = float(p["opposite_wick_max"])
    wick_ratio = float(p["long_wick_ratio"])
    trend = _prior_trend(df, i, int(p["trend_lookback"]))

    # --- single-bar ---------------------------------------------------

    is_doji = c0.body_ratio <= doji_max
    if is_doji:
        lower_frac = c0.lower_wick / c0.range
        upper_frac = c0.upper_wick / c0.range
        if upper_frac <= opp_max and lower_frac >= 1.0 - opp_max - doji_max:
            add("Dragonfly Doji", BULL, _scale(lower_frac, 1.0 - opp_max - doji_max, 1.0))
        elif lower_frac <= opp_max and upper_frac >= 1.0 - opp_max - doji_max:
            add("Gravestone Doji", BEAR, _scale(upper_frac, 1.0 - opp_max - doji_max, 1.0))
        else:
            add("Doji", NEUTRAL, _scale(-c0.body_ratio, -doji_max, 0.0))

    if not is_doji and c0.body > 0:
        lower_over_body = c0.lower_wick / c0.body
        upper_over_body = c0.upper_wick / c0.body

        if lower_over_body >= wick_ratio and c0.upper_wick / c0.range <= opp_max:
            s = _scale(lower_over_body, wick_ratio, wick_ratio * 3.0)
            # Same shape; the prior trend is the only thing that separates them.
            if trend == BEAR:
                add("Hammer", BULL, s)
            elif trend == BULL:
                add("Hanging Man", BEAR, s)

        if upper_over_body >= wick_ratio and c0.lower_wick / c0.range <= opp_max:
            s = _scale(upper_over_body, wick_ratio, wick_ratio * 3.0)
            if trend == BEAR:
                add("Inverted Hammer", BULL, s)
            elif trend == BULL:
                add("Shooting Star", BEAR, s)

    maru_max = float(p["marubozu_wick_max"])
    worst_wick = max(c0.upper_wick, c0.lower_wick) / c0.range
    if worst_wick <= maru_max and c0.body > 0:
        add("Marubozu", BULL if c0.bullish else BEAR, _scale(-worst_wick, -maru_max, 0.0))

    # --- two-bar ------------------------------------------------------

    if i >= 1:
        c1 = _bars(df, i - 1)
        if c1.body > 0 and c0.body > 0:
            ratio = c0.body / c1.body

            if c1.bearish and c0.bullish and c0.c > c1.o and c0.o < c1.c:
                add("Bullish Engulfing", BULL, _scale(ratio, 1.0, 3.0))
            if c1.bullish and c0.bearish and c0.c < c1.o and c0.o > c1.c:
                add("Bearish Engulfing", BEAR, _scale(ratio, 1.0, 3.0))

            if c1.bearish and c0.bullish and c0.o < c1.c and c1.o > c0.c > c1.body_mid:
                penetration = (c0.c - c1.c) / c1.body
                add("Piercing Line", BULL, _scale(penetration, 0.5, 1.0))
            if c1.bullish and c0.bearish and c0.o > c1.c and c1.o < c0.c < c1.body_mid:
                penetration = (c1.c - c0.c) / c1.body
                add("Dark Cloud Cover", BEAR, _scale(penetration, 0.5, 1.0))

            contained = (
                c0.body_top <= c1.body_top
                and c0.body_bottom >= c1.body_bottom
                and ratio <= float(p["harami_containment"])
            )
            if contained and c1.bearish and c0.bullish:
                add("Bullish Harami", BULL, _scale(-ratio, -1.0, 0.0))
            if contained and c1.bullish and c0.bearish:
                add("Bearish Harami", BEAR, _scale(-ratio, -1.0, 0.0))

        tol = float(p["tweezer_tol_atr"]) * atr
        if tol > 0:
            if c1.bullish and c0.bearish and abs(c0.h - c1.h) <= tol:
                add("Tweezer Top", BEAR, _scale(-abs(c0.h - c1.h), -tol, 0.0))
            if c1.bearish and c0.bullish and abs(c0.l - c1.l) <= tol:
                add("Tweezer Bottom", BULL, _scale(-abs(c0.l - c1.l), -tol, 0.0))

    # --- three-bar ----------------------------------------------------

    if i >= 2:
        c2, c1 = _bars(df, i - 2), _bars(df, i - 1)
        star_max = float(p["star_body_ratio"])

        if c2.body > 0:
            star = c1.body / c2.body <= star_max
            if star and c2.bearish and c0.bullish and c0.c > c2.body_mid:
                add("Morning Star", BULL, _scale((c0.c - c2.c) / c2.body, 0.5, 1.0))
            if star and c2.bullish and c0.bearish and c0.c < c2.body_mid:
                add("Evening Star", BEAR, _scale((c2.c - c0.c) / c2.body, 0.5, 1.0))

        trio = (c2, c1, c0)
        wick_max = float(p["soldier_wick_max"])
        rising = c2.c < c1.c < c0.c
        falling = c2.c > c1.c > c0.c
        opens_inside_up = c2.body_bottom <= c1.o <= c2.body_top and c1.body_bottom <= c0.o <= c1.body_top
        opens_inside_dn = c2.body_bottom <= c1.o <= c2.body_top and c1.body_bottom <= c0.o <= c1.body_top

        if all(b.bullish for b in trio) and rising and opens_inside_up \
                and all(b.upper_wick / b.range <= wick_max for b in trio if b.range > 0):
            add("Three White Soldiers", BULL, float(np.mean([b.body_ratio for b in trio])))

        if all(b.bearish for b in trio) and falling and opens_inside_dn \
                and all(b.lower_wick / b.range <= wick_max for b in trio if b.range > 0):
            add("Three Black Crows", BEAR, float(np.mean([b.body_ratio for b in trio])))

    return hits


def compute(df: pd.DataFrame, params: dict | None = None) -> dict:
    p = {**DEFAULTS, **(params or {})}
    lookback = int(p["lookback"])
    require_bars(df, int(p["atr_length"]) + int(p["trend_lookback"]) + lookback + 3)

    atr_series = ta.atr(df, int(p["atr_length"]))
    n = len(df)

    seen: dict[str, dict] = {}
    for bars_ago in range(lookback):
        i = n - 1 - bars_ago
        atr = atr_series.iloc[i]
        if not np.isfinite(atr) or atr <= 0:
            continue

        # §4.6 noise filter. Measured on the bar's *range*, not its body: a doji
        # has no body by construction, so a body-based filter would make the
        # whole doji family undetectable. Parameter name kept from the spec.
        if (float(df["high"].iloc[i]) - float(df["low"].iloc[i])) < float(p["min_body_atr"]) * atr:
            continue

        for hit in _detect_at(df, i, p, float(atr)):
            # Keep only the most recent occurrence of each pattern.
            if hit["name"] not in seen:
                seen[hit["name"]] = {**hit, "bars_ago": bars_ago}

    patterns = sorted(seen.values(), key=lambda h: (h["bars_ago"], -h["strength"], h["name"]))

    top_pattern = patterns[0]["name"] if patterns else None

    # Bias comes from the most recent bar that produced anything. Conflicting
    # patterns on that bar cancel — §4.6 requires both be reported and the bias
    # be `none`, not a majority vote.
    net_bias = NEUTRAL
    if patterns:
        newest = patterns[0]["bars_ago"]
        directions = {h["direction"] for h in patterns if h["bars_ago"] == newest}
        directions.discard(NEUTRAL)
        net_bias = directions.pop() if len(directions) == 1 else NEUTRAL

    return clean({
        "patterns": patterns,
        "top_pattern": top_pattern,
        "net_bias": net_bias,
        "pattern_count": len(patterns),
    })
