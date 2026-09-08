"""Screener configuration: load, validate, mutate, persist, hot-reload.

Config lives in two files. `config/default.json` is the shipped baseline and is
never written to. `config/user.json` holds the user's overrides and is the only
file the API mutates; deleting it restores defaults.
"""

from __future__ import annotations

import json
import threading
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .timeframes import SUPPORTED, is_supported
from .exchange import BINANCE_SPOT

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
DEFAULT_PATH = CONFIG_DIR / "default.json"
USER_PATH = CONFIG_DIR / "user.json"
SYMBOLS_PATH = CONFIG_DIR / "symbols.json"

INDICATOR_KEYS = (
    "ema", "rsi", "macd", "vfi", "adx", "candles", "supertrend", "sr", "classical",
)


class ConfigError(ValueError):
    """Raised when a config document is structurally invalid."""


@dataclass(frozen=True)
class UnverifiedSymbol:
    raw: str
    note: str


def _deep_merge(base: dict, override: dict) -> dict:
    out = deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = deepcopy(value)
    return out


def validate(doc: dict[str, Any]) -> None:
    if not isinstance(doc.get("exchange"), str) or not doc["exchange"]:
        raise ConfigError("`exchange` must be a non-empty string")
    if doc["exchange"] != BINANCE_SPOT:
        raise ConfigError("`exchange` must be 'binance' (Trading Scene is Spot-only)")

    symbols = doc.get("symbols")
    if not isinstance(symbols, list) or not all(isinstance(s, str) and "/" in s for s in symbols):
        raise ConfigError("`symbols` must be a list of `BASE/QUOTE` strings")
    if len(set(symbols)) != len(symbols):
        raise ConfigError("`symbols` contains duplicates")

    indicators = doc.get("indicators")
    if not isinstance(indicators, dict):
        raise ConfigError("`indicators` must be an object")
    unknown = set(indicators) - set(INDICATOR_KEYS)
    if unknown:
        raise ConfigError(
            f"unknown indicator(s): {', '.join(sorted(unknown))}. "
            f"The screener implements exactly: {', '.join(INDICATOR_KEYS)}"
        )
    for key in INDICATOR_KEYS:
        spec = indicators.get(key)
        if not isinstance(spec, dict):
            raise ConfigError(f"indicators.{key} is missing")
        if not isinstance(spec.get("enabled"), bool):
            raise ConfigError(f"indicators.{key}.enabled must be a boolean")
        tf = spec.get("timeframe")
        if not is_supported(tf):
            raise ConfigError(
                f"indicators.{key}.timeframe = {tf!r} is not supported "
                f"(supported: {', '.join(SUPPORTED)})"
            )
        if not isinstance(spec.get("params"), dict):
            raise ConfigError(f"indicators.{key}.params must be an object")

    scoring = doc.get("scoring", {})
    if not isinstance(scoring, dict):
        raise ConfigError("`scoring` must be an object")
    if scoring.get("mode") not in ("confluence_score", "empirical_probability"):
        raise ConfigError(
            "scoring.mode must be 'confluence_score' or 'empirical_probability'"
        )
    weights = scoring.get("weights", {})
    if not isinstance(weights, dict):
        raise ConfigError("scoring.weights must be an object")
    unknown_buckets = set(weights) - {"trend", "momentum", "volume", "location", "trigger"}
    if unknown_buckets:
        raise ConfigError(f"unknown scoring bucket(s): {', '.join(sorted(unknown_buckets))}")
    for bucket, value in weights.items():
        if not isinstance(value, (int, float)) or value < 0:
            raise ConfigError(f"scoring.weights.{bucket} must be a non-negative number")
    for key in ("ranging_multiplier", "transitional_multiplier", "trending_multiplier"):
        value = scoring.get(key)
        if value is not None and (not isinstance(value, (int, float)) or value < 0):
            raise ConfigError(f"scoring.{key} must be a non-negative number")

    strategy = doc.get("strategy", {})
    if strategy:
        if not isinstance(strategy, dict):
            raise ConfigError("`strategy` must be an object")
        slots = strategy.get("timeframes", {})
        if not isinstance(slots, dict) or set(slots) != {"1h", "15m", "5m"}:
            raise ConfigError(
                "strategy.timeframes must name exactly the three slots: 1h, 15m, 5m"
            )
        for slot, tf in slots.items():
            if not is_supported(tf):
                raise ConfigError(
                    f"strategy.timeframes.{slot} = {tf!r} is not supported "
                    f"(supported: {', '.join(SUPPORTED)})"
                )
        unknown = set(strategy.get("indicators", {})) - (
            set(INDICATOR_KEYS) | {"pivots", "vwap"}
        )
        if unknown:
            raise ConfigError(
                f"unknown strategy indicator(s): {', '.join(sorted(unknown))}"
            )

    data = doc.get("data", {})
    if not isinstance(data, dict):
        raise ConfigError("`data` must be an object")
    if int(data.get("fetch_bars", 1800)) < 600:
        raise ConfigError(
            "data.fetch_bars must be at least 600 — VFI(130) and EMA(200) need the depth"
        )


class ConfigStore:
    """Thread-safe holder for the live config. Reload swaps the document atomically."""

    def __init__(
        self,
        default_path: Path = DEFAULT_PATH,
        user_path: Path = USER_PATH,
        symbols_path: Path = SYMBOLS_PATH,
    ) -> None:
        self._default_path = default_path
        self._user_path = user_path
        self._symbols_path = symbols_path
        self._lock = threading.RLock()
        self._doc: dict[str, Any] = {}
        self._unverified: list[UnverifiedSymbol] = []
        self.reload()

    def reload(self) -> dict[str, Any]:
        with self._lock:
            doc = json.loads(self._default_path.read_text())
            canonical_exchange = doc["exchange"]

            seed = json.loads(self._symbols_path.read_text())
            doc["symbols"] = list(seed.get("symbols", []))
            self._unverified = [
                UnverifiedSymbol(raw=u["raw"], note=u.get("note", ""))
                for u in seed.get("unverified", [])
            ]

            if self._user_path.exists():
                doc = _deep_merge(doc, json.loads(self._user_path.read_text()))

            # Market source is a product invariant, not a user preference. Keep
            # a legacy override file intact as history, but never let its former
            # `binanceusdm` value reactivate Futures or prevent Spot startup.
            doc["exchange"] = canonical_exchange

            validate(doc)
            self._doc = doc
            return deepcopy(doc)

    @property
    def doc(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._doc)

    @property
    def unverified_symbols(self) -> list[UnverifiedSymbol]:
        with self._lock:
            return list(self._unverified)

    def update(self, patch: dict[str, Any]) -> dict[str, Any]:
        """Deep-merge `patch`, validate the result, then persist to user.json."""
        with self._lock:
            candidate = _deep_merge(self._doc, patch)
            validate(candidate)

            overrides = json.loads(self._user_path.read_text()) if self._user_path.exists() else {}
            overrides = _deep_merge(overrides, patch)
            tmp = self._user_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(overrides, indent=2))
            tmp.replace(self._user_path)

            self._doc = candidate
            return deepcopy(candidate)

    # --- derived views -------------------------------------------------

    def enabled_indicators(self) -> dict[str, dict[str, Any]]:
        return {k: v for k, v in self._doc["indicators"].items() if v["enabled"]}

    def active_timeframes(self) -> list[str]:
        """The distinct timeframes actually in use — the set §2.1 fetches against.

        Includes the strategy's three slots when it is enabled: they need candles
        just as much as the table columns do, and they share the same cache
        entries, so a 1h strategy slot costs nothing extra when a column already
        uses 1h.
        """
        with self._lock:
            tfs = {spec["timeframe"] for spec in self.enabled_indicators().values()}
            strategy = self._doc.get("strategy") or {}
            if strategy.get("enabled"):
                tfs.update(strategy.get("timeframes", {}).values())
        return sorted(tfs, key=lambda tf: SUPPORTED.index(tf))

    def strategy_timeframes(self) -> dict[str, str]:
        """Slot name -> timeframe, e.g. {"1h": "1h", "15m": "15m", "5m": "5m"}."""
        strategy = self._doc.get("strategy") or {}
        if not strategy.get("enabled"):
            return {}
        return dict(strategy.get("timeframes", {}))

    def required_series(self) -> list[tuple[str, str]]:
        """Every `(symbol, timeframe)` pair the current config needs, deduplicated."""
        with self._lock:
            symbols = list(self._doc["symbols"])
        return [(s, tf) for s in symbols for tf in self.active_timeframes()]
