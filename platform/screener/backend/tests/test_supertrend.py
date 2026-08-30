"""Supertrend — §4.7. The port the spec says is most likely to be silently wrong.

Beyond the oracle comparison, these tests pin the three specific behaviours a
plausible-but-wrong port gets away with: the ratchet direction, the `close[1]`
offset, and the `changeATR` branch.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app import ta
from app.indicators import supertrend
from tests import pine_oracle as oracle
from tests.test_parity_oracle import assert_series_match


def _frame(closes, highs=None, lows=None) -> pd.DataFrame:
    closes = [float(c) for c in closes]
    highs = [c + 1.0 for c in closes] if highs is None else [float(h) for h in highs]
    lows = [c - 1.0 for c in closes] if lows is None else [float(l) for l in lows]
    n = len(closes)
    return pd.DataFrame({
        "ts": np.arange(n, dtype="int64") * 3_600_000,
        "open": closes, "high": highs, "low": lows, "close": closes,
        "volume": [1000.0] * n,
    })


# --- parity ------------------------------------------------------------


@pytest.mark.parametrize("change_atr", [True, False])
@pytest.mark.parametrize("period,mult", [(10, 3.0), (7, 2.0), (14, 4.5)])
def test_matches_the_scalar_transcription(btc_1h, period, mult, change_atr):
    params = {"period": period, "multiplier": mult, "changeATR": change_atr}
    mine = supertrend.bands(btc_1h, params)

    ups, dns, trends = oracle.supertrend(
        [float(v) for v in btc_1h["high"]],
        [float(v) for v in btc_1h["low"]],
        [float(v) for v in btc_1h["close"]],
        period, mult, change_atr,
    )
    assert_series_match(mine["up"].tolist(), ups, label=f"up p{period}")
    assert_series_match(mine["dn"].tolist(), dns, label=f"dn p{period}")
    # §8.1 requires an exact integer match on direction — no tolerance.
    assert mine["trend"].tolist() == trends


def test_direction_is_exactly_plus_or_minus_one(btc_1h):
    assert set(supertrend.bands(btc_1h, None)["trend"].unique()) <= {1, -1}
    assert supertrend.compute(btc_1h, None)["direction"] in (1, -1)


# --- the ratchet -------------------------------------------------------


def test_up_band_ratchets_upward_only_while_the_trend_holds(btc_1h):
    """`up := close[1] > up1 ? max(up, up1) : up` — it may never fall mid-trend."""
    b = supertrend.bands(btc_1h, None)
    up, trend, close = b["up"].to_numpy(), b["trend"].to_numpy(), btc_1h["close"].to_numpy()

    checked = 0
    for i in range(1, len(b)):
        if trend[i] != 1 or trend[i - 1] != 1:
            continue
        if np.isnan(up[i]) or np.isnan(up[i - 1]):
            continue
        if close[i - 1] > up[i - 1]:
            assert up[i] >= up[i - 1] - 1e-9, f"up band fell at bar {i} inside an uptrend"
            checked += 1
    assert checked > 200, "fixture did not exercise the ratchet enough"


def test_dn_band_ratchets_downward_only_while_the_trend_holds(btc_1h):
    b = supertrend.bands(btc_1h, None)
    dn, trend, close = b["dn"].to_numpy(), b["trend"].to_numpy(), btc_1h["close"].to_numpy()

    checked = 0
    for i in range(1, len(b)):
        if trend[i] != -1 or trend[i - 1] != -1:
            continue
        if np.isnan(dn[i]) or np.isnan(dn[i - 1]):
            continue
        if close[i - 1] < dn[i - 1]:
            assert dn[i] <= dn[i - 1] + 1e-9, f"dn band rose at bar {i} inside a downtrend"
            checked += 1
    assert checked > 100


def test_ratchet_resets_across_a_flip_rather_than_running_cumulatively(btc_1h):
    """A cumulative max over the raw band would never let `up` drop. It must.

    The `close[1] > up1` guard is exactly what stops the ratchet from carrying
    across a trend change, so somewhere in the fixture `up` has to fall.
    """
    up = supertrend.bands(btc_1h, None)["up"].dropna().to_numpy()
    assert (np.diff(up) < -1e-9).any(), "up band never falls — the ratchet is running cumulatively"

    naive = np.maximum.accumulate(up)
    assert not np.allclose(up, naive), "band matches a plain cumulative max — guard is missing"


def test_band_is_compared_against_the_previous_close_not_the_current(btc_1h):
    """Shifting the comparison by one bar must change the result — pins the offset."""
    b = supertrend.bands(btc_1h, None)

    # Recompute with `close` where Pine uses `close[1]`.
    src = ta.source(btc_1h, "hl2").to_numpy()
    close = btc_1h["close"].to_numpy()
    atr = ta.rma(ta.true_range(btc_1h), 10).to_numpy()
    wrong_up, prev_up = [], np.nan
    for i in range(len(btc_1h)):
        raw = src[i] - 3.0 * atr[i]
        up1 = prev_up if not np.isnan(prev_up) else raw
        cur = raw
        if not np.isnan(up1) and close[i] > up1:          # `close`, not `close[1]`
            cur = max(raw, up1) if not np.isnan(raw) else up1
        wrong_up.append(cur)
        prev_up = cur

    assert not np.allclose(
        b["up"].to_numpy(), np.array(wrong_up), equal_nan=True
    ), "using close instead of close[1] produced identical output — offset is untested"


# --- changeATR branch --------------------------------------------------


def test_change_atr_selects_rma_versus_sma_of_true_range(btc_1h):
    rma_atr = supertrend.bands(btc_1h, {"changeATR": True})["atr"]
    sma_atr = supertrend.bands(btc_1h, {"changeATR": False})["atr"]

    assert_series_match(rma_atr.tolist(), ta.rma(ta.true_range(btc_1h), 10).tolist(),
                        label="changeATR=true -> rma")
    assert_series_match(sma_atr.tolist(), ta.sma(ta.true_range(btc_1h), 10).tolist(),
                        label="changeATR=false -> sma")
    assert not np.allclose(rma_atr.dropna().to_numpy()[-100:],
                           sma_atr.dropna().to_numpy()[-100:])


# --- hand-built series -------------------------------------------------


def test_flips_bearish_when_price_breaks_the_lower_band():
    up_leg = list(np.linspace(100.0, 160.0, 120))
    crash = [160.0, 120.0, 118.0, 117.0, 116.0]
    df = _frame(up_leg + crash)

    b = supertrend.bands(df, {"period": 10, "multiplier": 3.0})
    assert b["trend"].iloc[len(up_leg) - 1] == 1, "clean uptrend should read bullish"
    assert b["trend"].iloc[-1] == -1, "a break below the lower band must flip to bearish"


def test_flips_bullish_when_price_breaks_the_upper_band():
    down_leg = list(np.linspace(160.0, 100.0, 120))
    spike = [100.0, 140.0, 142.0, 143.0, 144.0]
    df = _frame(down_leg + spike)

    b = supertrend.bands(df, {"period": 10, "multiplier": 3.0})
    assert b["trend"].iloc[len(down_leg) - 1] == -1
    assert b["trend"].iloc[-1] == 1


def test_bars_since_flip_and_flipped_this_bar_agree():
    down_leg = list(np.linspace(160.0, 100.0, 120))
    df = _frame(down_leg + [100.0, 140.0])

    out = supertrend.compute(df, None)
    assert out["direction"] == 1
    assert out["bars_since_flip"] == 0
    assert out["flipped_this_bar"] is True

    later = supertrend.compute(_frame(down_leg + [100.0, 140.0, 141.0, 142.0]), None)
    assert later["bars_since_flip"] == 2
    assert later["flipped_this_bar"] is False


def test_line_tracks_the_active_band(btc_1h):
    out = supertrend.compute(btc_1h, None)
    b = supertrend.bands(btc_1h, None)
    expected = b["up"].iloc[-1] if out["direction"] == 1 else b["dn"].iloc[-1]
    assert out["line"] == pytest.approx(expected)

    close = float(btc_1h["close"].iloc[-1])
    assert out["dist_pct"] == pytest.approx((close - out["line"]) / out["line"] * 100)
    # In an uptrend the line sits below price, and vice versa.
    assert (out["dist_pct"] > 0) == (out["direction"] == 1)


# --- §8.2 / §8.5 -------------------------------------------------------


# No-lookahead for Supertrend is covered by tests/test_no_lookahead.py, which
# compares the full-history band and trend series against truncated history at
# several bars. The formulation that used to live here compared a frame with
# itself and could not fail.


def test_trend_history_is_stable_as_bars_are_appended(btc_1h):
    """A repainting Supertrend would rewrite past flips. This one must not."""
    full = supertrend.bands(btc_1h, None)["trend"].tolist()
    partial = supertrend.bands(btc_1h.iloc[:1200].reset_index(drop=True), None)["trend"].tolist()
    assert partial == full[:1200]


def test_deterministic(btc_1h):
    assert supertrend.compute(btc_1h, None) == supertrend.compute(btc_1h.copy(), None)
