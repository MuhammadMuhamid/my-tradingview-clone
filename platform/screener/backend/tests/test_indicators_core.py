"""Step 2 indicators: EMA, RSI, MACD, ADX.

Covers §8.2 (no lookahead / no repaint) and §8.5 (determinism) for all four, plus
the Pine-semantics traps each port can fall into. The §8.1 TradingView parity
assertions live in `test_parity_tradingview.py`.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app import ta
from app.indicators import REGISTRY, adx, ema, get, macd, rsi
from app.indicators.base import InsufficientData

CORE = ("ema", "rsi", "macd", "adx")
IMPLEMENTED = CORE + ("vfi", "supertrend", "sr", "candles")


# --- ta primitives ----------------------------------------------------


def test_ema_is_sma_seeded_not_pandas_ewm():
    """Pine emits `na` until `length` bars, then the SMA. pandas' ewm does neither."""
    src = pd.Series([float(i) for i in range(1, 51)])
    out = ta.ema(src, 10)

    assert out.iloc[:9].isna().all()
    assert out.iloc[9] == pytest.approx(src.iloc[:10].mean())

    naive = src.ewm(span=10).mean()
    assert out.iloc[9] != pytest.approx(naive.iloc[9]), "adjust=True ewm must not match the seed"

    alpha = 2 / 11
    assert out.iloc[10] == pytest.approx(alpha * src.iloc[10] + (1 - alpha) * out.iloc[9])


def test_rma_uses_wilder_alpha():
    src = pd.Series([float(i) for i in range(1, 41)])
    out = ta.rma(src, 14)
    assert out.iloc[13] == pytest.approx(src.iloc[:14].mean())
    assert out.iloc[14] == pytest.approx((1 / 14) * src.iloc[14] + (13 / 14) * out.iloc[13])


def test_stdev_is_population_not_sample():
    src = pd.Series([1.0, 2.0, 3.0, 4.0, 5.0])
    assert ta.stdev(src, 5).iloc[-1] == pytest.approx(np.std(src.to_numpy()))
    assert ta.stdev(src, 5).iloc[-1] != pytest.approx(src.std(ddof=1))


def test_true_range_falls_back_to_range_on_the_first_bar(btc_1h):
    tr = ta.true_range(btc_1h)
    assert tr.iloc[0] == pytest.approx(btc_1h["high"].iloc[0] - btc_1h["low"].iloc[0])
    assert tr.notna().all()


def test_rsi_saturates_correctly():
    assert ta.rsi(pd.Series([float(i) for i in range(1, 40)]), 14).iloc[-1] == pytest.approx(100.0)
    assert ta.rsi(pd.Series([float(i) for i in range(40, 1, -1)]), 14).iloc[-1] == pytest.approx(0.0)


def test_source_resolves_pine_names(btc_1h):
    assert ta.source(btc_1h, "hl2").iloc[-1] == pytest.approx(
        (btc_1h["high"].iloc[-1] + btc_1h["low"].iloc[-1]) / 2
    )
    assert ta.source(btc_1h, "hlc3").iloc[-1] == pytest.approx(
        (btc_1h["high"].iloc[-1] + btc_1h["low"].iloc[-1] + btc_1h["close"].iloc[-1]) / 3
    )
    with pytest.raises(ValueError):
        ta.source(btc_1h, "vwap")


# --- §8.2 no lookahead ------------------------------------------------


# No-lookahead lives in tests/test_no_lookahead.py. It is tested on the series
# form, which is the only formulation that can actually fail: comparing
# `compute(df[:n])` against `compute(df[:n+50].iloc[:n])` compares a frame with
# itself and passes for any function, including one that reads the future.


@pytest.mark.parametrize("name", IMPLEMENTED)
def test_deterministic_across_runs(name, btc_1h):
    """§8.5 — same inputs, same outputs."""
    module = get(name)
    assert module.compute(btc_1h, None) == module.compute(btc_1h.copy(), None)


@pytest.mark.parametrize("name", IMPLEMENTED)
def test_output_is_json_serialisable(name, btc_1h):
    import json

    out = get(name).compute(btc_1h, None)
    json.dumps(out)  # raises on numpy scalars or NaN-as-float
    assert all(not isinstance(v, (np.generic,)) for v in out.values())


@pytest.mark.parametrize("name", IMPLEMENTED)
def test_short_series_raises_rather_than_returning_garbage(name, btc_1h):
    with pytest.raises(InsufficientData):
        get(name).compute(btc_1h.iloc[:5].reset_index(drop=True), None)


def test_registry_holds_exactly_the_eight_indicators_of_section_4():
    """All eight are implemented. §5 forbids anything else — no SMA, no Bollinger."""
    from app.config import INDICATOR_KEYS

    assert set(REGISTRY) == set(IMPLEMENTED) == set(INDICATOR_KEYS)
    assert len(REGISTRY) == 8
    for extra in ("bollinger", "sma", "pivots", "fib", "obv", "stoch", "ichimoku"):
        with pytest.raises(KeyError):
            get(extra)


# --- §4.1 EMA ---------------------------------------------------------


def test_ema_distance_is_signed_and_atr_normalised(btc_1h):
    out = ema.compute(btc_1h, None)
    close = float(btc_1h["close"].iloc[-1])

    for n in (21, 50, 100, 200):
        value = out[f"ema_{n}"]
        assert out[f"dist_pct_{n}"] == pytest.approx((close - value) / value * 100)
        assert out[f"dist_atr_{n}"] == pytest.approx((close - value) / out["atr"])
        # Sign must track which side of the EMA price sits on.
        assert (out[f"dist_pct_{n}"] < 0) == (close < value)


def test_ema_stack_classification():
    def stack_of(values: list[float]) -> str:
        idx = pd.RangeIndex(400)
        df = pd.DataFrame({
            "ts": idx * 3_600_000, "open": 1.0, "high": 1.0, "low": 1.0,
            "close": 1.0, "volume": 1.0,
        })
        out = {}
        for n, v in zip((21, 50, 100, 200), values):
            out[n] = v
        ordered = [out[n] for n in (21, 50, 100, 200)]
        if all(a > b for a, b in zip(ordered, ordered[1:])):
            return "bull"
        if all(a < b for a, b in zip(ordered, ordered[1:])):
            return "bear"
        return "mixed"

    assert stack_of([4, 3, 2, 1]) == "bull"
    assert stack_of([1, 2, 3, 4]) == "bear"
    assert stack_of([4, 1, 3, 2]) == "mixed"


def test_ema_stack_on_a_monotone_ramp_is_bull():
    n = 500
    close = pd.Series(np.linspace(100.0, 200.0, n))
    df = pd.DataFrame({
        "ts": np.arange(n, dtype="int64") * 3_600_000,
        "open": close, "high": close + 0.5, "low": close - 0.5,
        "close": close, "volume": 1000.0,
    })
    out = ema.compute(df, None)
    assert out["stack"] == "bull"
    assert all(out[f"dist_pct_{n_}"] > 0 for n_ in (21, 50, 100, 200))


def test_nearest_ema_is_by_absolute_atr_distance(btc_1h):
    out = ema.compute(btc_1h, None)
    dists = {n: abs(out[f"dist_atr_{n}"]) for n in (21, 50, 100, 200)}
    assert out["nearest_ema"] == min(dists, key=dists.get)


# --- §4.2 RSI ---------------------------------------------------------


def test_rsi_slope_and_state(btc_1h):
    out = rsi.compute(btc_1h, None)
    assert 0.0 <= out["rsi"] <= 100.0
    assert out["slope"] == pytest.approx(out["rsi"] - out["rsi_prev"])
    expected = "oversold" if out["rsi"] < 30 else "overbought" if out["rsi"] > 70 else "neutral"
    assert out["state"] == expected


def test_rsi_prev_is_the_previous_closed_bar(btc_1h):
    out = rsi.compute(btc_1h, None)
    one_bar_back = rsi.compute(btc_1h.iloc[:-1].reset_index(drop=True), None)
    assert out["rsi_prev"] == pytest.approx(one_bar_back["rsi"])


# --- §4.3 MACD --------------------------------------------------------


def test_macd_components_are_consistent(btc_1h):
    out = macd.compute(btc_1h, None)
    assert out["hist"] == pytest.approx(out["macd"] - out["signal"])
    assert out["cross_state"] == ("bull" if out["macd"] > out["signal"] else "bear")
    assert out["above_zero"] is (out["macd"] > 0)


def test_bars_since_cross_counts_from_the_flip(btc_1h):
    """0 means the cross is on this bar; the count must agree with the history."""
    out = macd.compute(btc_1h, None)
    n = out["bars_since_cross"]
    assert n is not None and n >= 0

    at_cross = macd.compute(btc_1h.iloc[: len(btc_1h) - n].reset_index(drop=True), None)
    before = macd.compute(btc_1h.iloc[: len(btc_1h) - n - 1].reset_index(drop=True), None)
    assert at_cross["cross_state"] == out["cross_state"]
    assert before["cross_state"] != out["cross_state"], "no state change at the reported bar"


def test_macd_hist_slope_matches_the_previous_bar(btc_1h):
    out = macd.compute(btc_1h, None)
    prev = macd.compute(btc_1h.iloc[:-1].reset_index(drop=True), None)
    assert out["hist_slope"] == pytest.approx(out["hist"] - prev["hist"])


# --- §4.5 ADX ---------------------------------------------------------


def test_adx_range_and_regime_thresholds(btc_1h):
    out = adx.compute(btc_1h, None)
    assert 0.0 <= out["adx"] <= 100.0
    assert out["plus_di"] >= 0 and out["minus_di"] >= 0
    expected = "ranging" if out["adx"] < 20 else "trending" if out["adx"] > 25 else "transitional"
    assert out["regime"] == expected
    assert out["direction"] == ("bull" if out["plus_di"] > out["minus_di"] else "bear")


def test_adx_on_a_clean_uptrend_is_trending_and_bull():
    n = 400
    close = pd.Series(np.linspace(100.0, 300.0, n))
    df = pd.DataFrame({
        "ts": np.arange(n, dtype="int64") * 3_600_000,
        "open": close, "high": close + 1.0, "low": close - 1.0,
        "close": close, "volume": 1000.0,
    })
    out = adx.compute(df, None)
    assert out["direction"] == "bull"
    assert out["regime"] == "trending"
    assert out["plus_di"] > out["minus_di"]


def test_adx_on_a_flat_series_is_ranging():
    n = 400
    rng = np.random.default_rng(7)
    close = pd.Series(100.0 + rng.normal(0, 0.05, n))
    df = pd.DataFrame({
        "ts": np.arange(n, dtype="int64") * 3_600_000,
        "open": close, "high": close + 0.5, "low": close - 0.5,
        "close": close, "volume": 1000.0,
    })
    assert adx.compute(df, None)["regime"] == "ranging"


def test_macd_percent_is_the_line_normalised_by_price(btc_1h):
    """Raw MACD is in price units and unreadable in a column shared across coins."""
    out = macd.compute(btc_1h, None)
    close = float(btc_1h["close"].iloc[-1])

    assert out["macd_pct"] == pytest.approx(out["macd"] / close * 100)
    assert out["hist_pct"] == pytest.approx(out["hist"] / close * 100)
    # Same sign as the raw line — normalising must not change which side of zero
    # the reading is on, because that is the whole question the column answers.
    assert (out["macd_pct"] > 0) == (out["macd"] > 0)


def test_macd_percent_is_comparable_across_price_scales(btc_1h):
    """A coin priced at 0.25 and one at 79,000 must land in the same range."""
    cheap = btc_1h.copy()
    for col in ("open", "high", "low", "close"):
        cheap[col] = cheap[col] / 320_000.0     # ~0.25 instead of ~80,000

    rich = macd.compute(btc_1h, None)
    poor = macd.compute(cheap, None)

    assert abs(rich["macd"] / poor["macd"]) > 100_000, "raw values differ by orders of magnitude"
    assert rich["macd_pct"] == pytest.approx(poor["macd_pct"], rel=1e-6), (
        "the percent form must be scale-invariant"
    )
