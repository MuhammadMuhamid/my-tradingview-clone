"""Pine primitives, hand-ported.

No `pandas_ta`, no TA-Lib (§1): parameter parity with the Pine reference has to be
auditable line by line, and the two libraries disagree with Pine on exactly the
details that matter here — EMA seeding and Wilder smoothing.

The two seeding rules that trip up every port:

* `ta.ema(src, n)` is **not** `df.ewm(span=n).mean()`. Pine warms up with an SMA
  of the first `n` values, emits `na` before that, and only then runs the
  recursion. pandas' `adjust=True` default instead computes a weighted mean over
  all history, which differs on every bar and never quite converges.
* `ta.rma(src, n)` (Wilder) is the same shape with `alpha = 1/n`, also SMA-seeded.
  RSI, ATR and ADX are all built on it.

Every function here returns a float64 Series aligned to the input index, with
`NaN` where Pine would emit `na`.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def _as_series(x: pd.Series | np.ndarray) -> pd.Series:
    return x if isinstance(x, pd.Series) else pd.Series(x, dtype="float64")


def sma(src: pd.Series, length: int) -> pd.Series:
    """`ta.sma` — simple moving average, `na` until `length` bars exist."""
    return _as_series(src).rolling(length, min_periods=length).mean()


def _recursive_ma(src: pd.Series, length: int, alpha: float) -> pd.Series:
    """SMA-seeded exponential recursion. Shared by `ema` and `rma`."""
    src = _as_series(src).astype("float64")
    values = src.to_numpy(dtype="float64", copy=False)
    n = len(values)
    out = np.full(n, np.nan, dtype="float64")
    if n < length or length < 1:
        return pd.Series(out, index=src.index, dtype="float64")

    # Pine's own warm-up: the first non-na value is the SMA of the first `length`
    # bars, positioned on the last of them. Anything before that is `na`.
    seed_idx = length - 1
    window = values[:length]
    if np.isnan(window).any():
        # Leading NaNs in the source (a derived series, say) push the seed right.
        first_valid = np.argmax(~np.isnan(values)) if (~np.isnan(values)).any() else n
        seed_idx = first_valid + length - 1
        if seed_idx >= n or np.isnan(values[first_valid:seed_idx + 1]).any():
            return pd.Series(out, index=src.index, dtype="float64")
        window = values[first_valid:seed_idx + 1]

    prev = float(window.mean())
    out[seed_idx] = prev
    one_minus = 1.0 - alpha
    for i in range(seed_idx + 1, n):
        v = values[i]
        if np.isnan(v):
            out[i] = prev  # Pine carries the last value through an `na` input
            continue
        prev = alpha * v + one_minus * prev
        out[i] = prev
    return pd.Series(out, index=src.index, dtype="float64")


def ema(src: pd.Series, length: int) -> pd.Series:
    """`ta.ema` — alpha = 2/(length+1), SMA-seeded."""
    return _recursive_ma(src, length, 2.0 / (length + 1.0))


def rma(src: pd.Series, length: int) -> pd.Series:
    """`ta.rma` — Wilder's smoothing, alpha = 1/length, SMA-seeded."""
    return _recursive_ma(src, length, 1.0 / length)


def change(src: pd.Series, length: int = 1) -> pd.Series:
    """`ta.change` — `src - src[length]`."""
    return _as_series(src).diff(length)


def stdev(src: pd.Series, length: int) -> pd.Series:
    """`ta.stdev` — population standard deviation (ddof=0), as Pine computes it."""
    return _as_series(src).rolling(length, min_periods=length).std(ddof=0)


def true_range(df: pd.DataFrame) -> pd.Series:
    """`ta.tr` — on the first bar Pine falls back to `high - low`."""
    prev_close = df["close"].shift(1)
    tr = pd.concat(
        [
            df["high"] - df["low"],
            (df["high"] - prev_close).abs(),
            (df["low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    tr.iloc[0] = df["high"].iloc[0] - df["low"].iloc[0]
    return tr.astype("float64")


def atr(df: pd.DataFrame, length: int) -> pd.Series:
    """`ta.atr` — RMA of true range."""
    return rma(true_range(df), length)


def rsi(src: pd.Series, length: int) -> pd.Series:
    """`ta.rsi` — Wilder's, via RMA of the up and down moves."""
    delta = change(_as_series(src))
    up = rma(delta.clip(lower=0.0), length)
    down = rma((-delta).clip(lower=0.0), length)

    out = 100.0 - 100.0 / (1.0 + up / down)
    out = out.where(down != 0.0, 100.0)     # no downside in the window
    out = out.mask((up == 0.0) & (down != 0.0), 0.0)
    return out.where(up.notna() & down.notna()).astype("float64")


def source(df: pd.DataFrame, name: str) -> pd.Series:
    """Resolve a Pine source name (`close`, `hl2`, `hlc3`, `ohlc4`, ...)."""
    name = name.lower()
    if name in ("open", "high", "low", "close", "volume"):
        return df[name].astype("float64")
    if name == "hl2":
        return ((df["high"] + df["low"]) / 2.0).astype("float64")
    if name == "hlc3":
        return ((df["high"] + df["low"] + df["close"]) / 3.0).astype("float64")
    if name == "ohlc4":
        return ((df["open"] + df["high"] + df["low"] + df["close"]) / 4.0).astype("float64")
    if name == "hlcc4":
        return ((df["high"] + df["low"] + 2.0 * df["close"]) / 4.0).astype("float64")
    raise ValueError(f"unknown source: {name!r}")


def last(series: pd.Series, offset: int = 0) -> float | None:
    """The value `offset` bars back from the end, as a plain float or None for `na`."""
    if len(series) <= offset:
        return None
    value = series.iloc[-1 - offset]
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return None
    return float(value)


def bars_since(condition: pd.Series) -> int | None:
    """`ta.barssince` evaluated at the last bar. 0 = the condition is true now."""
    arr = condition.to_numpy(dtype=bool, na_value=False)
    hits = np.flatnonzero(arr)
    return None if hits.size == 0 else int(len(arr) - 1 - hits[-1])
