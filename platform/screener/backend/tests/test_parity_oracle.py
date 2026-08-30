"""§8.1 parity — vectorised `app/ta.py` vs an independent scalar transcription.

Tolerance is 1e-9 relative, tighter than the 1e-6 the spec asks for, because two
implementations of the *same* arithmetic should agree to near machine precision.
Anything looser would hide a real discrepancy.

What this does and does not establish is spelled out in `tests/pine_oracle.py`
and in the README: it catches porting and vectorisation bugs, it does not prove
agreement with TradingView's own output.
"""

from __future__ import annotations

import math

import pytest

from app import ta
from app.indicators import adx as adx_mod, macd as macd_mod, rsi as rsi_mod
from tests import pine_oracle as oracle

REL_TOL = 1e-9


def _close(btc_1h) -> list[float]:
    return [float(v) for v in btc_1h["close"]]


def assert_series_match(mine, theirs, tol: float = REL_TOL, label: str = "") -> int:
    """Compare aligned series, ignoring bars where both are `na`. Returns the count."""
    assert len(mine) == len(theirs), f"{label}: length mismatch"
    compared = 0
    for i, (a, b) in enumerate(zip(mine, theirs)):
        a_na = a is None or (isinstance(a, float) and math.isnan(a))
        b_na = b is None or (isinstance(b, float) and math.isnan(b))
        assert a_na == b_na, f"{label}: na disagreement at bar {i} ({a!r} vs {b!r})"
        if a_na:
            continue
        assert a == pytest.approx(b, rel=tol, abs=1e-12), f"{label}: bar {i}"
        compared += 1
    assert compared > 100, f"{label}: only {compared} bars compared — fixture too short"
    return compared


@pytest.mark.parametrize("length", [21, 50, 100, 200])
def test_ema_matches_the_scalar_transcription(btc_1h, length):
    close = _close(btc_1h)
    assert_series_match(
        ta.ema(btc_1h["close"], length).tolist(),
        oracle.ema(close, length),
        label=f"ema{length}",
    )


@pytest.mark.parametrize("length", [14, 20])
def test_rma_and_atr_match(btc_1h, length):
    close = _close(btc_1h)
    assert_series_match(ta.rma(btc_1h["close"], length).tolist(), oracle.rma(close, length),
                        label=f"rma{length}")

    high = [float(v) for v in btc_1h["high"]]
    low = [float(v) for v in btc_1h["low"]]
    assert_series_match(
        ta.true_range(btc_1h).tolist(), oracle.true_range(high, low, close), label="tr"
    )
    assert_series_match(
        ta.atr(btc_1h, length).tolist(),
        oracle.rma(oracle.true_range(high, low, close), length),
        label=f"atr{length}",
    )


def test_rsi_matches(btc_1h):
    assert_series_match(ta.rsi(btc_1h["close"], 14).tolist(), oracle.rsi(_close(btc_1h), 14),
                        label="rsi14")


def test_macd_matches(btc_1h):
    close = _close(btc_1h)
    line, sig, hist = oracle.macd(close, 12, 26, 9)

    mine_line = (ta.ema(btc_1h["close"], 12) - ta.ema(btc_1h["close"], 26))
    mine_sig = ta.ema(mine_line, 9)
    assert_series_match(mine_line.tolist(), line, label="macd")
    assert_series_match(mine_sig.tolist(), sig, label="signal")
    assert_series_match((mine_line - mine_sig).tolist(), hist, label="hist")


def test_adx_matches(btc_1h):
    high = [float(v) for v in btc_1h["high"]]
    low = [float(v) for v in btc_1h["low"]]
    close = _close(btc_1h)
    adx_ref, plus_ref, minus_ref = oracle.adx(high, low, close, 14, 14)

    plus, minus = adx_mod._dirmov(btc_1h, 14)
    total = plus + minus
    dx = (plus - minus).abs() / total.where(total != 0.0, 1.0)
    adx_series = 100.0 * ta.rma(dx, 14)

    assert_series_match(plus.tolist(), plus_ref, label="plus_di")
    assert_series_match(minus.tolist(), minus_ref, label="minus_di")
    assert_series_match(adx_series.tolist(), adx_ref, label="adx")


# --- the module-level outputs land on the same numbers -----------------


def test_module_outputs_agree_with_the_oracle_on_the_last_bar(btc_1h):
    close = _close(btc_1h)
    high = [float(v) for v in btc_1h["high"]]
    low = [float(v) for v in btc_1h["low"]]

    assert rsi_mod.compute(btc_1h, None)["rsi"] == pytest.approx(
        oracle.rsi(close, 14)[-1], rel=REL_TOL
    )

    line, sig, hist = oracle.macd(close, 12, 26, 9)
    out = macd_mod.compute(btc_1h, None)
    assert out["macd"] == pytest.approx(line[-1], rel=REL_TOL)
    assert out["signal"] == pytest.approx(sig[-1], rel=REL_TOL)
    assert out["hist"] == pytest.approx(hist[-1], rel=REL_TOL)

    adx_ref, plus_ref, minus_ref = oracle.adx(high, low, close, 14, 14)
    out = adx_mod.compute(btc_1h, None)
    assert out["adx"] == pytest.approx(adx_ref[-1], rel=REL_TOL)
    assert out["plus_di"] == pytest.approx(plus_ref[-1], rel=REL_TOL)
    assert out["minus_di"] == pytest.approx(minus_ref[-1], rel=REL_TOL)


def test_the_oracle_can_actually_fail(btc_1h):
    """Guard against a vacuous comparison: a deliberately wrong EMA must not pass."""
    close = _close(btc_1h)
    wrong = btc_1h["close"].ewm(span=21, adjust=True).mean().tolist()
    with pytest.raises(AssertionError):
        assert_series_match(wrong, oracle.ema(close, 21), label="deliberately-wrong")
