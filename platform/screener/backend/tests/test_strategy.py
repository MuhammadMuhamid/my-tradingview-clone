"""MTF 1h + 15m + 5m scalping strategy — the rule checklist.

The percentages are the thing most likely to be misread, so most of these tests
are about what they are *not*: they count conditions currently true, they are not
probabilities, an optional rule cannot pad them, and a rule that could not be
evaluated is never silently counted as a pass.
"""

from __future__ import annotations

import pytest

from app import strategy
from app.strategy import BEAR, BULL, RULES, evaluate, evaluate_side


def ctx(**over) -> dict:
    """A context where every bullish rule passes, with selected overrides."""
    base = {
        "ema": {
            "stack": "bull", "nearest_ema": 21, "atr": 100.0,
            "dist_atr_21": 0.1, "dist_atr_50": 1.0,
            "dist_atr_100": 2.0, "dist_atr_200": 3.0,
        },
        "rsi": {"rsi": 60.0},
        "macd": {"macd": 5.0},
        "adx": {"adx": 30.0, "plus_di": 28.0, "minus_di": 10.0},
        "supertrend": {"direction": 1},
        "sr": {"dist_to_support_atr": 0.2, "dist_to_resistance_atr": 4.0},
        "pivots": {"nearest": "S1", "nearest_dist_atr": 0.2},
        "vfi": {"vfi": 1.0, "vfima": 0.5, "above_signal": True,
                "bars_since_cross_up": 1, "bars_since_cross_down": 40},
        "vwap": {"above_vwap": True, "vwap": 100.0, "dist_atr": 0.5},
    }
    for key, value in over.items():
        base[key] = None if value is None else {**base.get(key, {}), **value}
    return base


def bear_ctx(**over) -> dict:
    base = ctx()
    base["ema"] = {**base["ema"], "stack": "bear",
                   "dist_atr_21": -0.1, "dist_atr_50": -1.0,
                   "dist_atr_100": -2.0, "dist_atr_200": -3.0}
    base["rsi"] = {"rsi": 40.0}
    base["macd"] = {"macd": -5.0}
    base["adx"] = {"adx": 30.0, "plus_di": 10.0, "minus_di": 28.0}
    base["supertrend"] = {"direction": -1}
    base["sr"] = {"dist_to_support_atr": 4.0, "dist_to_resistance_atr": 0.2}
    base["pivots"] = {"nearest": "R1", "nearest_dist_atr": 0.2}
    base["vfi"] = {"vfi": -1.0, "vfima": -0.5, "above_signal": False,
                   "bars_since_cross_up": 40, "bars_since_cross_down": 1}
    base["vwap"] = {"above_vwap": False, "vwap": 100.0, "dist_atr": -0.5}
    for key, value in over.items():
        base[key] = None if value is None else {**base.get(key, {}), **value}
    return base


def all_tf(builder) -> dict:
    return {slot: builder for slot in ("1h", "15m", "5m")}


# --- the rules are the ones the user specified -------------------------


def test_each_timeframe_has_exactly_seven_rules():
    assert {slot: len(rules) for slot, rules in RULES.items()} == {"1h": 7, "15m": 7, "5m": 7}


def test_the_1h_rule_set_matches_the_spec():
    assert [r.id for r in RULES["1h"]] == [
        "ema_stack", "rsi_50", "at_ema", "supertrend", "at_level", "adx_di", "macd_zero",
    ]


def test_the_15m_rule_set_matches_the_spec():
    assert [r.id for r in RULES["15m"]] == [
        "ema_stack", "ema_200_side", "rsi_50", "supertrend", "at_level", "adx_di", "macd_zero",
    ]


def test_the_5m_rule_set_matches_the_spec():
    assert [r.id for r in RULES["5m"]] == [
        "ema_200_side", "rsi_50", "vfi_cross", "supertrend", "adx_di", "vwap_side", "macd_zero",
    ]


def test_only_the_1h_supertrend_is_optional():
    """"must be bullish and can be bearish also" — informational, not a gate."""
    optional = [
        (slot, r.id) for slot, rules in RULES.items() for r in rules if not r.required
    ]
    assert optional == [("1h", "supertrend")]
    assert RULES["1h"][3].note and "either direction" in RULES["1h"][3].note


# --- a fully aligned setup --------------------------------------------


def test_a_perfect_bull_context_passes_every_required_rule():
    out = evaluate(all_tf(ctx()), None)
    assert out["bull"]["aligned"] is True
    assert out["bullish_pct"] == 100.0
    assert out["setup"] == BULL
    assert out["bias"] == BULL
    # 6 required on 1h (supertrend excluded) + 7 + 7
    assert out["bull"]["total"] == 20
    assert out["bull"]["passed"] == 20


def test_a_perfect_bear_context_passes_every_required_rule():
    out = evaluate(all_tf(bear_ctx()), None)
    assert out["bear"]["aligned"] is True
    assert out["bearish_pct"] == 100.0
    assert out["setup"] == BEAR
    assert out["bias"] == BEAR


def test_bull_and_bear_are_mirrors_not_the_same_test():
    bull = evaluate(all_tf(ctx()), None)
    assert bull["bullish_pct"] == 100.0
    assert bull["bearish_pct"] < 50.0, "a clean long setup must not also read as a short"


# --- the optional rule cannot pad the percentage ----------------------


def test_the_optional_rule_is_reported_but_excluded_from_the_count():
    """A bearish 1h Supertrend must not reduce the bullish percentage."""
    aligned = evaluate(all_tf(ctx()), None)

    contexts = all_tf(ctx()).copy()
    contexts["1h"] = ctx(supertrend={"direction": -1})
    with_bearish_st = evaluate(contexts, None)

    assert with_bearish_st["bullish_pct"] == aligned["bullish_pct"] == 100.0
    assert with_bearish_st["bull"]["aligned"] is True

    # It is still reported, just not counted.
    rule = next(
        r for r in with_bearish_st["bull"]["timeframes"]["1h"]["rules"]
        if r["id"] == "supertrend"
    )
    assert rule["passed"] is False
    assert rule["required"] is False


def test_the_1h_denominator_is_six_not_seven():
    out = evaluate(all_tf(ctx()), None)
    assert out["bull"]["timeframes"]["1h"]["total"] == 6
    assert out["bull"]["timeframes"]["15m"]["total"] == 7
    assert out["bull"]["timeframes"]["5m"]["total"] == 7


# --- individual rules --------------------------------------------------


def test_rsi_level_is_the_configured_threshold():
    assert evaluate(all_tf(ctx(rsi={"rsi": 50.1})), None)["bull"]["timeframes"]["5m"]["rules"][1]["passed"] is True
    assert evaluate(all_tf(ctx(rsi={"rsi": 49.9})), None)["bull"]["timeframes"]["5m"]["rules"][1]["passed"] is False
    custom = evaluate(all_tf(ctx(rsi={"rsi": 55.0})), {"rsi_level": 60.0})
    assert custom["bull"]["timeframes"]["5m"]["rules"][1]["passed"] is False


def test_adx_requires_both_adx_and_the_matching_di():
    def adx_rule(context):
        out = evaluate(all_tf(context), None)
        return next(r for r in out["bull"]["timeframes"]["5m"]["rules"] if r["id"] == "adx_di")

    assert adx_rule(ctx())["passed"] is True
    assert adx_rule(ctx(adx={"adx": 15.0}))["passed"] is False, "ADX below 20"
    assert adx_rule(ctx(adx={"plus_di": 12.0}))["passed"] is False, "+DI below 20"


def test_bearish_adx_uses_minus_di():
    out = evaluate(all_tf(bear_ctx()), None)
    rule = next(r for r in out["bear"]["timeframes"]["5m"]["rules"] if r["id"] == "adx_di")
    assert rule["passed"] is True
    assert "-DI=28.0" in rule["detail"]


def test_touching_an_ema_uses_an_atr_tolerance():
    def at_ema(context, params=None):
        out = evaluate(all_tf(context), params)
        return next(r for r in out["bull"]["timeframes"]["1h"]["rules"] if r["id"] == "at_ema")

    assert at_ema(ctx())["passed"] is True                      # 0.1 ATR from the 21
    far = ctx(ema={"dist_atr_21": 3.0, "dist_atr_50": 4.0,
                   "dist_atr_100": 5.0, "dist_atr_200": 6.0})
    assert at_ema(far)["passed"] is False
    assert at_ema(far, {"ema_touch_atr": 7.0})["passed"] is True


def test_level_rule_accepts_either_an_sr_level_or_a_pivot():
    def at_level(context):
        out = evaluate(all_tf(context), None)
        return next(r for r in out["bull"]["timeframes"]["1h"]["rules"] if r["id"] == "at_level")

    assert at_level(ctx())["passed"] is True

    only_pivot = ctx(sr={"dist_to_support_atr": 9.0}, pivots={"nearest": "S2",
                                                             "nearest_dist_atr": 0.1})
    assert at_level(only_pivot)["passed"] is True

    only_sr = ctx(sr={"dist_to_support_atr": 0.1}, pivots={"nearest": "R3",
                                                           "nearest_dist_atr": 9.0})
    assert at_level(only_sr)["passed"] is True

    neither = ctx(sr={"dist_to_support_atr": 9.0}, pivots={"nearest": "R3",
                                                           "nearest_dist_atr": 9.0})
    assert at_level(neither)["passed"] is False


def test_a_long_does_not_count_a_resistance_pivot_as_its_level():
    only_resistance_pivot = ctx(
        sr={"dist_to_support_atr": 9.0},
        pivots={"nearest": "R1", "nearest_dist_atr": 0.1},
    )
    out = evaluate(all_tf(only_resistance_pivot), None)
    rule = next(r for r in out["bull"]["timeframes"]["1h"]["rules"] if r["id"] == "at_level")
    assert rule["passed"] is False


def test_vfi_rule_needs_a_recent_cross_not_just_a_standing_state():
    def vfi_rule(context, params=None):
        out = evaluate(all_tf(context), params)
        return next(r for r in out["bull"]["timeframes"]["5m"]["rules"] if r["id"] == "vfi_cross")

    assert vfi_rule(ctx())["passed"] is True                       # crossed 1 bar ago
    stale = ctx(vfi={"bars_since_cross_up": 40})
    assert vfi_rule(stale)["passed"] is False, "a cross 40 bars ago is not a crossover"
    assert vfi_rule(stale, {"vfi_cross_max_bars": 50})["passed"] is True

    # Above the signal but never crossed up in the window is not a crossover.
    below = ctx(vfi={"above_signal": False, "bars_since_cross_up": 1})
    assert vfi_rule(below)["passed"] is False


def test_vwap_rule_flips_with_direction():
    bull = evaluate(all_tf(ctx()), None)
    rule = next(r for r in bull["bull"]["timeframes"]["5m"]["rules"] if r["id"] == "vwap_side")
    assert rule["passed"] is True

    bear = evaluate(all_tf(bear_ctx()), None)
    rule = next(r for r in bear["bear"]["timeframes"]["5m"]["rules"] if r["id"] == "vwap_side")
    assert rule["passed"] is True


# --- missing data is never a pass -------------------------------------


def test_a_rule_with_no_data_is_unknown_not_a_pass():
    out = evaluate(all_tf(ctx(vwap=None)), None)
    tf = out["bull"]["timeframes"]["5m"]
    rule = next(r for r in tf["rules"] if r["id"] == "vwap_side")

    assert rule["passed"] is None
    assert tf["unknown"] >= 1
    assert tf["passed"] == 6, "the unknown rule must not be counted as a hit"
    assert tf["all"] is False
    assert out["bull"]["aligned"] is False


def test_an_empty_context_scores_zero_not_a_hundred():
    out = evaluate(all_tf({}), None)
    assert out["bullish_pct"] == 0.0
    assert out["bearish_pct"] == 0.0
    assert out["bull"]["aligned"] is False
    assert out["setup"] is None


# --- alignment ---------------------------------------------------------


def test_alignment_requires_all_three_timeframes():
    contexts = all_tf(ctx()).copy()
    contexts["5m"] = ctx(macd={"macd": -1.0})
    out = evaluate(contexts, None)

    assert out["bull"]["timeframes"]["1h"]["all"] is True
    assert out["bull"]["timeframes"]["15m"]["all"] is True
    assert out["bull"]["timeframes"]["5m"]["all"] is False
    assert out["bull"]["aligned"] is False
    assert out["setup"] is None
    assert out["bullish_pct"] == 95.0, "19 of 20"


# --- the percentages are counts, not forecasts ------------------------


def test_the_payload_says_plainly_what_the_percentages_are():
    out = evaluate(all_tf(ctx()), None)
    assert "not probabilities" in out["note"]
    assert "share of the checklist" in out["note"]


def test_percentage_is_exactly_the_pass_fraction():
    contexts = all_tf(ctx()).copy()
    contexts["5m"] = ctx(macd={"macd": -1.0}, rsi={"rsi": 10.0})
    out = evaluate(contexts, None)

    passed = sum(t["passed"] for t in out["bull"]["timeframes"].values())
    total = sum(t["total"] for t in out["bull"]["timeframes"].values())
    assert out["bullish_pct"] == pytest.approx(round(passed / total * 100, 1))
    assert (passed, total) == (18, 20)


def test_nothing_in_the_strategy_payload_is_named_like_a_probability():
    out = evaluate(all_tf(ctx()), None)
    flat = str(out).lower()
    for key in out:
        assert "prob" not in key.lower()
    assert "not probabilities" in flat, "the disclaimer must survive serialisation"


def test_determinism():
    assert evaluate(all_tf(ctx()), None) == evaluate(all_tf(ctx()), None)
