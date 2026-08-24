#!/usr/bin/env python3
"""Original-style demo (15m + 1h). See fetch_data.py + optimize_morpho.py for MORPHOUSDT 5m."""

from __future__ import annotations

import argparse
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import pandas as pd
import requests

BASE = "https://api.binance.com"


def fetch_klines(symbol: str, interval: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    rows = []
    cursor = start_ms
    while cursor < end_ms:
        params = {
            "symbol": symbol.upper(),
            "interval": interval,
            "startTime": cursor,
            "endTime": end_ms,
            "limit": 1000,
        }
        r = requests.get(f"{BASE}/api/v3/klines", params=params, timeout=30)
        r.raise_for_status()
        chunk = r.json()
        if not chunk:
            break
        rows.extend(chunk)
        cursor = int(chunk[-1][0]) + 1
        time.sleep(0.08)

    if not rows:
        return pd.DataFrame()

    cols = [
        "open_time",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "close_time",
        "qav",
        "trades",
        "tb_base",
        "tb_quote",
        "ignore",
    ]
    df = pd.DataFrame(rows, columns=cols)
    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    for c in ["open", "high", "low", "close", "volume"]:
        df[c] = df[c].astype(float)
    df.set_index("open_time", inplace=True)
    return df[["open", "high", "low", "close", "volume"]]


@dataclass
class Params:
    touch_atr: float = 0.85
    sl_atr: float = 0.4
    rr: float = 2.25
    fee_roundtrip: float = 0.001


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="BTCUSDT")
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--start", help="YYYY-MM-DD (overrides --days)")
    ap.add_argument("--end", help="YYYY-MM-DD exclusive")
    args = ap.parse_args()

    if args.start and args.end:
        start = datetime.strptime(args.start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        end = datetime.strptime(args.end, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    else:
        end = datetime.now(timezone.utc)
        start = end - pd.Timedelta(days=args.days)

    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)

    print(f"Downloading {args.symbol} 15m + 1h …")
    df15 = fetch_klines(args.symbol, "15m", start_ms, end_ms)
    df1h = fetch_klines(args.symbol, "1h", start_ms, end_ms)
    print(f"15m bars: {len(df15)}, 1h bars: {len(df1h)}")
    print("For SR+Trend v5 on 5m use: fetch_data.py + optimize_morpho.py")


if __name__ == "__main__":
    main()
