#!/usr/bin/env python3
"""
TIAUSDT 5m optimizer — maximize net profit Apr 16 → May 16 2026.

LOCKED (last 4 screenshot groups — not searched):
  MA: 1m×200 + 1h×400, SuperTrend 5m×15×2.5
  LinReg: 5m×9, VWMA: 4h×200 (filters ON)
  Exit MA 4h×100 — Pine only (not in this sim)

  python fetch_data.py --symbol TIAUSDT --start 2026-04-01 --end 2026-05-17 \\
      --intervals 1m,5m,15m,1h,4h

  python optimize_tiausdt.py --samples 4000
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
from optimize_morpho import find_data_files, parse_date, sample_params as _unused
from retest_cache import precompute_retests
from simulate import simulate
from strategy_sim import StrategyParams

# Last-4-image locked trend filters
LOCKED = StrategyParams(
    ma1_len=200,
    ma3_len=400,
    vwma_len=200,
    lr_len=9,
    lr_tf="5",
    st_atr_len=15,
    st_mult=2.5,
    use_ma_trend=True,
    use_vwma=True,
    use_supertrend=True,
    use_linreg=True,
)

# Search only S/R + risk (+ optional MA/ST tweaks NOT in last-4 — keep MA/ST fixed)
TIA_SEARCH: dict = {
    "touch_atr": [0.65, 0.75, 0.85, 0.95, 1.0],
    "piv_len_5": [13, 15, 17, 19],
    "piv_len_15": [13, 15, 17, 19],
    "piv_len_60": [5, 7, 9, 11],
    "piv_len_240": [5, 7, 9, 11],
    "retest_confirm_bars": [8, 10, 12, 13, 15, 18],
    "prior_above_lb": [5, 7, 9, 11, 13],
    "atr_len": [5, 7, 10, 14],
    "sl_atr": [0.8, 1.0, 1.2, 1.4, 1.6],
    "struct_buff": [2.0, 2.5, 3.0, 3.25, 4.0],
    "tp_r": [1.5, 1.75, 2.0, 2.25, 2.5, 3.0],
    "trail_trigger_r": [1.0, 1.25, 1.5, 1.75, 2.0],
    "trail_atr": [0.5, 0.6, 0.8, 1.0, 1.2, 1.4],
    "min_sl_atr": [0.1, 0.15, 0.2, 0.25],
}


def sample_tia(rng: random.Random) -> StrategyParams:
    base = asdict(LOCKED)
    for k, choices in TIA_SEARCH.items():
        base[k] = rng.choice(choices)
    return StrategyParams(**base)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="TIAUSDT")
    ap.add_argument("--data-start", default="2026-04-01")
    ap.add_argument("--data-end", default="2026-05-17")
    ap.add_argument("--test-start", default="2026-04-16")
    ap.add_argument("--test-end", default="2026-05-17")
    ap.add_argument("--samples", type=int, default=4000)
    ap.add_argument("--min-trades", type=int, default=8)
    ap.add_argument("--seed", type=int, default=16)
    ap.add_argument("--out", default="results/best_tiausdt.json")
    args = ap.parse_args()

    paths = find_data_files(Path("data"), args.symbol, args.data_start, args.data_end)
    frames = {k: load_csv(v) for k, v in paths.items()}
    print(f"{args.symbol} 5m: {len(frames['5m'])} bars")

    bank = FeatureBank(frames, TIA_SEARCH, fixed=LOCKED)
    t0, t1 = parse_date(args.test_start), parse_date(args.test_end)
    rng = random.Random(args.seed)
    fc: dict = {}
    rb: dict = {}
    tv, pv = TIA_SEARCH["touch_atr"], TIA_SEARCH["prior_above_lb"]

    def frame_for(p: StrategyParams) -> pd.DataFrame:
        key = (p.piv_len_5, p.piv_len_15, p.piv_len_60, p.piv_len_240, p.atr_len)
        if key not in fc:
            d = bank.build_frame(p)
            fc[key] = d
            rb[key] = precompute_retests(d, tv, pv)
        return fc[key]

    def retest_for(p: StrategyParams) -> np.ndarray:
        key = (p.piv_len_5, p.piv_len_15, p.piv_len_60, p.piv_len_240, p.atr_len)
        if key not in rb:
            frame_for(p)
        return rb[key][(p.touch_atr, p.prior_above_lb)]

    rows: list[dict] = []
    for n in range(args.samples):
        p = sample_tia(rng)
        d = frame_for(p)
        r = simulate(d, p, t0, t1, r_any=retest_for(p))
        if r.trades >= args.min_trades:
            rows.append(
                {
                    "net_pct": r.net_pct,
                    "trades": r.trades,
                    "wins": r.wins,
                    "win_rate": r.win_rate,
                    "profit_factor": r.profit_factor,
                    "max_dd_pct": r.max_dd_pct,
                    "params": asdict(p),
                }
            )
        if (n + 1) % 500 == 0:
            print(f"  … {n + 1}/{args.samples}")

    rows.sort(key=lambda x: x["net_pct"], reverse=True)
    print(f"\n=== {args.symbol} | {args.test_start} → {args.test_end} | {len(rows)} valid configs ===\n")
    print(f"{'#':<4} {'Net%':>8} {'WR%':>7} {'PF':>6} {'Trd':>5} {'DD%':>7}")
    for i, row in enumerate(rows[:20], 1):
        print(
            f"{i:<4} {row['net_pct']:>+7.2f}% {row['win_rate']*100:>6.1f}% "
            f"{row['profit_factor']:>6.2f} {row['trades']:>5} {row['max_dd_pct']:>6.2f}"
        )

    best = rows[0] if rows else None
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "symbol": args.symbol,
        "test_start": args.test_start,
        "test_end": args.test_end,
        "locked_filters": asdict(LOCKED),
        "best": best,
        "top20": rows[:20],
        "search_space": TIA_SEARCH,
        "note": "Confirm on TradingView. Exit MA / requireBounce / cooldown not in sim.",
    }
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"\nSaved → {out}")
    if best:
        p = best["params"]
        print("\n--- Apply to Pine (S/R + risk only) ---")
        for k in TIA_SEARCH:
            print(f"  {k} = {p[k]}")


if __name__ == "__main__":
    main()
