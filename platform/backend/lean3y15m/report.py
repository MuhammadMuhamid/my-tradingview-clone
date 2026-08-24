#!/usr/bin/env python3
"""3-year leaderboard for the top-1000 MTF Confluence Lean 15m configs per coin.

Same interface as `lean15m-results` / `opt1hyear-results`:

    lean3y-results                    ranked coin table
    lean3y-results ZECUSDT            top 10 by overall score
    lean3y-results ZECUSDT net        top 500 by profit
    lean3y-results ZECUSDT dd         ... by lowest drawdown
    lean3y-results ZECUSDT wr         ... by win rate
    lean3y-results ZECUSDT pf         ... by profit factor
    lean3y-results ZECUSDT trades     ... by trade count
    lean3y-results ZECUSDT oos        ... by OUT-OF-SAMPLE profit  (extra mode)
    lean3y-results ZECUSDT best       balanced: DD + NET + WR + PF
    lean3y-results ZECUSDT 7          full record + inputs for rank #7
    lean3y-results --md out.md        markdown export

Window 2023-08-01 (or listing date) -> today. Account $1000, FIXED $1000 per
trade — no compounding, no leverage, so PROFIT reads as growth on $1000.

OOS = the part of the window before 2025-07-20, which the optimizer never saw.
Everything after that date is the year these configs were selected on, so it is
in-sample and flattering. ORIG# is the config's rank in the lean 15m leaderboard.
"""
from __future__ import annotations
import glob, json, os, sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
CFG = json.load(open(os.path.join(HERE, "config.json")))
SPLIT = CFG["splitDate"][:10]

G, R, Y, C, B, DIM, END = ("\033[92m", "\033[91m", "\033[93m", "\033[96m",
                           "\033[1m", "\033[2m", "\033[0m")
CMD = "lean3y-results"
APPLY = "lean3y-apply"


def color_net(v):
    if v is None:
        return "     —"
    return (G if v > 0 else R) + f"{v:+8.1f}%" + END


def load_coin(coin):
    f = os.path.join(OUT, coin.upper() + ".jsonl")
    if not os.path.exists(f):
        return []
    rows = []
    for line in open(f):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (r.get("holdout") or {}).get("net_pct") is not None:
            rows.append(r)
    return rows


def all_coins():
    return [os.path.basename(p)[:-6] for p in sorted(glob.glob(os.path.join(OUT, "*.jsonl")))]


def h(r, k, d=0):
    v = r["holdout"].get(k)
    return d if v is None else v


def print_record(coin, r, title):
    hd = r["holdout"]
    print(f"\n{B}{C}  ══════ {coin} — {title} ══════{END}")
    print(f"   lean15m rank:   {DIM}ORIG#{r['rank']}  "
          f"(in-sample net {r['in_sample']['net']:+.0f}%, pf {r['in_sample']['pf']}){END}")
    print(f"   Profit:       {color_net(hd.get('net_pct'))}   (${1000 + hd.get('net_usdt', 0):,.0f} from $1,000)")
    print(f"   {B}Out-of-sample:{END}{color_net(hd.get('oos_net_pct'))}   "
          f"{DIM}{hd.get('oos_trades') or 0} trades, win {hd.get('oos_win_rate') or 0:.1f}% "
          f"— before {SPLIT}, unseen{END}")
    print(f"   In-sample:    {color_net(hd.get('is_net_pct'))}   "
          f"{DIM}{hd.get('is_trades') or 0} trades, win {hd.get('is_win_rate') or 0:.1f}% "
          f"— the fitted year{END}")
    print(f"   Max drawdown: {hd.get('dd_pct', 0):.1f}%")
    legs = hd.get("legs")
    legnote = ""
    if legs and hd.get("trades") and legs > hd["trades"] * 1.5:
        legnote = f"  {Y}(win% is per exit-leg: {legs} legs from {hd['trades']} entries — partial TPs inflate it){END}"
    print(f"   Win rate:     {hd.get('win_rate') or 0:.1f}% over {hd.get('trades', 0)} entries{legnote}")
    print(f"   Profit factor:{hd.get('profit_factor') or 0:.2f}   Buy & hold: {hd.get('buy_hold_pct') or 0:+.1f}%\n")
    print(f"{B}   INPUTS:{END}")
    for k, v in (r.get("params") or {}).items():
        print(f"     {k:<24} = {v}")
    print()


ORDERS = {
    "net":    ("PROFIT (highest first)",        lambda r: -h(r, "net_pct")),
    "oos":    ("OUT-OF-SAMPLE PROFIT (highest first)", lambda r: -h(r, "oos_net_pct")),
    "dd":     ("MAX DD (lowest first)",         lambda r: h(r, "dd_pct", 1e9)),
    "wr":     ("WIN RATE (highest first)",      lambda r: -h(r, "win_rate")),
    "pf":     ("PROFIT FACTOR (highest first)", lambda r: -h(r, "profit_factor")),
    "trades": ("TRADES (most first)",           lambda r: -h(r, "trades")),
}


def balanced(rows):
    """DD + NET + WR + PF percentile blend — same idea as the `best` mode."""
    n = len(rows)
    def pr(key, rev):
        order = sorted(range(n), key=lambda i: h(rows[i], key), reverse=rev)
        out = [0.0] * n
        for pos, i in enumerate(order):
            out[i] = 1 - (pos / (n - 1) if n > 1 else 0)
        return out
    dd, net, wr, pf = pr("dd_pct", False), pr("net_pct", True), pr("win_rate", True), pr("profit_factor", True)
    combo = [dd[i] + net[i] + wr[i] + pf[i] for i in range(n)]
    return [rows[i] for i in sorted(range(n), key=lambda i: -combo[i])]


def coin_table(sort_mode):
    coins = all_coins()
    if not coins:
        print("no results yet — run lean3y-run")
        return
    rows, total = [], 0
    keyfn = ORDERS.get(sort_mode, ORDERS["net"])[1]
    for coin in coins:
        rs = load_coin(coin)
        if not rs:
            continue
        total += len(rs)
        best = sorted(rs, key=keyfn)[0]
        med_oos = sorted(rs, key=lambda r: h(r, "oos_net_pct"))[len(rs) // 2]
        rows.append((coin, best, med_oos, len(rs)))
    rows.sort(key=lambda t: -h(t[1], "net_pct"))

    label = ORDERS.get(sort_mode, ORDERS["net"])[0]
    print(f"\n{B}{C}  ══════ MTF LEAN 15m — THREE-YEAR TEST — TOP {CFG['topN']} CONFIGS PER COIN ══════{END}")
    print(f"   Window: {B}{CFG['holdoutStart'][:10]} → {CFG['holdoutEnd'][:10]}{END}   "
          f"Configs tested: {B}{total:,}{END}   Updated: {datetime.now():%b %d, %H:%M}")
    print(f"   Sizing: {B}${CFG['qtyCash']:,} fixed per trade{END} on a $1,000 account "
          f"{DIM}(no compounding){END}   Coin row = best by {label.split(' (')[0]}")
    print(f"   {DIM}ORIG# = that config's rank in lean15m-results (1..{CFG['topN']}).  "
          f"OOS = profit before {SPLIT}, unseen by the optimizer.{END}")
    print(f"   {DIM}MED# / MED-OOS = the median config by OOS profit — the honest representative "
          f"of all {CFG['topN']}.{END}")
    print(f"{B}      {'COIN':<13}{'ORIG#':>6}  {'PROFIT':>9}  {'OOS':>9}  {'MED#':>5}  {'MED-OOS':>9}  "
          f"{'MAX DD':>7}  {'WIN%':>6}  {'TRADES':>6}  {'PF':>5}  {'$1000→':>9}{END}")
    for coin, best, med, n in rows:
        hd = best["holdout"]
        print(f"      {coin:<13}{best['rank']:>6}  {color_net(hd.get('net_pct'))}  "
              f"{color_net(hd.get('oos_net_pct'))}  {med['rank']:>5}  {color_net(h(med, 'oos_net_pct'))}  "
              f"{hd.get('dd_pct', 0):6.1f}%  {hd.get('win_rate') or 0:5.1f}%  {hd.get('trades', 0):6}  "
              f"{hd.get('profit_factor') or 0:5.2f}  {'$' + format(1000 + hd.get('net_usdt', 0), ',.0f'):>9}")
    print(f"\n   {DIM}Detail: {CMD} COIN [net|oos|dd|wr|pf|trades|best|RANK#]   "
          f"|   Apply: {APPLY} COIN  (uses MED#){END}")
    print(f"   {DIM}Inputs for any ORIG#: {CMD} COIN oos   then   {CMD} COIN RANK#{END}\n")


def coin_view(coin, mode):
    rows = load_coin(coin)
    if not rows:
        print(f"No results for {coin}. Run lean3y-run first.")
        return
    n = len(rows)

    if mode and mode.isdigit():
        rank = int(mode)
        ordered = sorted(rows, key=lambda r: -h(r, "net_pct"))
        if not 1 <= rank <= n:
            print(f"{coin} has {n} tested configs — pick 1..{n}")
            return
        print_record(coin, ordered[rank - 1], f"RANK #{rank} BY PROFIT")
        print(f"   {DIM}Apply: {APPLY} {coin}{END}\n")
        return

    if mode in ("best", "balanced", "combo"):
        ordered = balanced(rows)[:500]
        label = "BALANCED (DD + NET + WR + PF)"
    elif mode in ORDERS:
        label, keyfn = ORDERS[mode]
        ordered = sorted(rows, key=keyfn)[:500]
    else:
        label = "PROFIT"
        ordered = sorted(rows, key=lambda r: -h(r, "net_pct"))[:10]

    bh = h(rows[0], "buy_hold_pct")
    med_oos = sorted(rows, key=lambda r: h(r, "oos_net_pct"))[n // 2]
    print(f"\n{B}{C}  ══════ {coin} — TOP {len(ordered)} BY {label} ══════{END}")
    print(f"   {DIM}{n} configs tested over {CFG['holdoutStart'][:10]} → {CFG['holdoutEnd'][:10]}   "
          f"buy & hold {bh:+.1f}%{END}")
    print(f"{B}      {'#':<5}{'ORIG#':<8}{'PROFIT':>9}  {'OOS':>9}  {'MAX DD':>7}  "
          f"{'WIN%':>6}  {'TRADES':>6}  {'PF':>5}  {'$1000→':>9}{END}")
    for i, r in enumerate(ordered, 1):
        hd = r["holdout"]
        print(f"      {i:<5}{r['rank']:<8}{color_net(hd.get('net_pct'))}  {color_net(hd.get('oos_net_pct'))}  "
              f"{hd.get('dd_pct', 0):6.1f}%  {hd.get('win_rate') or 0:5.1f}%  {hd.get('trades', 0):6}  "
              f"{hd.get('profit_factor') or 0:5.2f}  {'$' + format(1000 + hd.get('net_usdt', 0), ',.0f'):>9}")
    print(f"\n   {Y}Recommended: ORIG#{med_oos['rank']}{END} — the median config by out-of-sample profit "
          f"({h(med_oos, 'oos_net_pct'):+.1f}% OOS, {h(med_oos, 'net_pct'):+.1f}% total).")
    print(f"   {DIM}Top rows are the luckiest of {n} draws; the median is the honest representative.{END}")
    print(f"   {DIM}Inputs: {CMD} {coin} RANK#   |   Apply: {APPLY} {coin}{END}\n")


def apply_map(coin):
    rows = load_coin(coin)
    if not rows:
        print(f"no results for {coin}")
        return
    med = sorted(rows, key=lambda r: h(r, "oos_net_pct"))[len(rows) // 2]
    space = json.load(open(os.path.join(HERE, "..", "lean_optimizer15m", "params.json")))
    idmap = {p["name"]: p["id"] for p in space["parameters"]}
    hd = med["holdout"]
    print(f"\n{B}{C}  ══════ {coin} — OOS-MEDIAN CONFIG (ORIG#{med['rank']}) ══════{END}")
    print(f"   Profit {color_net(hd.get('net_pct'))}   OOS {color_net(hd.get('oos_net_pct'))}   "
          f"dd {hd.get('dd_pct', 0):.1f}%   pf {hd.get('profit_factor') or 0:.2f}   {hd.get('trades', 0)} trades\n")
    print(json.dumps({idmap[k]: v for k, v in med["params"].items() if k in idmap}, indent=1))
    print()


def markdown(path):
    L = [f"# Three-Year Test — top {CFG['topN']} configs per coin", "",
         f"Window {CFG['holdoutStart'][:10]} → {CFG['holdoutEnd'][:10]}. "
         f"$1,000 account, fixed ${CFG['qtyCash']:,} per trade.", "",
         f"OOS = before {SPLIT} (unseen). After that is the fitted year.", "",
         "| Coin | Best PROFIT | its OOS | Median OOS | % OOS profitable | Buy & hold | $1000 → |",
         "|---|---|---|---|---|---|---|"]
    for coin in all_coins():
        rs = load_coin(coin)
        if not rs:
            continue
        best = sorted(rs, key=lambda r: -h(r, "net_pct"))[0]
        med = sorted(rs, key=lambda r: h(r, "oos_net_pct"))[len(rs) // 2]
        prof = 100 * sum(1 for r in rs if h(r, "oos_net_pct") > 0) / len(rs)
        L.append(f"| {coin} | {h(best,'net_pct'):+.0f}% | {h(best,'oos_net_pct'):+.0f}% | "
                 f"**{h(med,'oos_net_pct'):+.0f}%** | {prof:.0f}% | {h(rs[0],'buy_hold_pct'):+.0f}% | "
                 f"${1000 + h(best,'net_usdt'):,.0f} |")
    open(path, "w").write("\n".join(L))
    print(f"written {path}")


def main():
    args = sys.argv[1:]
    if "--md" in args:
        markdown(args[args.index("--md") + 1]); return
    if "--apply" in args:
        i = args.index("--apply")
        apply_map(args[i + 1].upper().split(":")[-1]); return
    if "--sort" in args:
        i = args.index("--sort")
        coin_table(args[i + 1].lower()); return
    if not args:
        coin_table("net"); return
    coin = args[0].upper().split(":")[-1]
    coin_view(coin, args[1].lower() if len(args) > 1 else None)


if __name__ == "__main__":
    main()
