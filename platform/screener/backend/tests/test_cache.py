"""§8.3 cache dedup, plus the closed-candle and TTL guarantees it rests on."""

from __future__ import annotations

import asyncio

import pytest

from app.cache import CandleCache, drop_forming_bar, now_ms
from app.config import ConfigStore
from app.exchange import resolve_symbols
from app.timeframes import duration_ms
from tests.fakes import FakeFeed


@pytest.fixture
def cfg(isolated_config) -> ConfigStore:
    return isolated_config


def test_one_fetch_per_symbol_timeframe_not_per_indicator(store, cfg):
    """§8.3 — all eight indicators on 1h must cost one fetch per symbol.

    The MTF strategy is disabled here so the assertion isolates the property it
    is about: indicators sharing a timeframe share a fetch. The strategy's own
    three timeframes are covered by the test below.
    """
    cfg.update({"strategy": {"enabled": False}})
    symbols = cfg.doc["symbols"]
    indicators = cfg.doc["indicators"]

    assert len(symbols) == 36
    assert len(indicators) == 8
    assert all(spec["timeframe"] == "1h" for spec in indicators.values())
    assert all(spec["enabled"] for spec in indicators.values())

    pairs = cfg.required_series()
    # The naive implementation fetches once per indicator per symbol.
    naive = len(symbols) * len(indicators)

    feed = FakeFeed(symbols)
    cache = CandleCache(feed, store, fetch_bars=750, max_concurrent=8)
    report = asyncio.run(cache.refresh(pairs))

    assert feed.total_fetches == len(symbols), (
        f"expected {len(symbols)} fetches (one per symbol), got {feed.total_fetches}"
    )
    assert feed.total_fetches < naive
    assert max(feed.calls.values()) == 1, "a pair was fetched more than once"
    assert report.fetched == len(symbols)
    assert not report.failed


def test_second_refresh_within_the_bar_hits_zero_network(store, cfg):
    """§2.4 — a 1h series is not re-fetched until the next hourly bar closes."""
    cfg.update({"strategy": {"enabled": False}})
    symbols = cfg.doc["symbols"]
    pairs = cfg.required_series()
    feed = FakeFeed(symbols)
    cache = CandleCache(feed, store)

    async def scenario():
        await cache.refresh(pairs)
        first = feed.total_fetches
        second = await cache.refresh(pairs)
        return first, second

    first, second = asyncio.run(scenario())
    assert first == len(symbols)
    assert feed.total_fetches == first, "cache re-fetched inside the bar's TTL"
    assert second.fetched == 0
    assert second.served_from_cache == len(symbols)


def test_the_strategy_adds_its_timeframes_but_still_one_fetch_per_pair(store, cfg):
    """Three slots x 36 symbols = 108 fetches, not 108 x the indicator count."""
    symbols = cfg.doc["symbols"]
    assert cfg.active_timeframes() == ["5m", "15m", "1h"]

    pairs = cfg.required_series()
    assert len(pairs) == len(symbols) * 3

    feed = FakeFeed(symbols)
    cache = CandleCache(feed, store)
    asyncio.run(cache.refresh(pairs))

    assert feed.total_fetches == len(symbols) * 3
    assert max(feed.calls.values()) == 1


def test_mixed_timeframes_fetch_the_cross_product_once_each(store, cfg):
    cfg.update({"strategy": {"enabled": False}})
    symbols = cfg.doc["symbols"][:5]
    cfg.update({"indicators": {"ema": {"timeframe": "4h"}, "rsi": {"timeframe": "4h"},
                               "macd": {"timeframe": "1d"}}})
    tfs = cfg.active_timeframes()
    assert tfs == ["1h", "4h", "1d"]
    pairs = [(s, tf) for s in symbols for tf in tfs]

    feed = FakeFeed(symbols)
    cache = CandleCache(feed, store)
    asyncio.run(cache.refresh(pairs))

    assert feed.total_fetches == len(symbols) * len(tfs)
    assert max(feed.calls.values()) == 1


def test_concurrency_is_capped(store, cfg):
    symbols = cfg.doc["symbols"]
    feed = FakeFeed(symbols, latency=0.01)
    cache = CandleCache(feed, store, max_concurrent=8)
    asyncio.run(cache.refresh([(s, "1h") for s in symbols]))
    assert feed.max_observed_concurrency <= 8


def test_duplicate_pairs_in_one_request_collapse(store):
    feed = FakeFeed(["BTC/USDT"])
    cache = CandleCache(feed, store)
    asyncio.run(cache.refresh([("BTC/USDT", "1h")] * 8))
    assert feed.total_fetches == 1


# --- §2.2 closed candles only -----------------------------------------


def test_forming_bar_is_dropped():
    step = duration_ms("1h")
    current_open = (now_ms() // step) * step
    rows = [[current_open - i * step, 1, 2, 0.5, 1.5, 10] for i in range(5)][::-1]
    assert rows[-1][0] == current_open

    kept = drop_forming_bar(rows, "1h")
    assert len(kept) == len(rows) - 1
    assert kept[-1][0] == current_open - step


def test_cache_never_stores_the_forming_bar(store):
    feed = FakeFeed(["BTC/USDT"])
    cache = CandleCache(feed, store, fetch_bars=200)
    asyncio.run(cache.refresh([("BTC/USDT", "1h")]))

    raw = feed.series("BTC/USDT", "1h", 200)
    df = cache.get("BTC/USDT", "1h")

    assert len(df) == 199
    assert int(df["ts"].iloc[-1]) == int(raw[-2][0])
    assert int(df["ts"].iloc[-1]) + duration_ms("1h") <= now_ms()


def test_status_exposes_source_bar_close_time(store):
    feed = FakeFeed(["BTC/USDT"])
    cache = CandleCache(feed, store)
    asyncio.run(cache.refresh([("BTC/USDT", "1h")]))

    st = cache.status("BTC/USDT", "1h")
    assert st.last_close_ts == st.last_bar_ts + duration_ms("1h")
    assert st.last_close_ts <= now_ms()
    assert st.stale is False
    assert st.to_json()["bars"] == st.bars


# --- §2.5 symbol validation -------------------------------------------


def test_unknown_symbols_are_reported_not_dropped():
    feed = FakeFeed(["BTC/USDT", "ETH/USDT"])
    res = asyncio.run(resolve_symbols(feed, ["BTC/USDT", "NOPE/USDT", "ETH/USDT"]))
    assert res.valid == ["BTC/USDT", "ETH/USDT"]
    assert res.native == {"BTC/USDT": "BTC/USDT", "ETH/USDT": "ETH/USDT"}
    assert "NOPE/USDT" in res.unresolved
    assert "not listed" in res.unresolved["NOPE/USDT"]


def test_unreachable_exchange_marks_every_symbol_unresolved():
    class Dead(FakeFeed):
        async def load_markets(self):
            raise ConnectionError("geo-blocked")

    res = asyncio.run(resolve_symbols(Dead(["BTC/USDT"]), ["BTC/USDT", "ETH/USDT"]))
    assert res.valid == []
    assert len(res.unresolved) == 2
    assert "geo-blocked" in res.unresolved["BTC/USDT"]


def test_settle_suffixed_perpetuals_resolve_from_plain_symbols():
    """`binanceusdm` lists `BTC/USDT:USDT`; config says `BTC/USDT`. Bridge it."""

    class PerpFeed(FakeFeed):
        async def load_markets(self):
            self.load_markets_calls += 1
            return {
                "BTC/USDT:USDT": {"symbol": "BTC/USDT:USDT", "base": "BTC", "quote": "USDT",
                                  "settle": "USDT", "swap": True, "linear": True, "active": True},
                "BTC/USDT:USDT-260925": {"symbol": "BTC/USDT:USDT-260925", "base": "BTC",
                                         "quote": "USDT", "settle": "USDT", "swap": False,
                                         "linear": True, "active": True},
                "DEAD/USDT:USDT": {"symbol": "DEAD/USDT:USDT", "base": "DEAD", "quote": "USDT",
                                   "settle": "USDT", "swap": True, "linear": True, "active": False},
            }

    res = asyncio.run(resolve_symbols(PerpFeed([]), ["BTC/USDT", "DEAD/USDT", "GONE/USDT"]))
    assert res.native == {"BTC/USDT": "BTC/USDT:USDT"}, "dated futures must not be picked"
    assert "inactive" in res.unresolved["DEAD/USDT"]
    assert "not listed" in res.unresolved["GONE/USDT"]


def test_cache_fetches_under_the_native_symbol_but_keys_on_the_config_symbol(store):
    feed = FakeFeed(["BTC/USDT:USDT"])
    cache = CandleCache(feed, store, symbol_map={"BTC/USDT": "BTC/USDT:USDT"})
    asyncio.run(cache.refresh([("BTC/USDT", "1h")]))

    assert feed.calls == {("BTC/USDT:USDT", "1h"): 1}
    assert len(cache.get("BTC/USDT", "1h")) > 0


def test_denominated_contract_is_suggested_never_substituted():
    """`PEPE/USDT` is `1000PEPE/USDT:USDT` on Binance — a different price scale."""

    class DenomFeed(FakeFeed):
        async def load_markets(self):
            return {
                "1000PEPE/USDT:USDT": {"symbol": "1000PEPE/USDT:USDT", "base": "1000PEPE",
                                       "quote": "USDT", "settle": "USDT", "swap": True,
                                       "linear": True, "active": True},
            }

    res = asyncio.run(resolve_symbols(DenomFeed([]), ["PEPE/USDT"]))
    assert res.native == {}
    assert "1000PEPE/USDT" in res.unresolved["PEPE/USDT"]
