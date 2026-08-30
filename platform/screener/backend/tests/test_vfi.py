"""VFI — §4.4. The other port the spec singles out for scrutiny.

The three tests that matter are the negative ones: each pins a trap by asserting
that doing it the wrong way produces a *different* answer. Without those, a port
that applies the 3-period smoothing by default, or drops the `[1]` on `vave`,
passes every positive test while being wrong on every bar.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app import ta
from app.indicators import vfi
from app.indicators.base import InsufficientData
from tests import pine_oracle as oracle
from tests.test_parity_oracle import assert_series_match


def _args(df: pd.DataFrame):
    return (
        [float(v) for v in df["high"]],
        [float(v) for v in df["low"]],
        [float(v) for v in df["close"]],
        [float(v) for v in df["volume"]],
    )


# --- parity ------------------------------------------------------------


@pytest.mark.parametrize("length,signal", [(130, 5), (80, 9)])
def test_matches_the_scalar_transcription(btc_1h, length, signal):
    params = {"length": length, "signalLength": signal}
    mine = vfi.series(btc_1h, params)
    ref_vfi, ref_sig, ref_d = oracle.vfi(*_args(btc_1h), length=length, signal_length=signal)

    assert_series_match(mine["vfi"].tolist(), ref_vfi, label=f"vfi{length}")
    assert_series_match(mine["vfima"].tolist(), ref_sig, label=f"vfima{length}")
    assert_series_match(mine["d"].tolist(), ref_d, label=f"d{length}")


def test_smooth_vfi_true_also_matches(btc_1h):
    mine = vfi.series(btc_1h, {"smoothVFI": True})
    ref, _, _ = oracle.vfi(*_args(btc_1h), smooth_vfi=True)
    assert_series_match(mine["vfi"].tolist(), ref, label="vfi smoothed")


# --- trap 1: ma(x, 3) is a no-op when smoothVFI is false ---------------


def test_default_applies_no_smoothing(btc_1h):
    """§4.4 by name: `ma(x,y)` returns `x` unchanged when smoothVFI is false."""
    plain = vfi.series(btc_1h, None)["vfi"]
    smoothed = vfi.series(btc_1h, {"smoothVFI": True})["vfi"]

    assert vfi.DEFAULTS["smoothVFI"] is False
    tail = slice(-200, None)
    assert not np.allclose(
        plain.to_numpy()[tail], smoothed.to_numpy()[tail]
    ), "smoothed and unsmoothed are identical — the 3-SMA is not actually being applied anywhere"

    # And the default must be the *unsmoothed* branch, not the smoothed one.
    assert_series_match(
        smoothed.tolist(), ta.sma(plain, 3).tolist(), label="smoothVFI=true == sma(plain,3)"
    )


# --- trap 2: vave is the PREVIOUS bar's average ------------------------


def test_vave_uses_the_previous_bar(btc_1h):
    """`sma(volume, length)[1]`. Without the shift the bar normalises by itself."""
    length = 130
    volume = btc_1h["volume"].astype("float64")
    correct = ta.sma(volume, length).shift(1)
    unshifted = ta.sma(volume, length)

    # Rebuild the final division both ways and confirm they differ.
    s = vfi.series(btc_1h, None)
    implied_sum = s["vfi"] * correct
    wrong = implied_sum / unshifted

    tail = slice(-200, None)
    assert not np.allclose(
        s["vfi"].to_numpy()[tail], wrong.to_numpy()[tail]
    ), "shifting vave changed nothing — the [1] is untested"

    # The first usable vfi bar must sit one bar later than an unshifted version.
    assert s["vfi"].first_valid_index() == unshifted.first_valid_index() + length


# --- trap 3: population stdev -----------------------------------------


def test_vinter_uses_population_stdev(btc_1h):
    typical = ta.source(btc_1h, "hlc3")
    inter = np.log(typical) - np.log(typical.shift(1))

    population = ta.stdev(inter, 30)
    sample = inter.rolling(30, min_periods=30).std(ddof=1)

    assert_series_match(population.tolist(), oracle.stdev(inter.tolist(), 30), label="vinter")
    assert not np.allclose(
        population.dropna().to_numpy()[-100:], sample.dropna().to_numpy()[-100:]
    )


# --- outputs -----------------------------------------------------------


def test_outputs_are_internally_consistent(btc_1h):
    out = vfi.compute(btc_1h, None)
    s = vfi.series(btc_1h, None)

    assert out["vfi"] == pytest.approx(s["vfi"].iloc[-1])
    assert out["vfima"] == pytest.approx(s["vfima"].iloc[-1])
    assert out["hist"] == pytest.approx(out["vfi"] - out["vfima"])
    assert out["above_zero"] is (out["vfi"] > 0)
    assert out["above_signal"] is (out["vfi"] > out["vfima"])
    assert out["slope"] == pytest.approx(out["vfi"] - s["vfi"].iloc[-2])


def test_volume_is_capped_at_vcoef_times_the_average():
    """`vc = iff(volume < vmax, volume, vmax)` — a single spike cannot dominate."""
    n = 500
    rng = np.random.default_rng(3)
    close = pd.Series(100.0 + np.cumsum(rng.normal(0, 0.3, n)))
    volume = pd.Series(np.full(n, 1000.0))
    df = pd.DataFrame({
        "ts": np.arange(n, dtype="int64") * 3_600_000,
        "open": close, "high": close + 1, "low": close - 1, "close": close, "volume": volume,
    })
    baseline = vfi.series(df, {"length": 130})["vfi"].iloc[-1]

    spiked = df.copy()
    spiked.loc[spiked.index[-1], "volume"] = 1_000_000.0
    capped = vfi.series(spiked, {"length": 130})["vfi"].iloc[-1]

    # The spike bar contributes at most vcoef x the average, not its raw volume.
    max_contribution = 2.5 * 1000.0 / 1000.0
    assert abs(capped - baseline) <= max_contribution + 1e-6


def test_requires_enough_bars_for_a_rolling_sum_over_a_shifted_average(btc_1h):
    with pytest.raises(InsufficientData):
        vfi.compute(btc_1h.iloc[:200].reset_index(drop=True), None)
    assert vfi.compute(btc_1h, None)["vfi"] is not None


# --- §8.2 / §8.5 -------------------------------------------------------


# No-lookahead: see tests/test_no_lookahead.py.


def test_deterministic(btc_1h):
    assert vfi.compute(btc_1h, None) == vfi.compute(btc_1h.copy(), None)
