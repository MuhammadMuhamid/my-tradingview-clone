"""Canonical causal candlestick-pattern detector.

This is the one implementation used by Screener and the pattern-analysis API
consumed by chart, Research export, and server alerts. A hit belongs to its
final candle and is knowable only after that candle closes. Detection is a
description of OHLC geometry, never a claim about future returns.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from typing import Any

import numpy as np
import pandas as pd

from .. import ta
from .base import clean, require_bars

DETECTOR_ID = "trading-scene-candlesticks"
DETECTOR_VERSION = "2.0.0"
CATALOG_OBSERVED_AT = "2026-09-08"
BULL, BEAR, NEUTRAL = "bull", "bear", "none"

DEFAULTS: dict[str, Any] = {
    "doji_body_ratio": 0.10,
    "long_wick_ratio": 2.00,
    "opposite_wick_max": 0.30,
    "marubozu_wick_max": 0.05,
    # Historical key retained for compatibility; this is whole-candle range.
    "min_body_atr": 0.10,
    "trend_lookback": 5,
    "trend_sma_length": 50,
    "trend_method": "sma50",
    "tweezer_tol_atr": 0.05,
    "star_body_ratio": 0.50,
    "soldier_wick_max": 0.30,
    "harami_containment": 0.50,
    "body_avg_length": 14,
    "long_body_factor": 1.00,
    "short_body_factor": 0.50,
    "neck_tolerance_ratio": 0.10,
    "lookback": 5,
    "atr_length": 14,
    "bar_duration_ms": 0,
    "direction": "both",
}

# Stable id, exact TradingView UI name observed on 2026-09-08, direction, bars.
_ROWS = [
    ("abandoned_baby_bearish", "Abandoned Baby - Bearish", BEAR, 3),
    ("abandoned_baby_bullish", "Abandoned Baby - Bullish", BULL, 3),
    ("dark_cloud_cover_bearish", "Dark Cloud Cover - Bearish", BEAR, 2),
    ("doji", "Doji", NEUTRAL, 1),
    ("doji_star_bearish", "Doji Star - Bearish", BEAR, 2),
    ("doji_star_bullish", "Doji Star - Bullish", BULL, 2),
    ("downside_tasuki_gap_bearish", "Downside Tasuki Gap - Bearish", BEAR, 3),
    ("dragonfly_doji_bullish", "Dragonfly Doji - Bullish", BULL, 1),
    ("engulfing_bearish", "Engulfing - Bearish", BEAR, 2),
    ("engulfing_bullish", "Engulfing - Bullish", BULL, 2),
    ("evening_doji_star_bearish", "Evening Doji Star - Bearish", BEAR, 3),
    ("evening_star_bearish", "Evening Star - Bearish", BEAR, 3),
    ("falling_three_methods_bearish", "Falling Three Methods - Bearish", BEAR, 5),
    ("falling_window_bearish", "Falling Window - Bearish", BEAR, 2),
    ("gravestone_doji_bearish", "Gravestone Doji - Bearish", BEAR, 1),
    ("hammer_bullish", "Hammer - Bullish", BULL, 1),
    ("hanging_man_bearish", "Hanging Man - Bearish", BEAR, 1),
    ("harami_bearish", "Harami - Bearish", BEAR, 2),
    ("harami_bullish", "Harami - Bullish", BULL, 2),
    ("harami_cross_bearish", "Harami Cross - Bearish", BEAR, 2),
    ("harami_cross_bullish", "Harami Cross - Bullish", BULL, 2),
    ("inverted_hammer_bullish", "Inverted Hammer - Bullish", BULL, 1),
    ("kicking_bearish", "Kicking - Bearish", BEAR, 2),
    ("kicking_bullish", "Kicking - Bullish", BULL, 2),
    ("long_lower_shadow_bullish", "Long Lower Shadow - Bullish", BULL, 1),
    ("long_upper_shadow_bearish", "Long Upper Shadow - Bearish", BEAR, 1),
    ("marubozu_black_bearish", "Marubozu Black - Bearish", BEAR, 1),
    ("marubozu_white_bullish", "Marubozu White - Bullish", BULL, 1),
    ("morning_doji_star_bullish", "Morning Doji Star - Bullish", BULL, 3),
    ("morning_star_bullish", "Morning Star - Bullish", BULL, 3),
    ("on_neck_bearish", "On Neck - Bearish", BEAR, 2),
    ("piercing_bullish", "Piercing - Bullish", BULL, 2),
    ("rising_three_methods_bullish", "Rising Three Methods - Bullish", BULL, 5),
    ("rising_window_bullish", "Rising Window - Bullish", BULL, 2),
    ("shooting_star_bearish", "Shooting Star - Bearish", BEAR, 1),
    ("spinning_top_black", "Spinning Top Black", NEUTRAL, 1),
    ("spinning_top_white", "Spinning Top White", NEUTRAL, 1),
    ("three_black_crows_bearish", "Three Black Crows - Bearish", BEAR, 3),
    ("three_white_soldiers_bullish", "Three White Soldiers - Bullish", BULL, 3),
    ("tri_star_bearish", "Tri-Star - Bearish", BEAR, 3),
    ("tri_star_bullish", "Tri-Star - Bullish", BULL, 3),
    ("tweezer_bottom_bullish", "Tweezer Bottom - Bullish", BULL, 2),
    ("tweezer_top_bearish", "Tweezer Top - Bearish", BEAR, 2),
    ("upside_tasuki_gap_bullish", "Upside Tasuki Gap - Bullish", BULL, 3),
]
CATALOG = tuple({
    "id": pid, "name": name, "direction": direction, "bars": bars,
    "confirmation": "bar_close", "predictive_claim": False,
} for pid, name, direction, bars in _ROWS)
CATALOG_BY_NAME = {item["name"]: item for item in CATALOG}
CATALOG_BY_ID = {item["id"]: item for item in CATALOG}
STRENGTH_BASIS = {
    item["name"]: "geometric margin past named thresholds; not predictive"
    for item in CATALOG
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
        return max(0.0, self.h - max(self.o, self.c))

    @property
    def lower_wick(self) -> float:
        return max(0.0, min(self.o, self.c) - self.l)

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
        return (self.o + self.c) / 2


def catalog() -> list[dict[str, Any]]:
    return [dict(item) for item in CATALOG]


def normalized_settings(params: dict | None = None) -> dict[str, Any]:
    supplied = params or {}
    unknown = set(supplied) - set(DEFAULTS)
    if unknown:
        raise ValueError(f"unsupported candlestick setting: {sorted(unknown)[0]}")
    p = {**DEFAULTS, **supplied}
    if p["trend_method"] not in {"sma50", "close_change"}:
        raise ValueError("trend_method must be sma50 or close_change")
    if p["direction"] not in {"both", BULL, BEAR}:
        raise ValueError("direction must be both, bull, or bear")
    for key in ("lookback", "atr_length", "body_avg_length", "trend_sma_length", "trend_lookback"):
        p[key] = int(p[key])
        if p[key] < 1:
            raise ValueError(f"{key} must be positive")
    p["bar_duration_ms"] = int(p["bar_duration_ms"])
    if p["bar_duration_ms"] < 0:
        raise ValueError("bar_duration_ms must not be negative")
    ratios = (
        "doji_body_ratio", "opposite_wick_max", "marubozu_wick_max",
        "star_body_ratio", "soldier_wick_max", "harami_containment",
    )
    nonnegative = ("min_body_atr", "tweezer_tol_atr", "neck_tolerance_ratio")
    positive = ("long_wick_ratio", "long_body_factor", "short_body_factor")
    for key in (*ratios, *nonnegative, *positive):
        p[key] = float(p[key])
        if not math.isfinite(p[key]):
            raise ValueError(f"{key} must be finite")
    for key in ratios:
        if not 0 <= p[key] <= 1:
            raise ValueError(f"{key} must be between 0 and 1")
    for key in nonnegative:
        if p[key] < 0:
            raise ValueError(f"{key} must not be negative")
    for key in positive:
        if p[key] <= 0:
            raise ValueError(f"{key} must be positive")
    return p


def settings_hash(settings: dict[str, Any]) -> str:
    raw = json.dumps(settings, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()[:16]


def _scale(value: float, at_zero: float, at_one: float) -> float:
    if at_one == at_zero:
        return 0.0
    return float(np.clip((value - at_zero) / (at_one - at_zero), 0, 1))


def _bar(df: pd.DataFrame, i: int) -> Bar:
    row = df.iloc[i]
    return Bar(float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"]))


def _valid(bar: Bar) -> bool:
    return (
        all(np.isfinite(v) for v in (bar.o, bar.h, bar.l, bar.c))
        and bar.h >= max(bar.o, bar.c)
        and bar.l <= min(bar.o, bar.c)
        and bar.range > 0
    )


def _trend(df: pd.DataFrame, i: int, p: dict[str, Any]) -> str:
    """TradingView's documented current-close/SMA trend, known at bar close."""
    j = i
    if p["trend_method"] == "close_change":
        k = j - int(p["trend_lookback"])
        if k < 0:
            return NEUTRAL
        delta = float(df["close"].iloc[j]) - float(df["close"].iloc[k])
    else:
        length = int(p["trend_sma_length"])
        if j - length + 1 < 0:
            return NEUTRAL
        delta = float(df["close"].iloc[j]) - float(df["close"].iloc[j-length+1:j+1].mean())
    return BULL if delta > 0 else BEAR if delta < 0 else NEUTRAL


def _detect_at(df: pd.DataFrame, i: int, p: dict[str, Any], atr: float) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []

    def add(name: str, strength: float) -> None:
        meta = CATALOG_BY_NAME[name]
        if p["direction"] != "both" and meta["direction"] != p["direction"]:
            return
        hits.append({
            **meta,
            "strength": round(float(np.clip(strength, 0, 1)), 4),
            "basis": STRENGTH_BASIS[name],
        })

    c0 = _bar(df, i)
    if not _valid(c0):
        return hits
    c1 = _bar(df, i - 1) if i >= 1 else None
    c2 = _bar(df, i - 2) if i >= 2 else None
    body_avg = float((df["close"].iloc[max(0, i-int(p["body_avg_length"])):i]
                      - df["open"].iloc[max(0, i-int(p["body_avg_length"])):i]).abs().mean())
    long_min = body_avg * float(p["long_body_factor"])
    short_max = body_avg * float(p["short_body_factor"])
    doji_max = float(p["doji_body_ratio"])
    wick_ratio = float(p["long_wick_ratio"])
    opp_max = float(p["opposite_wick_max"])
    maru_max = float(p["marubozu_wick_max"])
    trend = _trend(df, i, p)

    is_doji = lambda b: b.body_ratio <= doji_max
    is_long = lambda b: b.body >= long_min and b.body > 0
    is_short = lambda b: b.body <= short_max
    is_maru = lambda b: b.body > 0 and max(b.upper_wick, b.lower_wick) / b.range <= maru_max
    gap_up = lambda a, b: b.body_bottom > a.body_top
    gap_down = lambda a, b: b.body_top < a.body_bottom

    # Single-bar family.
    if is_doji(c0):
        lo, up = c0.lower_wick / c0.range, c0.upper_wick / c0.range
        if up <= opp_max and lo >= 1 - opp_max - doji_max:
            add("Dragonfly Doji - Bullish", _scale(lo, 1-opp_max-doji_max, 1))
        elif lo <= opp_max and up >= 1 - opp_max - doji_max:
            add("Gravestone Doji - Bearish", _scale(up, 1-opp_max-doji_max, 1))
        else:
            add("Doji", _scale(-c0.body_ratio, -doji_max, 0))
    if not is_doji(c0) and c0.body > 0:
        lo, up = c0.lower_wick / c0.body, c0.upper_wick / c0.body
        if is_short(c0) and lo >= wick_ratio and c0.upper_wick / c0.range <= opp_max and trend != NEUTRAL:
            add("Hammer - Bullish" if trend == BEAR else "Hanging Man - Bearish",
                _scale(lo, wick_ratio, wick_ratio * 3))
        if is_short(c0) and up >= wick_ratio and c0.lower_wick / c0.range <= opp_max and trend != NEUTRAL:
            add("Inverted Hammer - Bullish" if trend == BEAR else "Shooting Star - Bearish",
                _scale(up, wick_ratio, wick_ratio * 3))
        if is_short(c0) and lo >= wick_ratio and c0.lower_wick > c0.upper_wick * 2:
            add("Long Lower Shadow - Bullish", _scale(lo, wick_ratio, wick_ratio * 4))
        if is_short(c0) and up >= wick_ratio and c0.upper_wick > c0.lower_wick * 2:
            add("Long Upper Shadow - Bearish", _scale(up, wick_ratio, wick_ratio * 4))
    worst_wick = max(c0.upper_wick, c0.lower_wick) / c0.range
    if is_maru(c0) and is_long(c0):
        add("Marubozu White - Bullish" if c0.bullish else "Marubozu Black - Bearish",
            _scale(-worst_wick, -maru_max, 0))
    if not is_doji(c0) and is_short(c0) and c0.upper_wick >= c0.body and c0.lower_wick >= c0.body:
        fit = min(c0.upper_wick, c0.lower_wick) / max(c0.body, 1e-12)
        add("Spinning Top White" if c0.bullish else "Spinning Top Black",
            _scale(fit, 1, 3))

    # Two-bar family.
    if c1 is not None and _valid(c1):
        ratio = c0.body / c1.body if c1.body > 0 else 0
        contained = (c1.l <= c0.l and c0.h <= c1.h
                     and ratio <= float(p["harami_containment"]))
        if (trend == BEAR and c1.bearish and is_short(c1) and c0.bullish and is_long(c0)
                and c0.body > c1.body and c0.c >= c1.o and c0.o <= c1.c):
            add("Engulfing - Bullish", _scale(ratio, 1, 3))
        if (trend == BULL and c1.bullish and is_short(c1) and c0.bearish and is_long(c0)
                and c0.body > c1.body and c0.c <= c1.o and c0.o >= c1.c):
            add("Engulfing - Bearish", _scale(ratio, 1, 3))
        if trend == BEAR and is_long(c1) and c1.bearish and c0.bullish and c0.o < c1.l and c1.o > c0.c > c1.body_mid:
            add("Piercing - Bullish", _scale((c0.c-c1.c)/c1.body, .5, 1))
        if trend == BULL and is_long(c1) and c1.bullish and c0.bearish and c0.o > c1.h and c1.o < c0.c < c1.body_mid:
            add("Dark Cloud Cover - Bearish", _scale((c1.c-c0.c)/c1.body, .5, 1))
        if contained and is_long(c1) and is_short(c0) and not is_doji(c0):
            if trend == BEAR and c1.bearish and c0.bullish:
                add("Harami - Bullish", _scale(-ratio, -1, 0))
            if trend == BULL and c1.bullish and c0.bearish:
                add("Harami - Bearish", _scale(-ratio, -1, 0))
        if contained and is_long(c1) and is_doji(c0):
            if trend == BEAR and c1.bearish:
                add("Harami Cross - Bullish", _scale(-c0.body_ratio, -doji_max, 0))
            if trend == BULL and c1.bullish:
                add("Harami Cross - Bearish", _scale(-c0.body_ratio, -doji_max, 0))
        if is_doji(c0) and is_long(c1):
            if trend == BULL and c1.bullish and gap_up(c1, c0):
                add("Doji Star - Bearish", _scale(c0.body_bottom-c1.body_top, 0, atr))
            if trend == BEAR and c1.bearish and gap_down(c1, c0):
                add("Doji Star - Bullish", _scale(c1.body_bottom-c0.body_top, 0, atr))
        if c0.l > c1.h:
            add("Rising Window - Bullish", _scale(c0.l-c1.h, 0, atr))
        if c0.h < c1.l:
            add("Falling Window - Bearish", _scale(c1.l-c0.h, 0, atr))
        if is_maru(c1) and is_maru(c0):
            if c1.bearish and c0.bullish and gap_up(c1, c0):
                add("Kicking - Bullish", _scale(c0.body_bottom-c1.body_top, 0, atr))
            if c1.bullish and c0.bearish and gap_down(c1, c0):
                add("Kicking - Bearish", _scale(c1.body_bottom-c0.body_top, 0, atr))
        if trend == BEAR and is_long(c1) and c1.bearish and c0.bullish and c0.o < c1.l:
            tol = max(c1.body * float(p["neck_tolerance_ratio"]), 1e-12)
            if abs(c0.c-c1.l) <= tol:
                add("On Neck - Bearish", _scale(-abs(c0.c-c1.l), -tol, 0))
        tol = float(p["tweezer_tol_atr"]) * atr
        if tol > 0:
            if (trend == BULL and c1.bullish and c0.bearish
                    and is_long(c1) and abs(c0.h-c1.h) <= tol):
                add("Tweezer Top - Bearish", _scale(-abs(c0.h-c1.h), -tol, 0))
            if (trend == BEAR and c1.bearish and c0.bullish
                    and is_long(c1) and abs(c0.l-c1.l) <= tol):
                add("Tweezer Bottom - Bullish", _scale(-abs(c0.l-c1.l), -tol, 0))

    # Three-bar family.
    if c2 is not None and c1 is not None and _valid(c2) and _valid(c1):
        star = (c2.body > 0 and is_long(c2) and is_short(c1)
                and c1.body / c2.body <= float(p["star_body_ratio"]))
        if (star and trend == BEAR and c2.bearish and c0.bullish and is_long(c0)
                and gap_down(c2, c1) and gap_up(c1, c0) and c0.c > c2.body_mid):
            add("Morning Star - Bullish", _scale((c0.c-c2.c)/c2.body, .5, 1))
            if is_doji(c1):
                add("Morning Doji Star - Bullish", _scale((c0.c-c2.c)/c2.body, .5, 1))
        if (star and trend == BULL and c2.bullish and c0.bearish and is_long(c0)
                and gap_up(c2, c1) and gap_down(c1, c0) and c0.c < c2.body_mid):
            add("Evening Star - Bearish", _scale((c2.c-c0.c)/c2.body, .5, 1))
            if is_doji(c1):
                add("Evening Doji Star - Bearish", _scale((c2.c-c0.c)/c2.body, .5, 1))
        if trend == BEAR and c2.bearish and is_long(c2) and is_doji(c1) and c0.bullish:
            # Bullish abandoned baby: the doji is isolated BELOW both real
            # bodies/ranges. The old first comparison pointed upward, making
            # this catalog entry geometrically impossible.
            if c1.h < c2.l and c0.l > c1.h and c0.c > c2.body_mid:
                add("Abandoned Baby - Bullish", _scale((c0.c-c2.c)/c2.body, .5, 1))
        if trend == BULL and c2.bullish and is_long(c2) and is_doji(c1) and c0.bearish:
            if c1.l > c2.h and c0.h < c1.l and c0.c < c2.body_mid:
                add("Abandoned Baby - Bearish", _scale((c2.c-c0.c)/c2.body, .5, 1))
        trio = (c2, c1, c0)
        opens_inside = (c2.body_bottom <= c1.o <= c2.body_top
                        and c1.body_bottom <= c0.o <= c1.body_top)
        wick_max = float(p["soldier_wick_max"])
        if (trend == BEAR and all(b.bullish and is_long(b) for b in trio) and c2.c < c1.c < c0.c
                and opens_inside and all(b.upper_wick/b.range <= wick_max for b in trio)):
            add("Three White Soldiers - Bullish", float(np.mean([b.body_ratio for b in trio])))
        if (trend == BULL and all(b.bearish and is_long(b) for b in trio) and c2.c > c1.c > c0.c
                and opens_inside and all(b.lower_wick/b.range <= wick_max for b in trio)):
            add("Three Black Crows - Bearish", float(np.mean([b.body_ratio for b in trio])))
        if all(is_doji(b) for b in trio):
            strength = 1 - float(np.mean([b.body_ratio for b in trio])) / doji_max
            if trend == BULL and gap_up(c2, c1) and gap_down(c1, c0):
                add("Tri-Star - Bearish", strength)
            if trend == BEAR and gap_down(c2, c1) and gap_up(c1, c0):
                add("Tri-Star - Bullish", strength)
        if c2.bullish and c1.bullish and gap_up(c2, c1) and c0.bearish:
            if c1.body_bottom < c0.o < c1.body_top and c2.body_top < c0.c < c1.body_bottom:
                add("Upside Tasuki Gap - Bullish",
                    _scale(c0.c-c2.body_top, 0, c1.body_bottom-c2.body_top))
        if c2.bearish and c1.bearish and gap_down(c2, c1) and c0.bullish:
            if c1.body_bottom < c0.o < c1.body_top and c1.body_top < c0.c < c2.body_bottom:
                add("Downside Tasuki Gap - Bearish",
                    _scale(c2.body_bottom-c0.c, 0, c2.body_bottom-c1.body_top))

    # Five-bar continuation family.
    if i >= 4:
        five = tuple(_bar(df, j) for j in range(i-4, i+1))
        if all(_valid(b) for b in five):
            first, *middle, last = five
            held = all(is_short(b) and first.l < b.l and b.h < first.h for b in middle)
            if (trend == BULL and first.bullish and is_long(first) and held
                    and all(b.bearish for b in middle) and last.bullish and last.c > first.c):
                add("Rising Three Methods - Bullish", _scale(last.c-first.c, 0, first.body))
            if (trend == BEAR and first.bearish and is_long(first) and held
                    and all(b.bullish for b in middle) and last.bearish and last.c < first.c):
                add("Falling Three Methods - Bearish", _scale(first.c-last.c, 0, first.body))
    return hits


def _base_result(patterns: list[dict[str, Any]], p: dict[str, Any], end: int | None) -> dict[str, Any]:
    return clean({
        "detector_id": DETECTOR_ID,
        "detector_version": DETECTOR_VERSION,
        "catalog_observed_at": CATALOG_OBSERVED_AT,
        "catalog_size": len(CATALOG),
        "confirmation": "bar_close",
        "causal": True,
        "predictive_claim": False,
        "settings": p,
        "settings_hash": settings_hash(p),
        "input_end_open_time": end,
        "patterns": patterns,
    })


def scan(df: pd.DataFrame, params: dict | None = None) -> dict[str, Any]:
    """Detect every confirmed occurrence in one causal pass."""
    p = normalized_settings(params)
    if df.empty:
        return _base_result([], p, None)
    required = {"open", "high", "low", "close"}
    if not required.issubset(df.columns):
        raise ValueError(f"candles require columns: {', '.join(sorted(required))}")
    atrs = ta.atr(df, int(p["atr_length"]))
    warmup = max(int(p["atr_length"]), int(p["body_avg_length"]),
                 int(p["trend_sma_length"]) if p["trend_method"] == "sma50"
                 else int(p["trend_lookback"])) + 1
    signature = settings_hash(p)
    patterns: list[dict[str, Any]] = []
    duration = int(p["bar_duration_ms"])
    for i in range(warmup, len(df)):
        atr = float(atrs.iloc[i])
        bar = _bar(df, i)
        if not np.isfinite(atr) or atr <= 0 or not _valid(bar):
            continue
        if bar.range < float(p["min_body_atr"]) * atr:
            continue
        open_time = int(df["ts"].iloc[i]) if "ts" in df else i
        for hit in _detect_at(df, i, p, atr):
            patterns.append({
                **hit,
                "open_time": open_time,
                "confirmed_at": open_time + duration if duration else None,
                "detector_id": DETECTOR_ID,
                "detector_version": DETECTOR_VERSION,
                "settings_hash": signature,
            })
    end = int(df["ts"].iloc[-1]) if "ts" in df else len(df)-1
    return _base_result(patterns, p, end)


def compute(df: pd.DataFrame, params: dict | None = None) -> dict[str, Any]:
    """Screener summary: most recent occurrence of each pattern in lookback."""
    p = normalized_settings(params)
    lookback = int(p["lookback"])
    required = max(int(p["atr_length"]), int(p["body_avg_length"]),
                   int(p["trend_sma_length"]) if p["trend_method"] == "sma50"
                   else int(p["trend_lookback"])) + lookback + 5
    require_bars(df, required)
    all_hits = scan(df, p)["patterns"]
    index_by_open = ({int(v): i for i, v in enumerate(df["ts"].to_numpy())}
                     if "ts" in df else {})
    recent: list[dict[str, Any]] = []
    for hit in all_hits:
        index = index_by_open.get(int(hit["open_time"]), int(hit["open_time"]))
        if index >= len(df) - lookback:
            recent.append({**hit, "bars_ago": len(df)-1-index})
    seen: dict[str, dict[str, Any]] = {}
    for hit in reversed(recent):
        seen.setdefault(hit["id"], hit)
    patterns = sorted(seen.values(),
                      key=lambda h: (h["bars_ago"], -h["strength"], h["name"]))
    net_bias = NEUTRAL
    if patterns:
        newest = patterns[0]["bars_ago"]
        directions = {h["direction"] for h in patterns if h["bars_ago"] == newest}
        directions.discard(NEUTRAL)
        net_bias = directions.pop() if len(directions) == 1 else NEUTRAL
    end = int(df["ts"].iloc[-1]) if "ts" in df else len(df)-1
    return clean({
        **_base_result(patterns, p, end),
        "top_pattern": patterns[0]["name"] if patterns else None,
        "net_bias": net_bias,
        "pattern_count": len(patterns),
    })
