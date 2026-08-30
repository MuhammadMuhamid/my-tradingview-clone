"""FastAPI layer.

Read endpoints serve the cache and never fetch — see `service.ScreenerService`.
The only endpoints that touch the network are the explicit `POST /api/refresh`
and adding a symbol, which has to validate against `load_markets()` before it can
be persisted.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .config import ConfigError
from .service import ScreenerService
from .timeframes import SUPPORTED

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
