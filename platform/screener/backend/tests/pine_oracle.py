"""A second, independent implementation of the Pine reference — scalar loops only.

The vectorised pandas code in `app/ta.py` is fast and unreadable next to the Pine
source. This module is the opposite: a literal, bar-by-bar transcription of the
formulas in `screener.rtf`, with no pandas, no rolling windows, and no
vectorisation tricks. Nothing here is imported by the application.

Its only job is to disagree with `app/ta.py` when `app/ta.py` is wrong. Two
implementations that share no code but agree to 1e-12 are very unlikely to share
a porting bug; one implementation compared against itself proves nothing.

This does **not** establish agreement with TradingView — see the README.
"""

from __future__ import annotations

import math

NAN = float("nan")


def _isna(x: float | None) -> bool:
    return x is None or math.isnan(x)


def sma(src: list[float], length: int) -> list[float | None]:
    out: list[float | None] = []
    for i in range(len(src)):
        if i < length - 1:
            out.append(None)
        else:
            out.append(sum(src[i - length + 1 : i + 1]) / length)
    return out


def _recursive(src: list[float], length: int, alpha: float) -> list[float | None]:
    """`out = alpha*src + (1-alpha)*out[1]`, seeded with the SMA at bar length-1."""
    out: list[float | None] = [None] * len(src)
    if len(src) < length:
        return out
    prev = sum(src[:length]) / length
    out[length - 1] = prev
    for i in range(length, len(src)):
        prev = alpha * src[i] + (1.0 - alpha) * prev
        out[i] = prev
    return out


def ema(src: list[float], length: int) -> list[float | None]:
    return _recursive(src, length, 2.0 / (length + 1.0))


def rma(src: list[float], length: int) -> list[float | None]:
    return _recursive(src, length, 1.0 / length)


def rma_from(src: list[float | None], length: int) -> list[float | None]:
    """RMA over a series whose leading values are `na` (a derived series)."""
    first = next((i for i, v in enumerate(src) if not _isna(v)), None)
    if first is None or len(src) - first < length:
        return [None] * len(src)
    out: list[float | None] = [None] * len(src)
    seed_idx = first + length - 1
    prev = sum(src[first : seed_idx + 1]) / length  # type: ignore[arg-type]
    out[seed_idx] = prev
    alpha = 1.0 / length
    for i in range(seed_idx + 1, len(src)):
        v = src[i]
        prev = prev if _isna(v) else alpha * v + (1.0 - alpha) * prev  # type: ignore[operator]
        out[i] = prev
    return out


def true_range(high: list[float], low: list[float], close: list[float]) -> list[float]:
    out = [high[0] - low[0]]
    for i in range(1, len(high)):
        pc = close[i - 1]
        out.append(max(high[i] - low[i], abs(high[i] - pc), abs(low[i] - pc)))
    return out


def rsi(src: list[float], length: int) -> list[float | None]:
    ups: list[float | None] = [None]
    downs: list[float | None] = [None]
    for i in range(1, len(src)):
        d = src[i] - src[i - 1]
        ups.append(max(d, 0.0))
        downs.append(max(-d, 0.0))

    up = rma_from(ups, length)
    down = rma_from(downs, length)

    out: list[float | None] = []
    for u, d in zip(up, down):
        if _isna(u) or _isna(d):
            out.append(None)
        elif d == 0.0:
            out.append(100.0)
        elif u == 0.0:
            out.append(0.0)
        else:
            out.append(100.0 - 100.0 / (1.0 + u / d))  # type: ignore[operator]
    return out


def macd(src: list[float], fast: int, slow: int, signal: int):
    ef, es = ema(src, fast), ema(src, slow)
    line: list[float | None] = [
        None if _isna(a) or _isna(b) else a - b for a, b in zip(ef, es)  # type: ignore[operator]
    ]
    sig = _ema_from(line, signal)
    hist: list[float | None] = [
        None if _isna(m) or _isna(s) else m - s for m, s in zip(line, sig)  # type: ignore[operator]
    ]
    return line, sig, hist


def _ema_from(src: list[float | None], length: int) -> list[float | None]:
    first = next((i for i, v in enumerate(src) if not _isna(v)), None)
    if first is None or len(src) - first < length:
        return [None] * len(src)
    out: list[float | None] = [None] * len(src)
    seed_idx = first + length - 1
    prev = sum(src[first : seed_idx + 1]) / length  # type: ignore[arg-type]
    out[seed_idx] = prev
    alpha = 2.0 / (length + 1.0)
    for i in range(seed_idx + 1, len(src)):
        v = src[i]
        prev = prev if _isna(v) else alpha * v + (1.0 - alpha) * prev  # type: ignore[operator]
        out[i] = prev
    return out


def adx(high: list[float], low: list[float], close: list[float], di_len: int, adx_len: int):
    """Literal transcription of the Pine v6 built-in in the reference file."""
    plus_dm: list[float | None] = [None]
    minus_dm: list[float | None] = [None]
    for i in range(1, len(high)):
        up = high[i] - high[i - 1]
        down = -(low[i] - low[i - 1])
        plus_dm.append(up if (up > down and up > 0) else 0.0)
        minus_dm.append(down if (down > up and down > 0) else 0.0)

    trur = rma(true_range(high, low, close), di_len)
    sp = rma_from(plus_dm, di_len)
    sm = rma_from(minus_dm, di_len)

    plus: list[float | None] = []
    minus: list[float | None] = []
    last_p = last_m = None
    for i in range(len(high)):
        if _isna(trur[i]) or _isna(sp[i]) or _isna(sm[i]) or trur[i] == 0:
            plus.append(last_p)      # fixnan: carry the last good value
            minus.append(last_m)
        else:
            last_p = 100.0 * sp[i] / trur[i]   # type: ignore[operator]
            last_m = 100.0 * sm[i] / trur[i]   # type: ignore[operator]
            plus.append(last_p)
            minus.append(last_m)

    dx: list[float | None] = []
    for p, m in zip(plus, minus):
        if _isna(p) or _isna(m):
            dx.append(None)
        else:
            total = p + m  # type: ignore[operator]
            dx.append(abs(p - m) / (total if total != 0 else 1.0))  # type: ignore[operator]

    adx_series = [None if _isna(v) else 100.0 * v for v in rma_from(dx, adx_len)]  # type: ignore[operator]
    return adx_series, plus, minus


def stdev(src: list[float | None], length: int) -> list[float | None]:
    """Population standard deviation, the ddof=0 form Pine uses."""
    out: list[float | None] = []
    for i in range(len(src)):
        window = src[i - length + 1 : i + 1] if i >= length - 1 else []
        if len(window) < length or any(_isna(v) for v in window):
            out.append(None)
            continue
        mean = sum(window) / length  # type: ignore[arg-type]
        out.append(math.sqrt(sum((v - mean) ** 2 for v in window) / length))  # type: ignore[operator]
    return out


def sma_from(src: list[float | None], length: int) -> list[float | None]:
    out: list[float | None] = []
    for i in range(len(src)):
        window = src[i - length + 1 : i + 1] if i >= length - 1 else []
        if len(window) < length or any(_isna(v) for v in window):
            out.append(None)
        else:
            out.append(sum(window) / length)  # type: ignore[arg-type]
    return out


def rolling_sum(src: list[float | None], length: int) -> list[float | None]:
    out: list[float | None] = []
    for i in range(len(src)):
        window = src[i - length + 1 : i + 1] if i >= length - 1 else []
        if len(window) < length or any(_isna(v) for v in window):
            out.append(None)
        else:
            out.append(sum(window))  # type: ignore[arg-type]
    return out


def supertrend(
    high: list[float],
    low: list[float],
    close: list[float],
    period: int,
    multiplier: float,
    change_atr: bool = True,
):
    """Literal transcription of the Pine v4 Supertrend, including the ratchet."""
    src = [(h + l) / 2.0 for h, l in zip(high, low)]
    tr = true_range(high, low, close)
    atr = rma(tr, period) if change_atr else sma(tr, period)

    ups: list[float | None] = []
    dns: list[float | None] = []
    trends: list[int] = []

    prev_up = prev_dn = None
    prev_trend = 1

    for i in range(len(close)):
        a = atr[i]
        raw_up = None if _isna(a) else src[i] - multiplier * a  # type: ignore[operator]
        raw_dn = None if _isna(a) else src[i] + multiplier * a  # type: ignore[operator]

        up1 = prev_up if not _isna(prev_up) else raw_up
        dn1 = prev_dn if not _isna(prev_dn) else raw_dn
        prev_close = close[i - 1] if i > 0 else None

        cur_up = raw_up
        if not _isna(prev_close) and not _isna(up1) and prev_close > up1:  # type: ignore[operator]
            cur_up = up1 if _isna(raw_up) else max(raw_up, up1)  # type: ignore[type-var]

        cur_dn = raw_dn
        if not _isna(prev_close) and not _isna(dn1) and prev_close < dn1:  # type: ignore[operator]
            cur_dn = dn1 if _isna(raw_dn) else min(raw_dn, dn1)  # type: ignore[type-var]

        t = prev_trend
        if prev_trend == -1 and not _isna(dn1) and close[i] > dn1:  # type: ignore[operator]
            t = 1
        elif prev_trend == 1 and not _isna(up1) and close[i] < up1:  # type: ignore[operator]
            t = -1

        ups.append(cur_up)
        dns.append(cur_dn)
        trends.append(t)
        prev_up, prev_dn, prev_trend = cur_up, cur_dn, t

    return ups, dns, trends


def vfi(
    high: list[float],
    low: list[float],
    close: list[float],
    volume: list[float],
    length: int = 130,
    coef: float = 0.2,
    vcoef: float = 2.5,
    signal_length: int = 5,
    smooth_vfi: bool = False,
):
    """Literal transcription of the Pine v2 LazyBear VFI."""
    typical = [(h + l + c) / 3.0 for h, l, c in zip(high, low, close)]

    inter: list[float | None] = [None]
    for i in range(1, len(typical)):
        inter.append(math.log(typical[i]) - math.log(typical[i - 1]))
    vinter = stdev(inter, 30)

    cutoff = [None if _isna(v) else coef * v * close[i] for i, v in enumerate(vinter)]  # type: ignore[operator]

    vave_now = sma(volume, length)
    vave: list[float | None] = [None] + vave_now[:-1]          # sma(volume, length)[1]
    vmax = [None if _isna(v) else v * vcoef for v in vave]      # type: ignore[operator]
    vc = [
        None if _isna(m) else (volume[i] if volume[i] < m else m)  # type: ignore[operator]
        for i, m in enumerate(vmax)
    ]

    mf: list[float | None] = [None]
    for i in range(1, len(typical)):
        mf.append(typical[i] - typical[i - 1])

    vcp: list[float | None] = []
    for i in range(len(typical)):
        if _isna(mf[i]) or _isna(cutoff[i]) or _isna(vc[i]):
            vcp.append(None)
        elif mf[i] > cutoff[i]:      # type: ignore[operator]
            vcp.append(vc[i])
        elif mf[i] < -cutoff[i]:     # type: ignore[operator]
            vcp.append(-vc[i])       # type: ignore[operator]
        else:
            vcp.append(0.0)

    summed = rolling_sum(vcp, length)
    raw = [
        None if _isna(s) or _isna(vave[i]) else s / vave[i]  # type: ignore[operator]
        for i, s in enumerate(summed)
    ]
    # ma(x, 3) is the identity when smoothVFI is false — the §4.4 trap.
    vfi_series = sma_from(raw, 3) if smooth_vfi else raw
    vfima = _ema_from(vfi_series, signal_length)
    d = [
        None if _isna(a) or _isna(b) else a - b  # type: ignore[operator]
        for a, b in zip(vfi_series, vfima)
    ]
    return vfi_series, vfima, d
