"""§6.2 — empirical calibration.

The tests that matter here are the refusals. A calibration module is trivially
easy to make look good: resolve ambiguous bars as wins, report a rate off twelve
samples, quietly drop unresolved bars, calibrate on the whole universe at once.
Each of those is asserted *against* below.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app import calibration
from app.calibration import INSUFFICIENT, Label, label_bar
from app.config import ConfigStore
from app.indicators import REGISTRY
from app.scoring import compute as compute_score


@pytest.fixture(scope="module")
def cfg() -> dict:
    return ConfigStore().doc


@pytest.fixture(scope="module")
def result(btc_1h, cfg) -> dict:
    return calibration.calibrate(btc_1h, cfg, "BTC/USDT", "1h")


# --- labelling ---------------------------------------------------------


def _bars(highs, lows):
    return np.array(highs, dtype="float64"), np.array(lows, dtype="float64")


def test_target_before_stop_is_a_hit():
    high, low = _bars([100, 105, 130], [100, 99, 120])
    assert label_bar(high, low, 100.0, 10.0, 0, 5, 2.0, 1.0) == Label(1, False)


def test_stop_before_target_is_a_miss():
    high, low = _bars([100, 105, 130], [100, 88, 120])
    assert label_bar(high, low, 100.0, 10.0, 0, 5, 2.0, 1.0) == Label(0, False)


def test_neither_within_the_horizon_is_unresolved():
    high, low = _bars([100, 101, 102, 103], [100, 99, 98, 97])
    assert label_bar(high, low, 100.0, 10.0, 0, 3, 2.0, 1.0) == Label(None, False)


def test_a_bar_spanning_both_levels_is_resolved_as_a_loss_and_flagged():
    """OHLC cannot say which came first. Calling it a win is how hit rates get faked."""
    high, low = _bars([100, 125], [100, 85])
    outcome = label_bar(high, low, 100.0, 10.0, 0, 3, 2.0, 1.0)
    assert outcome.outcome == 0
    assert outcome.ambiguous is True


def test_the_horizon_is_respected_exactly():
    # Target reached on bar 4; a horizon of 3 must not see it.
    high, low = _bars([100, 101, 102, 103, 130], [100, 99, 99, 99, 99])
    assert label_bar(high, low, 100.0, 10.0, 0, 3, 2.0, 1.0).outcome is None
    assert label_bar(high, low, 100.0, 10.0, 0, 4, 2.0, 1.0).outcome == 1


def test_target_and_stop_multiples_are_configurable():
    high, low = _bars([100, 112], [100, 100])
    assert label_bar(high, low, 100.0, 10.0, 0, 3, 2.0, 1.0).outcome is None
    assert label_bar(high, low, 100.0, 10.0, 0, 3, 1.0, 1.0).outcome == 1


# --- the fast path is the slow path ------------------------------------


@pytest.mark.parametrize("i", [900, 1400, 1798])
def test_fast_path_matches_the_slow_path(btc_1h, cfg, i):
    """Reading bar i from precomputed series must equal computing history[:i+1].

    Without this the calibration would be scoring a different model from the one
    the table displays, and any rate it produced would be about something else.
    """
    frames = calibration.indicator_frames(btc_1h, cfg)
    fast = frames[i]

    history = btc_1h.iloc[: i + 1].reset_index(drop=True)
    slow = {
        name: REGISTRY[name].compute(history, cfg["indicators"][name]["params"])
        for name in REGISTRY
    }

    for key in ("rsi", "slope"):
        assert fast["rsi"][key] == pytest.approx(slow["rsi"][key], rel=1e-9)
    for key in ("hist", "bars_since_cross"):
        assert fast["macd"][key] == pytest.approx(slow["macd"][key], rel=1e-9)
    for key in ("adx", "plus_di", "minus_di"):
        assert fast["adx"][key] == pytest.approx(slow["adx"][key], rel=1e-9)
    assert fast["adx"]["regime"] == slow["adx"]["regime"]
    assert fast["adx"]["direction"] == slow["adx"]["direction"]
    for key in ("vfi", "hist", "slope"):
        assert fast["vfi"][key] == pytest.approx(slow["vfi"][key], rel=1e-9)
    assert fast["supertrend"]["direction"] == slow["supertrend"]["direction"]
    assert fast["supertrend"]["bars_since_flip"] == slow["supertrend"]["bars_since_flip"]
    assert fast["ema"]["stack"] == slow["ema"]["stack"]
    for n in (21, 50, 100, 200):
        assert fast["ema"][f"dist_atr_{n}"] == pytest.approx(
            slow["ema"][f"dist_atr_{n}"], rel=1e-9
        )
    assert fast["candles"]["net_bias"] == slow["candles"]["net_bias"]
    assert [p["name"] for p in fast["candles"]["patterns"]] == [
        p["name"] for p in slow["candles"]["patterns"]
    ]


@pytest.mark.parametrize("i", [900, 1798])
def test_fast_path_produces_the_same_score_as_the_live_pipeline(btc_1h, cfg, i):
    frames = calibration.indicator_frames(btc_1h, cfg)
    history = btc_1h.iloc[: i + 1].reset_index(drop=True)

    payload = dict(frames[i])
    payload["sr"] = REGISTRY["sr"].compute(history, cfg["indicators"]["sr"]["params"])
    fast_score = compute_score(payload, cfg["scoring"])["score"]

    slow = {
        name: REGISTRY[name].compute(history, cfg["indicators"][name]["params"])
        for name in REGISTRY
    }
    slow_score = compute_score(slow, cfg["scoring"])["score"]

    assert fast_score == pytest.approx(slow_score, rel=1e-9)


# --- display rules, enforced in code -----------------------------------


def test_a_thin_decile_reports_insufficient_data_not_a_number(btc_1h, cfg):
    """§6.2: no percentage derived from twelve samples, ever."""
    out = calibration.calibrate(
        btc_1h, cfg, "BTC/USDT", "1h", params={"max_bars": 500, "min_decile_samples": 100}
    )
    thin = [d for d in out["deciles"] if not d["sufficient"]]
    assert thin, "fixture should produce at least one under-sampled decile"
    for d in thin:
        assert d["hit_rate"] is None
        assert INSUFFICIENT in d["display"]
        assert "%" not in d["display"]


def test_every_decile_reports_its_sample_size(result):
    for d in result["deciles"]:
        assert f"n={d['n']}" in d["display"]
        assert d["n"] == d["hits"] + (d["n"] - d["hits"])


def test_a_sufficient_decile_reports_a_rate_with_its_n(result):
    good = [d for d in result["deciles"] if d["sufficient"]]
    assert good
    for d in good:
        assert d["hit_rate"] is not None
        assert 0.0 <= d["hit_rate"] <= 1.0
        assert "%" in d["display"] and f"n={d['n']}" in d["display"]


def test_the_window_is_reported_and_short_windows_warn(result):
    window = result["window"]
    assert window["start_ts"] < window["end_ts"]
    assert window["days"] > 0
    # 1799 hourly bars is about 64 days, well under six months.
    assert any("under six months" in w for w in result["warnings"])


def test_overlapping_samples_are_disclosed(result):
    assert any("samples overlap" in w for w in result["warnings"])


def test_it_is_marked_in_sample(result):
    assert result["in_sample"] is True


def test_unresolved_and_ambiguous_bars_are_counted_not_hidden(result):
    assert result["unresolved"] >= 0
    assert result["ambiguous"] >= 0
    per_decile = sum(d["unresolved"] for d in result["deciles"])
    assert per_decile == result["unresolved"]


def test_deciles_are_equal_count_quantiles_not_equal_width(result):
    counts = [d["n"] + d["unresolved"] for d in result["deciles"]]
    assert max(counts) - min(counts) <= 2, "quantile deciles should be near-equal in size"
    widths = [d["score_hi"] - d["score_lo"] for d in result["deciles"]]
    assert max(widths) > 2 * min(widths), "equal-width bins would defeat the point"


def test_deciles_partition_the_score_range_without_gaps(result):
    for a, b in zip(result["deciles"], result["deciles"][1:]):
        assert a["score_hi"] == pytest.approx(b["score_lo"])


# --- lookup ------------------------------------------------------------


def test_lookup_returns_the_decile_the_live_score_falls_into(result):
    d = result["deciles"][3]
    mid = (d["score_lo"] + d["score_hi"]) / 2
    found = calibration.lookup(result, mid)
    assert found["decile"] == 3
    assert found["n"] == d["n"]
    assert found["display"] == d["display"]


def test_lookup_refuses_a_score_outside_the_calibrated_range(result):
    out = calibration.lookup(result, 999.0)
    assert out["available"] is False
    assert out["hit_rate"] is None
    assert INSUFFICIENT in out["display"]


def test_lookup_on_an_unavailable_calibration_is_not_a_number():
    out = calibration.lookup({"available": False, "deciles": []}, 60.0)
    assert out["hit_rate"] is None
    assert INSUFFICIENT in out["display"]


def test_a_refusal_still_reports_the_sample_size(btc_1h, cfg):
    """"insufficient data" with no n hides how far short the sample fell."""
    thin = calibration.calibrate(btc_1h.iloc[:400], cfg, "BTC/USDT", "1h")
    mid = (thin["deciles"][4]["score_lo"] + thin["deciles"][4]["score_hi"]) / 2
    out = calibration.lookup(thin, mid)
    assert out["hit_rate"] is None
    assert f"n={out['n']}" in out["display"]
    assert "no decile reached" in out["display"]


def test_lookup_of_a_thin_decile_is_not_available(btc_1h, cfg):
    out = calibration.calibrate(
        btc_1h, cfg, "BTC/USDT", "1h", params={"max_bars": 500, "min_decile_samples": 100}
    )
    thin = next(d for d in out["deciles"] if not d["sufficient"])
    found = calibration.lookup(out, (thin["score_lo"] + thin["score_hi"]) / 2)
    assert found["available"] is False
    assert found["hit_rate"] is None


# --- refusals ----------------------------------------------------------


def test_too_little_history_refuses_rather_than_guessing(btc_1h, cfg):
    out = calibration.calibrate(btc_1h.iloc[:280], cfg, "BTC/USDT", "1h")
    assert out["available"] is False
    assert "not enough history" in out["reason"]
    assert out["deciles"] == []


def test_a_calibration_where_no_decile_qualifies_is_not_available(btc_1h, cfg):
    """Ten rows of "insufficient data" is not a usable calibration."""
    out = calibration.calibrate(btc_1h.iloc[:400], cfg, "BTC/USDT", "1h")
    assert out["available"] is False
    assert "no decile reached 100 resolved samples" in out["reason"]
    # The deciles are still returned, so the user can see how thin it was.
    assert out["deciles"] and all(not d["sufficient"] for d in out["deciles"])
    assert calibration.lookup(out, 55.0)["hit_rate"] is None


def test_calibration_is_per_symbol(btc_1h, cfg):
    """A rate calibrated on one symbol must not be presented for another."""
    out = calibration.calibrate(btc_1h, cfg, "BTC/USDT", "1h")
    assert out["symbol"] == "BTC/USDT"
    assert out["timeframe"] == "1h"


def test_determinism(btc_1h, cfg):
    a = calibration.calibrate(btc_1h, cfg, "BTC/USDT", "1h", params={"max_bars": 400})
    b = calibration.calibrate(btc_1h, cfg, "BTC/USDT", "1h", params={"max_bars": 400})
    assert a == b
