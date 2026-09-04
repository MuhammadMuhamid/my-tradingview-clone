"""Exchange abstraction for the canonical Binance Spot Scanner feed.

Everything above this module talks to `MarketFeed`, never to ccxt. That keeps
network behavior testable with a fake while the production adapter remains
explicitly pinned to the product's Binance Spot market identity.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from .timeframes import duration_ms as timeframe_ms

log = logging.getLogger(__name__)

BINANCE_SPOT = "binance"

# Bars returned per `fetch_ohlcv` call, measured — ccxt does not expose these
# uniformly. Asking for more is silently truncated, which is how a "750-bar"
# series quietly becomes a 500-bar one.
_PAGE_CAPS = {BINANCE_SPOT: 1000}


@runtime_checkable
class MarketFeed(Protocol):
    id: str

    async def load_markets(self) -> dict[str, dict]: ...

    async def fetch_ohlcv(self, symbol: str, timeframe: str, limit: int) -> list[list[float]]: ...

    async def close(self) -> None: ...


@dataclass
class SymbolResolution:
    """Outcome of validating the configured symbol list against `load_markets()`.

    Config carries ccxt's unified Spot `BASE/QUOTE` symbols (§3). `native` is
    retained as an explicit mapping so callers can prove that the represented
    instrument is the exact configured Spot pair, never a substituted contract.
    """

    native: dict[str, str] = field(default_factory=dict)   # config symbol -> exchange symbol
    unresolved: dict[str, str] = field(default_factory=dict)  # config symbol -> reason

    @property
    def valid(self) -> list[str]:
        return list(self.native)

    def __bool__(self) -> bool:
        return bool(self.native)


_DENOM_PREFIXES = ("1000", "10000", "1000000", "1M")


def _near_match_hint(markets: dict[str, dict], base: str, quote: str) -> str:
    """Suggest a denominated Spot market without adopting it."""
    for prefix in _DENOM_PREFIXES:
        alt = f"{prefix}{base}"
        for m in markets.values():
            if (m.get("base") == alt and m.get("quote") == quote
                    and m.get("spot") is True and m.get("active") is not False):
                return f" — did you mean {alt}/{quote}? (denominated market, different price scale)"
    return ""


def _match_market(markets: dict[str, dict], symbol: str) -> tuple[str | None, str | None]:
    """Resolve only the exact active Spot `BASE/QUOTE` instrument."""
    market = markets.get(symbol)
    if market is not None:
        if market.get("active") is False:
            return None, "market is inactive (delisted or halted)"
        if market.get("spot") is not True:
            return None, "exact symbol is not a Spot market"
        native = market.get("symbol")
        if native != symbol:
            return None, "exchange market identity does not match the configured Spot symbol"
        return native, None

    base, _, quote = symbol.partition("/")
    return None, "not listed as an exact Spot market on this exchange" + _near_match_hint(
        markets, base, quote
    )


class CcxtFeed:
    """`ccxt.async_support` adapter. Rate limiting is delegated to ccxt itself."""

    def __init__(self, exchange_id: str = BINANCE_SPOT, options: dict | None = None) -> None:
        import ccxt.async_support as ccxt_async

        if not hasattr(ccxt_async, exchange_id):
            raise ValueError(f"unknown exchange id: {exchange_id!r}")
        if exchange_id != BINANCE_SPOT:
            raise ValueError("Scanner market feed must be Binance Spot")
        self.id = exchange_id
        client_options = dict((options or {}).get("options") or {})
        client_options["defaultType"] = "spot"
        config = {"enableRateLimit": True, **(options or {}), "options": client_options}
        self._client = getattr(ccxt_async, exchange_id)(config)
        self._markets: dict[str, dict] | None = None

    async def load_markets(self) -> dict[str, dict]:
        if self._markets is None:
            self._markets = await self._client.load_markets()
        return self._markets

    async def fetch_ohlcv(self, symbol: str, timeframe: str, limit: int) -> list[list[float]]:
        """Fetch `limit` bars, paginating backwards when the exchange caps a page.

        Binance returns at most 1000 Spot bars per call regardless of what you
        ask for, and the screener needs more than that: Pine seeds `ta.ema` with
        an SMA, and a 200-period EMA carries ~0.4% of that seed after 550 bars.
        Two pages put it under 1e-7, which is what the §8.1 tolerance needs.
        """
        page_cap = self._page_cap()
        if limit <= page_cap:
            return await self._client.fetch_ohlcv(symbol, timeframe=timeframe, limit=limit)

        step = timeframe_ms(timeframe)
        newest = await self._client.fetch_ohlcv(symbol, timeframe=timeframe, limit=page_cap)
        if not newest:
            return []

        bars: dict[int, list[float]] = {int(r[0]): r for r in newest}
        oldest_ts = int(newest[0][0])

        while len(bars) < limit:
            want = min(page_cap, limit - len(bars))
            since = oldest_ts - want * step
            page = await self._client.fetch_ohlcv(
                symbol, timeframe=timeframe, since=since, limit=want
            )
            page = [r for r in page if int(r[0]) < oldest_ts]
            if not page:
                break  # exchange has no more history
            for row in page:
                bars[int(row[0])] = row
            oldest_ts = int(page[0][0])

        ordered = [bars[ts] for ts in sorted(bars)]
        return ordered[-limit:]

    def _page_cap(self) -> int:
        """Largest page the exchange will actually return, whatever we ask for."""
        limits = (self._client.options or {}).get("fetchOHLCVLimit")
        return int(limits) if limits else _PAGE_CAPS.get(self.id, 1000)

    async def close(self) -> None:
        await self._client.close()


async def resolve_symbols(feed: MarketFeed, symbols: list[str]) -> SymbolResolution:
    """Validate every configured symbol. Invalid ones are reported, never dropped."""
    result = SymbolResolution()
    try:
        markets = await feed.load_markets()
    except Exception as exc:  # network, geo-block, auth — all fatal for resolution
        log.error("load_markets failed on %s: %s", getattr(feed, "id", "?"), exc)
        result.unresolved = {s: f"exchange unreachable: {exc}" for s in symbols}
        return result

    for symbol in symbols:
        native, reason = _match_market(markets, symbol)
        if native is None:
            result.unresolved[symbol] = reason or "unresolved"
        else:
            result.native[symbol] = native

    if result.unresolved:
        log.warning(
            "%d symbol(s) unresolved on %s: %s",
            len(result.unresolved),
            getattr(feed, "id", "?"),
            ", ".join(sorted(result.unresolved)),
        )
    return result
