#!/usr/bin/env python3
"""
Pretty leaderboard for the TV Autotuner.

  python3 show.py              → leaderboard across all coins
  python3 show.py DEXEUSDT     → best config detail + top-10 ranked results
  python3 show.py DEXEUSDT 3   → full inputs of that coin's rank-3 result
  python3 show.py DEXEUSDT all → every result, ranked by score
  python3 show.py DEXEUSDT dd  → sorted by lowest drawdown (also: wr, pf, net)
"""
import glob
import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))

# ── ANSI colors ───────────────────────────────────────────────────────────────
G, R, Y, C, B, DIM, END = "\033[92m", "\033[91m", "\033[93m", "\033[96m", "\033[1m", "\033[2m", "\033[0m"


def load():
    rows = []
    for f in sorted(glob.glob(os.path.join(HERE, "best", "*.json"))):
        b = json.load(open(f))
        coin = os.path.basename(f)[:-5]
        rf = os.path.join(HERE, "results", coin + ".jsonl")
        evals = sum(1 for _ in open(rf)) if os.path.exists(rf) else 0
        m = b.get("metrics") or {}
        rows.append({"coin": coin, "evals": evals, "score": b.get("score"),
                     "ts": b.get("ts", ""), "params": b.get("params", {}), **m})
    rows.sort(key=lambda r: r["score"] if r["score"] is not None else -1e18, reverse=True)
    return rows


def color_net(v):
    if v is None: return "     —"
    s = f"{v:+8.1f}%"
    return (G if v > 0 else R) + s + END


def medal(i):
    return ["🥇", "🥈", "🥉"][i] if i < 3 else "  "


def leaderboard():
    rows = load()
    if not rows:
        print("No results yet — is the daemon running?  (pgrep -f autotuner)")
        return
    total = sum(r["evals"] for r in rows)
    running = os.popen("pgrep -f 'autotuner.py --daemon' 2>/dev/null").read().strip()
    status = f"{G}● RUNNING{END}" if running else f"{R}○ STOPPED{END}"
    print()
    print(f"{B}{C}  ╔══════════════════════════════════════════════════════════════════════╗{END}")
    print(f"{B}{C}  ║              TV AUTOTUNER — BEST RESULTS LEADERBOARD                 ║{END}")
    print(f"{B}{C}  ╚══════════════════════════════════════════════════════════════════════╝{END}")
    print(f"   Bot: {status}   Total backtests: {B}{total}{END}   "
          f"{DIM}Updated: {datetime.now().strftime('%b %d, %H:%M')}{END}")
    print()
    hdr = f"      {'COIN':<11}{'PROFIT':>9}  {'MAX DD':>7}  {'WIN%':>6}  {'TRADES':>6}  {'PF':>5}  {'TESTS':>5}"
    print(B + hdr + END)
    print("   " + "─" * 66)
    for i, r in enumerate(rows):
        dd = f"{r.get('dd_pct') or 0:6.1f}%"
        wr = f"{r.get('win_rate') or 0:5.1f}%"
        pf = r.get("profit_factor")
        pf_s = (G if (pf or 0) >= 1.5 else Y if (pf or 0) >= 1.0 else R) + f"{pf or 0:5.2f}" + END
        print(f"   {medal(i)} {r['coin']:<11}{color_net(r.get('net_pct'))}  {dd}  {wr}  "
              f"{r.get('trades') or 0:>6}  {pf_s}  {r['evals']:>5}")
    print()
    print(f"   {DIM}PROFIT = net PnL on $1000 start, 100% equity compounding, 0.1% fees{END}")
    print(f"   {DIM}Detail view:  python3 show.py DEXEUSDT      (any coin){END}")
    print(f"   {DIM}⚠ Backtest scores — verify on chart before trading: "
          f"python3 autotuner.py --apply-best COIN{END}")
    print()


def ranked_history(coin: str):
    """All evaluations for a coin, deduped, ranked by score (best first)."""
    rf = os.path.join(HERE, "results", coin + ".jsonl")
    if not os.path.exists(rf):
        return []
    seen, recs = set(), []
    for line in open(rf):
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        g = tuple(r.get("genome") or [])
        if g in seen or r.get("score") is None:
            continue
        seen.add(g)
        recs.append(r)
    recs.sort(key=lambda r: r["score"], reverse=True)
    return recs


def print_record(coin: str, r: dict, title: str):
    m = r.get("metrics") or {}
    print()
    print(f"{B}{C}  ══════ {coin} — {title} ══════{END}")
    print(f"   Found:        {DIM}{r.get('ts','?')}{END}")
    print(f"   Profit:       {color_net(m.get('net_pct'))}   (${m.get('net_usdt','?')} on $1000)")
    print(f"   Max drawdown: {m.get('dd_pct','?')}%")
    print(f"   Win rate:     {m.get('win_rate','?')}%  over {m.get('trades','?')} trades")
    print(f"   Profit factor:{m.get('profit_factor','?')}    Sharpe: {m.get('sharpe','?')}")
    print(f"   Score:        {r.get('score','?')}")
    print()
    print(f"{B}   INPUTS (what to set in the strategy settings):{END}")
    for k, v in (r.get("params") or {}).items():
        print(f"     {k:<20} = {v}")
    print()


SORTS = {
    "dd":     ("MAX DD (lowest first)",      lambda m: m.get("dd_pct") if m.get("dd_pct") is not None else 1e9,   False),
    "wr":     ("WIN RATE (highest first)",   lambda m: m.get("win_rate") or -1,                                    True),
    "pf":     ("PROFIT FACTOR (highest first)", lambda m: m.get("profit_factor") or -1,                            True),
    "net":    ("PROFIT (highest first)",     lambda m: m.get("net_pct") if m.get("net_pct") is not None else -1e9, True),
    "trades": ("TRADES (most first)",        lambda m: m.get("trades") or 0,                                       True),
}


def sorted_view(coin: str, key: str):
    coin = coin.upper().split(":")[-1]
    recs = ranked_history(coin)          # score order → defines the stable rank #
    if not recs:
        print(f"No results for {coin} yet.")
        return
    title, fn, rev = SORTS[key]
    order = sorted(range(len(recs)), key=lambda i: fn(recs[i].get("metrics") or {}), reverse=rev)
    print()
    print(f"{B}{C}  ══════ {coin} — ALL {len(recs)} RESULTS SORTED BY {title} ══════{END}")
    print(f"{B}      {'#':<5}{'PROFIT':>9}  {'MAX DD':>7}  {'WIN%':>6}  {'TRADES':>6}  {'PF':>5}  {'SCORE':>8}{END}")
    print("   " + "─" * 60)
    for i in order:
        r = recs[i]
        m = r.get("metrics") or {}
        pf = m.get("profit_factor") or 0
        print(f"      {i+1:<5}{color_net(m.get('net_pct'))}  {m.get('dd_pct') or 0:6.1f}%  "
              f"{m.get('win_rate') or 0:5.1f}%  {m.get('trades') or 0:>6}  {pf:5.2f}  {r['score']:>8.1f}")
    print()
    print(f"   {DIM}'#' is the stable rank — use it anywhere:  results {coin} 7   |   tuner-apply {coin}:7{END}")
    print()


def detail(coin: str, rank: int | None = None):
    coin = coin.upper().split(":")[-1]
    recs = ranked_history(coin)
    if not recs:
        print(f"No results for {coin} yet. Coins with results: "
              + ", ".join(os.path.basename(x)[:-5] for x in glob.glob(os.path.join(HERE, 'best', '*.json'))))
        return

    if rank is not None and rank != -1:        # specific ranked result
        if not (1 <= rank <= len(recs)):
            print(f"{coin} has {len(recs)} ranked results — pick 1..{len(recs)}")
            return
        print_record(coin, recs[rank - 1], f"RANK #{rank} RESULT")
        print(f"   {DIM}Apply these inputs to the chart:{END}")
        print(f"   {DIM}  pkill -f 'autotuner.py --daemon'   # stop bot first{END}")
        print(f"   {DIM}  python3 autotuner.py --apply-best {coin}:{rank}{END}")
        print()
        return

    # default: best config + ranked table (top 10, or everything with 'all')
    show_all = rank == -1
    if not show_all:
        print_record(coin, recs[0], "BEST CONFIG FOUND")
    n = len(recs) if show_all else min(10, len(recs))
    label = "ALL" if show_all else f"TOP {n}"
    print(f"{B}   {label} RESULTS FOR {coin} (of {len(recs)} unique configs tested):{END}")
    print(f"      {'#':<5}{'PROFIT':>9}  {'MAX DD':>7}  {'WIN%':>6}  {'TRADES':>6}  {'PF':>5}  {'SCORE':>8}")
    print("   " + "─" * 60)
    for i, r in enumerate(recs[:n], 1):
        m = r.get("metrics") or {}
        pf = m.get("profit_factor") or 0
        print(f"      {i:<5}{color_net(m.get('net_pct'))}  {m.get('dd_pct') or 0:6.1f}%  "
              f"{m.get('win_rate') or 0:5.1f}%  {m.get('trades') or 0:>6}  {pf:5.2f}  {r['score']:>8.1f}")
    print()
    print(f"   {DIM}All results:                 results {coin} all{END}")
    print(f"   {DIM}Inputs of a specific rank:   results {coin} 3{END}")
    print(f"   {DIM}Apply best to chart:         tuner-apply {coin}{END}")
    print(f"   {DIM}Apply a specific rank:       tuner-apply {coin}:3{END}")
    print()


if __name__ == "__main__":
    if len(sys.argv) > 2:
        arg = sys.argv[2].lower()
        if arg in SORTS:
            sorted_view(sys.argv[1], arg)
        else:
            detail(sys.argv[1], -1 if arg in ("all", "a") else int(arg))
    elif len(sys.argv) > 1:
        detail(sys.argv[1])
    else:
        leaderboard()
