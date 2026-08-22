#!/usr/bin/env python3
"""
Download APTUSDT multi-timeframe OHLCV data from Binance (via ccxt).

Saves:
  data/APTUSDT_5m.csv   — 5-minute bars  (execution TF)
  data/APTUSDT_15m.csv  — 15-minute bars (S/R pivot TF)
  data/APTUSDT_1h.csv   — 1-hour bars    (MA / S/R TF)
  data/APTUSDT_4h.csv   — 4-hour bars    (VWMA / S/R TF)

Usage:
    pip install ccxt pandas
    python download_data.py
    python download_data.py --symbol BTCUSDT --start 2026-01-01 --end 2026-05-22
"""

import argparse
import os
import time
from datetime import datetime, timezone

import ccxt
import pandas as pd


# ── Default parameters ─────────────────────────────────────────────────────
SYMBOL     = "APT/USDT"
# Start earlier than backtest window so HTF indicators (e.g. 4h×200 VWMA)
# have enough bars to warm up before the test period begins.
DATA_START = "2025-09-01"
TEST_END   = "2026-05-23"   # exclusive (covers through May 22)
OUT_DIR    = "data"

TIMEFRAMES = ["5m", "15m", "1h", "4h"]
LIMIT      = 1000  # bars per request (Binance max = 1000)


# ── Core downloader ────────────────────────────────────────────────────────

def fetch_ohlcv(exchange: ccxt.Exchange, symbol: str, tf: str,
                start_str: str, end_str: str) -> pd.DataFrame:
    since  = int(datetime.strptime(start_str, "%Y-%m-%d")
                 .replace(tzinfo=timezone.utc).timestamp() * 1000)
    end_ms = int(datetime.strptime(end_str, "%Y-%m-%d")
                 .replace(tzinfo=timezone.utc).timestamp() * 1000)

    rows: list = []
    while since < end_ms:
        batch = exchange.fetch_ohlcv(symbol, tf, since=since, limit=LIMIT)
        if not batch:
            break
        rows.extend(batch)
        last_ts = batch[-1][0]
        since   = last_ts + 1
        print(f"  [{tf}]  {len(rows):>7,} bars  "
              f"last={pd.Timestamp(last_ts, unit='ms').strftime('%Y-%m-%d %H:%M')}")
        time.sleep(exchange.rateLimit / 1000)

    df = pd.DataFrame(rows, columns=["timestamp", "open", "high", "low", "close", "volume"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
    df = df[df["timestamp"] < end_str].copy()
    df = df.drop_duplicates("timestamp").sort_values("timestamp").reset_index(drop=True)
    return df


# ── Entry point ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Download OHLCV data from Binance")
    parser.add_argument("--symbol",     default=SYMBOL,      help="ccxt symbol, e.g. APT/USDT")
    parser.add_argument("--start",      default=DATA_START,   help="YYYY-MM-DD start date")
    parser.add_argument("--end",        default=TEST_END,     help="YYYY-MM-DD end date (exclusive)")
    parser.add_argument("--timeframes", default=",".join(TIMEFRAMES),
                        help="Comma-separated timeframes, e.g. 5m,1h,4h")
    args = parser.parse_args()

    tfs = [t.strip() for t in args.timeframes.split(",")]
    os.makedirs(OUT_DIR, exist_ok=True)

    exchange = ccxt.binance({"enableRateLimit": True})
    safe_sym = args.symbol.replace("/", "")

    for tf in tfs:
        print(f"\nDownloading {args.symbol}  [{tf}]  {args.start} → {args.end} …")
        df  = fetch_ohlcv(exchange, args.symbol, tf, args.start, args.end)
        out = os.path.join(OUT_DIR, f"{safe_sym}_{tf}.csv")
        df.to_csv(out, index=False)
        print(f"  Saved {len(df):,} bars → {out}")

    print("\nDone.")


if __name__ == "__main__":
    main()
