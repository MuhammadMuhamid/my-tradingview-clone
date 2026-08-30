"""Config validation, hot-reload, and the out-of-scope indicator guard (§5)."""

from __future__ import annotations

import json

import pytest

from app.config import DEFAULT_PATH, ConfigError, ConfigStore, validate
from app.timeframes import SUPPORTED


@pytest.fixture
def cfg(isolated_config):
    """A store writing its user overrides into tmp, so tests never touch the repo."""
    return isolated_config


def test_ships_exactly_the_eight_indicators(cfg):
    assert set(cfg.doc["indicators"]) == {
        "ema", "rsi", "macd", "vfi", "adx", "candles", "supertrend", "sr"
    }


def test_every_indicator_defaults_to_1h_and_is_independently_settable(cfg):
    assert all(spec["timeframe"] == "1h" for spec in cfg.doc["indicators"].values())
    cfg.update({"indicators": {"rsi": {"timeframe": "4h"}}})
    assert cfg.doc["indicators"]["rsi"]["timeframe"] == "4h"
    assert cfg.doc["indicators"]["ema"]["timeframe"] == "1h"


def test_update_persists_and_survives_reload(cfg):
    cfg.update({"indicators": {"sr": {"timeframe": "1d", "params": {"pivot_length": 20}}}})
    cfg.reload()
    sr = cfg.doc["indicators"]["sr"]
    assert sr["timeframe"] == "1d"
    assert sr["params"]["pivot_length"] == 20
    assert sr["params"]["min_strength"] == 1, "unpatched params must survive the merge"


def test_rejects_an_unsupported_timeframe(cfg):
    with pytest.raises(ConfigError, match="not supported"):
        cfg.update({"indicators": {"rsi": {"timeframe": "7m"}}})
    assert cfg.doc["indicators"]["rsi"]["timeframe"] == "1h", "rejected patch must not apply"


def test_rejects_out_of_scope_indicators(cfg):
    """§5 — no Bollinger, no SMA, no 'helpful extras'."""
    with pytest.raises(ConfigError, match="unknown indicator"):
        cfg.update({"indicators": {"bollinger": {"enabled": True, "timeframe": "1h", "params": {}}}})


def test_rejects_too_shallow_a_fetch(cfg):
    with pytest.raises(ConfigError, match="at least 600"):
        cfg.update({"data": {"fetch_bars": 200}})


def test_rejects_duplicate_symbols():
    doc = json.loads(DEFAULT_PATH.read_text())
    doc["symbols"] = ["BTC/USDT", "BTC/USDT"]
    with pytest.raises(ConfigError, match="duplicates"):
        validate(doc)


def test_active_timeframes_are_ordered_shortest_first(cfg):
    cfg.update({
        "strategy": {"enabled": False},
        "indicators": {"ema": {"timeframe": "1d"}, "rsi": {"timeframe": "15m"}},
    })
    tfs = cfg.active_timeframes()
    assert tfs == sorted(tfs, key=SUPPORTED.index)
    assert tfs == ["15m", "1h", "1d"]


def test_the_strategy_contributes_its_timeframes_to_the_fetch_set(cfg):
    """1h, 15m and 5m need candles too, and they share the column cache."""
    assert cfg.strategy_timeframes() == {"1h": "1h", "15m": "15m", "5m": "5m"}
    assert cfg.active_timeframes() == ["5m", "15m", "1h"]

    cfg.update({"strategy": {"enabled": False}})
    assert cfg.strategy_timeframes() == {}
    assert cfg.active_timeframes() == ["1h"]


def test_the_strategy_rejects_an_unsupported_slot_timeframe(cfg):
    with pytest.raises(ConfigError, match="not supported"):
        cfg.update({"strategy": {"timeframes": {"1h": "9m", "15m": "15m", "5m": "5m"}}})


def test_the_strategy_slots_are_exactly_three():
    """Validated on the whole document — a PATCH cannot remove a slot by omission."""
    doc = json.loads(DEFAULT_PATH.read_text())
    doc["symbols"] = ["BTC/USDT"]
    doc["strategy"]["timeframes"] = {"1h": "1h", "15m": "15m"}
    with pytest.raises(ConfigError, match="exactly the three slots"):
        validate(doc)


def test_the_strategy_rejects_unknown_indicators(cfg):
    with pytest.raises(ConfigError, match="unknown strategy indicator"):
        cfg.update({"strategy": {"indicators": {"ichimoku": {}}}})


def test_disabled_indicators_do_not_pull_a_timeframe(cfg):
    cfg.update({"indicators": {"sr": {"enabled": False, "timeframe": "1w"}}})
    assert "1w" not in cfg.active_timeframes()


def test_universe_is_the_36_symbols_that_resolve_on_the_default_exchange(cfg):
    """§3 minus two, at the user's direction on 2026-08-28.

    The unverifiable `BIANRENSHENGUSDT` was dropped, and `PEPE/USDT` with it —
    `binanceusdm` lists only the denominated `1000PEPE` contract, which is a
    different price scale. Any surviving unverified entry must still be surfaced
    rather than silently enabled, so the mechanism stays under test.
    """
    symbols = cfg.doc["symbols"]
    assert len(symbols) == 36
    assert not any("PEPE" in s for s in symbols)
    assert not any("BIANRENSHENG" in s for s in symbols)
    assert cfg.unverified_symbols == []
