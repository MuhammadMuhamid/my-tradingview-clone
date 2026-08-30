"""Confluence score — §6.1.

The two properties that matter most are negative ones: the score must **not**
behave like a probability, and correlated inputs must **not** be able to
manufacture confluence by voting several times for the same price move.
"""

from __future__ import annotations

import math

import pandas as pd
import pytest

from app import scoring
from app.indicators import REGISTRY


@pytest.fixture(scope="module")
def btc_indicators():
    df = pd.read_csv("tests/fixtures/BTCUSDT_1h.csv")
    return {k: m.compute(df, None) for k, m in REGISTRY.items()}


def _ind(**overrides) -> dict:
    """A neutral indicator set, with selected fields overridden."""
    base = {
        "ema": {"stack": "mixed", "atr": 100.0,
                **{f"dist_atr_{n}": 0.0 for n in (21, 50, 100, 200)}},
        "rsi": {"rsi": 50.0, "slope": 0.0},
        "macd": {"hist": 0.0, "bars_since_cross": 5},
        "vfi": {"vfi": 0.0, "hist": 0.0, "slope": 0.0},
        "adx": {"regime": "trending", "direction": "bull", "adx": 30.0},
        "supertrend": {"direction": 1, "bars_since_flip": 50},
        "sr": {"position_in_range": 0.5, "dist_to_support_atr": 1.0,
               "dist_to_resistance_atr": 1.0},
        "candles": {"net_bias": "none", "patterns": []},
    }
    for key, value in overrides.items():
        base[key] = {**base[key], **value} if value is not None else None
        if value is None:
            del base[key]
    return base


# --- it is a score, not a probability ---------------------------------


def test_it_is_labelled_a_score_and_carries_the_disclaimer(btc_indicators):
    out = scoring.compute(btc_indicators, None)
    assert out["label"] == "Confluence Score"
    assert "not a probability" in out["disclaimer"]
    assert "not been validated against forward returns" in out["disclaimer"]
    assert "probability" not in str(out["buckets"]).lower()


def test_nothing_in_the_payload_is_named_like_a_probability(btc_indicators):
    out = scoring.compute(btc_indicators, None)
    for key in out:
        assert "prob" not in key.lower()
        assert "chance" not in key.lower()
        assert "%" not in key


# --- the anti-fake-confluence design ----------------------------------


def test_a_pure_trend_move_cannot_saturate_the_score():
    """§6.1's core problem: EMA, Supertrend, ADX and MACD share one price series.

    Everything trend-shaped maxed out, everything else neutral. If those were
    counted as independent votes the score would sit near 100. Bucketing caps
    the trend contribution at its own weight.
    """
    ind = _ind(
        ema={"stack": "bull", **{f"dist_atr_{n}": 10.0 for n in (21, 50, 100, 200)}},
        supertrend={"direction": 1, "bars_since_flip": 200},
        macd={"hist": 500.0, "bars_since_cross": 0},
        adx={"regime": "trending", "direction": "bull"},
    )
    out = scoring.compute(ind, None)

    assert out["buckets"]["trend"]["sub_score"] == pytest.approx(1.0, abs=0.02)
    # Trend is 30 of 100 and momentum only partly moves, so the ceiling is far
    # short of saturation while volume, location and trigger stay neutral.
    assert out["score"] < 80, f"a single trend move reached {out['score']:.1f}"
    assert out["signed"] < 60


def test_agreement_across_independent_buckets_scores_higher_than_one_bucket():
    trend_only = scoring.compute(
        _ind(ema={"stack": "bull", **{f"dist_atr_{n}": 10.0 for n in (21, 50, 100, 200)}},
             supertrend={"direction": 1, "bars_since_flip": 200}),
        None,
    )
    everything = scoring.compute(
        _ind(ema={"stack": "bull", **{f"dist_atr_{n}": 10.0 for n in (21, 50, 100, 200)}},
             supertrend={"direction": 1, "bars_since_flip": 200},
             rsi={"rsi": 65.0, "slope": 4.0},
             macd={"hist": 200.0, "bars_since_cross": 1},
             vfi={"vfi": 4.0, "hist": 3.0, "slope": 2.0},
             sr={"position_in_range": 0.05, "dist_to_support_atr": 0.1,
                 "dist_to_resistance_atr": 4.0},
             candles={"net_bias": "bull",
                      "patterns": [{"name": "Hammer", "direction": "bull",
                                    "strength": 0.9, "bars_ago": 0}]}),
        None,
    )
    assert everything["score"] > trend_only["score"] + 15


def test_location_uses_the_atr_distances_for_something_position_cannot_express():
    """The obvious second component is algebraically identical to the first.

    `(d_res - d_sup) / (d_res + d_sup)` expands to exactly `1 - 2 * position`,
    so averaging them would show one number twice and read as two confirmations.
    Proximity is used for conviction instead: the same relative position inside
    a tight range must score harder than inside a wide one.
    """
    tight = scoring.compute(
        _ind(sr={"position_in_range": 0.0, "dist_to_support_atr": 0.05,
                 "dist_to_resistance_atr": 1.0}), None,
    )["buckets"]["location"]
    wide = scoring.compute(
        _ind(sr={"position_in_range": 0.0, "dist_to_support_atr": 6.0,
                 "dist_to_resistance_atr": 20.0}), None,
    )["buckets"]["location"]

    assert tight["sub_score"] > wide["sub_score"]
    assert tight["sub_score"] > 0.9, "sitting on support should read strongly bullish"
    assert abs(wide["sub_score"]) < 0.3, "a distant level should barely register"

    # And the redundant formulation must not be present as a separate component.
    assert "atr_balance" not in tight["components"]


# --- ADX is a gate, not a vote ----------------------------------------


def test_adx_is_a_multiplier_on_trend_and_trigger_only():
    strong = _ind(
        ema={"stack": "bull", **{f"dist_atr_{n}": 4.0 for n in (21, 50, 100, 200)}},
        vfi={"vfi": 3.0, "hist": 2.0, "slope": 1.0},
        candles={"net_bias": "bull",
                 "patterns": [{"name": "Hammer", "direction": "bull",
                               "strength": 1.0, "bars_ago": 0}]},
    )
    trending = scoring.compute({**strong, "adx": {"regime": "trending", "direction": "bull"}}, None)
    ranging = scoring.compute({**strong, "adx": {"regime": "ranging", "direction": "bull"}}, None)

    assert ranging["gate"]["multiplier"] == 0.5
    assert ranging["gate"]["applies_to"] == ["trend", "trigger"]
    assert ranging["score"] < trending["score"]

    # The gated buckets' effective weights halve; the others do not move.
    for bucket in ("trend", "trigger"):
        assert ranging["buckets"][bucket]["effective_weight"] == pytest.approx(
            trending["buckets"][bucket]["effective_weight"] * 0.5
        )
    for bucket in ("momentum", "volume", "location"):
        assert ranging["buckets"][bucket]["effective_weight"] == pytest.approx(
            trending["buckets"][bucket]["effective_weight"]
        )


def test_adx_never_contributes_a_sub_score_of_its_own():
    out = scoring.compute(_ind(), None)
    assert set(out["buckets"]) == {"trend", "momentum", "volume", "location", "trigger"}
    assert "adx" not in out["buckets"]


def test_the_ranging_multiplier_is_configurable():
    strong = _ind(
        ema={"stack": "bull", **{f"dist_atr_{n}": 4.0 for n in (21, 50, 100, 200)}},
        adx={"regime": "ranging", "direction": "bull"},
    )
    assert scoring.compute(strong, {"ranging_multiplier": 0.0})["buckets"]["trend"][
        "effective_weight"
    ] == 0.0
    assert scoring.compute(strong, {"ranging_multiplier": 1.0})["gate"]["multiplier"] == 1.0


def test_di_conflict_hook_is_off_by_default_but_wired():
    """§6.1 names DI direction as a gate input but specifies only the regime."""
    bearish_trend = _ind(
        ema={"stack": "bear", **{f"dist_atr_{n}": -4.0 for n in (21, 50, 100, 200)}},
        supertrend={"direction": -1, "bars_since_flip": 50},
        adx={"regime": "trending", "direction": "bull"},
    )
    default = scoring.compute(bearish_trend, None)
    assert default["gate"]["di_conflicts_with_trend"] is True
    assert default["gate"]["multiplier"] == 1.0, "default must match the spec exactly"

    penalised = scoring.compute(bearish_trend, {"di_conflict_multiplier": 0.5})
    assert penalised["gate"]["multiplier"] == 0.5


# --- sub-scores are visible and auditable -----------------------------


def test_every_bucket_exposes_its_sub_score_weight_and_components(btc_indicators):
    out = scoring.compute(btc_indicators, None)
    for name in ("trend", "momentum", "volume", "location", "trigger"):
        bucket = out["buckets"][name]
        assert -1.0 <= bucket["sub_score"] <= 1.0
        assert bucket["weight"] > 0
        assert bucket["components"], f"{name} has no visible components"
        assert bucket["contribution"] == pytest.approx(
            bucket["effective_weight"] * bucket["sub_score"]
        )


def test_the_final_score_is_the_weighted_mean_of_the_sub_scores(btc_indicators):
    out = scoring.compute(btc_indicators, None)
    total = sum(b["contribution"] for b in out["buckets"].values() if b["contribution"] is not None)
    weight = sum(b["effective_weight"] for b in out["buckets"].values() if b["available"])
    assert out["signed"] == pytest.approx(total / weight * 100.0)
    assert out["score"] == pytest.approx((out["signed"] + 100.0) / 2.0)


def test_score_is_bounded(btc_indicators):
    for ind in (btc_indicators, _ind(), _ind(ema={"stack": "bull"}, rsi={"rsi": 99.0})):
        out = scoring.compute(ind, None)
        assert 0.0 <= out["score"] <= 100.0
        assert -100.0 <= out["signed"] <= 100.0


def test_a_fully_neutral_row_scores_fifty():
    """Neutral means 50 — but only once Supertrend is out of the picture.

    Supertrend has no neutral state: `direction` is always +1 or -1, so a row
    carrying it can never have an exactly-zero trend bucket. That is a property
    of the indicator, not a scoring bug, and it is pinned separately below.
    """
    out = scoring.compute(_ind(supertrend=None), None)
    assert out["score"] == pytest.approx(50.0, abs=1e-9)
    assert out["signed"] == pytest.approx(0.0, abs=1e-9)
    assert out["coverage"] == 1.0, "trend is still available via the EMA components"


def test_supertrend_always_leans_because_it_has_no_neutral_state():
    """Documented asymmetry: an otherwise flat row still scores off 50."""
    flat_but_bullish_st = scoring.compute(_ind(), None)
    flat_but_bearish_st = scoring.compute(
        _ind(supertrend={"direction": -1, "bars_since_flip": 50}), None
    )

    assert flat_but_bullish_st["score"] > 50.0
    assert flat_but_bearish_st["score"] < 50.0
    assert flat_but_bullish_st["signed"] == pytest.approx(-flat_but_bearish_st["signed"])
    # The lean is bounded by Supertrend's share of one bucket: it is one of three
    # trend components, and trend is 30 of 100.
    assert abs(flat_but_bullish_st["signed"]) == pytest.approx(30 / 3, abs=1e-9)


# --- missing inputs ----------------------------------------------------


def test_a_missing_indicator_narrows_the_basis_rather_than_dragging_the_score():
    """Disabling VFI must not look like a market-wide move toward neutral."""
    full = _ind(vfi={"vfi": 5.0, "hist": 4.0, "slope": 2.0},
                ema={"stack": "bull", **{f"dist_atr_{n}": 3.0 for n in (21, 50, 100, 200)}})
    without = {k: v for k, v in full.items() if k != "vfi"}

    a = scoring.compute(full, None)
    b = scoring.compute(without, None)

    assert a["coverage"] == 1.0
    assert b["coverage"] == pytest.approx(0.8)
    assert b["buckets"]["volume"]["available"] is False
    assert b["buckets"]["volume"]["effective_weight"] == 0.0
    # The remaining buckets are renormalised, so the score stays on the same scale.
    remaining = sum(
        v["contribution"] for k, v in b["buckets"].items() if v["contribution"] is not None
    )
    weight = sum(v["effective_weight"] for v in b["buckets"].values() if v["available"])
    assert b["signed"] == pytest.approx(remaining / weight * 100.0)


def test_no_usable_inputs_returns_none_not_fifty():
    out = scoring.compute({}, None)
    assert out["score"] is None
    assert out["signed"] is None
    assert out["coverage"] == 0.0
    assert out["note"] == "no bucket had usable inputs"


def test_location_is_unavailable_when_price_brackets_nothing():
    """4 of 36 symbols had no resistance above price on 2026-08-28."""
    ind = _ind(sr={"position_in_range": None, "dist_to_support_atr": 2.0,
                   "dist_to_resistance_atr": None})
    out = scoring.compute(ind, None)
    assert out["buckets"]["location"]["available"] is False
    assert out["score"] is not None, "the row must still score on the other buckets"


# --- trigger recency ---------------------------------------------------


def test_a_pattern_older_than_the_window_is_not_a_trigger():
    def bias_at(bars_ago: int) -> float:
        ind = _ind(candles={
            "net_bias": "bull",
            "patterns": [{"name": "Hammer", "direction": "bull",
                          "strength": 1.0, "bars_ago": bars_ago}],
        })
        return scoring.compute(ind, None)["buckets"]["trigger"]["sub_score"]

    assert bias_at(0) == pytest.approx(1.0)
    assert bias_at(2) == pytest.approx(1.0)
    assert bias_at(3) == pytest.approx(0.0), "outside trigger_max_bars_ago"


def test_conflicting_candles_contribute_nothing():
    ind = _ind(candles={
        "net_bias": "none",
        "patterns": [
            {"name": "Hammer", "direction": "bull", "strength": 0.9, "bars_ago": 0},
            {"name": "Shooting Star", "direction": "bear", "strength": 0.9, "bars_ago": 0},
        ],
    })
    assert scoring.compute(ind, None)["buckets"]["trigger"]["sub_score"] == pytest.approx(0.0)


def test_macd_cross_recency_decays_but_not_to_zero():
    def macd_at(bars: int) -> float:
        ind = _ind(macd={"hist": 200.0, "bars_since_cross": bars})
        return scoring.compute(ind, None)["buckets"]["momentum"]["components"]["macd"]

    assert macd_at(0) > macd_at(10) > macd_at(30)
    assert macd_at(60) > 0, "an old cross still says which side of the signal price sits on"


def test_supertrend_direction_is_discounted_until_it_matures():
    def st_at(bars: int) -> float:
        ind = _ind(supertrend={"direction": 1, "bars_since_flip": bars})
        return scoring.compute(ind, None)["buckets"]["trend"]["components"]["supertrend"]

    assert st_at(0) == pytest.approx(0.5)
    assert st_at(5) == pytest.approx(0.75)
    assert st_at(10) == pytest.approx(1.0)
    assert st_at(100) == pytest.approx(1.0)


# --- §8.5 --------------------------------------------------------------


def test_deterministic_and_serialisable(btc_indicators):
    import json

    a = scoring.compute(btc_indicators, None)
    assert a == scoring.compute(dict(btc_indicators), None)
    json.dumps(a)


def test_sign_is_symmetric_under_inversion():
    bull = _ind(
        ema={"stack": "bull", **{f"dist_atr_{n}": 3.0 for n in (21, 50, 100, 200)}},
        rsi={"rsi": 65.0, "slope": 3.0},
        vfi={"vfi": 2.0, "hist": 1.0, "slope": 0.5},
        supertrend={"direction": 1, "bars_since_flip": 50},
    )
    bear = _ind(
        ema={"stack": "bear", **{f"dist_atr_{n}": -3.0 for n in (21, 50, 100, 200)}},
        rsi={"rsi": 35.0, "slope": -3.0},
        vfi={"vfi": -2.0, "hist": -1.0, "slope": -0.5},
        supertrend={"direction": -1, "bars_since_flip": 50},
    )
    a = scoring.compute(bull, None)["signed"]
    b = scoring.compute(bear, None)["signed"]
    assert a == pytest.approx(-b, abs=1e-9)
