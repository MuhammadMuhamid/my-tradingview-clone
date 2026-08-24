#!/usr/bin/env python3
"""Print the 5m MTF Confluence Lean leaderboard straight from best/*.json.

    python3 optimizer1y5m/leaderboard.py                 # ranked table
    python3 optimizer1y5m/leaderboard.py ZECUSDT         # winning params for one coin
    python3 optimizer1y5m/leaderboard.py --sort net      # sort by net% instead of score
    python3 optimizer1y5m/leaderboard.py --min-trades 50 # hide thin, low-evidence configs
"""
from __future__ import annotations

import glob
import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
KEYS = {"score": "score", "net": "net_pct", "dd": "dd_pct", "wr": "win_rate",
        "trades": "trades", "pf": "profit_factor",
        # out-of-sample: never seen by the optimiser
        "oos": "oos_net_pct", "oosdd": "oos_dd_pct", "ooswr": "oos_win_rate",
        "oostrades": "oos_trades", "oospf": "oos_profit_factor",
        # share of entries STOPPED OUT AT A LOSS (not merely "the stop filled":
        # a trailing/BE stop books a profitable exit as SL)
        "sl": "sl_loss_rate", "oossl": "oos_sl_loss_rate"}


def rows(min_trades: int = 0) -> list[dict]:
    out = []
    for path in glob.glob(os.path.join(HERE, "best", "*.json")):
        try:
            with open(path) as fh:
                rec = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        m = rec.get("metrics") or {}
        if (m.get("trades") or 0) < min_trades:
            continue
        out.append(rec)
    return out


def evals_per_coin() -> dict[str, int]:
    counts = {}
    for path in glob.glob(os.path.join(HERE, "results", "*.jsonl")):
        coin = os.path.basename(path)[:-6]
        with open(path, "rb") as fh:
            counts[coin] = sum(chunk.count(b"\n") for chunk in iter(lambda: fh.read(8 << 20), b""))
    return counts


def show_table(sort: str, min_trades: int) -> None:
    recs = rows(min_trades)
    key = KEYS.get(sort, "score")
    reverse = key != "dd_pct"          # drawdown: lower is better

    def val(r):
        v = r["score"] if key == "score" else (r.get("metrics") or {}).get(key)
        return v if v is not None else (float("inf") if not reverse else float("-inf"))

    recs.sort(key=val, reverse=reverse)
    counts = evals_per_coin()
    total = sum(counts.values())

    cfg = {}
    try:
        with open(os.path.join(HERE, "config.json")) as fh:
            cfg = json.load(fh)
    except OSError:
        pass
    rng = cfg.get("range", {})
    print(f"MTF Confluence Lean · {cfg.get('timeframe', '5m')} · {rng.get('start', '?')[:10]} → {rng.get('end', '?')}")
    print(f"{total:,} backtests across {len(recs)} coins"
          + (f"   (min-trades filter: {min_trades})" if min_trades else "")
          + f"   sorted by {sort}\n")

    hdr = (f"{'#':>2} {'COIN':13s}{'score':>9s}{'net%':>10s}{'dd%':>8s}{'wr%':>7s}{'trades':>8s}{'pf':>7s}{'SLloss%':>9s}"
           f"  |{'OOSnet%':>9s}{'OOSdd%':>8s}{'OOSwr%':>8s}{'OOStr':>7s}{'OOSSLl%':>9s}{'HOLD?':>8s}{'evals':>9s}")
    print(hdr)
    print("-" * len(hdr))
    for i, r in enumerate(recs, 1):
        m = r.get("metrics") or {}
        pf = m.get("profit_factor")
        onet = m.get("oos_net_pct")
        # HOLD? is the honesty column: did the in-sample edge survive on data the
        # optimiser never saw? Green in-sample and red out-of-sample = curve fit.
        if onet is None:                              hold = "n/a"
        elif (m.get("net_pct") or 0) > 0 and onet > 0: hold = "HELD"
        elif (m.get("net_pct") or 0) > 0 >= onet:      hold = "FAILED"
        else:                                          hold = "weak"
        sl = m.get("sl_loss_rate")
        osl = m.get("oos_sl_loss_rate")
        oos = (f"  |{onet:9.1f}{(m.get('oos_dd_pct') or 0):8.1f}"
               f"{(m.get('oos_win_rate') or 0):8.1f}{(m.get('oos_trades') or 0):7d}"
               f"{(osl if osl is not None else 0):9.1f}"
               if onet is not None else f"  |{'—':>9}{'—':>8}{'—':>8}{'—':>7}{'—':>9}")
        print(f"{i:>2} {r['symbol']:13s}"
              f"{(r.get('score') or 0):9.1f}"
              f"{(m.get('net_pct') or 0):10.1f}"
              f"{(m.get('dd_pct') or 0):8.1f}"
              f"{(m.get('win_rate') or 0):7.1f}"
              f"{(m.get('trades') or 0):8d}"
              f"{(pf if pf is not None else 0):7.2f}"
              f"{(sl if sl is not None else 0):9.1f}"
              f"{oos}{hold:>8s}"
              f"{counts.get(r['symbol'], 0):9,d}")

    stale = [r for r in recs if (r.get("metrics") or {}).get("trades", 0) < 30]
    if stale and not min_trades:
        names = ", ".join(r["symbol"] for r in stale)
        print(f"\n  note: thin sample (<30 trades) — {names}")
        print("        re-run with --min-trades 50 to hide low-evidence configs.")


def show_coin(coin: str) -> None:
    path = os.path.join(HERE, "best", f"{coin.upper()}.json")
    if not os.path.exists(path):
        print(f"no best record for {coin.upper()}")
        return
    with open(path) as fh:
        rec = json.load(fh)
    m = rec.get("metrics") or {}
    ts = rec.get("ts", "")
    print(f"{rec['symbol']}  score={rec.get('score')}  found {ts}")
    print(f"  net={m.get('net_pct')}%  dd={m.get('dd_pct')}%  wr={m.get('win_rate')}%  "
          f"trades={m.get('trades')}  pf={m.get('profit_factor')}  "
          f"stopped@loss={m.get('sl_loss_rate')}%  stopped@gain={m.get('sl_profit_rate')}%\n")
    if m.get("oos_net_pct") is not None:
        print(f"  OUT-OF-SAMPLE (never seen by the search):")
        print(f"    net={m.get('oos_net_pct')}%  dd={m.get('oos_dd_pct')}%  "
              f"wr={m.get('oos_win_rate')}%  trades={m.get('oos_trades')}  pf={m.get('oos_profit_factor')}  "
              f"stopped@loss={m.get('oos_sl_loss_rate')}%\n")
    print("  winning tunables (everything else is base_params.json):")
    for k, v in sorted((rec.get("params") or {}).items()):
        print(f"    {k:22s} {v}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:]]
    sort = "score"
    min_trades = 0
    if "--sort" in args:
        i = args.index("--sort")
        sort = args[i + 1]
        del args[i:i + 2]
    if "--min-trades" in args:
        i = args.index("--min-trades")
        min_trades = int(args[i + 1])
        del args[i:i + 2]
    if args:
        show_coin(args[0])
    else:
        show_table(sort, min_trades)
