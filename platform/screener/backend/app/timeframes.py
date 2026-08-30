"""Timeframe parsing and bar-boundary maths.

The screener treats a timeframe as a fixed-length bucket of wall-clock time. That
holds for every timeframe in SUPPORTED except ``1w``/``3d``, where the exchange's
own bucket origin matters; we anchor those to the Unix epoch, which is what
Binance does (epoch was a Thursday, and Binance weekly bars open Monday, so the
week case is handled explicitly below).
"""

from __future__ import annotations

SUPPORTED: tuple[str, ...] = (
    "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "3d", "1w",
)

_UNIT_MS = {"m": 60_000, "h": 3_600_000, "d": 86_400_000, "w": 604_800_000}


def is_supported(tf: str) -> bool:
    return tf in SUPPORTED


def duration_ms(tf: str) -> int:
    """Length of one bar of `tf`, in milliseconds."""
    if not is_supported(tf):
        raise ValueError(f"unsupported timeframe: {tf!r} (supported: {', '.join(SUPPORTED)})")
    return int(tf[:-1]) * _UNIT_MS[tf[-1]]


def open_time(ts_ms: int, tf: str) -> int:
    """Open timestamp of the bar containing `ts_ms`."""
    step = duration_ms(tf)
    if tf == "1w":
        # Weekly bars open Monday 00:00 UTC. The Unix epoch is a Thursday, so
        # Monday sits four days in; floor against that offset, not against zero.
        offset = 4 * _UNIT_MS["d"]
        return ((ts_ms - offset) // step) * step + offset
    return (ts_ms // step) * step


def is_closed(bar_open_ms: int, tf: str, now_ms: int) -> bool:
    """True when the bar opening at `bar_open_ms` has finished forming."""
    return bar_open_ms + duration_ms(tf) <= now_ms
