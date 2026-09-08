"""Canonical Screener indicator registry."""

from __future__ import annotations

from types import ModuleType

from . import adx, candles, classical, ema, macd, pivots, rsi, sr, supertrend, vfi, vwap

REGISTRY: dict[str, ModuleType] = {
    "ema": ema,
    "rsi": rsi,
    "macd": macd,
    "adx": adx,
    "vfi": vfi,
    "supertrend": supertrend,
    "sr": sr,
    "candles": candles,
    "classical": classical,
}

#: Indicators the MTF scalping strategy needs that are not in the table registry.
#: They are deliberately kept out of REGISTRY so the main table stays at the
#: canonical columns, while the strategy can still reach them.
STRATEGY_EXTRAS: dict[str, ModuleType] = {
    "pivots": pivots,
    "vwap": vwap,
}

PLANNED: tuple[str, ...] = ()


def get(name: str) -> ModuleType:
    try:
        return REGISTRY[name]
    except KeyError:
        planned = " (planned, not yet implemented)" if name in PLANNED else ""
        raise KeyError(f"unknown indicator: {name!r}{planned}") from None
