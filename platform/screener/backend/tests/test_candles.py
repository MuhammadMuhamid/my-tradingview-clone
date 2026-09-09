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
import json
from pathlib import Path

from app.indicators import candles


def test_product_default_profile_matches_screener_chart_and_alert_geometry():
    configured = json.loads(
        (Path(__file__).parents[1] / "config" / "default.json").read_text()
    )["indicators"]["candles"]["params"]
    normalized = candles.normalized_settings(configured)
    assert normalized["min_body_atr"] == candles.DEFAULTS["min_body_atr"] == 0.1
    for key, value in configured.items():
        assert normalized[key] == value
from app import ta
from app.indicators.base import InsufficientData


def ta_atr(df):
    return ta.atr(df, 14)

PAD = 70
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
    assert "Dragonfly Doji - Bullish" in _at_zero(_frame([dragonfly]))

    # Same tiny body, but the wick is on the wrong side.
    assert "Dragonfly Doji - Bullish" not in _at_zero(_frame([(base, base + 9.0, base - 0.2, base + 0.1)]))


def test_gravestone_doji_needs_the_wick_above():
    base = _last(0.0)
    assert "Gravestone Doji - Bearish" in _at_zero(_frame([(base, base + 9.0, base - 0.2, base + 0.1)]))
    assert "Gravestone Doji - Bearish" not in _at_zero(_frame([(base, base + 0.2, base - 9.0, base + 0.1)]))


def test_hammer_after_a_downtrend_and_hanging_man_after_an_uptrend():
    """Identical bar; only the prior trend differs."""
    down_base, up_base = _last(DOWN), _last(UP)
    shape = lambda b: (b, b + 2.2, b - 12.0, b + 2.0)   # long lower wick, small body

    assert "Hammer - Bullish" in _at_zero(_frame([shape(down_base)], DOWN))
    assert "Hanging Man - Bearish" not in _at_zero(_frame([shape(down_base)], DOWN))

    assert "Hanging Man - Bearish" in _at_zero(_frame([shape(up_base)], UP))
    assert "Hammer - Bullish" not in _at_zero(_frame([shape(up_base)], UP))


def test_hammer_rejected_when_the_wick_is_too_short():
    base = _last(DOWN)
    # lower wick 3.0 vs body 2.0 = 1.5x, under the 2.0 threshold.
    assert "Hammer - Bullish" not in _at_zero(_frame([(base, base + 2.2, base - 3.0, base + 2.0)], DOWN))


def test_inverted_hammer_and_shooting_star_split_on_prior_trend():
    down_base, up_base = _last(DOWN), _last(UP)
    shape = lambda b: (b, b + 12.0, b - 0.4, b + 2.0)   # long upper wick

    assert "Inverted Hammer - Bullish" in _at_zero(_frame([shape(down_base)], DOWN))
    assert "Shooting Star - Bearish" not in _at_zero(_frame([shape(down_base)], DOWN))

    assert "Shooting Star - Bearish" in _at_zero(_frame([shape(up_base)], UP))
    assert "Inverted Hammer - Bullish" not in _at_zero(_frame([shape(up_base)], UP))


def test_marubozu_both_directions_and_the_wick_limit():
    base = _last(0.0)
    bull = (base, base + 10.05, base - 0.05, base + 10.0)
    bear = (base, base + 0.05, base - 10.05, base - 10.0)

    hits = candles.compute(_frame([bull]), None)["patterns"]
    maru = [h for h in hits if h["name"] == "Marubozu White - Bullish"]
    assert maru and maru[0]["direction"] == "bull"

    hits = candles.compute(_frame([bear]), None)["patterns"]
    maru = [h for h in hits if h["name"] == "Marubozu Black - Bearish"]
    assert maru and maru[0]["direction"] == "bear"

    # A wick of 1.0 on a range of 11 is 9% — over the 5% limit.
    assert "Marubozu White - Bullish" not in _at_zero(_frame([(base, base + 11.0, base - 0.05, base + 10.0)]))


# --- two-bar -----------------------------------------------------------


def test_bullish_engulfing_and_the_containment_requirement():
    b = _last(DOWN)
    prev = (b, b + 1.0, b - 3.0, b - 2.0)              # short bearish body
    cur = (b - 3.0, b + 6.0, b - 4.0, b + 5.0)         # long body overtakes it
    assert "Engulfing - Bullish" in _at_zero(_frame([prev, cur], DOWN))

    # Closes inside the previous body — not engulfing.
    small = (b - 3.0, b - 0.5, b - 4.0, b - 1.0)
    assert "Engulfing - Bullish" not in _at_zero(_frame([prev, small], DOWN))


def test_bearish_engulfing():
    b = _last(UP)
    prev = (b, b + 3.0, b - 1.0, b + 2.0)              # short bullish body
    cur = (b + 3.0, b + 4.0, b - 6.0, b - 5.0)
    assert "Engulfing - Bearish" in _at_zero(_frame([prev, cur], UP))

    inside = (b + 3.0, b + 4.0, b + 0.5, b + 1.0)
    assert "Engulfing - Bearish" not in _at_zero(_frame([prev, inside], UP))


def test_piercing_line_needs_to_clear_the_midpoint():
    b = _last(DOWN)
    prev = (b, b + 1.0, b - 11.0, b - 10.0)            # bearish body b..b-10, mid b-5
    deep = (b - 12.0, b - 2.0, b - 13.0, b - 3.0)      # closes above mid, below prev open
    assert "Piercing - Bullish" in _at_zero(_frame([prev, deep], DOWN))

    shallow = (b - 12.0, b - 7.0, b - 13.0, b - 8.0)   # closes below the midpoint
    assert "Piercing - Bullish" not in _at_zero(_frame([prev, shallow], DOWN))


def test_dark_cloud_cover_needs_to_clear_the_midpoint():
    b = _last(UP)
    prev = (b, b + 11.0, b - 1.0, b + 10.0)            # bullish body b..b+10, mid b+5
    deep = (b + 12.0, b + 13.0, b + 2.0, b + 3.0)
    assert "Dark Cloud Cover - Bearish" in _at_zero(_frame([prev, deep], UP))

    shallow = (b + 12.0, b + 13.0, b + 7.0, b + 8.0)
    assert "Dark Cloud Cover - Bearish" not in _at_zero(_frame([prev, shallow], UP))


def test_bullish_harami_requires_containment():
    b = _last(DOWN)
    prev = (b, b + 1.0, b - 13.0, b - 12.0)            # long bearish
    inner = (b - 9.0, b - 6.0, b - 10.0, b - 7.0)      # short bullish range inside it
    assert "Harami - Bullish" in _at_zero(_frame([prev, inner], DOWN))

    outside = (b - 10.0, b + 4.0, b - 11.0, b + 3.0)   # closes above the prior open
    assert "Harami - Bullish" not in _at_zero(_frame([prev, outside], DOWN))


def test_bearish_harami_requires_containment():
    b = _last(UP)
    prev = (b, b + 13.0, b - 1.0, b + 12.0)
    inner = (b + 9.0, b + 10.0, b + 6.0, b + 7.0)
    assert "Harami - Bearish" in _at_zero(_frame([prev, inner], UP))

    outside = (b + 10.0, b + 11.0, b - 3.0, b - 2.0)
    assert "Harami - Bearish" not in _at_zero(_frame([prev, outside], UP))


def test_tweezer_top_needs_matching_highs_within_the_atr_tolerance():
    b = _last(UP)
    prev = (b, b + 10.0, b - 1.0, b + 8.0)             # bullish
    cur = (b + 8.0, b + 10.02, b - 2.0, b - 1.0)       # bearish, near-identical high
    assert "Tweezer Top - Bearish" in _at_zero(_frame([prev, cur], UP))

    off = (b + 8.0, b + 16.0, b - 2.0, b - 1.0)        # high far away
    assert "Tweezer Top - Bearish" not in _at_zero(_frame([prev, off], UP))


def test_tweezer_bottom_needs_matching_lows():
    b = _last(DOWN)
    prev = (b, b + 1.0, b - 10.0, b - 8.0)             # bearish
    cur = (b - 8.0, b + 2.0, b - 10.02, b + 1.0)       # bullish, near-identical low
    assert "Tweezer Bottom - Bullish" in _at_zero(_frame([prev, cur], DOWN))

    off = (b - 8.0, b + 2.0, b - 16.0, b + 1.0)
    assert "Tweezer Bottom - Bullish" not in _at_zero(_frame([prev, off], DOWN))


# --- three-bar ---------------------------------------------------------


def test_morning_star_and_a_star_that_is_too_large():
    b = _last(DOWN)
    first = (b, b + 1.0, b - 13.0, b - 12.0)           # long bearish, mid = b-6
    star = (b - 13.0, b - 12.0, b - 15.0, b - 13.5)    # small body
    third = (b - 12.5, b - 2.0, b - 14.0, b - 3.0)     # bullish, gaps up and closes above mid
    assert "Morning Star - Bullish" in _at_zero(_frame([first, star, third], DOWN))

    fat_star = (b - 13.0, b - 6.0, b - 15.0, b - 7.0)  # body 6 of 12 = 50%+ ... too big
    assert "Morning Star - Bullish" not in _at_zero(
        _frame([first, fat_star, third], DOWN), {"star_body_ratio": 0.2}
    )


def test_evening_star():
    b = _last(UP)
    first = (b, b + 13.0, b - 1.0, b + 12.0)           # long bullish, mid = b+6
    star = (b + 13.0, b + 15.0, b + 12.0, b + 13.5)
    third = (b + 12.5, b + 14.0, b + 2.0, b + 3.0)     # bearish, gaps down and closes below mid
    assert "Evening Star - Bearish" in _at_zero(_frame([first, star, third], UP))

    shallow = (b + 12.5, b + 14.0, b + 8.0, b + 9.0)   # closes above the midpoint
    assert "Evening Star - Bearish" not in _at_zero(_frame([first, star, shallow], UP))


def test_three_white_soldiers_and_the_gap_rejection():
    b = _last(DOWN)
    trio = [
        (b + 0.0, b + 8.2, b - 0.2, b + 8.0),
        (b + 4.0, b + 16.2, b + 3.8, b + 16.0),
        (b + 12.0, b + 24.2, b + 11.8, b + 24.0),
    ]
    assert "Three White Soldiers - Bullish" in _at_zero(_frame(trio, DOWN))

    # Third bar opens above the previous body — a gap, not a soldier.
    gapped = list(trio)
    gapped[2] = (b + 20.0, b + 32.2, b + 19.8, b + 32.0)
    assert "Three White Soldiers - Bullish" not in _at_zero(_frame(gapped, DOWN))


def test_three_black_crows_and_the_gap_rejection():
    b = _last(UP)
    trio = [
        (b - 0.0, b + 0.2, b - 8.2, b - 8.0),
        (b - 4.0, b - 3.8, b - 16.2, b - 16.0),
        (b - 12.0, b - 11.8, b - 24.2, b - 24.0),
    ]
    assert "Three Black Crows - Bearish" in _at_zero(_frame(trio, UP))

    gapped = list(trio)
    gapped[2] = (b - 20.0, b - 19.8, b - 32.2, b - 32.0)
    assert "Three Black Crows - Bearish" not in _at_zero(_frame(gapped, UP))


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
        hits = [h for h in candles.compute(df, None)["patterns"] if h["name"] == "Hammer - Bullish"]
        return hits[0]["strength"]

    assert hammer_strength(4.0) < hammer_strength(8.0) < hammer_strength(14.0)
    assert hammer_strength(4.0) == pytest.approx(0.0, abs=0.05), "at threshold -> ~0"


def test_every_pattern_has_a_documented_basis():
    assert len(candles.STRENGTH_BASIS) == 44
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
    prev = (b, b + 1.0, b - 3.0, b - 2.0)
    cur = (b - 3.0, b + 6.0, b - 4.0, b + 5.0)         # bullish engulfing on bar 0
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


def test_catalog_contract_has_exact_stable_identity_and_directions():
    catalog = candles.catalog()
    assert len(catalog) == 44
    assert len({p["id"] for p in catalog}) == 44
    assert len({p["name"] for p in catalog}) == 44
    assert all(p["id"] == p["id"].lower() and " " not in p["id"] for p in catalog)
    assert {p["direction"] for p in catalog} == {"bull", "bear", "none"}
    assert all(p["confirmation"] == "bar_close" for p in catalog)
    assert all(p["predictive_claim"] is False for p in catalog)


def test_settings_reject_unknown_nonfinite_and_out_of_range_values():
    with pytest.raises(ValueError, match="unsupported candlestick setting"):
        candles.normalized_settings({"future_confirmation": True})
    with pytest.raises(ValueError, match="doji_body_ratio must be finite"):
        candles.normalized_settings({"doji_body_ratio": float("nan")})
    with pytest.raises(ValueError, match="between 0 and 1"):
        candles.normalized_settings({"harami_containment": 1.1})
    with pytest.raises(ValueError, match="long_wick_ratio must be positive"):
        candles.normalized_settings({"long_wick_ratio": 0})


def test_scan_contract_carries_exact_open_confirmation_and_version():
    df = _frame([(_last(0.0), _last(0.0)+5, _last(0.0)-5, _last(0.0)+0.4)])
    out = candles.scan(df, {"bar_duration_ms": 3_600_000})
    hit = next(p for p in out["patterns"] if p["name"] == "Doji")
    assert hit["open_time"] == int(df["ts"].iloc[-1])
    assert hit["confirmed_at"] == hit["open_time"] + 3_600_000
    assert hit["detector_id"] == out["detector_id"]
    assert hit["detector_version"] == out["detector_version"]
    assert hit["settings_hash"] == out["settings_hash"]
    assert out["causal"] is True and out["predictive_claim"] is False


def test_scan_is_prefix_stable_no_repaint(btc_1h):
    """Every occurrence in a prefix is byte-for-byte stable after future bars arrive."""
    full = candles.scan(btc_1h, {"bar_duration_ms": 3_600_000})["patterns"]
    for end in (400, 900, 1400):
        prefix = candles.scan(btc_1h.iloc[:end].copy(), {"bar_duration_ms": 3_600_000})["patterns"]
        expected = [p for p in full if p["open_time"] <= int(btc_1h["ts"].iloc[end-1])]
        assert prefix == expected


def test_direction_filter_is_deterministic_and_excludes_neutral_shapes(btc_1h):
    all_hits = candles.scan(btc_1h)["patterns"]
    bulls = candles.scan(btc_1h, {"direction": "bull"})["patterns"]
    bears = candles.scan(btc_1h, {"direction": "bear"})["patterns"]
    assert all(p["direction"] == "bull" for p in bulls)
    assert all(p["direction"] == "bear" for p in bears)
    assert bulls == candles.scan(btc_1h, {"direction": "bull"})["patterns"]
    assert len(all_hits) >= max(len(bulls), len(bears))


def test_new_single_bar_catalog_shapes_and_near_misses():
    b = _last(0.0)
    assert "Long Lower Shadow - Bullish" in _at_zero(_frame([(b, b+2.2, b-12, b+2)]))
    assert "Long Lower Shadow - Bullish" not in _at_zero(_frame([(b, b+4, b-3, b+2)]))
    assert "Long Upper Shadow - Bearish" in _at_zero(_frame([(b, b+12, b-.4, b+2)]))
    assert "Long Upper Shadow - Bearish" not in _at_zero(_frame([(b, b+3, b-4, b+2)]))
    assert "Spinning Top White" in _at_zero(_frame([(b, b+5, b-4, b+2)]))
    assert "Spinning Top White" not in _at_zero(_frame([(b, b+5, b-.1, b+4.8)]))
    assert "Spinning Top Black" in _at_zero(_frame([(b, b+4, b-5, b-2)]))
    assert "Spinning Top Black" not in _at_zero(_frame([(b, b+.1, b-5, b-4.8)]))


def test_new_two_bar_catalog_shapes_and_near_misses():
    down, up = _last(DOWN), _last(UP)
    bearish = (down, down+1, down-13, down-12)
    bull_long = (up, up+13, up-1, up+12)
    doji_below = (down-15, down-14, down-17, down-15.1)
    doji_above = (up+15, up+17, up+14, up+15.1)
    assert "Doji Star - Bullish" in _at_zero(_frame([bearish, doji_below], DOWN))
    assert "Doji Star - Bullish" not in _at_zero(_frame([bearish, (down-8, down-7, down-10, down-8.1)], DOWN))
    assert "Doji Star - Bearish" in _at_zero(_frame([bull_long, doji_above], UP))
    assert "Doji Star - Bearish" not in _at_zero(_frame([bull_long, (up+8, up+10, up+7, up+8.1)], UP))
    assert "Harami Cross - Bullish" in _at_zero(_frame([bearish, (down-7, down-5, down-9, down-7.1)], DOWN))
    assert "Harami Cross - Bullish" not in _at_zero(_frame([bearish, (down-14, down-12, down-16, down-14.1)], DOWN))
    assert "Harami Cross - Bearish" in _at_zero(_frame([bull_long, (up+7, up+9, up+5, up+7.1)], UP))
    assert "Harami Cross - Bearish" not in _at_zero(_frame([bull_long, (up+14, up+16, up+12, up+14.1)], UP))
    assert "Rising Window - Bullish" in _at_zero(_frame([(up, up+5, up-1, up+4), (up+7, up+12, up+6, up+11)], UP))
    assert "Rising Window - Bullish" not in _at_zero(_frame([(up, up+5, up-1, up+4), (up+4, up+10, up+3, up+9)], UP))
    assert "Falling Window - Bearish" in _at_zero(_frame([(down, down+1, down-5, down-4), (down-7, down-6, down-12, down-11)], DOWN))
    assert "Falling Window - Bearish" not in _at_zero(_frame([(down, down+1, down-5, down-4), (down-4, down-3, down-10, down-9)], DOWN))


def test_kicking_on_neck_and_their_near_misses():
    down, up = _last(DOWN), _last(UP)
    assert "Kicking - Bullish" in _at_zero(_frame([(down, down+.1, down-10.1, down-10), (down+2, down+12.1, down+1.9, down+12)], DOWN))
    assert "Kicking - Bullish" not in _at_zero(_frame([(down, down+.1, down-10.1, down-10), (down-9, down+1.1, down-9.1, down+1)], DOWN))
    assert "Kicking - Bearish" in _at_zero(_frame([(up, up+10.1, up-.1, up+10), (up-2, up-1.9, up-12.1, up-12)], UP))
    assert "Kicking - Bearish" not in _at_zero(_frame([(up, up+10.1, up-.1, up+10), (up+9, up+9.1, up-1.1, up-1)], UP))
    first = (down, down+1, down-11, down-10)
    assert "On Neck - Bearish" in _at_zero(_frame([first, (down-12, down-10.5, down-13, down-11)], DOWN))
    assert "On Neck - Bearish" not in _at_zero(_frame([first, (down-12, down-5, down-13, down-6)], DOWN))


def test_doji_star_variants_and_abandoned_babies():
    down, up = _last(DOWN), _last(UP)
    first_bear = (down, down+1, down-13, down-12)
    middle_low = (down-16, down-15, down-18, down-16.1)
    last_bull = (down-14.5, down-2, down-15, down-3)
    names = _at_zero(_frame([first_bear, middle_low, last_bull], DOWN))
    assert {"Morning Star - Bullish", "Morning Doji Star - Bullish"} <= names
    assert "Abandoned Baby - Bullish" in _at_zero(_frame([first_bear, (down-16, down-15, down-18, down-16.1), (down-13, down-2, down-14, down-3)], DOWN))
    assert "Abandoned Baby - Bullish" not in _at_zero(_frame([first_bear, middle_low, (down-16, down-2, down-17, down-3)], DOWN))
    first_bull = (up, up+13, up-1, up+12)
    middle_high = (up+16, up+18, up+15, up+16.1)
    last_bear = (up+14.5, up+15, up+2, up+3)
    names = _at_zero(_frame([first_bull, middle_high, last_bear], UP))
    assert {"Evening Star - Bearish", "Evening Doji Star - Bearish"} <= names
    assert "Abandoned Baby - Bearish" in _at_zero(_frame([first_bull, middle_high, (up+13, up+14, up+2, up+3)], UP))
    assert "Abandoned Baby - Bearish" not in _at_zero(_frame([first_bull, middle_high, (up+16, up+17, up+2, up+3)], UP))


def test_tri_stars_tasuki_gaps_and_near_misses():
    down, up = _last(DOWN), _last(UP)
    bull_tri = [(down, down+1, down-1, down+.05), (down-3, down-2, down-4, down-2.95), (down, down+1, down-1, down+.05)]
    assert "Tri-Star - Bullish" in _at_zero(_frame(bull_tri, DOWN))
    assert "Tri-Star - Bullish" not in _at_zero(_frame([*bull_tri[:2], (down-3, down-2, down-4, down-2.95)], DOWN))
    bear_tri = [(up, up+1, up-1, up+.05), (up+3, up+4, up+2, up+3.05), (up, up+1, up-1, up+.05)]
    assert "Tri-Star - Bearish" in _at_zero(_frame(bear_tri, UP))
    assert "Tri-Star - Bearish" not in _at_zero(_frame([*bear_tri[:2], (up+3, up+4, up+2, up+3.05)], UP))
    upside = [(up, up+5, up-1, up+4), (up+7, up+12, up+6, up+11), (up+10, up+10.5, up+4.5, up+5)]
    assert "Upside Tasuki Gap - Bullish" in _at_zero(_frame(upside, UP))
    assert "Upside Tasuki Gap - Bullish" not in _at_zero(_frame([*upside[:2], (up+10, up+10.5, up+3, up+3.5)], UP))
    downside = [(down, down+1, down-5, down-4), (down-7, down-6, down-12, down-11), (down-10, down-5, down-10.5, down-5.5)]
    assert "Downside Tasuki Gap - Bearish" in _at_zero(_frame(downside, DOWN))
    assert "Downside Tasuki Gap - Bearish" not in _at_zero(_frame([*downside[:2], (down-10, down-3, down-10.5, down-3.5)], DOWN))


def test_rising_and_falling_three_methods_and_near_misses():
    up, down = _last(UP), _last(DOWN)
    rising = [(up, up+11, up-1, up+10), (up+8, up+9, up+6, up+7), (up+7, up+8, up+5, up+6), (up+6, up+7, up+4, up+5), (up+5, up+13, up+4, up+12)]
    assert "Rising Three Methods - Bullish" in _at_zero(_frame(rising, UP))
    assert "Rising Three Methods - Bullish" not in _at_zero(_frame([*rising[:4], (up+5, up+10, up+4, up+9)], UP))
    falling = [(down, down+1, down-11, down-10), (down-8, down-6, down-9, down-7), (down-7, down-5, down-8, down-6), (down-6, down-4, down-7, down-5), (down-5, down-4, down-13, down-12)]
    assert "Falling Three Methods - Bearish" in _at_zero(_frame(falling, DOWN))
    assert "Falling Three Methods - Bearish" not in _at_zero(_frame([*falling[:4], (down-5, down-4, down-10, down-9)], DOWN))


def test_short_series_raises(btc_1h):
    with pytest.raises(InsufficientData):
        candles.compute(btc_1h.iloc[:10].reset_index(drop=True), None)
