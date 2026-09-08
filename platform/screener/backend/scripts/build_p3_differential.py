"""Build P3's frozen classical-pattern corpus from P2's exact Binance bars.

The OHLC source is reused byte-for-byte so P3 adds no network variability and
P2's reviewed source hashes remain independently checkable.  TradingView
observations are filled only from authenticated exact-window review; pending
windows stay explicitly pending.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
from urllib.parse import urlencode
from urllib.request import urlopen

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.indicators import classical  # noqa: E402

SOURCE = ROOT / "tests/fixtures/p2_differential_corpus.json"
TARGET = ROOT / "tests/fixtures/p3_classical_differential_corpus.json"
MARKET_DATA_URL = "https://data-api.binance.vision/api/v3/klines"
BAR_COUNT = 600

CORPUS_BAR_DURATION_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
}


def canonical_hash(value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def fetch_bars(symbol: str, timeframe: str, end_exclusive: int, count: int) -> list[dict]:
    query = urlencode({
        "symbol": symbol, "interval": timeframe, "limit": count,
        "endTime": end_exclusive - 1,
    })
    with urlopen(f"{MARKET_DATA_URL}?{query}", timeout=30) as response:  # noqa: S310
        rows = json.loads(response.read())
    if len(rows) != count:
        raise RuntimeError(f"{symbol} {timeframe}: expected {count} bars, got {len(rows)}")
    return [{
        "open_time": int(row[0]), "open": float(row[1]), "high": float(row[2]),
        "low": float(row[3]), "close": float(row[4]), "close_time": int(row[6]),
    } for row in rows]


def assert_inherited_overlap(old_bars: list[dict], bars: list[dict]) -> None:
    by_time = {row["open_time"]: row for row in bars}
    for old in old_bars:
        fresh = by_time.get(old["open_time"])
        if fresh is None or fresh != old:
            raise RuntimeError(f"P2 overlap changed at {old['open_time']}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh-market-data", action="store_true")
    args = parser.parse_args()
    source = json.loads(SOURCE.read_text())
    cached = json.loads(TARGET.read_text()) if TARGET.exists() else {"windows": []}
    cached_by_key = {
        (window["symbol"], window["timeframe"], window["window_end_exclusive"]): window
        for window in cached["windows"] if len(window.get("bars", [])) == BAR_COUNT
    }
    windows = []
    for old in source["windows"]:
        key = (old["symbol"], old["timeframe"], old["window_end_exclusive"])
        if args.refresh_market_data or key not in cached_by_key:
            # Extend only backwards. P2 froze a point-in-time suffix and one
            # daily window ended during a forming candle whose current Binance
            # close has since changed. Re-fetching the suffix would rewrite the
            # evidence instead of enlarging it.
            old_bars = old["bars"]
            prefix = fetch_bars(
                old["symbol"], old["timeframe"], old_bars[0]["open_time"],
                BAR_COUNT - len(old_bars),
            )
            bars = [*prefix, *old_bars]
        else:
            bars = cached_by_key[key]["bars"]
        assert_inherited_overlap(old["bars"], bars)
        if bars[-len(old["bars"])-1]["close_time"] != old["bars"][0]["open_time"] - 1:
            raise RuntimeError(f"{old['symbol']} {old['timeframe']}: prefix is not contiguous")
        frame = pd.DataFrame({
            "ts": [row["open_time"] for row in bars],
            "open": [row["open"] for row in bars],
            "high": [row["high"] for row in bars],
            "low": [row["low"] for row in bars],
            "close": [row["close"] for row in bars],
        })
        settings = classical.normalized_settings({
            # The inherited P2 research corpus intentionally includes 1m even
            # though the live screener's product registry begins at 5m. Keep
            # this offline duration mapping local rather than widening the API.
            "bar_duration_ms": CORPUS_BAR_DURATION_MS[old["timeframe"]],
        })
        result = classical.scan(frame, settings)
        prior = cached_by_key.get(key)
        preserve_review = prior is not None and prior.get("ohlc_sha256") == canonical_hash(bars)
        windows.append({
            "venue": "BINANCE",
            "market_type": "spot",
            "symbol": old["symbol"],
            "timeframe": old["timeframe"],
            "window_end_exclusive": old["window_end_exclusive"],
            "bars": bars,
            "ohlc_sha256": canonical_hash(bars),
            "ohlc_source": MARKET_DATA_URL,
            "settings": settings,
            "settings_hash": classical.settings_hash(settings),
            "detector_version": classical.DETECTOR_VERSION,
            "scene_patterns": result["patterns"],
            "tradingview": prior["tradingview"] if preserve_review else {
                "review_status": "pending_exact_bar_review",
                "patterns": [],
                "note": "No TradingView detection is inferred from Scene output.",
            },
            "differential": prior["differential"] if preserve_review else {
                "status": "pending_exact_bar_review",
                "anchor_tolerance_bars": 5,
                "matches": [],
                "tv_only": [],
                "scene_only": [],
            },
        })
    document = {
        "schema_version": 1,
        "created_at": "2026-09-08T21:45:00Z",
        "source": "Frozen Binance Spot public OHLC; P2's 320-bar suffix verified byte-for-byte",
        "bars_per_window": BAR_COUNT,
        "pair_count": len({window["symbol"] for window in windows}),
        "window_count": len(windows),
        "bar_count": sum(len(window["bars"]) for window in windows),
        "timeframes": sorted({window["timeframe"] for window in windows}),
        "tradingview_catalog_observed_at": classical.CATALOG_OBSERVED_AT,
        "detector_id": classical.DETECTOR_ID,
        "detector_version": classical.DETECTOR_VERSION,
        "catalog_count": len(classical.CATALOG),
        "windows": windows,
    }
    TARGET.write_text(json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n")
    print(f"wrote {TARGET}: {document['pair_count']} pairs, {document['window_count']} windows, "
          f"{document['bar_count']} bars")


if __name__ == "__main__":
    main()
