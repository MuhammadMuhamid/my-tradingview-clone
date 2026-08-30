"""Screener service — ties config, cache and indicators into rows for the API.

The refresh discipline of §2.4 lives here: refreshing is a scheduled pull, and
serving a request only ever reads the cache. A UI render never triggers a fetch,
so a user hammering the sort control cannot rate-limit the exchange.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd

from . import calibration as calib
from .cache import CandleCache, SeriesStatus, now_ms
from .config import CONFIG_DIR, ConfigStore
from .exchange import CcxtFeed, MarketFeed, SymbolResolution, resolve_symbols
from . import strategy as strat
from .indicators import REGISTRY, STRATEGY_EXTRAS
from .indicators.base import InsufficientData
from .scoring import compute as compute_score
from .store import OhlcvStore
from .timeframes import duration_ms

log = logging.getLogger(__name__)

PRESETS_PATH = CONFIG_DIR / "presets.json"
DAY_MS = 86_400_000


@dataclass
class RowSeries:
    """Provenance for one `(symbol, timeframe)` the row depended on."""

    timeframe: str
    last_bar_ts: int | None
    last_close_ts: int | None
    stale: bool
    bars: int


@dataclass
class ScreenerRow:
    symbol: str
    state: str                       # ok | unresolved | no_data | partial
    price: float | None = None
    change_24h_pct: float | None = None
    indicators: dict[str, Any] = field(default_factory=dict)
    series: dict[str, RowSeries] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)
    score: dict[str, Any] | None = None
    empirical: dict[str, Any] | None = None
    strategy: dict[str, Any] | None = None
    #: Every indicator at each of the strategy's timeframes, keyed
    #: mtf[timeframe][indicator]. The table's columns are per-timeframe now, so
    #: this is what they read; it reuses the contexts the strategy already built
    #: rather than computing anything twice.
    mtf: dict[str, dict[str, Any]] = field(default_factory=dict)
    note: str | None = None

    def to_json(self) -> dict:
        return {
            "symbol": self.symbol,
            "state": self.state,
            "price": self.price,
            "change_24h_pct": self.change_24h_pct,
            "indicators": self.indicators,
            "score": self.score,
            "empirical": self.empirical,
            "strategy": self.strategy,
            "mtf": self.mtf,
            "series": {
                tf: {
                    "timeframe": s.timeframe,
                    "last_bar_ts": s.last_bar_ts,
                    "last_close_ts": s.last_close_ts,
                    "stale": s.stale,
                    "bars": s.bars,
                }
                for tf, s in self.series.items()
            },
            "errors": self.errors,
            "note": self.note,
        }


class ScreenerService:
    def __init__(
        self,
        config: ConfigStore | None = None,
        feed: MarketFeed | None = None,
        store: OhlcvStore | None = None,
    ) -> None:
        self.config = config or ConfigStore()
        doc = self.config.doc
        self.feed = feed or CcxtFeed(doc["exchange"])
        self.store = store or OhlcvStore()
        self.cache = CandleCache(
            self.feed,
            self.store,
            fetch_bars=int(doc["data"]["fetch_bars"]),
            max_concurrent=int(doc["data"]["max_concurrent_fetches"]),
        )
        self.resolution = SymbolResolution()
        self.last_refresh_ms: int | None = None
        self.last_refresh_error: str | None = None
        self._refresh_lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._calibrating: set[str] = set()
        self._snapshot: dict | None = None
        self._snapshot_lock = threading.RLock()

    # --- lifecycle -----------------------------------------------------

    async def startup(self) -> None:
        """§2.5 — validate every configured symbol before serving anything."""
        await self.revalidate()
        for u in self.config.unverified_symbols:
            log.warning("unverified symbol %s — %s", u.raw, u.note)
        await self.refresh()

    async def revalidate(self) -> SymbolResolution:
        self.resolution = await resolve_symbols(self.feed, self.config.doc["symbols"])
        self.cache.symbol_map = dict(self.resolution.native)
        return self.resolution

    def start_scheduler(self, interval_seconds: int = 30) -> None:
        """Pull-based refresh. The TTL in the cache decides what actually fetches."""
        if self._task is not None:
            return

        async def loop() -> None:
            while True:
                try:
                    await asyncio.sleep(interval_seconds)
                    await self.refresh()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # a scheduler must not die on one bad tick
                    log.exception("scheduled refresh failed: %s", exc)

        self._task = asyncio.ensure_future(loop())

    async def shutdown(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        await self.feed.close()
        self.store.close()

    # --- refresh -------------------------------------------------------

    async def refresh(self, force: bool = False) -> dict:
        """Bring every required series up to date. Serialised — one at a time."""
        async with self._refresh_lock:
            pairs = self.required_pairs()
            report = await self.cache.refresh(pairs, force=force)
            self._snapshot = None
            self.last_refresh_ms = now_ms()
            self.last_refresh_error = (
                f"{len(report.failed)} series failed" if report.failed else None
            )
            return {
                "requested": report.requested,
                "fetched": report.fetched,
                "served_from_cache": report.served_from_cache,
                "failed": {f"{s}@{tf}": msg for (s, tf), msg in report.failed.items()},
                "at": self.last_refresh_ms,
            }

    def required_pairs(self) -> list[tuple[str, str]]:
        """Only resolved symbols, crossed with the timeframes actually in use."""
        tfs = self.config.active_timeframes()
        return [(s, tf) for s in self.resolution.native for tf in tfs]

    # --- rows ----------------------------------------------------------

    def _price_and_change(self, symbol: str, tfs: list[str]) -> tuple[float | None, float | None]:
        """Last close and 24h change, taken from the shortest cached series."""
        for tf in tfs:
            df = self.cache.get(symbol, tf, bars=max(2, DAY_MS // duration_ms(tf) + 1))
            if len(df) < 2:
                continue
            price = float(df["close"].iloc[-1])
            back = DAY_MS // duration_ms(tf)
            if back < 1 or len(df) <= back:
                return price, None
            earlier = float(df["close"].iloc[-1 - back])
            return price, ((price / earlier) - 1.0) * 100.0 if earlier else None
        return None, None

    def build_row(self, symbol: str) -> ScreenerRow:
        if symbol in self.resolution.unresolved:
            return ScreenerRow(
                symbol=symbol, state="unresolved",
                note=self.resolution.unresolved[symbol],
            )

        enabled = {k: v for k, v in self.config.doc["indicators"].items() if v["enabled"]}
        tfs = self.config.active_timeframes()

        row = ScreenerRow(symbol=symbol, state="ok")
        row.price, row.change_24h_pct = self._price_and_change(symbol, tfs)

        frames: dict[str, pd.DataFrame] = {}
        for tf in tfs:
            df = frames[tf] = self.cache.get(symbol, tf)
            status: SeriesStatus = self.cache.status(symbol, tf)
            row.series[tf] = RowSeries(
                timeframe=tf,
                last_bar_ts=status.last_bar_ts,
                last_close_ts=status.last_close_ts,
                stale=status.stale,
                bars=len(df),
            )

        if all(len(df) == 0 for df in frames.values()):
            row.state = "no_data"
            row.note = "no candles cached yet"
            return row

        for name, spec in enabled.items():
            tf = spec["timeframe"]
            df = frames.get(tf)
            if df is None or df.empty:
                row.errors[name] = f"no data for {tf}"
                continue
            try:
                row.indicators[name] = REGISTRY[name].compute(df, spec["params"])
            except InsufficientData as exc:
                row.errors[name] = str(exc)
            except Exception as exc:  # one bad indicator must not blank the row
                log.exception("%s failed on %s %s", name, symbol, tf)
                row.errors[name] = f"{type(exc).__name__}: {exc}"

        # Scored from whatever computed. Buckets with no inputs are dropped and
        # the weights renormalised, so a disabled indicator narrows the basis
        # rather than silently dragging every score toward neutral.
        row.score = compute_score(row.indicators, self.config.doc.get("scoring"))

        # §6.2 is off by default and never overwrites the score. When it is on
        # and a calibration exists for this symbol, the empirical rate is
        # attached alongside — with its own sample size and display string.
        empirical = (self.config.doc.get("scoring", {}).get("empirical") or {})
        if empirical.get("enabled"):
            stored = self.store.load_calibration(self.cache.exchange_id, symbol, tfs[0])
            row.empirical = (
                calib.lookup(stored, row.score.get("score")) if stored
                else {"available": False, "display": "not calibrated", "hit_rate": None, "n": 0}
            )

        try:
            row.strategy, row.mtf = self.build_strategy(symbol)
        except Exception as exc:
            log.exception("strategy failed on %s", symbol)
            row.errors["strategy"] = f"{type(exc).__name__}: {exc}"

        if row.errors:
            row.state = "partial" if row.indicators else "no_data"
        return row

    def rows(self) -> list[ScreenerRow]:
        return [self.build_row(s) for s in self.config.doc["symbols"]]

    def snapshot(self, force: bool = False) -> dict:
        """The cached snapshot, rebuilt on refresh rather than per request.

        Building it means eight indicators plus a three-timeframe strategy pass
        for every symbol — seconds of arithmetic. The UI polls; recomputing that
        on every poll wasted the work and made the page feel slow for no reason.
        """
        with self._snapshot_lock:
            if not force and self._snapshot is not None:
                return self._snapshot
            self._snapshot = self._build_snapshot()
            return self._snapshot

    def _build_snapshot(self) -> dict:
        started = time.perf_counter()
        rows = self.rows()
        return {
            "exchange": self.cache.exchange_id,
            "generated_at": now_ms(),
            "last_refresh_at": self.last_refresh_ms,
            "last_refresh_error": self.last_refresh_error,
            "timeframes": self.config.active_timeframes(),
            "indicators": {
                k: {"enabled": v["enabled"], "timeframe": v["timeframe"], "params": v["params"]}
                for k, v in self.config.doc["indicators"].items()
            },
            "strategy": {
                "enabled": bool((self.config.doc.get("strategy") or {}).get("enabled")),
                "name": (self.config.doc.get("strategy") or {}).get("name"),
                "timeframes": self.config.strategy_timeframes(),
                "rules": {
                    slot: [
                        {"id": r.id, "label": r.label, "required": r.required, "note": r.note}
                        for r in rules
                    ]
                    for slot, rules in strat.RULES.items()
                },
                "note": strat.evaluate({}, self.config.doc.get("strategy"))["note"],
            },
            "scoring": {
                "label": "Confluence Score",
                "mode": self.config.doc.get("scoring", {}).get("mode", "confluence_score"),
                "disclaimer": (
                    "A weighted confluence score, not a probability. "
                    "It has not been validated against forward returns."
                ),
                "weights": self.config.doc.get("scoring", {}).get("weights", {}),
                "ranging_multiplier": self.config.doc.get("scoring", {}).get(
                    "ranging_multiplier"
                ),
            },
            "unverified_symbols": [
                {"raw": u.raw, "note": u.note} for u in self.config.unverified_symbols
            ],
            "rows": [r.to_json() for r in rows],
            "compute_ms": round((time.perf_counter() - started) * 1000, 1),
        }

    # --- strategy ------------------------------------------------------

    def strategy_context(self, symbol: str, timeframe: str) -> dict[str, Any]:
        """Every indicator the rule engine needs, on one timeframe.

        The strategy uses its own parameters, not the table's: it wants RSI(50)
        where the columns show RSI(14). Same cached candles either way, so the
        extra cost is arithmetic, not network.
        """
        spec = self.config.doc.get("strategy") or {}
        params = spec.get("indicators", {})
        df = self.cache.get(symbol, timeframe)
        if df.empty:
            return {}

        ctx: dict[str, Any] = {}
        for name, module in {**REGISTRY, **STRATEGY_EXTRAS}.items():
            if name == "candles":
                continue          # the strategy has no candle-pattern rule
            try:
                if name == "pivots":
                    ctx[name] = module.compute(df, params.get(name), timeframe=timeframe)
                else:
                    ctx[name] = module.compute(df, params.get(name))
            except InsufficientData:
                ctx[name] = None
            except Exception:
                log.exception("strategy indicator %s failed on %s %s", name, symbol, timeframe)
                ctx[name] = None
        return ctx

    #: Fields dropped from the per-timeframe payload. They are lists, they are
    #: large, and no column reads them — carrying them for 36 symbols x 3
    #: timeframes would multiply the response size for nothing.
    _MTF_DROP = {"sr": ("levels",), "pivots": ()}

    def _slim(self, contexts: dict[str, dict]) -> dict[str, dict]:
        slim: dict[str, dict] = {}
        for slot, ctx in contexts.items():
            out: dict[str, Any] = {}
            for name, block in ctx.items():
                if not isinstance(block, dict):
                    out[name] = block
                    continue
                drop = self._MTF_DROP.get(name, ())
                out[name] = {k: v for k, v in block.items() if k not in drop}
            slim[slot] = out
        return slim

    def build_strategy(self, symbol: str) -> tuple[dict[str, Any] | None, dict[str, dict]]:
        slots = self.config.strategy_timeframes()
        if not slots:
            return None, {}

        contexts = {slot: self.strategy_context(symbol, tf) for slot, tf in slots.items()}
        result = strat.evaluate(contexts, self.config.doc.get("strategy"))
        result["timeframes_used"] = slots
        result["series"] = {
            slot: self.cache.status(symbol, tf).to_json() for slot, tf in slots.items()
        }
        return result, self._slim(contexts)

    # --- calibration (§6.2) --------------------------------------------

    async def calibrate(self, symbol: str, with_sr: bool = True) -> dict:
        """Run the walk-forward calibration for one symbol, off the event loop."""
        if symbol not in self.resolution.native:
            raise ValueError(f"{symbol} is not resolved on this exchange")
        if symbol in self._calibrating:
            raise ValueError(f"{symbol} is already being calibrated")

        tf = self.config.active_timeframes()[0]
        df = self.cache.get(symbol, tf)
        if df.empty:
            raise ValueError(f"no cached candles for {symbol} at {tf}")

        self._calibrating.add(symbol)
        try:
            loop = asyncio.get_running_loop()
            payload = await loop.run_in_executor(
                None,
                lambda: calib.calibrate(df, self.config.doc, symbol, tf, with_sr=with_sr),
            )
        finally:
            self._calibrating.discard(symbol)

        payload["generated_at"] = now_ms()
        self._snapshot = None
        self.store.save_calibration(self.cache.exchange_id, symbol, tf, payload)
        return payload

    def calibration(self, symbol: str) -> dict | None:
        tf = self.config.active_timeframes()[0]
        return self.store.load_calibration(self.cache.exchange_id, symbol, tf)

    def calibrations(self) -> list[dict]:
        return self.store.list_calibrations(self.cache.exchange_id)

    # --- symbols -------------------------------------------------------

    async def add_symbol(self, symbol: str) -> dict:
        """§3 — validate against `load_markets()` before persisting, then backfill."""
        symbol = symbol.strip().upper()
        if "/" not in symbol:
            raise ValueError("symbol must be in BASE/QUOTE form, e.g. BTC/USDT")
        if symbol in self.config.doc["symbols"]:
            raise ValueError(f"{symbol} is already in the watchlist")

        probe = await resolve_symbols(self.feed, [symbol])
        if symbol not in probe.native:
            raise ValueError(probe.unresolved.get(symbol, "could not be resolved"))

        self._snapshot = None
        self.config.update({"symbols": self.config.doc["symbols"] + [symbol]})
        self.resolution.native[symbol] = probe.native[symbol]
        self.cache.symbol_map = dict(self.resolution.native)

        # Backfill every timeframe currently in use, so the row is not empty.
        await self.cache.refresh([(symbol, tf) for tf in self.config.active_timeframes()])
        return {"symbol": symbol, "native": probe.native[symbol]}

    def remove_symbol(self, symbol: str) -> dict:
        symbols = self.config.doc["symbols"]
        if symbol not in symbols:
            raise ValueError(f"{symbol} is not in the watchlist")
        self._snapshot = None
        self.config.update({"symbols": [s for s in symbols if s != symbol]})
        self.resolution.native.pop(symbol, None)
        self.resolution.unresolved.pop(symbol, None)
        self.cache.symbol_map = dict(self.resolution.native)
        return {"symbol": symbol, "removed": True}

    # --- presets -------------------------------------------------------

    def presets(self) -> dict[str, dict]:
        if not PRESETS_PATH.exists():
            return {}
        return json.loads(PRESETS_PATH.read_text())

    def save_preset(self, name: str) -> dict:
        """A preset is the indicator block only — timeframes, params, enabled flags."""
        name = name.strip()
        if not name:
            raise ValueError("preset name cannot be empty")
        all_presets = self.presets()
        all_presets[name] = {"indicators": self.config.doc["indicators"], "saved_at": now_ms()}
        tmp = PRESETS_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(all_presets, indent=2))
        tmp.replace(PRESETS_PATH)
        return {"name": name, "saved": True}

    async def load_preset(self, name: str) -> dict:
        all_presets = self.presets()
        if name not in all_presets:
            raise ValueError(f"no preset named {name!r}")
        self.config.update({"indicators": all_presets[name]["indicators"]})
        # Timeframes may have changed; fetch only the newly-required pairs.
        await self.refresh()
        return {"name": name, "loaded": True, "timeframes": self.config.active_timeframes()}

    def delete_preset(self, name: str) -> dict:
        all_presets = self.presets()
        if name not in all_presets:
            raise ValueError(f"no preset named {name!r}")
        del all_presets[name]
        PRESETS_PATH.write_text(json.dumps(all_presets, indent=2))
        return {"name": name, "deleted": True}
