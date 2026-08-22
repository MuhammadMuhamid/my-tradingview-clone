#!/usr/bin/env python3
"""
Single-pass backtest runner.

Usage:
  python3 run_sim.py --symbol TIAUSDT --test-start 2026-04-13 --test-end 2026-05-15
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from binance_data import fetch_klines, load_csv, save_csv
from feature_bank import FeatureBank
from retest_cache import precompute_retests
from simulate import simulate
from strategy_sim import StrategyParams


TF_MAP     = {"1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h"}
INTERVALS  = ["1m", "5m", "15m", "1h", "4h"]


def parse_date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def today_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def find_or_download(symbol: str, start: str, end: str, data_dir: Path) -> dict[str, Path]:
    paths: dict[str, Path] = {}
    for tf in INTERVALS:
        # Try to reuse any cached file that covers the range
        matches = sorted(data_dir.glob(f"{symbol}_{tf}_*.csv"))
        if matches:
            paths[tf] = matches[-1]
            print(f"  {tf}: cached {matches[-1].name}")
            continue
        fname = data_dir / f"{symbol}_{tf}_{start}_{end}.csv"
        print(f"  Downloading {symbol} {tf} …", end=" ", flush=True)
        start_ms = int(parse_date(start).timestamp() * 1000)
        end_ms   = int(parse_date(end).timestamp()   * 1000)
        df = fetch_klines(symbol, TF_MAP[tf], start_ms, end_ms)
        if df.empty:
            print(f"WARNING: no data")
            continue
        save_csv(df, fname)
        print(f"{len(df)} bars")
        paths[tf] = fname
    return paths


def main() -> None:
    ap = argparse.ArgumentParser(description="SR+Trend v5 single backtest")
    ap.add_argument("--symbol",     required=True)
    ap.add_argument("--test-start", required=True, help="YYYY-MM-DD")
    ap.add_argument("--test-end",   default=None,  help="YYYY-MM-DD (default: today)")
    ap.add_argument("--data-start", default=None,
                    help="Warmup start (default: 3 months before test-start)")
    ap.add_argument("--capital",    type=float, default=1000.0)
    ap.add_argument("--order-usdt", type=float, default=930.0)
    args = ap.parse_args()

    symbol    = args.symbol.upper()
    test_end  = args.test_end or today_str()

    # Auto warmup: 3 months before test start
    if args.data_start:
        data_start = args.data_start
    else:
        ts = parse_date(args.test_start)
        m  = ts.month - 3
        y  = ts.year + (m - 1) // 12
        m  = (m - 1) % 12 + 1
        data_start = f"{y}-{m:02d}-01"

    data_dir = Path("data")
    data_dir.mkdir(parents=True, exist_ok=True)

    # ── 1. Load data ──────────────────────────────────────────────────────────
    print(f"\nSR+Trend v5 Single Backtest — {symbol}")
    print(f"Data range : {data_start} → {test_end}")
    print(f"Test window: {args.test_start} → {test_end}")
    print()
    paths = find_or_download(symbol, data_start, test_end, data_dir)

    frames: dict[str, pd.DataFrame] = {}
    for tf, p in paths.items():
        frames[tf] = load_csv(p)
    if "1m" not in frames:
        frames["1m"] = frames.get("1h", frames["5m"])

    # ── 2. Build params (optimised — 2505-trial search, TIAUSDT Apr-May 2026) ──
    p = StrategyParams(
        # MA trend: 1m×200 SMA + 1h×200 SMA  [locked]
        use_ma_trend=True, ma1_len=200, ma3_len=200,
        # VWMA OFF  [locked]
        use_vwma=False, vwma_len=200,
        # SuperTrend 5m 15/2.5  [locked]
        use_supertrend=True, st_atr_len=15, st_mult=2.5,
        # LinReg 1m len=8  [locked]
        use_linreg=True, lr_tf="1", lr_len=8,
        # Volume filter  [locked]
        use_volume_filter=True, vol_ma_len=100, vol_mult_min=1.0,
        # Extra filters OFF  [locked]
        use_local_trend=False, use_hh_structure=False, require_ma_slope=False,
        # Entry  [optimised]
        touch_atr=1.2, retest_confirm_bars=20, prior_above_lb=1,
        # Pivot lengths  [optimised]
        piv_len_5=13, piv_len_15=13, piv_len_60=7, piv_len_240=9,
        # SL/TP  [optimised]
        atr_len=5, sl_atr=0.6, struct_buff=3.5, tp_r=1.5,
        trail_trigger_r=1.75, trail_atr=3.0, trail_style="ratchet", min_sl_atr=0.2,
        # Fixed  [locked]
        fee_pct=0.05, sl_swing_lb=26, reclaim_pierce_atr=0.5,
        require_bounce=True,
        # Soft exits all OFF  [locked]
        use_exit_below_st=False, use_exit_below_ma1=False, use_exit_below_lr=False,
        # Exit MA: 1h×100 VWMA  [locked]
        use_exit_ma=True, exit_ma_tf="1h", exit_ma_len=100, exit_ma_type="VWMA",
        # HTF break trail (Pine defaults)  [locked]
        use_htf_break_trail=True, htf_res_pivot_len=9,
        htf_break_buf_atr=0.25, htf_trail_atr_mult=1.0, htf_reset_trail_anchor=True,
    )

    # ── 3. Feature bank ────────────────────────────────────────────────────────
    print("\nBuilding features …")
    bank = FeatureBank(frames, search={}, fixed=p)
    d    = bank.build_frame(p)

    # ── 4. Retest mask ────────────────────────────────────────────────────────
    retest_cache = precompute_retests(
        d, [p.touch_atr], [p.prior_above_lb],
        reclaim_pierce_atr=p.reclaim_pierce_atr,
    )
    r_any = retest_cache[(p.touch_atr, p.prior_above_lb)]

    # ── 5. Simulate ────────────────────────────────────────────────────────────
    t0 = pd.Timestamp(args.test_start, tz="UTC")
    t1 = pd.Timestamp(test_end, tz="UTC")
    res = simulate(d, p, t0, t1, capital=args.capital, order_usdt=args.order_usdt,
                   r_any=r_any)

    # ── 6. Print results ───────────────────────────────────────────────────────
    bar = "=" * 52
    print(f"\n{bar}")
    print(f"  {symbol}  |  {args.test_start} → {test_end}")
    print(bar)
    print(f"  Net P&L        : {res.net_pct:+.2f}%  "
          f"(${args.capital * res.net_pct / 100:+.2f})")
    print(f"  Trades         : {res.trades}  "
          f"(W={res.wins}  L={res.losses})")
    print(f"  Win Rate       : {res.win_rate*100:.1f}%")
    print(f"  Profit Factor  : {res.profit_factor:.2f}")
    print(f"  Max Drawdown   : {res.max_dd_pct:.2f}%")
    print(f"  Gross Profit   : ${res.gross_profit:.2f}")
    print(f"  Gross Loss     : ${res.gross_loss:.2f}")
    print(f"  Composite Score: {res.composite_score:.4f}")
    print(bar)


if __name__ == "__main__":
    main()
