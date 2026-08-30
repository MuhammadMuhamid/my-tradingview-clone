"""Volume Flow Indicator — §4.4, ported from the Pine v2 LazyBear source.

The original will not port literally: it predates the `ta.` namespace and uses
`iff()` and `type=bool`. Transcribed:

    typical = hlc3
    inter   = log(typical) - log(typical[1])
    vinter  = stdev(inter, 30)
    cutoff  = coef * vinter * close
    vave    = sma(volume, length)[1]
    vmax    = vave * vcoef
    vc      = iff(volume < vmax, volume, vmax)
    mf      = typical - typical[1]
    vcp     = iff(mf > cutoff, vc, iff(mf < -cutoff, -vc, 0))
    vfi     = ma(sum(vcp, length) / vave, 3)
    vfima   = ema(vfi, signalLength)
    d       = vfi - vfima

Three traps, all of which silently produce a plausible-looking wrong curve:

1. **`ma(x, 3)` is a no-op when `smoothVFI` is false**, which is the default.
   Applying the 3-period SMA anyway is the mistake §4.4 calls out by name.
2. **`vave` is the *previous* bar's volume average** — `sma(volume, length)[1]`.
   Dropping the `[1]` leaks the current bar's own volume into its own normaliser.
3. **`stdev` is population, not sample.** `app.ta.stdev` uses ddof=0 for this.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .. import ta
from .base import clean, require_bars

DEFAULTS = {
    "length": 130,
    "coef": 0.2,
    "vcoef": 2.5,
    "signalLength": 5,
    "smoothVFI": False,
    "inter_length": 30,
    "smooth_length": 3,
    # "VFI green line must cross over the red line" is about a crossover, not a
    # standing state. A cross this many bars ago or fewer still counts.
    "cross_max_bars": 5,
}


def series(df: pd.DataFrame, params: dict | None = None) -> pd.DataFrame:
    """Full `vfi` / `vfima` / `d` series, so tests can inspect the whole curve."""
    p = {**DEFAULTS, **(params or {})}
    length = int(p["length"])

    typical = ta.source(df, "hlc3")
    volume = df["volume"].astype("float64")

    inter = np.log(typical) - np.log(typical.shift(1))
    vinter = ta.stdev(inter, int(p["inter_length"]))
    cutoff = float(p["coef"]) * vinter * df["close"]

    vave = ta.sma(volume, length).shift(1)          # note the [1]
    vmax = vave * float(p["vcoef"])
    vc = volume.where(volume < vmax, vmax)          # iff(volume < vmax, volume, vmax)

    mf = typical - typical.shift(1)
    vcp = pd.Series(
        np.where(mf > cutoff, vc, np.where(mf < -cutoff, -vc, 0.0)),
        index=df.index,
        dtype="float64",
    )
    vcp[mf.isna() | cutoff.isna() | vc.isna()] = np.nan

    raw = vcp.rolling(length, min_periods=length).sum() / vave
    # `ma(x, 3)` — identity unless smoothVFI is on. Do not apply it by default.
    vfi = ta.sma(raw, int(p["smooth_length"])) if p["smoothVFI"] else raw

    vfima = ta.ema(vfi, int(p["signalLength"]))
    return pd.DataFrame({"vfi": vfi, "vfima": vfima, "d": vfi - vfima}, index=df.index)


def compute(df: pd.DataFrame, params: dict | None = None) -> dict:
    p = {**DEFAULTS, **(params or {})}
    # rolling sum over `length` bars, on top of a `length`-bar SMA shifted by one.
    require_bars(df, 2 * int(p["length"]) + int(p["signalLength"]) + 2)

    s = series(df, p)
    vfi_now, vfi_prev = ta.last(s["vfi"]), ta.last(s["vfi"], 1)
    vfima_now = ta.last(s["vfima"])

    # Cast to a real bool dtype before shifting. `shift(1).fillna(False)` on the
    # default object dtype leaves Python bools in the array, and `~` on those is
    # a bitwise integer inversion, not a logical not — deprecated in 3.16 and
    # wrong long before that.
    valid = (s["vfi"].notna() & s["vfima"].notna()).to_numpy(dtype=bool)
    above = (s["vfi"] > s["vfima"]).to_numpy(dtype=bool) & valid

    prev_above = np.concatenate([[False], above[:-1]])
    prev_valid = np.concatenate([[False], valid[:-1]])

    cross_up = pd.Series(above & ~prev_above & valid & prev_valid, index=s.index)
    cross_dn = pd.Series(~above & prev_above & valid & prev_valid, index=s.index)

    return clean({
        "vfi": vfi_now,
        "vfima": vfima_now,
        "hist": ta.last(s["d"]),
        "above_zero": None if vfi_now is None else vfi_now > 0.0,
        "above_signal": None if vfi_now is None or vfima_now is None else vfi_now > vfima_now,
        "slope": None if vfi_now is None or vfi_prev is None else vfi_now - vfi_prev,
        "cross_up_this_bar": bool(cross_up.iloc[-1]),
        "cross_down_this_bar": bool(cross_dn.iloc[-1]),
        "bars_since_cross_up": ta.bars_since(cross_up),
        "bars_since_cross_down": ta.bars_since(cross_dn),
    })
