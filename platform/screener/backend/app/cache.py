"""Candle cache — the deduplication layer everything else reads through.

Two rules govern this module and both come straight from §2:

1. **Fetch is keyed by `(exchange, symbol, timeframe)`, not by indicator.**
   Callers hand in the set of pairs the config needs; identical pairs collapse.
   Eight indicators on 1h across 37 symbols cost 37 fetches, not 296.
2. **Closed bars only.** The forming bar is dropped here, once, so nothing
   downstream can accidentally compute on it. This is Pine's
   `barmerge.lookahead_off` + `barstate.isconfirmed` equivalent.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

import pandas as pd

from .exchange import MarketFeed
from .store import OhlcvStore
from .timeframes import duration_ms, is_closed

log = logging.getLogger(__name__)

DEFAULT_FETCH_BARS = 1800


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(frozen=True)
class SeriesStatus:
    """What the UI needs to render provenance and staleness for one series."""

    symbol: str
    timeframe: str
    bars: int
    last_bar_ts: int | None      # open time of the newest closed bar
    last_close_ts: int | None    # close time of that bar — the timestamp §2.2 exposes
    fetched_at: int | None
    error: str | None = None

    @property
    def stale(self) -> bool:
        """True when the source bar is older than 2x its own timeframe."""
        if self.last_close_ts is None:
            return True
        return now_ms() - self.last_close_ts > 2 * duration_ms(self.timeframe)

    def to_json(self) -> dict:
        return {
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "bars": self.bars,
            "last_bar_ts": self.last_bar_ts,
            "last_close_ts": self.last_close_ts,
            "fetched_at": self.fetched_at,
            "stale": self.stale,
            "error": self.error,
        }


@dataclass
class RefreshReport:
    requested: int = 0        # pairs asked for, after dedup
    fetched: int = 0          # pairs that actually hit the network
    served_from_cache: int = 0
    failed: dict[tuple[str, str], str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.failed is None:
            self.failed = {}


def drop_forming_bar(rows: list[list[float]], timeframe: str, at_ms: int | None = None) -> list[list[float]]:
    """Strip any bar that has not finished forming. §2.2 — non-negotiable."""
    at = now_ms() if at_ms is None else at_ms
    return [r for r in rows if is_closed(int(r[0]), timeframe, at)]


class CandleCache:
    def __init__(
        self,
        feed: MarketFeed,
        store: OhlcvStore,
        fetch_bars: int = DEFAULT_FETCH_BARS,
        max_concurrent: int = 8,
        symbol_map: dict[str, str] | None = None,
    ) -> None:
        self.feed = feed
        self.store = store
        self.fetch_bars = fetch_bars
        # config symbol -> exchange-native symbol (see exchange.SymbolResolution).
        # Cache rows stay keyed by the config symbol within the feed's exchange
        # namespace. `binance` and legacy `binanceusdm` rows therefore cannot mix.
        self.symbol_map: dict[str, str] = dict(symbol_map or {})
        self._sem = asyncio.Semaphore(max_concurrent)
        # Guards against two concurrent refreshes racing on the same pair — the
        # second would otherwise fetch before the first has written its meta row.
        self._inflight: dict[tuple[str, str], asyncio.Task] = {}

    @property
    def exchange_id(self) -> str:
        return self.feed.id

    def native(self, symbol: str) -> str:
        return self.symbol_map.get(symbol, symbol)

    # --- freshness -----------------------------------------------------

    def is_fresh(self, symbol: str, timeframe: str, at_ms: int | None = None) -> bool:
        """§2.4: a series is fresh until the next bar of its own timeframe closes."""
        meta = self.store.get_meta(self.exchange_id, symbol, timeframe)
        if meta is None:
            return False
        _fetched_at, last_bar_ts = meta
        at = now_ms() if at_ms is None else at_ms
        step = duration_ms(timeframe)
        # The newest bar that *could* be closed right now.
        newest_closed_open = ((at // step) * step) - step
        return last_bar_ts >= newest_closed_open

    # --- refresh -------------------------------------------------------

    async def refresh(
        self, pairs: list[tuple[str, str]], force: bool = False
    ) -> RefreshReport:
        """Bring every `(symbol, timeframe)` pair up to date, fetching each at most once."""
        unique = sorted(set(pairs))
        report = RefreshReport(requested=len(unique))

        stale_pairs = [p for p in unique if force or not self.is_fresh(*p)]
        report.served_from_cache = len(unique) - len(stale_pairs)

        results = await asyncio.gather(
            *(self._refresh_one(sym, tf) for sym, tf in stale_pairs),
            return_exceptions=True,
        )
        for pair, outcome in zip(stale_pairs, results):
            if isinstance(outcome, BaseException):
                report.failed[pair] = f"{type(outcome).__name__}: {outcome}"
                log.warning("fetch failed for %s %s: %s", pair[0], pair[1], outcome)
            else:
                report.fetched += 1
        return report

    async def _refresh_one(self, symbol: str, timeframe: str) -> int:
        key = (symbol, timeframe)
        task = self._inflight.get(key)
        if task is not None:
            return await asyncio.shield(task)

        task = asyncio.ensure_future(self._do_fetch(symbol, timeframe))
        self._inflight[key] = task
        try:
            return await task
        finally:
            self._inflight.pop(key, None)

    async def _do_fetch(self, symbol: str, timeframe: str) -> int:
        async with self._sem:
            rows = await self.feed.fetch_ohlcv(self.native(symbol), timeframe, self.fetch_bars)

        closed = drop_forming_bar(rows, timeframe)
        if not closed:
            raise RuntimeError(f"no closed bars returned for {symbol} {timeframe}")

        written = self.store.upsert(self.exchange_id, symbol, timeframe, closed)
        self.store.trim(self.exchange_id, symbol, timeframe, keep=self.fetch_bars * 2)
        self.store.set_meta(
            self.exchange_id, symbol, timeframe,
            fetched_at=now_ms(), last_bar_ts=int(closed[-1][0]),
        )
        return written

    # --- reads ---------------------------------------------------------

    def get(self, symbol: str, timeframe: str, bars: int | None = None) -> pd.DataFrame:
        """Closed bars for one series, oldest-first. Empty frame if never fetched."""
        return self.store.load(
            self.exchange_id, symbol, timeframe, limit=bars or self.fetch_bars
        )

    def status(self, symbol: str, timeframe: str, error: str | None = None) -> SeriesStatus:
        meta = self.store.get_meta(self.exchange_id, symbol, timeframe)
        df = self.store.load(self.exchange_id, symbol, timeframe)
        last_bar_ts = int(df["ts"].iloc[-1]) if len(df) else None
        return SeriesStatus(
            symbol=symbol,
            timeframe=timeframe,
            bars=len(df),
            last_bar_ts=last_bar_ts,
            last_close_ts=None if last_bar_ts is None else last_bar_ts + duration_ms(timeframe),
            fetched_at=meta[0] if meta else None,
            error=error,
        )
