"""Exchange abstraction.

Everything above this module talks to `MarketFeed`, never to ccxt. That is what
makes the exchange swappable per §1 (Binance may be unreachable from the deploy
region; Bybit and OKX are the fallbacks) and what lets the cache tests count
fetches against a fake without touching the network.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from .timeframes import duration_ms as timeframe_ms

log = logging.getLogger(__name__)

FALLBACK_EXCHANGES = ("binanceusdm", "bybit", "okx")

# Bars returned per `fetch_ohlcv` call, measured — ccxt does not expose these
# uniformly. Asking for more is silently truncated, which is how a "750-bar"
# series quietly becomes a 500-bar one.
_PAGE_CAPS = {"binanceusdm": 1000, "binance": 1000, "bybit": 1000, "okx": 300}


@runtime_checkable
class MarketFeed(Protocol):
    id: str

    async def load_markets(self) -> dict[str, dict]: ...

    async def fetch_ohlcv(self, symbol: str, timeframe: str, limit: int) -> list[list[float]]: ...

    async def close(self) -> None: ...


@dataclass
class SymbolResolution:
    """Outcome of validating the configured symbol list against `load_markets()`.

    Config carries plain `BASE/QUOTE` symbols (§3). Exchanges do not all speak
    that: ccxt's unified symbol for a linear perpetual is `BASE/QUOTE:SETTLE`,
    so `BTC/USDT` on `binanceusdm` is really `BTC/USDT:USDT`. `native` holds that
    translation so the rest of the app never has to know.
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
    """Suggest a denominated contract without adopting it.

    Binance lists low-priced assets as `1000PEPE/USDT:USDT` — a different quote
    unit for the same asset. Percentage-based outputs would survive the swap but
    price levels would not, so the substitution is the user's call, not ours.
    """
    for prefix in _DENOM_PREFIXES:
        alt = f"{prefix}{base}"
        for m in markets.values():
            if m.get("base") == alt and m.get("quote") == quote and m.get("active") is not False:
                return f" — did you mean {alt}/{quote}? (denominated contract, different price scale)"
    return ""


def _match_market(markets: dict[str, dict], symbol: str) -> tuple[str | None, str | None]:
    """Resolve one `BASE/QUOTE` symbol to an exchange-native symbol.

    Preference order: an exact match (spot exchanges), then the perpetual swap
    settled in the quote currency, then any active linear swap on that pair.
    Dated futures (`BTC/USDT:USDT-260925`) are never chosen implicitly — they
    expire, and a screener silently tracking an expiring contract is a trap.
    """
    market = markets.get(symbol)
    if market is not None:
        if market.get("active") is False:
            return None, "market is inactive (delisted or halted)"
        return symbol, None

    base, _, quote = symbol.partition("/")
    candidates = [
        m for m in markets.values()
        if m.get("base") == base and m.get("quote") == quote
        and m.get("swap") and m.get("linear") and m.get("settle") == quote
    ]
    if not candidates:
        return None, "not listed on this exchange" + _near_match_hint(markets, base, quote)

    active = [m for m in candidates if m.get("active") is not False]
    if not active:
        return None, "market is inactive (delisted or halted)"
    return active[0]["symbol"], None


class CcxtFeed:
    """`ccxt.async_support` adapter. Rate limiting is delegated to ccxt itself."""

    def __init__(self, exchange_id: str = "binanceusdm", options: dict | None = None) -> None:
        import ccxt.async_support as ccxt_async

        if not hasattr(ccxt_async, exchange_id):
            raise ValueError(f"unknown exchange id: {exchange_id!r}")
        self.id = exchange_id
        self._client = getattr(ccxt_async, exchange_id)(
            {"enableRateLimit": True, **(options or {})}
        )
        self._markets: dict[str, dict] | None = None

    async def load_markets(self) -> dict[str, dict]:
        if self._markets is None:
            self._markets = await self._client.load_markets()
        return self._markets

    async def fetch_ohlcv(self, symbol: str, timeframe: str, limit: int) -> list[list[float]]:
        """Fetch `limit` bars, paginating backwards when the exchange caps a page.

        Binance USDⓈ-M returns at most 1000 bars per call regardless of what you
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
