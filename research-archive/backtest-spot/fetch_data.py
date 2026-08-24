#!/usr/bin/env python3
"""
Download Binance Spot OHLCV for backtesting.

Example — MORPHOUSDT, Apr 9–13 2026 (5m chart + HTF filters need warmup):
  python fetch_data.py --symbol MORPHOUSDT --start 2026-04-01 --end 2026-04-14 \\
      --intervals 1m,5m,15m,1h,4h

Test window only (after you already have warmup files):
  python fetch_data.py --symbol MORPHOUSDT --start 2026-04-09 --end 2026-04-14 --intervals 5m
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

from binance_data import fetch_klines, save_csv

TF_MAP = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "60m": "1h",
    "4h": "4h",
    "240m": "4h",
}


def parse_date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def main() -> None:
    ap = argparse.ArgumentParser(description="Download Binance klines to CSV")
    ap.add_argument("--symbol", default="MORPHOUSDT")
    ap.add_argument("--start", required=True, help="YYYY-MM-DD (UTC)")
    ap.add_argument("--end", required=True, help="YYYY-MM-DD exclusive end (UTC)")
    ap.add_argument(
        "--intervals",
        default="1m,5m,15m,1h,4h",
        help="Comma-separated: 1m,5m,15m,1h,4h",
    )
    ap.add_argument(
        "--out-dir",
        default="data",
        help="Output folder (default: ./data)",
    )
    args = ap.parse_args()

    start_ms = int(parse_date(args.start).timestamp() * 1000)
    end_ms = int(parse_date(args.end).timestamp() * 1000)
    out = Path(args.out_dir)
    symbol = args.symbol.upper()

    for raw in args.intervals.split(","):
        key = raw.strip().lower()
        if key not in TF_MAP:
            raise SystemExit(f"Unknown interval: {raw}")
        interval = TF_MAP[key]
        print(f"Downloading {symbol} {interval} …")
        df = fetch_klines(symbol, interval, start_ms, end_ms)
        if df.empty:
            print(f"  WARNING: no rows for {interval}")
            continue
        fname = out / f"{symbol}_{interval}_{args.start}_{args.end}.csv"
        save_csv(df, fname)
        print(f"  saved {len(df)} bars → {fname}")


if __name__ == "__main__":
    main()
