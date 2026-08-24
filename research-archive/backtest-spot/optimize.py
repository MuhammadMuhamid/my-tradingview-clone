#!/usr/bin/env python3
"""
SR+Trend v5 — Unified 5-minute strategy optimizer.

EXECUTION TIMEFRAME: 5m (every trade opens/closes at a 5m bar close price).
HTF data (15m, 1h, 4h) is downloaded ONLY to compute indicator filters
(VWMA, MA trend, SuperTrend) that are then aligned forward onto 5m bars.
No trade ever opens or closes on a 1m / 15m / 1h / 4h bar — only on 5m bars.

Usage:
  python optimize.py --symbol APTUSDT

Steps (automatic):
  1. Download 5m / 15m / 1h / 4h from Binance (Oct 2025 → today) unless
     files already exist in ./data/.
  2. Build precomputed indicator feature bank (all indicators aligned to 5m).
  3. Random-search over S/R, risk, and new filter parameters.
  4. Score by composite metric (net%, profit factor, win rate, drawdown).
  5. Print top 20 ranked configs.
  6. Save results/SYMBOL_best.json + results/SYMBOL_pine.txt.

Options:
  --samples N         random samples (default 8000)
  --min-trades N      discard configs with fewer closed trades (default 8)
  --seed N            RNG seed for reproducibility (default 42)
  --data-start DATE   warmup start, YYYY-MM-DD (default 2025-10-01)
  --test-start DATE   actual test start (default 2025-11-01)
  --test-end DATE     test end, default = today
  --out-dir DIR       results folder (default ./results)
  --no-download       skip data download (use existing files)
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

# Local imports
from binance_data import fetch_klines, load_csv, save_csv
from feature_bank import FeatureBank
from pine_map import format_pine_report
from retest_cache import precompute_retests
from simulate import SimResult, simulate
from strategy_sim import StrategyParams

# ─────────────────────────────────────────────────────────────────────────────
# Search space  (all new filters default OFF — enables fair comparison)
# ─────────────────────────────────────────────────────────────────────────────
SEARCH_SPACE: dict[str, list] = {
    # ── S/R structure ────────────────────────────────────────────────────────
    # Wider touch zones + longer confirm windows → more entry opportunities
    "touch_atr":           [0.50, 0.65, 0.75, 0.85, 1.0, 1.2, 1.5],
    "piv_len_5":           [5, 7, 9, 11, 13, 15],
    "piv_len_15":          [7, 9, 11, 13, 15, 17],
    "piv_len_60":          [5, 7, 9, 11],
    "piv_len_240":         [5, 7, 9],
    "retest_confirm_bars": [4, 6, 8, 10, 12, 16, 20, 25],   # 25 = ~2h window
    "prior_above_lb":      [1, 2, 3, 4, 5],
    # ── Risk / exits ─────────────────────────────────────────────────────────
    # Tighter ATR stops = smaller risk per trade = more freq + lower DD
    "atr_len":             [5, 7, 10, 14],
    "sl_atr":              [0.4, 0.5, 0.6, 0.8, 1.0, 1.2],  # 0.4/0.5 new — tighter stops
    "struct_buff":         [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5],
    "tp_r":                [1.5, 1.75, 2.0, 2.25, 2.5, 3.0],
    "trail_trigger_r":     [0.25, 0.5, 0.75, 1.0, 1.25, 1.5],  # 0.25 new
    "trail_atr":           [0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0],
    "trail_style":         ["ratchet", "chandelier"],
    "min_sl_atr":          [0.10, 0.15, 0.20, 0.25],
    # ── MA slope filter ───────────────────────────────────────────────────────
    "require_ma_slope":    [False, True],
    "ma_slope_lb":         [3, 5, 8],
    # ── Local 5m EMA stack ───────────────────────────────────────────────────
    "use_local_trend":     [False, True],
    "local_ema_fast":      [13, 21],
    "local_ema_slow":      [34, 55],
    # ── Volume filter ────────────────────────────────────────────────────────
    "use_volume_filter":   [False, True],
    "vol_ma_len":          [14, 20],
    "vol_mult_min":        [0.8, 1.0, 1.2, 1.5],
    # ── HH structure ─────────────────────────────────────────────────────────
    "use_hh_structure":    [False, True],
    "hh_pivot_len":        [5, 7, 9],
    # ── LinReg ───────────────────────────────────────────────────────────────
    "lr_len":              [5, 6, 8, 10, 12, 15],
}

# Locked filters (not sampled — match your Pine defaults)
# NOTE: lr_tf="5" uses the 5m LinReg (same chart TF as execution).
# This avoids downloading 334k rows of 1m data and is correct for a 5m strategy.
# The 1m×200 MA is approximated by the 5m SMA aligned from 1h data (MA1 = 1h×40 equivalent).
# If you want exact 1m×200 MA, set USE_1M_DATA=True below.
LOCKED = dict(
    ma1_len        = 200,   # 1h × 200 SMA (≈ macro trend; 1m×200 ≈ 1h×40 — use 1h for speed)
    ma3_len        = 400,   # 1h × 400 SMA
    vwma_len       = 200,   # 4h × 200 VWMA
    st_atr_len     = 15,
    st_mult        = 2.5,
    lr_tf          = "5",   # 5m LinReg — same execution TF, no 1m data needed
    use_ma_trend   = True,
    use_vwma       = True,
    use_supertrend = True,
    use_linreg     = True,
    fee_pct        = 0.075,  # 0.05% commission + ~0.025% slippage (2 ticks on 5m)
    sl_swing_lb        = 25,    # matches Pine "Swing low lookback bars" = 25
    reclaim_pierce_atr = 0.05,  # matches Pine "Pierce below support (× ATR) = reclaim block" = 0.05
)

# Set True if you want exact 1m×200 SMA (requires downloading 334k rows of 1m data)
USE_1M_DATA = False


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def today_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def parse_date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def to_ts(s: str) -> pd.Timestamp:
    return pd.Timestamp(s, tz="UTC")


TF_MAP = {"1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h"}
# 1m is optional — only needed when USE_1M_DATA=True for exact 1m×200 SMA
INTERVALS_BASE = ["5m", "15m", "1h", "4h"]
INTERVALS_1M   = ["1m", "5m", "15m", "1h", "4h"]


def find_or_download(symbol: str, start: str, end: str, data_dir: Path) -> dict[str, Path]:
    """Return paths to CSV files, downloading any that are missing."""
    intervals = INTERVALS_1M if USE_1M_DATA else INTERVALS_BASE
    paths: dict[str, Path] = {}
    for tf in intervals:
        fname = data_dir / f"{symbol}_{tf}_{start}_{end}.csv"
        if not fname.exists():
            print(f"  Downloading {symbol} {tf} …", end=" ", flush=True)
            start_ms = int(parse_date(start).timestamp() * 1000)
            end_ms   = int(parse_date(end).timestamp()   * 1000)
            df = fetch_klines(symbol, TF_MAP[tf], start_ms, end_ms)
            if df.empty:
                print(f"WARNING: no data returned for {tf}")
                continue
            save_csv(df, fname)
            print(f"{len(df)} bars → {fname.name}")
        else:
            print(f"  {tf}: using cached {fname.name}")
        paths[tf] = fname
    return paths


def sample_params(rng: random.Random) -> StrategyParams:
    kwargs = {**LOCKED}
    for k, choices in SEARCH_SPACE.items():
        kwargs[k] = rng.choice(choices)
    return StrategyParams(**kwargs)


def frame_key(p: StrategyParams) -> tuple:
    """Retest cache key — only pivot lengths + atr_len affect sup/band columns."""
    return (p.piv_len_5, p.piv_len_15, p.piv_len_60, p.piv_len_240, p.atr_len)


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="SR+Trend v5 optimizer")
    ap.add_argument("--symbol",       required=True, help="e.g. APTUSDT")
    ap.add_argument("--samples",      type=int,   default=5000)
    ap.add_argument("--min-trades",   type=int,   default=8)
    ap.add_argument("--seed",         type=int,   default=42)
    ap.add_argument("--data-start",   default="2025-10-01")
    ap.add_argument("--test-start",   default="2025-11-01")
    ap.add_argument("--test-end",     default=None)
    ap.add_argument("--out-dir",      default="results")
    ap.add_argument("--no-download",  action="store_true")
    args = ap.parse_args()

    symbol    = args.symbol.upper()
    test_end  = args.test_end or today_str()
    data_dir  = Path("data")
    out_dir   = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    intervals = INTERVALS_1M if USE_1M_DATA else INTERVALS_BASE

    print(f"\n{'='*60}")
    print(f"  SR+Trend v5 Optimizer — {symbol}")
    print(f"  Execution TF : 5m  (all trades open/close at 5m bar closes)")
    print(f"  HTF filters  : 15m S/R · 1h MA/S/R · 4h VWMA/S/R (aligned to 5m)")
    print(f"  LinReg       : 5m (same chart TF)")
    print(f"  Data:  {args.data_start} → {test_end}")
    print(f"  Test:  {args.test_start} → {test_end}")
    print(f"  Samples: {args.samples}  |  Min trades: {args.min_trades}")
    print(f"{'='*60}\n")

    # ── 1. Data ──────────────────────────────────────────────────────────────
    if not args.no_download:
        print("[ Step 1 ] Data download / cache check")
        paths = find_or_download(symbol, args.data_start, test_end, data_dir)
    else:
        print("[ Step 1 ] Skipping download (--no-download)")
        paths = {
            tf: next(data_dir.glob(f"{symbol}_{tf}_*.csv"), None)
            for tf in intervals
        }

    missing = [tf for tf, p in paths.items() if p is None]
    if missing:
        sys.exit(f"ERROR: missing data files for timeframes: {missing}")

    frames: dict[str, pd.DataFrame] = {}
    for tf, p in paths.items():
        df = load_csv(p)
        frames[tf] = df
    # For 1m MA computation: if no 1m data, use 1h data as ma1 source
    if "1m" not in frames:
        frames["1m"] = frames["1h"]   # feature_bank will compute 1h×200 SMA as ma1
    print(f"\n  5m bars loaded : {len(frames['5m'])}")
    print(f"  1h bars loaded : {len(frames['1h'])}")
    print(f"  4h bars loaded : {len(frames['4h'])}")

    # ── 2. Feature bank ───────────────────────────────────────────────────────
    print("\n[ Step 2 ] Building indicator feature bank (all indicators aligned to 5m) …")
    t0_build = time.time()
    fixed_seed = StrategyParams(**LOCKED,
        piv_len_5=9, piv_len_15=13, piv_len_60=7, piv_len_240=7, atr_len=7,
        local_ema_fast=21, local_ema_slow=55, vol_ma_len=20, hh_pivot_len=7,
        lr_len=8,
    )
    bank = FeatureBank(frames, SEARCH_SPACE, fixed=fixed_seed)
    print(f"  Bank built in {time.time()-t0_build:.1f}s")

    t0 = to_ts(args.test_start)
    t1 = to_ts(test_end)
    rng = random.Random(args.seed)

    # ── 3. Retest cache per frame ─────────────────────────────────────────────
    # Cache key: only pivot lengths + atr_len (determines sup/band columns).
    # build_frame() is called fresh each sample (~10ms) to avoid stale EMA/vol/HH columns.
    print("\n[ Step 3 ] Precomputing retest masks …")
    retest_cache: dict[tuple, dict] = {}
    touch_vals = SEARCH_SPACE["touch_atr"]
    prior_vals = SEARCH_SPACE["prior_above_lb"]

    def get_retest(p: StrategyParams, d: pd.DataFrame) -> np.ndarray:
        key = frame_key(p)
        if key not in retest_cache:
            retest_cache[key] = precompute_retests(
                d, touch_vals, prior_vals,
                reclaim_pierce_atr=p.reclaim_pierce_atr,
            )
        return retest_cache[key][(p.touch_atr, p.prior_above_lb)]

    # Warm up retest cache for one sample
    warmup_p = sample_params(rng)
    warmup_d = bank.build_frame(warmup_p)
    get_retest(warmup_p, warmup_d)
    rng = random.Random(args.seed)  # reset so seed is deterministic
    print(f"  Retest cache primed ({len(retest_cache)} unique pivot+atr frame(s))")

    # ── 4. Random search ──────────────────────────────────────────────────────
    print(f"\n[ Step 4 ] Random search — {args.samples} samples …")
    rows: list[dict] = []
    t0_search = time.time()

    for n in range(args.samples):
        p  = sample_params(rng)
        d  = bank.build_frame(p)
        r  = simulate(d, p, t0, t1, r_any=get_retest(p, d))

        if r.trades >= args.min_trades:
            rows.append({
                "score":         r.composite_score,
                "net_pct":       round(r.net_pct,       3),
                "win_rate":      round(r.win_rate,       4),
                "profit_factor": round(r.profit_factor,  4),
                "max_dd_pct":    round(r.max_dd_pct,     3),
                "trades":        r.trades,
                "wins":          r.wins,
                "losses":        r.losses,
                "params":        asdict(p),
            })

        if (n + 1) % 1000 == 0:
            elapsed = time.time() - t0_search
            eta     = elapsed / (n + 1) * (args.samples - n - 1)
            print(f"  … {n+1:>6}/{args.samples}  valid={len(rows)}  "
                  f"elapsed={elapsed:.0f}s  eta={eta:.0f}s")

    elapsed_total = time.time() - t0_search
    print(f"\n  Finished {args.samples} samples in {elapsed_total:.1f}s")
    print(f"  Valid configs (≥{args.min_trades} trades): {len(rows)}")

    if not rows:
        sys.exit("No valid configs found. Try reducing --min-trades or widening the date range.")

    # ── 5. Sort & display ────────────────────────────────────────────────────
    rows.sort(key=lambda x: x["score"], reverse=True)

    print(f"\n{'='*80}")
    print(f"  TOP 20  —  {symbol}  |  test {args.test_start} → {test_end}")
    print(f"{'='*80}")
    hdr = f"{'#':<4} {'Score':>8} {'Net%':>8} {'WR%':>7} {'PF':>6} {'DD%':>7} {'Trd':>5}  Key settings"
    print(hdr)
    print("-" * 80)

    for i, row in enumerate(rows[:20], 1):
        p   = StrategyParams(**row["params"])
        flags = []
        if p.require_ma_slope:   flags.append("slope")
        if p.use_local_trend:    flags.append(f"EMA{p.local_ema_fast}/{p.local_ema_slow}")
        if p.use_volume_filter:  flags.append(f"vol×{p.vol_mult_min}")
        if p.use_hh_structure:   flags.append("HH")
        flag_str = " ".join(flags) or "base"
        trail_s  = "chand" if p.trail_style == "chandelier" else "ratch"
        key_str  = (f"tpR={p.tp_r} trT={p.trail_trigger_r} trA={p.trail_atr} "
                    f"sb={p.struct_buff} {trail_s} | {flag_str}")
        print(f"{i:<4} {row['score']:>8.4f} {row['net_pct']:>+7.2f}% "
              f"{row['win_rate']*100:>6.1f}% {row['profit_factor']:>6.2f} "
              f"{row['max_dd_pct']:>6.2f}% {row['trades']:>5}  {key_str}")

    # ── 6. Save results ───────────────────────────────────────────────────────
    best_row    = rows[0]
    best_params = StrategyParams(**best_row["params"])

    json_path  = out_dir / f"{symbol}_best.json"
    pine_path  = out_dir / f"{symbol}_pine.txt"

    payload = {
        "symbol":       symbol,
        "data_start":   args.data_start,
        "test_start":   args.test_start,
        "test_end":     test_end,
        "samples":      args.samples,
        "locked":       LOCKED,
        "search_space": SEARCH_SPACE,
        "best":         best_row,
        "top20":        rows[:20],
        "note": (
            "Soft exits (4h MA cross, ST flip, LinReg, TF1 MA flip) not simulated. "
            "Validate top settings in TradingView before live trading. "
            "Re-run with a different --seed to check stability."
        ),
    }
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    pine_txt = format_pine_report(best_params, symbol=symbol, score=best_row["score"])
    pine_path.write_text(pine_txt, encoding="utf-8")

    print(f"\n{'='*60}")
    print(f"  Results saved:")
    print(f"    JSON  → {json_path}")
    print(f"    Pine  → {pine_path}")
    print(f"\n  BEST CONFIG — Score {best_row['score']:.4f}")
    print(f"    Net%={best_row['net_pct']:+.2f}%  WR={best_row['win_rate']*100:.1f}%  "
          f"PF={best_row['profit_factor']:.2f}  DD={best_row['max_dd_pct']:.2f}%  "
          f"Trades={best_row['trades']}")
    print(f"\n  Key risk settings to apply in TradingView:")
    p = best_params
    print(f"    touchAtrMult={p.touch_atr}  structBuff={p.struct_buff}")
    print(f"    tpR={p.tp_r}  trailTriggerR={p.trail_trigger_r}  "
          f"trailAtrMult={p.trail_atr}  trailStyle={'Chandelier' if p.trail_style=='chandelier' else 'ATR ratchet'}")
    print(f"    retestConfirmBars={p.retest_confirm_bars}  priorAboveLb={p.prior_above_lb}")
    new_flags = []
    if p.require_ma_slope:  new_flags.append(f"requireMaSlope=ON (lb={p.ma_slope_lb})")
    if p.use_local_trend:   new_flags.append(f"useLocalTrend=ON (EMA {p.local_ema_fast}/{p.local_ema_slow})")
    if p.use_volume_filter: new_flags.append(f"useVolumeFilter=ON (×{p.vol_mult_min})")
    if p.use_hh_structure:  new_flags.append(f"useHhStructure=ON (piv {p.hh_pivot_len})")
    if new_flags:
        print(f"    New filters: {', '.join(new_flags)}")
    print(f"{'='*60}\n")

    # Stability hint: count how many of top-10 agree on each new filter
    top10 = rows[:10]
    slope_on  = sum(1 for r in top10 if r["params"]["require_ma_slope"])
    local_on  = sum(1 for r in top10 if r["params"]["use_local_trend"])
    vol_on    = sum(1 for r in top10 if r["params"]["use_volume_filter"])
    hh_on     = sum(1 for r in top10 if r["params"]["use_hh_structure"])
    chand_on  = sum(1 for r in top10 if r["params"]["trail_style"] == "chandelier")
    print(f"  Filter consensus in top-10:")
    print(f"    MA slope ON : {slope_on}/10")
    print(f"    Local EMA ON: {local_on}/10")
    print(f"    Volume ON   : {vol_on}/10")
    print(f"    HH struct ON: {hh_on}/10")
    print(f"    Chandelier  : {chand_on}/10")
    print()


if __name__ == "__main__":
    main()
