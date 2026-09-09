"""Causal classical chart-pattern detector.

Every anchor is a confirmed ``left/right`` pivot.  A pivot at bar ``i`` only
becomes knowable at ``i + pivot_right``; ``detected_at`` is never earlier than
that confirmation bar.  Breakouts are close-confirmed on a later completed
bar.  Appending candles may advance an occurrence's lifecycle, but cannot move
its anchors or its original detection time.

This module is the canonical implementation used by the chart, Screener and
Research exports.  Targets describe conventional measured moves, not forecasts.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from typing import Any, Iterable

import numpy as np
import pandas as pd

from .base import clean, require_bars
from .. import ta

DETECTOR_ID = "trading-scene-classical-patterns"
DETECTOR_VERSION = "1.1.0"
CATALOG_OBSERVED_AT = "2026-09-08"
SEARCH_BARS = 600

BULL, BEAR, BOTH = "bull", "bear", "both"

_ROWS = (
    ("bullish_flag", "Bullish Flag", "flag", BULL),
    ("bearish_flag", "Bearish Flag", "flag", BEAR),
    ("bullish_pennant", "Bullish Pennant", "pennant", BULL),
    ("bearish_pennant", "Bearish Pennant", "pennant", BEAR),
    ("double_top", "Double Top", "double", BEAR),
    ("double_bottom", "Double Bottom", "double", BULL),
    ("triple_top", "Triple Top", "triple", BEAR),
    ("triple_bottom", "Triple Bottom", "triple", BULL),
    ("head_and_shoulders", "Head And Shoulders", "head_and_shoulders", BEAR),
    ("inverse_head_and_shoulders", "Inverse Head And Shoulders", "head_and_shoulders", BULL),
    ("rising_wedge", "Rising Wedge", "wedge", BEAR),
    ("falling_wedge", "Falling Wedge", "wedge", BULL),
    ("triangle", "Triangle", "triangle", BOTH),
    ("rectangle", "Rectangle", "rectangle", BOTH),
    ("cup_and_handle", "Cup and Handle", "cup_and_handle", BULL),
    ("inverted_cup_and_handle", "Inverted Cup and Handle", "cup_and_handle", BEAR),
)

CATALOG = tuple(
    {
        "id": pattern_id,
        "name": name,
        "family": family,
        "direction": direction,
        "confirmation": "close",
        "pivot_basis": "confirmed_5_5",
        "target_basis": "measured_move",
        "predictive_claim": False,
    }
    for pattern_id, name, family, direction in _ROWS
)
CATALOG_BY_ID = {item["id"]: item for item in CATALOG}

DEFAULTS: dict[str, Any] = {
    "pivot_left": 5,
    "pivot_right": 5,
    "search_bars": SEARCH_BARS,
    "price_tolerance": 0.12,
    "line_tolerance": 0.18,
    "min_height_atr": 1.0,
    "min_pattern_bars": 8,
    "max_pattern_bars": 180,
    "cup_min_bars": 20,
    "flagpole_min_atr": 3.0,
    "max_results": 100,
    "include_developing": True,
    "status_filter": "all",
    "family_filter": [],
    "bar_duration_ms": 0,
}


@dataclass(frozen=True)
class Pivot:
    index: int
    price: float
    kind: str
    confirmed_index: int


@dataclass(frozen=True)
class Candidate:
    pattern_id: str
    anchors: tuple[Pivot, ...]
    upper: tuple[tuple[int, float], tuple[int, float]] | None
    lower: tuple[tuple[int, float], tuple[int, float]] | None
    height: float
    quality: dict[str, float]
    target_direction: str
    invalidation_price: float


def catalog() -> list[dict[str, Any]]:
    return [dict(item) for item in CATALOG]


def normalized_settings(params: dict | None = None) -> dict[str, Any]:
    supplied = params or {}
    unknown = set(supplied) - set(DEFAULTS)
    if unknown:
        raise ValueError(f"unsupported classical-pattern setting: {sorted(unknown)[0]}")
    out = {**DEFAULTS, **supplied}
    for key in (
        "pivot_left", "pivot_right", "search_bars", "min_pattern_bars",
        "max_pattern_bars", "cup_min_bars", "max_results", "bar_duration_ms",
    ):
        out[key] = int(out[key])
    if not 1 <= out["pivot_left"] <= 20 or not 1 <= out["pivot_right"] <= 20:
        raise ValueError("pivot_left and pivot_right must be integers from 1 to 20")
    if not 50 <= out["search_bars"] <= SEARCH_BARS:
        raise ValueError(f"search_bars must be between 50 and {SEARCH_BARS}")
    if not 4 <= out["min_pattern_bars"] < out["max_pattern_bars"] <= SEARCH_BARS:
        raise ValueError("pattern bar limits must satisfy 4 <= min < max <= 600")
    if not 20 <= out["cup_min_bars"] <= out["max_pattern_bars"]:
        raise ValueError("cup_min_bars must be between 20 and max_pattern_bars")
    if not 1 <= out["max_results"] <= 500:
        raise ValueError("max_results must be between 1 and 500")
    if out["bar_duration_ms"] < 0:
        raise ValueError("bar_duration_ms must not be negative")
    for key in ("price_tolerance", "line_tolerance", "min_height_atr", "flagpole_min_atr"):
        out[key] = float(out[key])
        if not math.isfinite(out[key]) or out[key] <= 0:
            raise ValueError(f"{key} must be finite and positive")
    if out["price_tolerance"] > 0.5 or out["line_tolerance"] > 0.5:
        raise ValueError("price and line tolerances must not exceed 0.5")
    if not isinstance(out["include_developing"], bool):
        raise ValueError("include_developing must be a boolean")
    if out["status_filter"] not in {
        "all", "developing", "emerging", "completed", "formed",
        "awaiting", "reached", "failed", "indefinable",
    }:
        raise ValueError("unsupported status_filter")
    families = out["family_filter"]
    if not isinstance(families, list) or not all(isinstance(v, str) for v in families):
        raise ValueError("family_filter must be a list of catalog ids or families")
    allowed = {item["id"] for item in CATALOG} | {item["family"] for item in CATALOG}
    if set(families) - allowed:
        raise ValueError("family_filter contains an unknown catalog id or family")
    out["family_filter"] = sorted(set(families))
    return out


def settings_hash(settings: dict[str, Any]) -> str:
    encoded = json.dumps(settings, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()[:16]


def _line(points: Iterable[Pivot]) -> tuple[tuple[int, float], tuple[int, float]]:
    values = list(points)
    return ((values[0].index, values[0].price), (values[-1].index, values[-1].price))


def _line_value(line: tuple[tuple[int, float], tuple[int, float]], index: int) -> float:
    (x1, y1), (x2, y2) = line
    return y1 if x2 == x1 else y1 + (y2 - y1) * ((index - x1) / (x2 - x1))


def _slope(line: tuple[tuple[int, float], tuple[int, float]]) -> float:
    (x1, y1), (x2, y2) = line
    return (y2 - y1) / max(1, x2 - x1)


def _close(values: Iterable[float], tolerance: float,
           scale: float | None = None) -> tuple[bool, float]:
    rows = list(values)
    span = max(rows) - min(rows)
    mean = sum(rows) / len(rows)
    allowed = max(1e-12, abs(scale if scale is not None else mean) * tolerance)
    score = max(0.0, 1.0 - span / allowed)
    return span <= allowed, score


def _quality(**parts: float) -> dict[str, float]:
    bounded = {key: round(max(0.0, min(1.0, value)), 4) for key, value in parts.items()}
    bounded["score"] = round(sum(bounded.values()) / max(1, len(bounded)), 4)
    return bounded


def _pivot_histories(df: pd.DataFrame, left: int, right: int,
                     start: int) -> list[tuple[Pivot, ...]]:
    """Return every causal zig-zag state after a confirmation-bar batch.

    A later same-side pivot may replace the last pivot in the *current* zig-zag,
    but it must not erase candidates that were visible while the earlier pivot
    was the confirmed extreme.  Replaying the small (at most 600-bar) horizon
    makes that history deterministic without relying on process or UI state.
    """
    raw = sorted(
        _raw_pivots(df, left, right, start),
        key=lambda pivot: (pivot.confirmed_index, pivot.index,
                           0 if pivot.kind == "high" else 1),
    )
    histories: list[tuple[Pivot, ...]] = []
    current: list[Pivot] = []
    offset = 0
    while offset < len(raw):
        confirmed = raw[offset].confirmed_index
        while offset < len(raw) and raw[offset].confirmed_index == confirmed:
            pivot = raw[offset]
            if current and current[-1].kind == pivot.kind:
                old = current[-1]
                stronger = pivot.price > old.price if pivot.kind == "high" else pivot.price < old.price
                if stronger:
                    current[-1] = pivot
            else:
                current.append(pivot)
            offset += 1
        histories.append(tuple(current))
    return histories


def _raw_pivots(df: pd.DataFrame, left: int, right: int, start: int) -> list[Pivot]:
    highs = df["high"].to_numpy(dtype=float)
    lows = df["low"].to_numpy(dtype=float)
    raw: list[Pivot] = []
    for i in range(max(start, left), len(df) - right):
        high_window = highs[i-left:i+right+1]
        low_window = lows[i-left:i+right+1]
        if highs[i] == np.max(high_window) and int(np.argmax(high_window)) == left:
            raw.append(Pivot(i, float(highs[i]), "high", i + right))
        if lows[i] == np.min(low_window) and int(np.argmin(low_window)) == left:
            raw.append(Pivot(i, float(lows[i]), "low", i + right))
    return raw


def _valid_span(anchors: tuple[Pivot, ...], settings: dict[str, Any]) -> bool:
    span = anchors[-1].index - anchors[0].index
    return settings["min_pattern_bars"] <= span <= settings["max_pattern_bars"]


def _reversals(pivots: list[Pivot], atr: np.ndarray, settings: dict[str, Any]) -> list[Candidate]:
    found: list[Candidate] = []
    tol = float(settings["price_tolerance"])
    min_atr = float(settings["min_height_atr"])
    for size in (3, 5):
        for offset in range(len(pivots) - size + 1):
            a = tuple(pivots[offset:offset+size])
            if not _valid_span(a, settings):
                continue
            local_atr = float(atr[a[-1].index])
            if not math.isfinite(local_atr) or local_atr <= 0:
                continue
            high_first = a[0].kind == "high"
            extrema = a[::2]
            middles = a[1::2]
            height = (
                sum(p.price for p in extrema) / len(extrema)
                - sum(p.price for p in middles) / len(middles)
            ) * (1 if high_first else -1)
            aligned, symmetry = _close((p.price for p in extrema), tol, abs(height))
            if size == 3 and aligned and height >= min_atr * local_atr:
                pattern_id = "double_top" if high_first else "double_bottom"
                boundary = _line(middles)
                q = _quality(symmetry=symmetry, height=min(1.0, height / (3 * local_atr)))
                found.append(Candidate(
                    pattern_id, a, None if high_first else boundary,
                    boundary if high_first else None, height, q,
                    BEAR if high_first else BULL,
                    max(p.price for p in extrema) if high_first else min(p.price for p in extrema),
                ))
            if size != 5:
                continue
            # H&S has a distinct centre; triple formations have aligned outer extrema.
            centre = extrema[1].price
            shoulder_scale = abs(centre - sum(p.price for p in middles) / len(middles))
            shoulders_ok, shoulder_fit = _close(
                (extrema[0].price, extrema[2].price), tol, shoulder_scale,
            )
            head_delta = (centre - max(extrema[0].price, extrema[2].price)) * (1 if high_first else -1)
            neckline = _line(middles)
            if shoulders_ok and head_delta >= min_atr * local_atr * 0.5:
                pattern_id = "head_and_shoulders" if high_first else "inverse_head_and_shoulders"
                height_hs = abs(centre - _line_value(neckline, extrema[1].index))
                found.append(Candidate(
                    pattern_id, a, None if high_first else neckline,
                    neckline if high_first else None, height_hs,
                    _quality(shoulder_symmetry=shoulder_fit,
                             head_prominence=min(1.0, head_delta / (2 * local_atr))),
                    BEAR if high_first else BULL,
                    max(extrema[0].price, extrema[2].price) if high_first
                    else min(extrema[0].price, extrema[2].price),
                ))
            elif aligned and height >= min_atr * local_atr:
                pattern_id = "triple_top" if high_first else "triple_bottom"
                found.append(Candidate(
                    pattern_id, a, None if high_first else neckline,
                    neckline if high_first else None, height,
                    _quality(symmetry=symmetry, height=min(1.0, height / (3 * local_atr))),
                    BEAR if high_first else BULL,
                    max(p.price for p in extrema) if high_first else min(p.price for p in extrema),
                ))
    return found


def _channels(pivots: list[Pivot], df: pd.DataFrame, atr: np.ndarray,
              settings: dict[str, Any]) -> list[Candidate]:
    found: list[Candidate] = []
    line_tol = float(settings["line_tolerance"])
    pole_min = float(settings["flagpole_min_atr"])
    closes = df["close"].to_numpy(dtype=float)
    for offset in range(len(pivots) - 4):
        a = tuple(pivots[offset:offset+5])
        if not _valid_span(a, settings):
            continue
        highs = tuple(p for p in a if p.kind == "high")
        lows = tuple(p for p in a if p.kind == "low")
        if len(highs) < 2 or len(lows) < 2:
            continue
        upper, lower = _line(highs), _line(lows)
        mid = a[-1].index
        height = _line_value(upper, mid) - _line_value(lower, mid)
        local_atr = float(atr[mid])
        if not math.isfinite(local_atr) or height < float(settings["min_height_atr"]) * local_atr:
            continue
        us, ls = _slope(upper), _slope(lower)
        scale = max(local_atr, height) / max(1, a[-1].index - a[0].index)
        flat = line_tol * scale
        convergence = us < ls
        residual = max(
            [abs(p.price - _line_value(upper, p.index)) for p in highs]
            + [abs(p.price - _line_value(lower, p.index)) for p in lows]
        )
        if residual > height * line_tol:
            continue
        # A candidate is not allowed to have already closed outside its own
        # structure before its last anchor.  This matches the benchmark's
        # close-intersection rule and prevents hindsight-selecting a channel.
        crossed = any(
            closes[index] > _line_value(upper, index) + height * line_tol
            or closes[index] < _line_value(lower, index) - height * line_tol
            for index in range(a[0].index, a[-1].index + 1)
        )
        if crossed:
            continue
        boundary_fit = max(0.0, 1.0 - residual / max(height * line_tol, 1e-12))
        pattern_id: str | None = None
        target_direction = BOTH
        if abs(us) <= flat and abs(ls) <= flat:
            pattern_id = "rectangle"
        elif convergence and us > 0 and ls > 0:
            pattern_id, target_direction = "rising_wedge", BEAR
        elif convergence and us < 0 and ls < 0:
            pattern_id, target_direction = "falling_wedge", BULL
        elif convergence and us <= flat and ls >= -flat:
            pattern_id = "triangle"

        # A large move into a short channel maps the same boundary geometry to
        # flag/pennant.  The pole is entirely before point 1 and therefore causal.
        pole_start = max(0, a[0].index - (a[-1].index - a[0].index))
        pole = closes[a[0].index] - closes[pole_start]
        pole_atr = abs(pole) / local_atr
        direction = BULL if pole > 0 else BEAR
        continuation: str | None = None
        if pole_atr >= pole_min:
            if convergence and us <= flat and ls >= -flat:
                continuation = "bullish_pennant" if direction == BULL else "bearish_pennant"
            elif abs(us-ls) <= flat * 2 and (
                (direction == BULL and us <= flat) or (direction == BEAR and us >= -flat)
            ):
                continuation = "bullish_flag" if direction == BULL else "bearish_flag"
        if pattern_id is not None:
            invalidation = (
                _line_value(upper, mid) + _line_value(lower, mid)
            ) / 2 if target_direction == BOTH else _line_value(
                lower if target_direction == BULL else upper, mid
            )
            found.append(Candidate(
                pattern_id, a, upper, lower, height,
                _quality(boundary_fit=boundary_fit,
                         scale=min(1.0, height / max(local_atr * 4, 1e-12))),
                target_direction, invalidation,
            ))
        # Keep the structural family as well as its continuation
        # interpretation.  TradingView exposes both tools independently and a
        # pennant does not stop being triangle-shaped because it has a pole.
        if continuation:
            continuation_direction = direction
            invalidation = _line_value(
                lower if continuation_direction == BULL else upper, mid
            )
            found.append(Candidate(
                continuation, a, upper, lower, abs(pole),
                _quality(boundary_fit=boundary_fit,
                         scale=min(1.0, height / max(local_atr * 4, 1e-12)),
                         pole=min(1.0, pole_atr / max(pole_min * 2, 1e-12))),
                continuation_direction, invalidation,
            ))
    return found


def _cups(pivots: list[Pivot], atr: np.ndarray, settings: dict[str, Any]) -> list[Candidate]:
    found: list[Candidate] = []
    tol = float(settings["price_tolerance"])
    for offset in range(len(pivots) - 3):
        a = tuple(pivots[offset:offset+4])
        if a[-1].index - a[0].index < settings["cup_min_bars"]:
            continue
        if not _valid_span(a, settings):
            continue
        bullish = [p.kind for p in a] == ["high", "low", "high", "low"]
        bearish = [p.kind for p in a] == ["low", "high", "low", "high"]
        if not bullish and not bearish:
            continue
        local_atr = float(atr[a[-1].index])
        cup_height = abs((a[0].price + a[2].price) / 2 - a[1].price)
        edge_ok, edge_fit = _close((a[0].price, a[2].price), tol, cup_height)
        handle_depth = abs(a[2].price - a[3].price)
        if (not edge_ok or not math.isfinite(local_atr) or
                cup_height < settings["min_height_atr"] * local_atr or
                handle_depth >= cup_height * 0.7):
            continue
        handle = ((a[2].index, a[2].price), (a[3].index, a[3].price))
        found.append(Candidate(
            "cup_and_handle" if bullish else "inverted_cup_and_handle",
            a, handle if bullish else None, None if bullish else handle,
            cup_height,
            _quality(edge_symmetry=edge_fit, handle_depth=1-handle_depth/cup_height,
                     width_balance=1-abs((a[1].index-a[0].index)-(a[2].index-a[1].index))
                     / max(1, a[2].index-a[0].index)),
            BULL if bullish else BEAR,
            a[1].price,
        ))
    return found


def _anchor_payload(pivot: Pivot, df: pd.DataFrame, duration: int) -> dict[str, Any]:
    opened = int(df["ts"].iloc[pivot.index]) if "ts" in df else pivot.index
    confirmed_open = int(df["ts"].iloc[pivot.confirmed_index]) if "ts" in df else pivot.confirmed_index
    return {
        "index": pivot.index,
        "open_time": opened,
        "price": pivot.price,
        "kind": pivot.kind,
        "confirmed_at_index": pivot.confirmed_index,
        "confirmed_at": confirmed_open + duration if duration else None,
    }


def _boundary_payload(line: tuple[tuple[int, float], tuple[int, float]] | None,
                      df: pd.DataFrame, extend_to: int) -> dict[str, Any] | None:
    if line is None:
        return None
    end_index = extend_to if line[0][0] == line[1][0] else line[1][0]
    end_price = _line_value(line, end_index)
    return {
        "start": {"index": line[0][0], "open_time": int(df["ts"].iloc[line[0][0]]), "price": line[0][1]},
        "end": {"index": end_index, "open_time": int(df["ts"].iloc[end_index]), "price": end_price},
    }


def _invalidation(candidate: Candidate, direction: str, index: int,
                  df: pd.DataFrame) -> tuple[float, str]:
    """Resolve the documented opposite structure for one event bar."""
    if candidate.pattern_id in {
        "bullish_flag", "bearish_flag", "bullish_pennant", "bearish_pennant",
    }:
        formed = df.iloc[candidate.anchors[0].index:candidate.anchors[-1].index + 1]
        if direction == BULL:
            return float(formed["low"].min()), "formation_channel_extreme"
        return float(formed["high"].max()), "formation_channel_extreme"
    if candidate.pattern_id in {"rising_wedge", "falling_wedge"}:
        line = candidate.lower if direction == BULL else candidate.upper
        if line is not None:
            return _line_value(line, index), "dynamic_opposite_structure_boundary"
    opposite = "low" if direction == BULL else "high"
    pivot = next((anchor for anchor in reversed(candidate.anchors)
                  if anchor.kind == opposite), None)
    if pivot is not None:
        return pivot.price, "last_opposite_pivot"
    return candidate.invalidation_price, "family_structural_rollback"


def _prospective_targets(candidate: Candidate, index: int) -> list[dict[str, Any]]:
    """Targets visible while a formed bidirectional structure awaits breakout."""
    if candidate.target_direction != BOTH or candidate.upper is None or candidate.lower is None:
        return []
    return [
        {
            "direction": BULL,
            "price": _line_value(candidate.upper, index) + candidate.height,
            "basis": "pattern height projected from prospective close breakout",
        },
        {
            "direction": BEAR,
            "price": _line_value(candidate.lower, index) - candidate.height,
            "basis": "pattern height projected from prospective close breakout",
        },
    ]


def _materialize(candidate: Candidate, df: pd.DataFrame, settings: dict[str, Any],
                 signature: str) -> dict[str, Any]:
    duration = int(settings["bar_duration_ms"])
    detected_index = max(p.confirmed_index for p in candidate.anchors)
    closes = df["close"].to_numpy(dtype=float)
    highs = df["high"].to_numpy(dtype=float)
    lows = df["low"].to_numpy(dtype=float)
    breakout_index: int | None = None
    breakout_direction: str | None = None
    breakout_boundary: float | None = None
    # A crossing during right-side pivot confirmation is already an observed
    # event when the formation becomes knowable. Keep its event bar distinct
    # from the later first-known time instead of discarding it.
    for index in range(candidate.anchors[-1].index + 1, len(df)):
        upper = _line_value(candidate.upper, index) if candidate.upper else math.inf
        lower = _line_value(candidate.lower, index) if candidate.lower else -math.inf
        allowed = candidate.target_direction
        if closes[index] > upper and allowed in {BULL, BOTH}:
            breakout_index, breakout_direction, breakout_boundary = index, BULL, upper
            break
        if closes[index] < lower and allowed in {BEAR, BOTH}:
            breakout_index, breakout_direction, breakout_boundary = index, BEAR, lower
            break

    formation = "formed"
    status = "awaiting"
    target_price: float | None = None
    reached_index: int | None = None
    failed_index: int | None = None
    ambiguous_index: int | None = None
    invalidation_price: float | None = None
    invalidation_basis = "direction_specific_opposite_structure"
    if breakout_index is not None and breakout_boundary is not None and breakout_direction is not None:
        target_price = breakout_boundary + candidate.height * (1 if breakout_direction == BULL else -1)
        invalidation_price, invalidation_basis = _invalidation(
            candidate, breakout_direction, breakout_index, df,
        )
        # The breakout is knowable only at this bar's close.  Its earlier
        # intrabar high/low cannot truthfully count as a post-confirmation
        # target or invalidation event, so lifecycle evaluation starts with
        # the next completed bar.
        for index in range(breakout_index + 1, len(df)):
            target_touched = (breakout_direction == BULL and highs[index] >= target_price) or (
                breakout_direction == BEAR and lows[index] <= target_price
            )
            event_invalidation, _ = _invalidation(candidate, breakout_direction, index, df)
            invalidated = (
                breakout_direction == BULL and lows[index] <= event_invalidation
            ) or (
                breakout_direction == BEAR and highs[index] >= event_invalidation
            )
            if target_touched and invalidated:
                ambiguous_index = index
                status = "indefinable"
                invalidation_price = event_invalidation
                break
            if target_touched:
                reached_index = index
                status = "reached"
                break
            if invalidated:
                failed_index = index
                status = "failed"
                invalidation_price = event_invalidation
                break
    elif candidate.target_direction in {BULL, BEAR}:
        invalidation_price, invalidation_basis = _invalidation(
            candidate, candidate.target_direction, detected_index, df,
        )

    def event(index: int | None, price: float | None = None) -> dict[str, Any] | None:
        if index is None:
            return None
        opened = int(df["ts"].iloc[index]) if "ts" in df else index
        return {
            "index": index, "open_time": opened,
            "confirmed_at": opened + duration if duration else None,
            **({"price": price} if price is not None else {}),
        }

    meta = CATALOG_BY_ID[candidate.pattern_id]
    first = candidate.anchors[0].index
    # Window-relative indices shift whenever a rolling 600-bar request drops
    # its oldest candle.  Exchange open-times do not, so an occurrence keeps
    # the same identity across overlapping live/research windows.
    anchor_identities = (
        [int(df["ts"].iloc[p.index]) for p in candidate.anchors]
        if "ts" in df else [p.index for p in candidate.anchors]
    )
    stable_key = f"{candidate.pattern_id}:" + ":".join(map(str, anchor_identities))
    detected_open = int(df["ts"].iloc[detected_index]) if "ts" in df else detected_index
    breakout_first_known_index = (
        max(detected_index, breakout_index) if breakout_index is not None else None
    )
    breakout_first_known = event(breakout_first_known_index)
    result = {
        **meta,
        "pivot_basis": f"confirmed_{settings['pivot_left']}_{settings['pivot_right']}",
        "occurrence_id": hashlib.sha256(stable_key.encode()).hexdigest()[:20],
        "anchors": [_anchor_payload(p, df, duration) for p in candidate.anchors],
        "start_index": first,
        "end_index": candidate.anchors[-1].index,
        "detected_at_index": detected_index,
        "detected_open_time": detected_open,
        "detected_at": detected_open + duration if duration else None,
        "formation": formation,
        "state": formation,
        "status": status,
        "breakout": None if breakout_index is None else {
            **event(breakout_index, breakout_boundary), "direction": breakout_direction,
            "first_known_at_index": breakout_first_known_index,
            "first_known_at": breakout_first_known["confirmed_at"] if breakout_first_known else None,
        },
        "invalidation": {
            "price": invalidation_price,
            "basis": invalidation_basis,
            "triggered": event(failed_index, invalidation_price),
        },
        "target": None if target_price is None else {
            "price": target_price,
            "direction": breakout_direction,
            "basis": "pattern height projected from close-confirmed breakout",
            "reached": event(reached_index, target_price),
        },
        "prospective_targets": _prospective_targets(candidate, detected_index)
        if breakout_index is None else [],
        "ambiguity": None if ambiguous_index is None else {
            **event(ambiguous_index),
            "basis": "target_and_invalidation_touched_on_same_ohlc_bar",
            "target_price": target_price,
            "invalidation_price": invalidation_price,
        },
        "boundaries": {
            "upper": _boundary_payload(candidate.upper, df, candidate.anchors[-1].index),
            "lower": _boundary_payload(candidate.lower, df, candidate.anchors[-1].index),
        },
        "quality": candidate.quality,
        "detector_id": DETECTOR_ID,
        "detector_version": DETECTOR_VERSION,
        "settings_hash": signature,
    }
    return clean(result)


def _matches_filters(item: dict[str, Any], settings: dict[str, Any]) -> bool:
    if item["formation"] == "emerging" and not settings["include_developing"]:
        return False
    selected = settings["family_filter"]
    if selected and item["id"] not in selected and item["family"] not in selected:
        return False
    status = settings["status_filter"]
    if status == "all":
        return True
    if status in {"developing", "emerging"}:
        return item["formation"] == "emerging"
    if status in {"completed", "formed"}:
        return item["formation"] == "formed"
    return item["status"] == status


_FAMILY_PRIORITY = {
    "head_and_shoulders": 9, "cup_and_handle": 9, "triple": 8,
    "flag": 5, "pennant": 5, "double": 4, "wedge": 3,
    "rectangle": 2, "triangle": 1,
}


def _overlaps(left: Candidate, right: Candidate) -> bool:
    left_ids = {pivot.index for pivot in left.anchors}
    right_ids = {pivot.index for pivot in right.anchors}
    if left_ids == right_ids:
        return True
    channel_families = {"flag", "pennant", "wedge", "triangle", "rectangle"}
    if CATALOG_BY_ID[left.pattern_id]["family"] not in channel_families or (
        CATALOG_BY_ID[right.pattern_id]["family"] not in channel_families
    ):
        return False
    shared = len(left_ids & right_ids)
    if (shared < 2 or left.anchors[0].index != right.anchors[0].index
            or left.anchors[-1].index != right.anchors[-1].index):
        return False
    start = max(left.anchors[0].index, right.anchors[0].index)
    end = min(left.anchors[-1].index, right.anchors[-1].index)
    union_start = min(left.anchors[0].index, right.anchors[0].index)
    union_end = max(left.anchors[-1].index, right.anchors[-1].index)
    return max(0, end - start) / max(1, union_end - union_start) >= 0.6


def _suppress_overlaps(candidates: Iterable[Candidate]) -> list[Candidate]:
    """Keep one deterministic primary for contradictory intersecting geometry."""
    ranked = sorted(candidates, key=lambda candidate: (
        max(p.confirmed_index for p in candidate.anchors),
        -_FAMILY_PRIORITY.get(CATALOG_BY_ID[candidate.pattern_id]["family"], 0),
        -candidate.quality["score"], candidate.pattern_id,
        tuple(p.index for p in candidate.anchors),
    ))
    kept: list[Candidate] = []
    for candidate in ranked:
        if any(_overlaps(candidate, primary) for primary in kept):
            continue
        kept.append(candidate)
    return kept


def scan(df: pd.DataFrame, params: dict | None = None) -> dict[str, Any]:
    settings = normalized_settings(params)
    signature = settings_hash(settings)
    if df.empty:
        return clean({
            "detector_id": DETECTOR_ID, "detector_version": DETECTOR_VERSION,
            "catalog_observed_at": CATALOG_OBSERVED_AT, "catalog_size": len(CATALOG),
            "causal": True, "confirmation": "close", "predictive_claim": False,
            "settings": settings, "settings_hash": signature,
            "input_end_open_time": None, "patterns": [],
        })
    start = max(0, len(df) - int(settings["search_bars"]))
    atr = ta.atr(df, 14).to_numpy(dtype=float)
    histories = _pivot_histories(
        df, settings["pivot_left"], settings["pivot_right"], start,
    )
    candidates: list[Candidate] = []
    for history in histories:
        pivots = list(history)
        candidates.extend(_reversals(pivots, atr, settings))
        candidates.extend(_channels(pivots, df, atr, settings))
        candidates.extend(_cups(pivots, atr, settings))
    unique: dict[tuple[str, tuple[int, ...]], Candidate] = {}
    for candidate in candidates:
        key = (candidate.pattern_id, tuple(p.index for p in candidate.anchors))
        unique[key] = candidate
    primary = _suppress_overlaps(unique.values())
    patterns = [_materialize(candidate, df, settings, signature) for candidate in primary]
    patterns = [item for item in patterns if _matches_filters(item, settings)]
    patterns.sort(key=lambda item: (
        item["detected_at_index"], item["quality"]["score"], item["id"]
    ), reverse=True)
    patterns = patterns[:settings["max_results"]]
    end = int(df["ts"].iloc[-1]) if "ts" in df else len(df)-1
    return clean({
        "detector_id": DETECTOR_ID,
        "detector_version": DETECTOR_VERSION,
        "catalog_observed_at": CATALOG_OBSERVED_AT,
        "catalog_size": len(CATALOG),
        "causal": True,
        "confirmation": "close",
        "pivot_confirmation": {
            "left_bars": settings["pivot_left"], "right_bars": settings["pivot_right"],
        },
        "search_horizon_bars": settings["search_bars"],
        "predictive_claim": False,
        "settings": settings,
        "settings_hash": signature,
        "input_end_open_time": end,
        "patterns": patterns,
    })


def compute(df: pd.DataFrame, params: dict | None = None) -> dict[str, Any]:
    settings = normalized_settings(params)
    require_bars(df, max(60, settings["pivot_left"] + settings["pivot_right"] + 20))
    result = scan(df, settings)
    latest = result["patterns"][0] if result["patterns"] else None
    return clean({
        **result,
        "top_pattern": latest["name"] if latest else None,
        "top_family": latest["family"] if latest else None,
        "top_status": latest["status"] if latest else None,
        "top_direction": latest["direction"] if latest else None,
        "pattern_count": len(result["patterns"]),
    })
