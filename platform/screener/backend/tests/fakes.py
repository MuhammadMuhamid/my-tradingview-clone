"""In-memory MarketFeed that counts fetches. No network, deterministic bars."""

from __future__ import annotations

import math
from collections import Counter

from app.cache import now_ms
from app.timeframes import duration_ms


class FakeFeed:
    """Synthesises a deterministic OHLCV series and records every fetch call."""

    def __init__(self, symbols: list[str], *, latency: float = 0.0) -> None:
        self.id = "fakeex"
        self._symbols = list(symbols)
        self.calls: Counter[tuple[str, str]] = Counter()
        self.load_markets_calls = 0
        self.latency = latency
        self.max_observed_concurrency = 0
        self._in_flight = 0
        self._series_cache: dict[tuple[str, str, int], list[list[float]]] = {}

    async def load_markets(self) -> dict[str, dict]:
        self.load_markets_calls += 1
        return {
            s: {
                "symbol": s,
                "base": s.partition("/")[0],
                "quote": s.partition("/")[2],
                "spot": True,
                "active": True,
            }
            for s in self._symbols
        }

    async def fetch_ohlcv(self, symbol: str, timeframe: str, limit: int) -> list[list[float]]:
        self.calls[(symbol, timeframe)] += 1
        self._in_flight += 1
        self.max_observed_concurrency = max(self.max_observed_concurrency, self._in_flight)
        try:
            if self.latency:
                import asyncio
                await asyncio.sleep(self.latency)
            return self.series(symbol, timeframe, limit)
        finally:
            self._in_flight -= 1

    @property
    def total_fetches(self) -> int:
        return sum(self.calls.values())

    def series(self, symbol: str, timeframe: str, limit: int) -> list[list[float]]:
        """`limit` bars ending with the currently-forming bar, as a real exchange returns.

        Memoised: the API tests build the same series dozens of times, and the
        generation loop dominated their runtime.
        """
        key = (symbol, timeframe, limit)
        if key in self._series_cache:
            return self._series_cache[key]
        step = duration_ms(timeframe)
        current_open = (now_ms() // step) * step
        seed = sum(ord(c) for c in symbol)
        rows: list[list[float]] = []
        for i in range(limit):
            ts = current_open - (limit - 1 - i) * step
            base = 100.0 + (seed % 50) + 10.0 * math.sin((i + seed) / 17.0)
            o = base
            c = base + math.cos((i + seed) / 11.0)
            rows.append([ts, o, max(o, c) + 0.5, min(o, c) - 0.5, c, 1000.0 + (i % 97)])
        self._series_cache[key] = rows
        return rows

    async def close(self) -> None:
        return None
