"""FastAPI layer.

Read endpoints serve the cache and never fetch — see `service.ScreenerService`.
The only endpoints that touch the network are the explicit `POST /api/refresh`
and adding a symbol, which has to validate against `load_markets()` before it can
be persisted.
"""

from __future__ import annotations

import logging
import math
import re
from contextlib import asynccontextmanager
from typing import Any

import pandas as pd
from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .config import ConfigError
from .service import ScreenerService
from .timeframes import SUPPORTED, duration_ms
from .indicators import candles as candle_patterns
from .indicators import classical as classical_patterns

_ANALYSIS_TIMEFRAME = re.compile(r"^([1-9][0-9]{0,3})([smhd])$")
_ANALYSIS_UNITS = {"s": 1_000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}


def _analysis_duration_ms(value: str) -> int:
    """Fixed chart resolutions, including exact derived Binance Spot bars."""
    match = _ANALYSIS_TIMEFRAME.fullmatch(value)
    if match is None:
        raise ValueError("unsupported timeframe")
    duration = int(match.group(1)) * _ANALYSIS_UNITS[match.group(2)]
    if duration > 86_400_000:
        raise ValueError("unsupported timeframe")
    return duration


def _validated_pattern_rows(source: Any, step: int, as_of: int) -> tuple[list[dict], int]:
    """Validate one exact, contiguous UTC grid shared by both pattern APIs."""
    if not isinstance(source, list) or not 1 <= len(source) <= 2_000:
        raise ValueError("candles must contain between 1 and 2000 bars")
    rows: list[dict[str, float | int]] = []
    previous: int | None = None
    excluded = 0
    for raw in source:
        if not isinstance(raw, dict):
            raise ValueError("each candle must be an object")
        required = {"open_time", "open", "high", "low", "close", "close_time"}
        if set(raw) != required:
            raise ValueError("each candle requires exactly open_time, open, high, low, close, close_time")
        opened = int(raw["open_time"])
        closed = int(raw["close_time"])
        if opened % step != 0:
            raise ValueError("candle open_time is off the declared UTC timeframe grid")
        if previous is not None and opened != previous + step:
            raise ValueError("candle open_time values must be contiguous at the declared timeframe")
        previous = opened
        if closed != opened + step - 1:
            raise ValueError("close_time does not match timeframe")
        values = [float(raw[key]) for key in ("open", "high", "low", "close")]
        if not all(math.isfinite(value) and value > 0 for value in values):
            raise ValueError("OHLC values must be finite and positive")
        opened_price, high, low, close = values
        if high < max(opened_price, close) or low > min(opened_price, close) or high <= low:
            raise ValueError("invalid OHLC geometry")
        if closed > as_of:
            excluded += 1
            continue
        rows.append({
            "ts": opened, "open": opened_price, "high": high,
            "low": low, "close": close,
        })
    return rows, excluded

log = logging.getLogger(__name__)


def create_app(service: ScreenerService | None = None, schedule: bool = True) -> FastAPI:
    svc = service or ScreenerService()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await svc.startup()
        if schedule:
            svc.start_scheduler()
        yield
        await svc.shutdown()

    app = FastAPI(title="Crypto Screener", version="0.6.0", lifespan=lifespan)
    # Any localhost port: the dev server picks whatever is free, and pinning 3000
    # silently breaks every request the moment it lands on 3005 instead.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.service = svc

    # --- read ---------------------------------------------------------

    @app.get("/api/health")
    async def health() -> dict:
        return {
            "ok": True,
            "exchange": svc.cache.exchange_id,
            "market": svc.market_contract(),
            "symbols": len(svc.config.doc["symbols"]),
            "resolved": len(svc.resolution.native),
            "unresolved": len(svc.resolution.unresolved),
            "timeframes": svc.config.active_timeframes(),
            "last_refresh_at": svc.last_refresh_ms,
            "last_refresh_error": svc.last_refresh_error,
        }

    @app.get("/api/screener")
    async def screener() -> dict:
        """The whole table. Reads the cache only — never triggers a fetch."""
        return svc.snapshot()

    @app.get("/api/strategy")
    async def strategy_view() -> dict:
        """The MTF checklist alone, without the eight indicator columns."""
        snap = svc.snapshot()
        return {
            "generated_at": snap["generated_at"],
            "market": snap["market"],
            "strategy": snap["strategy"],
            "rows": [
                {
                    "symbol": r["symbol"],
                    "state": r["state"],
                    "price": r["price"],
                    "change_24h_pct": r["change_24h_pct"],
                    "score": (r["score"] or {}).get("score"),
                    "empirical": r["empirical"],
                    "strategy": r["strategy"],
                }
                for r in snap["rows"]
            ],
        }

    @app.get("/api/symbols")
    async def symbols() -> dict:
        return {
            "market": svc.market_contract(),
            "symbols": svc.config.doc["symbols"],
            "resolved": svc.resolution.native,
            "unresolved": svc.resolution.unresolved,
            "unverified": [
                {"raw": u.raw, "note": u.note} for u in svc.config.unverified_symbols
            ],
        }

    @app.get("/api/config")
    async def get_config() -> dict:
        return {"config": svc.config.doc, "supported_timeframes": list(SUPPORTED)}

    @app.get("/api/patterns/catalog")
    async def pattern_catalog() -> dict:
        """Versioned catalog shared by chart, Screener, export, and alerts."""
        settings = candle_patterns.normalized_settings()
        return {
            "detector_id": candle_patterns.DETECTOR_ID,
            "detector_version": candle_patterns.DETECTOR_VERSION,
            "catalog_observed_at": candle_patterns.CATALOG_OBSERVED_AT,
            "confirmation": "bar_close",
            "causal": True,
            "predictive_claim": False,
            "settings": settings,
            "settings_hash": candle_patterns.settings_hash(settings),
            "patterns": candle_patterns.catalog(),
        }

    @app.post("/api/patterns/analyze")
    async def analyze_patterns(payload: dict[str, Any] = Body(...)) -> dict:
        """Analyze caller-supplied, completed Binance Spot OHLC bars only.

        This endpoint deliberately does not fetch and does not accept a generic
        exchange identity. Its result is suitable for annotations and exports:
        every occurrence names the exact source-bar open and confirmation time.
        """
        try:
            allowed = {"venue", "market_type", "symbol", "timeframe", "as_of", "candles", "settings"}
            extra = set(payload) - allowed
            if extra:
                raise ValueError(f"unsupported field: {sorted(extra)[0]}")
            if str(payload.get("venue", "")).upper() != "BINANCE":
                raise ValueError("venue must be BINANCE")
            if payload.get("market_type") != "spot":
                raise ValueError("market_type must be spot")
            symbol = str(payload.get("symbol", "")).upper()
            if not symbol.isalnum() or not 3 <= len(symbol) <= 30:
                raise ValueError("symbol must be an alphanumeric Binance Spot symbol")
            timeframe = str(payload.get("timeframe", ""))
            step = _analysis_duration_ms(timeframe)
            as_of = int(payload.get("as_of"))
            if as_of <= 0:
                raise ValueError("as_of must be a positive Unix time in milliseconds")
            rows, excluded = _validated_pattern_rows(
                payload.get("candles"), step, as_of,
            )

            settings = payload.get("settings")
            if settings is not None and not isinstance(settings, dict):
                raise ValueError("settings must be an object")
            params = {**(settings or {}), "bar_duration_ms": step}
            result = candle_patterns.scan(pd.DataFrame(rows), params)
            return {
                **result,
                "source": {
                    "venue": "BINANCE", "market_type": "spot", "symbol": symbol,
                    "timeframe": timeframe, "ohlc": "caller_supplied_binance_spot",
                    "as_of": as_of, "closed_bars_analyzed": len(rows),
                    "forming_bars_excluded": excluded,
                },
            }
        except (TypeError, ValueError, OverflowError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/api/classical-patterns/catalog")
    async def classical_pattern_catalog() -> dict:
        """Current 16-family catalog with deterministic detector provenance."""
        settings = classical_patterns.normalized_settings()
        return {
            "detector_id": classical_patterns.DETECTOR_ID,
            "detector_version": classical_patterns.DETECTOR_VERSION,
            "catalog_observed_at": classical_patterns.CATALOG_OBSERVED_AT,
            "search_horizon_bars": classical_patterns.SEARCH_BARS,
            "confirmation": "close",
            "pivot_confirmation": {"left_bars": 5, "right_bars": 5},
            "causal": True,
            "predictive_claim": False,
            "settings": settings,
            "settings_hash": classical_patterns.settings_hash(settings),
            "patterns": classical_patterns.catalog(),
        }

    @app.post("/api/classical-patterns/analyze")
    async def analyze_classical_patterns(payload: dict[str, Any] = Body(...)) -> dict:
        """Analyze only completed caller-supplied Binance Spot OHLC bars."""
        try:
            allowed = {"venue", "market_type", "symbol", "timeframe", "as_of", "candles", "settings"}
            extra = set(payload) - allowed
            if extra:
                raise ValueError(f"unsupported field: {sorted(extra)[0]}")
            if str(payload.get("venue", "")).upper() != "BINANCE":
                raise ValueError("venue must be BINANCE")
            if payload.get("market_type") != "spot":
                raise ValueError("market_type must be spot")
            symbol = str(payload.get("symbol", "")).upper()
            if not symbol.isalnum() or not 3 <= len(symbol) <= 30:
                raise ValueError("symbol must be an alphanumeric Binance Spot symbol")
            timeframe = str(payload.get("timeframe", ""))
            step = _analysis_duration_ms(timeframe)
            as_of = int(payload.get("as_of"))
            if as_of <= 0:
                raise ValueError("as_of must be a positive Unix time in milliseconds")
            rows, excluded = _validated_pattern_rows(
                payload.get("candles"), step, as_of,
            )
            settings = payload.get("settings")
            if settings is not None and not isinstance(settings, dict):
                raise ValueError("settings must be an object")
            result = classical_patterns.scan(
                pd.DataFrame(rows), {**(settings or {}), "bar_duration_ms": step},
            )
            return {
                **result,
                "source": {
                    "venue": "BINANCE", "market_type": "spot", "symbol": symbol,
                    "timeframe": timeframe, "ohlc": "caller_supplied_binance_spot",
                    "as_of": as_of, "closed_bars_analyzed": len(rows),
                    "forming_bars_excluded": excluded,
                },
            }
        except (TypeError, ValueError, OverflowError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    # --- write --------------------------------------------------------

    @app.patch("/api/config")
    async def patch_config(patch: dict[str, Any] = Body(...)) -> dict:
        try:
            doc = svc.config.update(patch)
        except ConfigError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        # A changed timeframe needs only the newly-required pairs; the cache TTL
        # keeps everything already held from being re-fetched. The refresh also
        # drops the cached snapshot, so the next read reflects the new config.
        report = await svc.refresh()
        return {"config": doc, "refresh": report}

    @app.post("/api/refresh")
    async def refresh(force: bool = False) -> dict:
        return await svc.refresh(force=force)

    @app.post("/api/symbols")
    async def add_symbol(payload: dict = Body(...)) -> dict:
        try:
            return await svc.add_symbol(str(payload.get("symbol", "")))
        except (ValueError, ConfigError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.delete("/api/symbols/{base}/{quote}")
    async def remove_symbol(base: str, quote: str) -> dict:
        try:
            return svc.remove_symbol(f"{base.upper()}/{quote.upper()}")
        except (ValueError, ConfigError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    # --- calibration (§6.2) -------------------------------------------

    @app.post("/api/calibrate/{base}/{quote}")
    async def calibrate(base: str, quote: str, with_sr: bool = True) -> dict:
        """Walk-forward calibration for one symbol. Slow (seconds), on demand."""
        try:
            return await svc.calibrate(f"{base.upper()}/{quote.upper()}", with_sr=with_sr)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/api/calibration/{base}/{quote}")
    async def get_calibration(base: str, quote: str) -> dict:
        payload = svc.calibration(f"{base.upper()}/{quote.upper()}")
        if payload is None:
            raise HTTPException(status_code=404, detail="not calibrated")
        return payload

    @app.get("/api/calibrations")
    async def list_calibrations() -> dict:
        return {
            "calibrations": [
                {
                    "symbol": c["symbol"],
                    "timeframe": c.get("timeframe"),
                    "generated_at": c.get("generated_at"),
                    "samples": c.get("samples"),
                    "window_days": (c.get("window") or {}).get("days"),
                    "warnings": len(c.get("warnings", [])),
                    "current": c.get("current", False),
                    "stale": c.get("stale", True),
                    "stale_reason": c.get("stale_reason"),
                }
                for c in svc.calibrations()
            ]
        }

    # --- presets ------------------------------------------------------

    @app.get("/api/presets")
    async def list_presets() -> dict:
        return {"presets": svc.presets()}

    @app.post("/api/presets")
    async def save_preset(payload: dict = Body(...)) -> dict:
        try:
            return svc.save_preset(str(payload.get("name", "")))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/api/presets/{name}/load")
    async def load_preset(name: str) -> dict:
        try:
            return await svc.load_preset(name)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.delete("/api/presets/{name}")
    async def delete_preset(name: str) -> dict:
        try:
            return svc.delete_preset(name)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    return app
