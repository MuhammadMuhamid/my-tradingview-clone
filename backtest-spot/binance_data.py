"""Download Binance Spot klines and save to CSV."""

from __future__ import annotations

import time
from pathlib import Path

import pandas as pd
import requests

BASE = "https://api.binance.com"


def fetch_klines(
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
    max_retries: int = 5,
) -> pd.DataFrame:
    rows: list = []
    cursor = start_ms
    while cursor < end_ms:
        params = {
            "symbol": symbol.upper(),
            "interval": interval,
            "startTime": cursor,
            "endTime": end_ms,
            "limit": 1000,
        }
        for attempt in range(max_retries):
            try:
                r = requests.get(f"{BASE}/api/v3/klines", params=params, timeout=30)
                r.raise_for_status()
                chunk = r.json()
                break
            except Exception as exc:
                if attempt == max_retries - 1:
                    raise
                wait = 2 ** attempt
                print(f"\n  Retry {attempt+1}/{max_retries} after error ({exc}) — waiting {wait}s …")
                time.sleep(wait)
        if not chunk:
            break
        rows.extend(chunk)
        cursor = int(chunk[-1][0]) + 1
        time.sleep(0.12)

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
    df = df.set_index("open_time")
    return df[["open", "high", "low", "close", "volume"]]


def save_csv(df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path)


def load_csv(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["open_time"], index_col="open_time")
    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC")
    return df


INTERVAL_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
}
