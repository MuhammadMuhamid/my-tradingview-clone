#!/usr/bin/env python3
"""
Optimize S/R + risk + LinReg length only. Trend filters FIXED to screenshot defaults.

Constraints: win_rate >= 60%, profit_factor >= 3

  python optimize_morpho.py --symbol MORPHOUSDT \\
      --data-start 2026-04-09 --data-end 2026-05-14 \\
      --test-start 2026-04-09 --test-end 2026-05-14 \\
      --samples 5000
"""

from __future__ import annotations

import argparse
import json
import random
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from binance_data import load_csv
from feature_bank import FeatureBank
from pine_map import format_pine_report
from retest_cache import precompute_retests
from simulate import SimResult, simulate
from strategy_sim import StrategyParams

# Screenshot-locked (never randomized): MA 1m×200 + 1h×400, VWMA 4h×200, ST 5m 15/2.5, LinReg ON @ 1m
SCREENSHOT_BASE = StrategyParams(
    ma1_len=200,
    ma3_len=400,
    vwma_len=200,
    st_atr_len=15,
    st_mult=2.5,
    use_ma_trend=True,
    use_vwma=True,
    use_supertrend=True,
    use_linreg=True,
)

# Search space — S/R, risk, LinReg length (1m)
SEARCH_SPACE: dict = {
    "touch_atr": [0.35, 0.5, 0.65, 0.8, 0.95],
    "piv_len_5": [9, 11, 13, 15],
    "piv_len_15": [13, 16, 19, 22],
    "piv_len_60": [5, 7, 9, 11],
    "piv_len_240": [5, 7, 9, 11],
    "retest_confirm_bars": [3, 5, 8, 10, 12, 15, 18],
    "prior_above_lb": [2, 3, 4, 5, 6, 8],
    "lr_len": [4, 5, 6, 7, 8, 9, 10, 11, 12],
    "atr_len": [5, 7, 10, 14],
    "sl_atr": [0.7, 0.8, 1.0, 1.2, 1.4, 1.6],
    "struct_buff": [2.0, 2.5, 3.25, 4.0, 5.0],
    "tp_r": [1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0],
    "trail_trigger_r": [1.0, 1.25, 1.5, 1.75, 2.0, 2.25],
    "trail_atr": [0.8, 1.0, 1.2, 1.4, 1.6],
    "min_sl_atr": [0.1, 0.15, 0.2, 0.25, 0.35],
}


def parse_date(s: str) -> pd.Timestamp:
    return pd.Timestamp(datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc))


def find_data_files(data_dir: Path, symbol: str, data_start: str, data_end: str) -> dict[str, Path]:
    sym = symbol.upper()
    out = {}
    for interval in ("1m", "5m", "15m", "1h", "4h"):
        exact = data_dir / f"{sym}_{interval}_{data_start}_{data_end}.csv"
        if exact.exists():
            out[interval] = exact
            continue
        matches = sorted(data_dir.glob(f"{sym}_{interval}_*.csv"), key=lambda p: p.stat().st_mtime)
        if not matches:
            raise FileNotFoundError(f"No CSV for {sym} {interval}")
        out[interval] = matches[-1]
    return out


def sample_params(rng: random.Random) -> StrategyParams:
    base = asdict(SCREENSHOT_BASE)
    for k, choices in SEARCH_SPACE.items():
        base[k] = rng.choice(choices)
    return StrategyParams(**base)


def meets_constraints(r: SimResult, min_trades: int, min_wr: float, min_pf: float) -> bool:
    return r.trades >= min_trades and r.win_rate >= min_wr and r.profit_factor >= min_pf


def score(r: SimResult) -> float:
    return r.net_pct + 0.15 * r.win_rate * 100 + 0.1 * min(r.profit_factor, 10) * 10 - 0.25 * r.max_dd_pct


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="MORPHOUSDT")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--data-start", default="2026-04-09")
    ap.add_argument("--data-end", default="2026-05-14")
    ap.add_argument("--test-start", default="2026-04-09")
    ap.add_argument("--test-end", default="2026-05-14")
    ap.add_argument("--samples", type=int, default=5000)
    ap.add_argument("--min-trades", type=int, default=15)
    ap.add_argument("--min-win-rate", type=float, default=0.60)
    ap.add_argument("--min-profit-factor", type=float, default=3.0)
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="results/best_morpho_constrained.json")
    args = ap.parse_args()

    paths = find_data_files(Path(args.data_dir), args.symbol, args.data_start, args.data_end)
    frames = {k: load_csv(v) for k, v in paths.items()}
    print(f"5m bars: {len(frames['5m'])} | {frames['5m'].index.min()} → {frames['5m'].index.max()}")
    print("Fixed filters: MA 1m×200 + 1h×400 | VWMA 4h×200 | ST 5m×15×2.5 | LinReg 1m ON")

    bank = FeatureBank(frames, SEARCH_SPACE, fixed=SCREENSHOT_BASE)
    t0, t1 = parse_date(args.test_start), parse_date(args.test_end)
    rng = random.Random(args.seed)
    frame_cache: dict[tuple, pd.DataFrame] = {}
    retest_bank: dict[tuple, dict[tuple[float, int], np.ndarray]] = {}

    qualified: list[dict] = []
    all_rows: list[dict] = []

    touch_vals = SEARCH_SPACE["touch_atr"]
    prior_vals = SEARCH_SPACE["prior_above_lb"]

    def frame_key(p: StrategyParams) -> tuple:
        return (p.piv_len_5, p.piv_len_15, p.piv_len_60, p.piv_len_240, p.lr_len, p.atr_len)

    def frame_for(p: StrategyParams) -> pd.DataFrame:
        key = frame_key(p)
        if key not in frame_cache:
            d = bank.build_frame(p)
            frame_cache[key] = d
            retest_bank[key] = precompute_retests(d, touch_vals, prior_vals)
        return frame_cache[key]

    def retest_for(p: StrategyParams) -> np.ndarray:
        fk = frame_key(p)
        if fk not in retest_bank:
            frame_for(p)
        return retest_bank[fk][(p.touch_atr, p.prior_above_lb)]

    print(
        f"Searching {args.samples} combos | WR>={args.min_win_rate:.0%} PF>={args.min_profit_factor} "
        f"| trades>={args.min_trades}"
    )
    for n in range(args.samples):
        p = sample_params(rng)
        d = frame_for(p)
        r = simulate(d, p, t0, t1, r_any=retest_for(p))
        row = {
            "net_pct": r.net_pct,
            "trades": r.trades,
            "wins": r.wins,
            "win_rate": r.win_rate,
            "profit_factor": r.profit_factor,
            "max_dd_pct": r.max_dd_pct,
            "score": score(r),
            "qualified": meets_constraints(r, args.min_trades, args.min_win_rate, args.min_profit_factor),
            "params": asdict(p),
        }
        all_rows.append(row)
        if row["qualified"]:
            qualified.append(row)
        if (n + 1) % 500 == 0:
            print(f"  … {n + 1}/{args.samples} | qualified so far: {len(qualified)}")

    qualified.sort(key=lambda x: (x["net_pct"], x["profit_factor"]), reverse=True)
    all_rows.sort(key=lambda x: x["score"], reverse=True)
    pool = qualified if qualified else all_rows

    print(f"\n=== {args.symbol} | {args.test_start} → {args.test_end} ===")
    print(f"Qualified configs: {len(qualified)} / {args.samples}\n")
    print(f"{'#':<4} {'Net%':>8} {'WR%':>7} {'PF':>6} {'Trd':>5} {'DD%':>7}")
    for i, row in enumerate(pool[: args.top], 1):
        print(
            f"{i:<4} {row['net_pct']:>+7.2f}% {row['win_rate']*100:>6.1f}% "
            f"{row['profit_factor']:>6.2f} {row['trades']:>5} {row['max_dd_pct']:>6.2f}"
        )

    best = pool[0]
    best_p = StrategyParams(**best["params"])
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "symbol": args.symbol,
        "test_start": args.test_start,
        "test_end": args.test_end,
        "constraints": {
            "min_win_rate": args.min_win_rate,
            "min_profit_factor": args.min_profit_factor,
            "min_trades": args.min_trades,
        },
        "qualified_count": len(qualified),
        "samples": args.samples,
        "fixed_filters": asdict(SCREENSHOT_BASE),
        "best": best,
        "top_qualified": qualified[: args.top],
        "search_space": SEARCH_SPACE,
    }
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    report_path = out_path.with_suffix(".pine.txt")
    report_path.write_text(format_pine_report(best_p), encoding="utf-8")
    print(f"\nSaved → {out_path}")
    print("\n" + format_pine_report(best_p))
    if not qualified:
        print(
            "\n⚠ No config met WR>=60% AND PF>=3 in this simplified sim. "
            "Best-effort top row shown — verify on TradingView."
        )


if __name__ == "__main__":
    main()
