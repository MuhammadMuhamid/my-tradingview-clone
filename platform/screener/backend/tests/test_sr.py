"""Support & Resistance — §4.8.

This is a reimplementation rather than a port, so there is no oracle to compare
against. The tests instead pin each of the five steps against hand-built series
where the correct answer is known by construction, plus the no-repaint property
that pivot detection makes easy to get wrong.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app import ta
from app.indicators import sr
from app.indicators.base import InsufficientData

L = 15  # default pivot_length


def _frame(highs, lows=None, closes=None) -> pd.DataFrame:
    highs = [float(h) for h in highs]
    n = len(highs)
    lows = [h - 1.0 for h in highs] if lows is None else [float(l) for l in lows]
    closes = [(h + l) / 2 for h, l in zip(highs, lows)] if closes is None else [float(c) for c in closes]
    return pd.DataFrame({
        "ts": np.arange(n, dtype="int64") * 3_600_000,
        "open": closes, "high": highs, "low": lows, "close": closes,
        "volume": [1000.0] * n,
    })


def _flat(n: int, price: float = 100.0) -> list[float]:
    return [price] * n


# --- step 1: pivots ----------------------------------------------------


def test_pivot_high_needs_length_bars_either_side():
    highs = _flat(40)
    highs[20] = 120.0
    df = _frame(highs)

    ph, pl = sr.find_pivots(df, L)
    assert ph == [20]

    # One bar too close to the end: cannot be confirmed, must not be reported.
    highs2 = _flat(40)
    highs2[30] = 120.0            # only 9 bars to the right
    assert sr.find_pivots(_frame(highs2), L)[0] == []


def test_pivot_low_is_detected_symmetrically():
    lows = _flat(40)
    lows[20] = 80.0
    df = _frame(_flat(40, 101.0), lows=lows)
    assert sr.find_pivots(df, L)[1] == [20]


def test_a_tied_extreme_is_not_a_pivot():
    """Two equal highs inside the window means neither is a unique extreme."""
    highs = _flat(60)
    highs[25] = 120.0
    highs[30] = 120.0
    assert sr.find_pivots(_frame(highs), L)[0] == []


def test_pivots_are_never_reported_inside_the_confirmation_lag():
    df = _frame([100.0 + i for i in range(200)])
    ph, pl = sr.find_pivots(df, L)
    assert all(i <= len(df) - 1 - L for i in ph + pl)
    assert all(i >= L for i in ph + pl)


# --- step 2 & 3: clustering and strength -------------------------------


def test_nearby_pivots_merge_into_one_level_with_strength_equal_to_the_count():
    """Three highs within ATR(20)/8 of each other are one level of strength 3."""
    highs = _flat(200, 100.0)
    for i, price in ((40, 130.0), (80, 130.02), (120, 129.98)):
        highs[i] = price
    df = _frame(highs)

    atr = ta.last(ta.atr(df, 20))
    spread = 0.04
    assert spread < atr / 8, "fixture must place the pivots inside the merge distance"

    found = [l for l in sr.levels(df, None) if l.price > 125]
    assert len(found) == 1
    assert found[0].strength == 3
    assert found[0].price == pytest.approx(np.mean([130.0, 130.02, 129.98]))


def test_pivots_further_apart_than_the_merge_distance_stay_separate():
    # Closes are held flat below both spikes, so neither level invalidates the
    # other — under "Close" invalidation a wick through a level does not kill it.
    highs = _flat(200, 100.0)
    highs[40] = 130.0
    highs[120] = 160.0
    df = _frame(highs, closes=_flat(200, 99.0))

    atr = ta.last(ta.atr(df, 20))
    assert 30.0 > atr / 8

    found = sorted(l.price for l in sr.levels(df, None) if l.price > 125)
    assert len(found) == 2
    assert found == pytest.approx([130.0, 160.0])


def test_min_strength_filters_single_pivot_levels():
    highs = _flat(240, 100.0)
    highs[40] = 130.0            # lone pivot, strength 1
    for i in (100, 140, 180):
        highs[i] = 160.0 + (i % 3) * 0.01   # cluster of 3
    df = _frame(highs, closes=_flat(240, 99.0))

    assert any(l.strength == 1 for l in sr.levels(df, {"min_strength": 1}))
    strong = sr.levels(df, {"min_strength": 2})
    assert strong and all(l.strength >= 2 for l in strong)
    assert not any(l.price == pytest.approx(130.0) for l in strong)


# --- step 4: invalidation ----------------------------------------------


def test_a_resistance_dies_when_price_closes_through_it():
    highs = _flat(120, 100.0)
    highs[40] = 130.0
    df = _frame(highs)
    assert any(l.price == pytest.approx(130.0) for l in sr.levels(df, None))

    # Same series, but price later closes above the level.
    highs_break = list(highs) + _flat(40, 140.0)
    broken = _frame(highs_break)
    assert not any(l.price == pytest.approx(130.0) for l in sr.levels(broken, None))


def test_a_support_dies_when_price_closes_through_it():
    lows = _flat(120, 100.0)
    lows[40] = 70.0
    base = _frame(_flat(120, 101.0), lows=lows)
    assert any(l.price == pytest.approx(70.0) for l in sr.levels(base, None))

    lows_break = list(lows) + _flat(40, 60.0)
    broken = _frame(_flat(160, 101.0)[: len(lows_break)], lows=lows_break,
                    closes=[101.0] * 120 + [60.0] * 40)
    assert not any(l.price == pytest.approx(70.0) for l in sr.levels(broken, None))


def test_wick_invalidation_is_stricter_than_close():
    """A wick through the level but a close back below kills it only in Wick mode."""
    n = 120
    highs = _flat(n, 100.0)
    highs[40] = 130.0
    closes = _flat(n, 99.0)

    # Later bar wicks to 135 but closes at 99 — under the level.
    highs = highs + [135.0] + _flat(20, 100.0)
    closes = closes + [99.0] + _flat(20, 99.0)
    lows = [c - 1.0 for c in closes]
    df = _frame(highs, lows=lows, closes=closes)

    survives_close = any(l.price == pytest.approx(130.0) for l in sr.levels(df, {"invalidation": "Close"}))
    survives_wick = any(l.price == pytest.approx(130.0) for l in sr.levels(df, {"invalidation": "Wick"}))

    assert survives_close, "a wick alone must not invalidate under Close"
    assert not survives_wick, "the wick must invalidate under Wick"


# --- step 5: age -------------------------------------------------------


def test_levels_older_than_max_distance_bars_are_discarded():
    highs = _flat(700, 100.0)
    highs[40] = 130.0            # ~660 bars back — outside a 500-bar horizon
    highs[400] = 160.0           # ~300 bars back — inside it
    df = _frame(highs, closes=_flat(700, 99.0))

    prices = {round(l.price, 2) for l in sr.levels(df, {"max_distance_bars": 500})}
    assert 160.0 in prices
    assert 130.0 not in prices

    wider = {round(l.price, 2) for l in sr.levels(df, {"max_distance_bars": 700})}
    assert 130.0 in wider


# --- outputs -----------------------------------------------------------


def test_position_in_range_is_zero_at_support_and_one_at_resistance():
    out = sr.compute(pd.read_csv("tests/fixtures/BTCUSDT_1h.csv"), None)
    assert 0.0 <= out["position_in_range"] <= 1.0

    close = 80066.3
    span = out["nearest_resistance"] - out["nearest_support"]
    assert out["position_in_range"] == pytest.approx((close - out["nearest_support"]) / span)


def test_nearest_levels_bracket_the_close(btc_1h):
    out = sr.compute(btc_1h, None)
    close = float(btc_1h["close"].iloc[-1])
    assert out["nearest_support"] <= close < out["nearest_resistance"]

    assert out["dist_to_support_pct"] == pytest.approx(
        abs(close - out["nearest_support"]) / close * 100
    )
    assert out["dist_to_support_atr"] > 0 and out["dist_to_resistance_atr"] > 0


def test_nearest_support_is_the_closest_one_below(btc_1h):
    out = sr.compute(btc_1h, None)
    close = float(btc_1h["close"].iloc[-1])
    below = [l["price"] for l in out["levels"] if l["price"] <= close]
    above = [l["price"] for l in out["levels"] if l["price"] > close]
    assert out["nearest_support"] == pytest.approx(max(below))
    assert out["nearest_resistance"] == pytest.approx(min(above))


def test_in_zone_is_true_only_within_the_merge_distance():
    highs = _flat(200, 100.0)
    highs[40] = 130.0
    df = _frame(highs)
    assert sr.compute(df, None)["in_zone"] is False

    # Walk price up to sit right on the level.
    atr = ta.last(ta.atr(df, 20))
    on_level = list(highs) + [130.0 - atr / 16]
    df2 = _frame(on_level, closes=[(h + h - 1) / 2 for h in highs] + [130.0 - atr / 16])
    assert sr.compute(df2, None)["in_zone"] is True


def test_missing_side_yields_none_not_a_crash():
    """A series with no level above price must report a null resistance."""
    lows = _flat(200, 100.0)
    lows[40] = 70.0
    df = _frame(_flat(200, 101.0), lows=lows)
    out = sr.compute(df, None)
    assert out["nearest_resistance"] is None
    assert out["dist_to_resistance_pct"] is None
    assert out["resistance_strength"] is None
    assert out["position_in_range"] is None


# --- §8.2 / §8.5 -------------------------------------------------------


# S&R has no series form, so its no-lookahead guarantee is pinned by
# test_a_level_does_not_appear_before_its_pivot_confirms below, which walks a
# level across its confirmation boundary.


def test_a_level_does_not_appear_before_its_pivot_confirms():
    """The bar the pivot happened on is not enough — it needs `length` bars after."""
    highs = _flat(200, 100.0)
    highs[150] = 130.0
    full = _frame(highs)

    at_pivot = sr.levels(full.iloc[: 150 + 1].reset_index(drop=True), None)
    assert not any(l.price == pytest.approx(130.0) for l in at_pivot)

    one_short = sr.levels(full.iloc[: 150 + L].reset_index(drop=True), None)
    assert not any(l.price == pytest.approx(130.0) for l in one_short)

    confirmed = sr.levels(full.iloc[: 150 + L + 1].reset_index(drop=True), None)
    assert any(l.price == pytest.approx(130.0) for l in confirmed)


def test_deterministic_and_serialisable(btc_1h):
    import json

    a = sr.compute(btc_1h, None)
    assert a == sr.compute(btc_1h.copy(), None)
    json.dumps(a)


def test_short_series_raises(btc_1h):
    with pytest.raises(InsufficientData):
        sr.compute(btc_1h.iloc[:20].reset_index(drop=True), None)
