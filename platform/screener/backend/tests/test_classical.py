"""Causal classical-pattern catalog, lifecycle, and stability tests."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.indicators import classical

HOUR = 3_600_000


def _series(points: list[tuple[int, float]], count: int | None = None) -> pd.DataFrame:
    """Piecewise-linear closes with deterministic, non-flat extrema."""
    end = count if count is not None else points[-1][0] + 8
    x = np.arange(end, dtype=float)
    close = np.interp(x, [p[0] for p in points], [p[1] for p in points])
    # Narrow bodies retain the intended high/low pivot topology.
    open_ = close + np.where(np.arange(end) % 2 == 0, -0.08, 0.08)
    high = np.maximum(open_, close) + 0.22
    low = np.minimum(open_, close) - 0.22
    return pd.DataFrame({
        "ts": np.arange(end, dtype="int64") * HOUR,
        "open": open_, "high": high, "low": low, "close": close,
        "volume": np.full(end, 1_000.0),
    })


def _ids(result: dict) -> set[str]:
    return {item["id"] for item in result["patterns"]}


def _one(result: dict, pattern_id: str) -> dict:
    return next(item for item in result["patterns"] if item["id"] == pattern_id)


def test_catalog_matches_current_tradingview_all_patterns_surface():
    assert len(classical.catalog()) == 16
    assert {item["id"] for item in classical.catalog()} == {
        "bullish_flag", "bearish_flag", "bullish_pennant", "bearish_pennant",
        "double_top", "double_bottom", "triple_top", "triple_bottom",
        "head_and_shoulders", "inverse_head_and_shoulders",
        "rising_wedge", "falling_wedge", "triangle", "rectangle",
        "cup_and_handle", "inverted_cup_and_handle",
    }
    assert all(item["predictive_claim"] is False for item in classical.catalog())


def test_confirmed_double_top_is_formed_and_awaiting_until_breakout():
    awaiting = _series([(0, 92), (12, 100), (22, 112), (32, 101), (42, 111.5)], 49)
    result = classical.scan(awaiting, {"bar_duration_ms": HOUR})
    top = _one(result, "double_top")
    assert top["formation"] == "formed"
    assert top["state"] == "formed"
    assert top["status"] == "awaiting"
    assert top["breakout"] is None
    assert (
        top["boundaries"]["lower"]["start"]["open_time"]
        < top["boundaries"]["lower"]["end"]["open_time"]
    )
    assert top["detected_at_index"] == top["anchors"][-1]["index"] + 5
    assert top["anchors"][-1]["confirmed_at"] == top["detected_at"]

    completed = _series(
        [(0, 92), (12, 100), (22, 112), (32, 101), (42, 111.5), (50, 99)], 55,
    )
    top = _one(classical.scan(completed, {"bar_duration_ms": HOUR}), "double_top")
    assert top["formation"] == "formed"
    assert top["breakout"]["direction"] == "bear"
    assert top["breakout"]["first_known_at_index"] >= top["detected_at_index"]
    assert top["target"]["price"] < top["breakout"]["price"]


def test_prefix_stability_preserves_occurrence_identity_anchors_and_knowable_time():
    frame = _series(
        [(0, 92), (12, 100), (22, 112), (32, 101), (42, 111.5), (52, 98), (64, 88)], 70,
    )
    prefix = classical.scan(frame.iloc[:49], {"bar_duration_ms": HOUR})
    full = classical.scan(frame, {"bar_duration_ms": HOUR})
    before = _one(prefix, "double_top")
    after = next(item for item in full["patterns"] if item["occurrence_id"] == before["occurrence_id"])
    for field in ("anchors", "detected_at_index", "detected_at", "occurrence_id", "quality"):
        assert after[field] == before[field]
    assert before["formation"] == "formed"
    assert before["status"] == "awaiting"
    assert after["status"] in {"awaiting", "reached", "failed", "indefinable"}


def test_occurrence_identity_survives_a_rolling_window():
    frame = _series(
        [(0, 92), (12, 100), (22, 112), (32, 101), (42, 111.5), (52, 98), (70, 88)], 80,
    )
    before = _one(classical.scan(frame), "double_top")
    rolled = frame.iloc[8:].reset_index(drop=True)
    after = _one(classical.scan(rolled), "double_top")
    assert after["occurrence_id"] == before["occurrence_id"]
    assert [anchor["open_time"] for anchor in after["anchors"]] == [
        anchor["open_time"] for anchor in before["anchors"]
    ]
    assert after["detected_open_time"] == before["detected_open_time"]


def test_breakout_bar_cannot_retroactively_reach_target_or_invalidate():
    frame = _series(
        [(0, 92), (12, 100), (22, 112), (32, 101), (42, 111.5), (49, 102), (50, 89)], 51,
    )
    # The close-confirmed breakdown bar spans both the measured target and the
    # old highs.  Those intrabar extremes precede the close confirmation and
    # therefore cannot settle the newly completed occurrence.
    frame.loc[50, "high"] = 115
    frame.loc[50, "low"] = 80
    item = _one(classical.scan(frame, {"bar_duration_ms": HOUR}), "double_top")
    assert item["breakout"]["index"] == 50
    assert item["status"] == "awaiting"
    assert item["target"]["reached"] is None
    assert item["invalidation"]["triggered"] is None


def test_breakout_during_final_pivot_confirmation_keeps_event_and_known_times():
    frame = _series([(0, 92), (12, 100), (22, 112), (32, 101), (42, 111.5)], 49)
    frame.loc[44, ["open", "high", "low", "close"]] = [100.0, 100.2, 98.8, 99.0]
    item = _one(classical.scan(frame, {"bar_duration_ms": HOUR}), "double_top")
    assert item["breakout"]["index"] == 44
    assert item["breakout"]["confirmed_at"] == 45 * HOUR
    assert item["breakout"]["index"] < item["detected_at_index"]
    assert item["breakout"]["first_known_at_index"] == item["detected_at_index"]
    assert item["breakout"]["first_known_at"] == item["detected_at"]


def test_same_bar_target_and_invalidation_is_indefinable_for_ohlc():
    frame = _series(
        [(0, 92), (12, 100), (22, 112), (32, 101), (42, 111.5), (50, 99)], 52,
    )
    frame.loc[51, ["open", "high", "low", "close"]] = [99.0, 115.0, 80.0, 98.0]
    item = _one(classical.scan(frame, {"bar_duration_ms": HOUR}), "double_top")
    assert item["status"] == "indefinable"
    assert item["ambiguity"]["index"] == 51
    assert item["target"]["reached"] is None
    assert item["invalidation"]["triggered"] is None


def test_reversal_invalidation_is_last_opposite_pivot_not_midpoint_or_old_extreme():
    frame = _series(
        [(0, 92), (12, 100), (22, 112), (32, 101), (42, 111.5), (50, 99)], 51,
    )
    item = _one(classical.scan(frame, {"bar_duration_ms": HOUR}), "double_top")
    assert item["invalidation"]["basis"] == "last_opposite_pivot"
    assert item["invalidation"]["price"] == item["anchors"][-1]["price"]


@pytest.mark.parametrize(
    ("pattern_id", "points"),
    [
        ("head_and_shoulders", [(0, 90), (10, 100), (20, 112), (30, 101), (40, 120), (50, 100), (60, 111), (70, 98)]),
        ("inverse_head_and_shoulders", [(0, 130), (10, 120), (20, 108), (30, 119), (40, 100), (50, 120), (60, 109), (70, 122)]),
        ("triple_top", [(0, 90), (10, 100), (20, 112), (30, 101), (40, 111.4), (50, 100), (60, 112.2), (70, 98)]),
        ("triple_bottom", [(0, 130), (10, 122), (20, 108), (30, 120), (40, 108.6), (50, 121), (60, 107.8), (70, 123)]),
    ],
)
def test_five_pivot_reversal_families(pattern_id: str, points: list[tuple[int, float]]):
    assert pattern_id in _ids(classical.scan(_series(points, 78)))


@pytest.mark.parametrize(
    ("pattern_id", "points"),
    [
        ("triangle", [(0, 100), (10, 92), (20, 112), (30, 96), (40, 108), (50, 99), (60, 105)]),
        ("rectangle", [(0, 100), (10, 94), (20, 112), (30, 100), (40, 110), (50, 100), (60, 112)]),
        ("rising_wedge", [(0, 90), (10, 96), (20, 104), (30, 99), (40, 108), (50, 103), (60, 111)]),
        ("falling_wedge", [(0, 125), (10, 118), (20, 110), (30, 115), (40, 107), (50, 111), (60, 104)]),
    ],
)
def test_boundary_families(pattern_id: str, points: list[tuple[int, float]]):
    result = classical.scan(_series(points, 68), {"flagpole_min_atr": 100})
    assert pattern_id in _ids(result)
    item = _one(result, pattern_id)
    assert item["boundaries"]["upper"] is not None
    assert item["boundaries"]["lower"] is not None


@pytest.mark.parametrize(
    ("pattern_id", "points", "count"),
    [
        ("bullish_flag", [(0, 80), (20, 120), (30, 112), (40, 118), (50, 110), (60, 116)], 68),
        ("bearish_flag", [(0, 140), (20, 100), (30, 108), (40, 102), (50, 110), (60, 104)], 68),
        ("bullish_pennant", [(0, 80), (20, 120), (30, 108), (40, 117), (50, 111), (60, 115), (72, 112)], 78),
        ("bearish_pennant", [(0, 140), (20, 100), (30, 112), (40, 103), (50, 109), (60, 105)], 68),
    ],
)
def test_continuation_families_require_a_causal_pre_pattern_pole(
    pattern_id: str, points: list[tuple[int, float]], count: int,
):
    item = _one(classical.scan(_series(points, count)), pattern_id)
    assert item["direction"] == ("bull" if pattern_id.startswith("bullish") else "bear")
    assert item["quality"]["pole"] > 0
    assert item["detected_at_index"] >= item["anchors"][-1]["confirmed_at_index"]


@pytest.mark.parametrize(
    ("pattern_id", "points"),
    [
        ("cup_and_handle", [(0, 90), (10, 100), (22, 115), (38, 95), (54, 114), (64, 108), (72, 116)]),
        ("inverted_cup_and_handle", [(0, 130), (10, 120), (22, 105), (38, 125), (54, 106), (64, 112), (72, 104)]),
    ],
)
def test_cup_families_have_measured_targets(pattern_id: str, points: list[tuple[int, float]]):
    result = classical.scan(_series(points, 80))
    assert pattern_id in _ids(result)
    item = _one(result, pattern_id)
    assert item["quality"]["edge_symmetry"] > 0


def test_settings_are_closed_bounded_and_part_of_provenance():
    with pytest.raises(ValueError, match="unsupported classical"):
        classical.normalized_settings({"future_peeking": True})
    with pytest.raises(ValueError, match="pivot_left"):
        classical.normalized_settings({"pivot_left": 0})
    first = classical.normalized_settings()
    second = classical.normalized_settings({"include_developing": False})
    assert classical.settings_hash(first) != classical.settings_hash(second)


def test_custom_pivot_provenance_names_the_normalized_basis():
    frame = _series([(0, 92), (12, 100), (22, 112), (32, 101), (42, 111.5)], 47)
    item = _one(classical.scan(frame, {"pivot_left": 3, "pivot_right": 3}), "double_top")
    assert item["pivot_basis"] == "confirmed_3_3"


def test_same_anchor_interpretations_have_one_deterministic_primary():
    frame = _series(
        [(0, 80), (20, 120), (30, 108), (40, 117), (50, 111), (60, 115), (72, 112)], 78,
    )
    patterns = classical.scan(frame)["patterns"]
    anchor_groups: dict[tuple[int, ...], list[str]] = {}
    for item in patterns:
        key = tuple(anchor["open_time"] for anchor in item["anchors"])
        anchor_groups.setdefault(key, []).append(item["id"])
    assert all(len(ids) == 1 for ids in anchor_groups.values())
    assert "bullish_pennant" in _ids({"patterns": patterns})


def test_bidirectional_formed_pattern_has_two_prospective_targets():
    frame = _series(
        [(0, 100), (10, 92), (20, 112), (30, 96), (40, 108), (50, 99), (60, 105)], 68,
    )
    item = _one(classical.scan(frame.iloc[:60], {"flagpole_min_atr": 100}), "triangle")
    assert item["status"] == "awaiting"
    assert item["target"] is None
    assert {target["direction"] for target in item["prospective_targets"]} == {"bull", "bear"}


def test_status_and_family_filters_do_not_change_detection_identity():
    frame = _series([(0, 92), (12, 100), (22, 112), (32, 101), (42, 111.5)], 49)
    all_result = classical.scan(frame)
    only = classical.scan(frame, {"status_filter": "formed", "family_filter": ["double"]})
    assert _one(all_result, "double_top")["occurrence_id"] == _one(only, "double_top")["occurrence_id"]
    assert _one(classical.scan(frame, {"include_developing": False}), "double_top")["status"] == "awaiting"
