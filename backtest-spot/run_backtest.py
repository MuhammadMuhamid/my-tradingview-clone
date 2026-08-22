#!/usr/bin/env python3
"""Single backtest with full parameter printout (defaults or JSON config)."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from binance_data import load_csv
from feature_bank import FeatureBank
from optimize_morpho import FULL_SEARCH, find_data_files
from pine_map import format_pine_report
from simulate import simulate
from strategy_sim import StrategyParams


def parse_date(s: str) -> pd.Timestamp:
    return pd.Timestamp(datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="MORPHOUSDT")
    ap.add_argument("--data-start", default="2026-04-09")
    ap.add_argument("--data-end", default="2026-05-14")
    ap.add_argument("--test-start", default="2026-04-09")
    ap.add_argument("--test-end", default="2026-05-14")
    ap.add_argument("--config", help="JSON from optimize_morpho.py (uses best.params)")
    args = ap.parse_args()

    paths = find_data_files(Path("data"), args.symbol, args.data_start, args.data_end)
    frames = {k: load_csv(v) for k, v in paths.items()}
    bank = FeatureBank(frames, FULL_SEARCH)

    if args.config:
        data = json.loads(Path(args.config).read_text())
        p = StrategyParams(**data["best"]["params"])
    else:
        p = StrategyParams()

    d = bank.build_frame(p)
    t0, t1 = parse_date(args.test_start), parse_date(args.test_end)
    r = simulate(d, p, t0, t1)

    print(f"\n{args.symbol} {args.test_start} → {args.test_end}")
    print(
        f"Net: {r.net_pct:+.2f}%  Trades: {r.trades}  WR: {r.win_rate*100:.1f}%  "
        f"PF: {r.profit_factor:.2f}  Max DD: {r.max_dd_pct:.2f}%"
    )
    print("\n" + format_pine_report(p))


if __name__ == "__main__":
    main()
