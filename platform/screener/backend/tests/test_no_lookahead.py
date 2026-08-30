"""§8.2 — no lookahead, tested in the only way that can actually fail.

The obvious formulation is a tautology. Computing on `df[:n]` and on
`df[:n+50]` and then comparing "the value at index n-1" is meaningless when the
compute function only ever returns its last bar: `df[:n+50].iloc[:n]` *is*
`df[:n]`, so the assertion compares a frame with itself and passes for any
function whatsoever, including one that openly reads the future.

What can genuinely fail is the series form. Every indicator here also exists as
a full-history series, and the calibration walk in `app/calibration.py` depends
on reading bar `i` out of one. So the property under test is:

    series(full_history)[i] == compute(history_up_to_i).last

If an indicator peeks ahead — a centred window, a `.bfill()`, a normalisation
over the whole range, a cumulative extreme applied in the wrong direction — the
two disagree and this fails. That is also exactly the guarantee the fast path
needs in order to be a legitimate substitute for the slow one.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app import ta
from app.indicators import adx as adx_mod
from app.indicators import supertrend as st_mod
from app.indicators import vfi as vfi_mod

# Bars spread across the fixture, all far enough in for every warm-up to finish.
PROBES = [420, 700, 1013, 1288, 1600, 1798]


def _truncated(df: pd.DataFrame, i: int) -> pd.DataFrame:
    return df.iloc[: i + 1].reset_index(drop=True)


@pytest.mark.parametrize("i", PROBES)
@pytest.mark.parametrize("length", [21, 200])
def test_ema_series_matches_truncated_history(btc_1h, i, length):
    full = ta.ema(btc_1h["close"], length)
    partial = ta.ema(_truncated(btc_1h, i)["close"], length)
    assert full.iloc[i] == pytest.approx(partial.iloc[-1], rel=1e-12)


@pytest.mark.parametrize("i", PROBES)
def test_rsi_series_matches_truncated_history(btc_1h, i):
    full = ta.rsi(btc_1h["close"], 14)
    partial = ta.rsi(_truncated(btc_1h, i)["close"], 14)
    assert full.iloc[i] == pytest.approx(partial.iloc[-1], rel=1e-12)


@pytest.mark.parametrize("i", PROBES)
def test_atr_series_matches_truncated_history(btc_1h, i):
    full = ta.atr(btc_1h, 14)
    partial = ta.atr(_truncated(btc_1h, i), 14)
    assert full.iloc[i] == pytest.approx(partial.iloc[-1], rel=1e-12)


@pytest.mark.parametrize("i", PROBES)
def test_macd_series_matches_truncated_history(btc_1h, i):
    def macd_line(df: pd.DataFrame):
        line = ta.ema(df["close"], 12) - ta.ema(df["close"], 26)
        return line, ta.ema(line, 9)

    full_line, full_sig = macd_line(btc_1h)
    part_line, part_sig = macd_line(_truncated(btc_1h, i))
    assert full_line.iloc[i] == pytest.approx(part_line.iloc[-1], rel=1e-12)
    assert full_sig.iloc[i] == pytest.approx(part_sig.iloc[-1], rel=1e-12)


@pytest.mark.parametrize("i", PROBES)
def test_adx_series_matches_truncated_history(btc_1h, i):
    def adx_at(df: pd.DataFrame):
        plus, minus = adx_mod._dirmov(df, 14)
        total = plus + minus
        dx = (plus - minus).abs() / total.where(total != 0.0, 1.0)
        return 100.0 * ta.rma(dx, 14), plus, minus

    full, fp, fm = adx_at(btc_1h)
    part, pp, pm = adx_at(_truncated(btc_1h, i))
    assert full.iloc[i] == pytest.approx(part.iloc[-1], rel=1e-12)
    assert fp.iloc[i] == pytest.approx(pp.iloc[-1], rel=1e-12)
    assert fm.iloc[i] == pytest.approx(pm.iloc[-1], rel=1e-12)


@pytest.mark.parametrize("i", PROBES)
def test_vfi_series_matches_truncated_history(btc_1h, i):
    full = vfi_mod.series(btc_1h, None)
    partial = vfi_mod.series(_truncated(btc_1h, i), None)
    for column in ("vfi", "vfima", "d"):
        assert full[column].iloc[i] == pytest.approx(partial[column].iloc[-1], rel=1e-10)


@pytest.mark.parametrize("i", PROBES)
def test_supertrend_series_matches_truncated_history(btc_1h, i):
    """The band ratchet is the likeliest place for a direction leak to hide."""
    full = st_mod.bands(btc_1h, None)
    partial = st_mod.bands(_truncated(btc_1h, i), None)
    assert int(full["trend"].iloc[i]) == int(partial["trend"].iloc[-1])
    assert full["up"].iloc[i] == pytest.approx(partial["up"].iloc[-1], rel=1e-12)
    assert full["dn"].iloc[i] == pytest.approx(partial["dn"].iloc[-1], rel=1e-12)


def test_the_probe_actually_detects_a_lookahead():
    """Negative control: a deliberately future-peeking series must fail."""
    df = pd.DataFrame({"close": np.linspace(1.0, 100.0, 300)})

    # A centred rolling mean reads `window//2` bars into the future.
    cheating_full = df["close"].rolling(11, center=True, min_periods=1).mean()
    cheating_part = df["close"].iloc[:201].rolling(11, center=True, min_periods=1).mean()

    with pytest.raises(AssertionError):
        assert cheating_full.iloc[200] == pytest.approx(cheating_part.iloc[-1], rel=1e-12)


def test_supertrend_trend_history_never_rewrites(btc_1h):
    """A repainting Supertrend would change past flips as new bars land."""
    full = st_mod.bands(btc_1h, None)["trend"].tolist()
    for i in PROBES:
        partial = st_mod.bands(_truncated(btc_1h, i), None)["trend"].tolist()
        assert partial == full[: i + 1], f"history rewritten when truncated at {i}"
