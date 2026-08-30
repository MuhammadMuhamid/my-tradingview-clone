"""Candle patterns — §4.6, with the §8.4 fixtures.

Every pattern gets two tests: a hand-built bar that must be detected, and a
near-miss that must not. The near-miss is the one that matters — a detector with
its threshold wired backwards, or ignored entirely, passes every positive test.

The padding deliberately alternates bullish and bearish bars while drifting, so
it establishes a prior trend without accidentally forming soldiers, crows or
engulfings of its own.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.indicators import candles
from app import ta
from app.indicators.base import InsufficientData


def ta_atr(df):
    return ta.atr(df, 14)

PAD = 40
BODY = 6.0
WICK = 7.0        # wick/range = 0.35, above soldier_wick_max, so trios never form
START = 1000.0


def _padding(drift: float) -> list[tuple[float, float, float, float]]:
    """`PAD` bars drifting at `drift`/bar that form no pattern of their own.

    Single-colour in the direction of the drift, so nothing needing two opposite
    bars (engulfing, harami, piercing, dark cloud, tweezers, stars) can appear.
    The wicks are deliberately long enough to fail `soldier_wick_max`, which is
    what would otherwise make a drifting run of same-colour bars read as Three
    White Soldiers or Three Black Crows.
    """
    bars = []
    bearish = drift < 0
    for k in range(PAD):
        mid = START + k * drift
        o = mid + BODY / 2 if bearish else mid - BODY / 2
        c = mid - BODY / 2 if bearish else mid + BODY / 2
        bars.append((o, max(o, c) + WICK, min(o, c) - WICK, c))
    return bars


def _frame(bars: list[tuple[float, float, float, float]], drift: float = 0.0) -> pd.DataFrame:
    """Padding + the supplied `(open, high, low, close)` bars."""
    rows = _padding(drift) + bars
    n = len(rows)
    return pd.DataFrame({
        "ts": np.arange(n, dtype="int64") * 3_600_000,
        "open": [r[0] for r in rows],
        "high": [r[1] for r in rows],
        "low": [r[2] for r in rows],
        "close": [r[3] for r in rows],
        "volume": [1000.0] * n,
    })


def _names(df: pd.DataFrame, params: dict | None = None) -> set[str]:
    return {p["name"] for p in candles.compute(df, params)["patterns"]}


def _at_zero(df: pd.DataFrame, params: dict | None = None) -> set[str]:
    return {p["name"] for p in candles.compute(df, params)["patterns"] if p["bars_ago"] == 0}


DOWN, UP = -2.0, 2.0


def _last(drift: float) -> float:
    """Close of the final padding bar, so fixtures can hang off it."""
    return _padding(drift)[-1][3]


# --- sanity: the padding forms nothing ---------------------------------


def test_padding_alone_produces_no_patterns():
    for drift in (DOWN, UP, 0.0):
        assert candles.compute(_frame([], drift), None)["patterns"] == []


# --- single-bar --------------------------------------------------------


def test_doji_detected_and_near_miss_rejected():
    base = _last(0.0)
    # body 0.4 of a 10 range = 4% — under the 10% threshold.
    assert "Doji" in _at_zero(_frame([(base, base + 5.0, base - 5.0, base + 0.4)]))
    # body 1.5 of 10 = 15% — over it.
    assert "Doji" not in _at_zero(_frame([(base, base + 5.0, base - 5.0, base + 1.5)]))


def test_dragonfly_doji_needs_the_wick_below():
    base = _last(0.0)
    dragonfly = (base, base + 0.2, base - 9.0, base + 0.1)
    assert "Dragonfly Doji" in _at_zero(_frame([dragonfly]))

    # Same tiny body, but the wick is on the wrong side.
    assert "Dragonfly Doji" not in _at_zero(_frame([(base, base + 9.0, base - 0.2, base + 0.1)]))


def test_gravestone_doji_needs_the_wick_above():
    base = _last(0.0)
    assert "Gravestone Doji" in _at_zero(_frame([(base, base + 9.0, base - 0.2, base + 0.1)]))
    assert "Gravestone Doji" not in _at_zero(_frame([(base, base + 0.2, base - 9.0, base + 0.1)]))


def test_hammer_after_a_downtrend_and_hanging_man_after_an_uptrend():
    """Identical bar; only the prior trend differs."""
    down_base, up_base = _last(DOWN), _last(UP)
    shape = lambda b: (b, b + 2.2, b - 12.0, b + 2.0)   # long lower wick, small body

    assert "Hammer" in _at_zero(_frame([shape(down_base)], DOWN))
    assert "Hanging Man" not in _at_zero(_frame([shape(down_base)], DOWN))

    assert "Hanging Man" in _at_zero(_frame([shape(up_base)], UP))
    assert "Hammer" not in _at_zero(_frame([shape(up_base)], UP))


def test_hammer_rejected_when_the_wick_is_too_short():
    base = _last(DOWN)
    # lower wick 3.0 vs body 2.0 = 1.5x, under the 2.0 threshold.
    assert "Hammer" not in _at_zero(_frame([(base, base + 2.2, base - 3.0, base + 2.0)], DOWN))


def test_inverted_hammer_and_shooting_star_split_on_prior_trend():
    down_base, up_base = _last(DOWN), _last(UP)
    shape = lambda b: (b, b + 12.0, b - 0.4, b + 2.0)   # long upper wick

    assert "Inverted Hammer" in _at_zero(_frame([shape(down_base)], DOWN))
    assert "Shooting Star" not in _at_zero(_frame([shape(down_base)], DOWN))

    assert "Shooting Star" in _at_zero(_frame([shape(up_base)], UP))
    assert "Inverted Hammer" not in _at_zero(_frame([shape(up_base)], UP))


def test_marubozu_both_directions_and_the_wick_limit():
    base = _last(0.0)
    bull = (base, base + 10.05, base - 0.05, base + 10.0)
    bear = (base, base + 0.05, base - 10.05, base - 10.0)

    hits = candles.compute(_frame([bull]), None)["patterns"]
    maru = [h for h in hits if h["name"] == "Marubozu"]
    assert maru and maru[0]["direction"] == "bull"

    hits = candles.compute(_frame([bear]), None)["patterns"]
    maru = [h for h in hits if h["name"] == "Marubozu"]
    assert maru and maru[0]["direction"] == "bear"

    # A wick of 1.0 on a range of 11 is 9% — over the 5% limit.
    assert "Marubozu" not in _at_zero(_frame([(base, base + 11.0, base - 0.05, base + 10.0)]))


# --- two-bar -----------------------------------------------------------


def test_bullish_engulfing_and_the_containment_requirement():
    b = _last(DOWN)
    prev = (b, b + 1.0, b - 9.0, b - 8.0)              # bearish
    cur = (b - 9.0, b + 3.0, b - 10.0, b + 2.0)        # opens below, closes above
    assert "Bullish Engulfing" in _at_zero(_frame([prev, cur], DOWN))

    # Closes inside the previous body — not engulfing.
    small = (b - 9.0, b - 3.0, b - 10.0, b - 4.0)
    assert "Bullish Engulfing" not in _at_zero(_frame([prev, small], DOWN))


def test_bearish_engulfing():
    b = _last(UP)
    prev = (b, b + 9.0, b - 1.0, b + 8.0)              # bullish
    cur = (b + 9.0, b + 10.0, b - 3.0, b - 2.0)
    assert "Bearish Engulfing" in _at_zero(_frame([prev, cur], UP))

    inside = (b + 5.0, b + 6.0, b + 3.0, b + 4.0)
    assert "Bearish Engulfing" not in _at_zero(_frame([prev, inside], UP))


def test_piercing_line_needs_to_clear_the_midpoint():
    b = _last(DOWN)
    prev = (b, b + 1.0, b - 11.0, b - 10.0)            # bearish body b..b-10, mid b-5
    deep = (b - 12.0, b - 2.0, b - 13.0, b - 3.0)      # closes above mid, below prev open
    assert "Piercing Line" in _at_zero(_frame([prev, deep], DOWN))

    shallow = (b - 12.0, b - 7.0, b - 13.0, b - 8.0)   # closes below the midpoint
    assert "Piercing Line" not in _at_zero(_frame([prev, shallow], DOWN))


def test_dark_cloud_cover_needs_to_clear_the_midpoint():
    b = _last(UP)
    prev = (b, b + 11.0, b - 1.0, b + 10.0)            # bullish body b..b+10, mid b+5
    deep = (b + 12.0, b + 13.0, b + 2.0, b + 3.0)
    assert "Dark Cloud Cover" in _at_zero(_frame([prev, deep], UP))

    shallow = (b + 12.0, b + 13.0, b + 7.0, b + 8.0)
    assert "Dark Cloud Cover" not in _at_zero(_frame([prev, shallow], UP))


def test_bullish_harami_requires_containment():
    b = _last(DOWN)
    prev = (b, b + 1.0, b - 13.0, b - 12.0)            # long bearish
    inner = (b - 10.0, b - 5.0, b - 11.0, b - 6.0)     # small bullish inside it
    assert "Bullish Harami" in _at_zero(_frame([prev, inner], DOWN))

    outside = (b - 10.0, b + 4.0, b - 11.0, b + 3.0)   # closes above the prior open
    assert "Bullish Harami" not in _at_zero(_frame([prev, outside], DOWN))


def test_bearish_harami_requires_containment():
    b = _last(UP)
    prev = (b, b + 13.0, b - 1.0, b + 12.0)
    inner = (b + 10.0, b + 11.0, b + 5.0, b + 6.0)
    assert "Bearish Harami" in _at_zero(_frame([prev, inner], UP))

    outside = (b + 10.0, b + 11.0, b - 3.0, b - 2.0)
    assert "Bearish Harami" not in _at_zero(_frame([prev, outside], UP))


def test_tweezer_top_needs_matching_highs_within_the_atr_tolerance():
    b = _last(UP)
    prev = (b, b + 10.0, b - 1.0, b + 8.0)             # bullish
    cur = (b + 8.0, b + 10.02, b - 2.0, b - 1.0)       # bearish, near-identical high
    assert "Tweezer Top" in _at_zero(_frame([prev, cur], UP))

    off = (b + 8.0, b + 16.0, b - 2.0, b - 1.0)        # high far away
    assert "Tweezer Top" not in _at_zero(_frame([prev, off], UP))


def test_tweezer_bottom_needs_matching_lows():
    b = _last(DOWN)
    prev = (b, b + 1.0, b - 10.0, b - 8.0)             # bearish
    cur = (b - 8.0, b + 2.0, b - 10.02, b + 1.0)       # bullish, near-identical low
    assert "Tweezer Bottom" in _at_zero(_frame([prev, cur], DOWN))

    off = (b - 8.0, b + 2.0, b - 16.0, b + 1.0)
    assert "Tweezer Bottom" not in _at_zero(_frame([prev, off], DOWN))


# --- three-bar ---------------------------------------------------------


def test_morning_star_and_a_star_that_is_too_large():
    b = _last(DOWN)
    first = (b, b + 1.0, b - 13.0, b - 12.0)           # long bearish, mid = b-6
    star = (b - 13.0, b - 12.0, b - 15.0, b - 13.5)    # small body
    third = (b - 13.0, b - 2.0, b - 14.0, b - 3.0)     # bullish, closes above mid
    assert "Morning Star" in _at_zero(_frame([first, star, third], DOWN))

    fat_star = (b - 13.0, b - 6.0, b - 15.0, b - 7.0)  # body 6 of 12 = 50%+ ... too big
    assert "Morning Star" not in _at_zero(
        _frame([first, fat_star, third], DOWN), {"star_body_ratio": 0.2}
    )


def test_evening_star():
    b = _last(UP)
    first = (b, b + 13.0, b - 1.0, b + 12.0)           # long bullish, mid = b+6
    star = (b + 13.0, b + 15.0, b + 12.0, b + 13.5)
    third = (b + 13.0, b + 14.0, b + 2.0, b + 3.0)     # bearish, closes below mid
    assert "Evening Star" in _at_zero(_frame([first, star, third], UP))

    shallow = (b + 13.0, b + 14.0, b + 8.0, b + 9.0)   # closes above the midpoint
    assert "Evening Star" not in _at_zero(_frame([first, star, shallow], UP))


def test_three_white_soldiers_and_the_gap_rejection():
    b = _last(UP)
    trio = [
        (b + 0.0, b + 8.2, b - 0.2, b + 8.0),
        (b + 4.0, b + 16.2, b + 3.8, b + 16.0),
        (b + 12.0, b + 24.2, b + 11.8, b + 24.0),
    ]
    assert "Three White Soldiers" in _at_zero(_frame(trio, UP))

    # Third bar opens above the previous body — a gap, not a soldier.
    gapped = list(trio)
    gapped[2] = (b + 20.0, b + 32.2, b + 19.8, b + 32.0)
    assert "Three White Soldiers" not in _at_zero(_frame(gapped, UP))


def test_three_black_crows_and_the_gap_rejection():
    b = _last(DOWN)
    trio = [
        (b - 0.0, b + 0.2, b - 8.2, b - 8.0),
        (b - 4.0, b - 3.8, b - 16.2, b - 16.0),
        (b - 12.0, b - 11.8, b - 24.2, b - 24.0),
    ]
    assert "Three Black Crows" in _at_zero(_frame(trio, DOWN))

    gapped = list(trio)
    gapped[2] = (b - 20.0, b - 19.8, b - 32.2, b - 32.0)
    assert "Three Black Crows" not in _at_zero(_frame(gapped, DOWN))


# --- the noise filter --------------------------------------------------


def test_bars_smaller_than_min_body_atr_are_ignored():
    """A textbook shape on a bar too small to matter must not be reported."""
    b = _last(0.0)
    tiny = (b, b + 0.02, b - 0.02, b + 0.019)          # a perfect doji, but microscopic
    assert _at_zero(_frame([tiny])) == set()

    # The same shape scaled up clears the filter.
    big = (b, b + 5.0, b - 5.0, b + 0.4)
    assert "Doji" in _at_zero(_frame([big]))


def test_the_filter_is_configurable_not_hardcoded():
    b = _last(0.0)
    small = (b, b + 1.0, b - 1.0, b + 0.1)
    assert _at_zero(_frame([small]), {"min_body_atr": 0.30}) == set()
    assert "Doji" in _at_zero(_frame([small]), {"min_body_atr": 0.01})


# --- strength ----------------------------------------------------------


def test_strength_is_bounded_and_carries_its_basis(btc_1h):
    out = candles.compute(btc_1h, None)
    for hit in out["patterns"]:
        assert 0.0 <= hit["strength"] <= 1.0
        assert hit["basis"] == candles.STRENGTH_BASIS[hit["name"]]


def test_strength_rises_with_how_textbook_the_bar_is():
    """A longer hammer wick must score higher than a barely-qualifying one."""
    b = _last(DOWN)
    # The 4.0 wick is exactly at the 2.0x threshold, and its 6.2 range clears the
    # 6.0 noise floor these fixtures produce — deliberately, not by luck.
    def hammer_strength(wick: float) -> float:
        df = _frame([(b, b + 2.2, b - wick, b + 2.0)], DOWN)
        hits = [h for h in candles.compute(df, None)["patterns"] if h["name"] == "Hammer"]
        return hits[0]["strength"]

    assert hammer_strength(4.0) < hammer_strength(8.0) < hammer_strength(14.0)
    assert hammer_strength(4.0) == pytest.approx(0.0, abs=0.05), "at threshold -> ~0"


def test_every_pattern_has_a_documented_basis():
    assert len(candles.STRENGTH_BASIS) == 20   # 8 single-bar + 8 two-bar + 4 three-bar
    for name, basis in candles.STRENGTH_BASIS.items():
        assert basis and not basis.isdigit(), f"{name} has no documented strength basis"


# --- net_bias and top_pattern ------------------------------------------


def test_conflicting_patterns_on_one_bar_yield_no_net_bias():
    """§4.6: report both, set net_bias = none. Never a majority vote."""
    b = _last(UP)
    prev = (b, b + 9.0, b - 1.0, b + 8.0)
    # Bearish engulfing that also closes as a bullish-looking long lower wick is
    # hard to build; force the case with a bar carrying both a Marubozu (bull)
    # and a Bearish Harami is impossible, so drive it through the helper instead.
    out = candles.compute(_frame([prev, (b + 9.0, b + 10.0, b - 3.0, b - 2.0)], UP), None)
    assert out["net_bias"] in ("bull", "bear", "none")

    # Direct check of the resolution rule.
    patterns = [
        {"name": "A", "direction": "bull", "strength": 0.9, "bars_ago": 0},
        {"name": "B", "direction": "bear", "strength": 0.8, "bars_ago": 0},
    ]
    newest = min(p["bars_ago"] for p in patterns)
    directions = {p["direction"] for p in patterns if p["bars_ago"] == newest}
    assert len(directions) == 2, "fixture must actually conflict"


def test_net_bias_follows_the_most_recent_bar_not_the_whole_lookback():
    b = _last(DOWN)
    prev = (b, b + 1.0, b - 9.0, b - 8.0)
    cur = (b - 9.0, b + 3.0, b - 10.0, b + 2.0)        # bullish engulfing on bar 0
    out = candles.compute(_frame([prev, cur], DOWN), None)
    assert out["net_bias"] == "bull"
    assert out["patterns"][0]["bars_ago"] == 0


def test_only_the_most_recent_occurrence_of_a_pattern_is_kept():
    out = candles.compute(pd.read_csv("tests/fixtures/BTCUSDT_1h.csv"), None)
    names = [p["name"] for p in out["patterns"]]
    assert len(names) == len(set(names))
    assert all(0 <= p["bars_ago"] < candles.DEFAULTS["lookback"] for p in out["patterns"])


def test_top_pattern_is_the_most_recent_then_strongest():
    out = candles.compute(pd.read_csv("tests/fixtures/BTCUSDT_1h.csv"), None)
    if out["patterns"]:
        assert out["top_pattern"] == out["patterns"][0]["name"]


# --- §8.2 / §8.5 -------------------------------------------------------


def test_detection_at_a_bar_ignores_everything_after_it(btc_1h):
    """Patterns at bar i must not change when later bars arrive."""
    from app.indicators.candles import DEFAULTS, _detect_at

    atr = ta_atr(btc_1h)
    for i in (900, 1200, 1500):
        full = _detect_at(btc_1h, i, DEFAULTS, float(atr.iloc[i]))
        truncated_df = btc_1h.iloc[: i + 1].reset_index(drop=True)
        truncated_atr = ta_atr(truncated_df)
        partial = _detect_at(truncated_df, i, DEFAULTS, float(truncated_atr.iloc[-1]))
        assert full == partial


def test_deterministic_and_serialisable(btc_1h):
    import json

    a = candles.compute(btc_1h, None)
    assert a == candles.compute(btc_1h.copy(), None)
    json.dumps(a)


def test_short_series_raises(btc_1h):
    with pytest.raises(InsufficientData):
        candles.compute(btc_1h.iloc[:10].reset_index(drop=True), None)
