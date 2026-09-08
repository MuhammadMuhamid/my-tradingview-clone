"""Build the frozen Binance Spot side of the P2 exact-bar differential corpus.

TradingView observations are reviewed manually and merged into the generated
JSON; this script never scrapes or reverse-engineers TradingView. Re-running it
against the fixed end times must reproduce the same source candles and Scene
detections (Binance can occasionally repair historical trades, hence the
recorded SHA-256 per window).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import urllib.parse
import urllib.request

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.indicators import candles as detector  # noqa: E402

PAIRS = [
    ("BTCUSDT", "15m"), ("ETHUSDT", "1h"), ("BNBUSDT", "4h"),
    ("SOLUSDT", "5m"), ("XRPUSDT", "1d"), ("ADAUSDT", "15m"),
    ("DOGEUSDT", "1h"), ("TRXUSDT", "4h"), ("AVAXUSDT", "5m"),
    ("LINKUSDT", "15m"), ("DOTUSDT", "1h"), ("LTCUSDT", "1d"),
    ("BCHUSDT", "4h"), ("NEARUSDT", "5m"), ("UNIUSDT", "15m"),
    ("AAVEUSDT", "1m"),
]
ENDS = [1788883200000, 1786752000000]  # 2026-09-08 and 2026-08-15 16:00 UTC
SCORE_BARS = 240
FETCH_BARS = SCORE_BARS + 80  # detector warm-up precedes every scored bar
INTERVAL_MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000,
               "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
OUT = ROOT / "tests" / "fixtures" / "p2_differential_corpus.json"


def fetch(symbol: str, timeframe: str, end: int) -> list[list]:
    query = urllib.parse.urlencode({
        "symbol": symbol, "interval": timeframe, "limit": FETCH_BARS, "endTime": end - 1,
    })
    request = urllib.request.Request(
        f"https://data-api.binance.vision/api/v3/klines?{query}",
        headers={"User-Agent": "TradingScene-P2-corpus/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def main() -> None:
    windows = []
    for symbol, timeframe in PAIRS:
        for end in ENDS:
            raw = fetch(symbol, timeframe, end)
            bars = [{
                "open_time": int(row[0]), "open": float(row[1]), "high": float(row[2]),
                "low": float(row[3]), "close": float(row[4]), "close_time": int(row[6]),
            } for row in raw]
            frame = pd.DataFrame([{
                "ts": b["open_time"], "open": b["open"], "high": b["high"],
                "low": b["low"], "close": b["close"],
            } for b in bars])
            settings = {"bar_duration_ms": INTERVAL_MS[timeframe]}
            scene = detector.scan(frame, settings)
            score_start = bars[-SCORE_BARS]["open_time"]
            occurrences = [p for p in scene["patterns"] if p["open_time"] >= score_start]
            canonical = json.dumps(bars, sort_keys=True, separators=(",", ":")).encode()
            windows.append({
                "venue": "BINANCE", "market_type": "spot", "symbol": symbol,
                "timeframe": timeframe, "window_end_exclusive": end,
                "ohlc_sha256": hashlib.sha256(canonical).hexdigest(), "bars": bars,
                "settings": scene["settings"], "settings_hash": scene["settings_hash"],
                "detector_version": scene["detector_version"],
                "score_start_open_time": score_start,
                "scene_occurrences": occurrences,
                "tradingview": {
                    "study": "All Patterns", "trend": "SMA50", "direction": "Both",
                    "occurrences": [], "review_status": "pending_exact_bar_review",
                },
                "differential": {
                    "exact_match": [], "tv_only": [],
                    "scene_only": [
                        {"pattern_id": p["id"], "open_time": p["open_time"]}
                        for p in occurrences
                    ],
                    "bar_offset": [], "status": "pending_tradingview_observations",
                },
            })
    payload = {
        "schema_version": 1, "created_at": "2026-09-08T18:00:00Z",
        "source": "Binance Spot public market-data API", "scored_bar_count_per_window": SCORE_BARS,
        "warmup_bar_count_per_window": FETCH_BARS - SCORE_BARS,
        "pair_count": len(PAIRS), "window_count": len(windows),
        "timeframes": sorted({tf for _, tf in PAIRS}),
        "tradingview_catalog_observed_at": detector.CATALOG_OBSERVED_AT,
        "detector_id": detector.DETECTOR_ID, "detector_version": detector.DETECTOR_VERSION,
        "windows": windows,
    }
    # The raw bars dominate this checked-in fixture; compact JSON keeps the
    # frozen corpus reviewable with jq without adding megabytes of whitespace.
    OUT.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(f"wrote {OUT}: {len(PAIRS)} pairs, {len(windows)} windows")


if __name__ == "__main__":
    main()
