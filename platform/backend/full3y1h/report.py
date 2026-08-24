#!/usr/bin/env python3
"""3-year leaderboard for the top-1000 opt1hyear-results configs per coin.

Same interface as `opt1hyear-results` / `optyear-results`:

    full3y-results                    ranked coin table
    full3y-results ZECUSDT            top 10 by overall score
    full3y-results ZECUSDT net        top 500 by profit
    full3y-results ZECUSDT dd         ... by lowest drawdown
    full3y-results ZECUSDT wr         ... by win rate
    full3y-results ZECUSDT pf         ... by profit factor
    full3y-results ZECUSDT trades     ... by trade count
    full3y-results ZECUSDT oos        ... by OUT-OF-SAMPLE profit  (extra mode)
    full3y-results ZECUSDT best       balanced: DD + NET + WR + PF
    full3y-results ZECUSDT 7          full record + inputs for rank #7
    full3y-results --md out.md        markdown export

Window 2023-08-01 (or listing date) -> today. Account $1000, FIXED $1000 per
trade — no compounding, no leverage, so PROFIT reads as growth on $1000.

OOS = the part of the window before 2025-07-20, which the optimizer never saw.
Everything after that date is the year these configs were selected on, so it is
in-sample and flattering. ORIG# is the config's rank in opt1hyear-results.
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
CMD = "full3y-results"
APPLY = "full3y-apply"


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

def spearman(xs, ys):
    """Rank correlation, robust to the wild outliers replay returns produce.

    OPT-16: `holdout1h/report.py` framed its results as a DISTRIBUTION and led
    with this number — the single most honest piece of analysis in either
    repository. This tree shares byte-identical config sets with it and dropped
    the analysis, leaving only leaderboards, which read as if in-sample rank
    means something. It does not, unless this number says so.
    """
    n = len(xs)
    if n < 3:
        return 0.0

    def ranks(v):
        order = sorted(range(n), key=lambda i: v[i])
        out = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                out[order[k]] = avg
            i = j + 1
        return out

    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    dx = sum((a - mx) ** 2 for a in rx) ** 0.5
    dy = sum((b - my) ** 2 for b in ry) ** 0.5
    return 0.0 if dx == 0 or dy == 0 else num / (dx * dy)


def rank_correlation_line(rows, field="net_pct"):
    """Does in-sample rank predict anything here? Printed before any leaderboard."""
    usable = [r for r in rows if r.get("rank") is not None and h(r, field, None) is not None]
    if len(usable) < 3:
        return None
    rk = [-r["rank"] for r in usable]                 # negate: higher = better rank
    val = [h(r, field) for r in usable]
    rho = spearman(rk, val)
    verdict = ("in-sample rank predicts this well" if rho >= 0.4 else
               "weak" if rho >= 0.15 else
               "IN-SAMPLE RANK PREDICTS NOTHING HERE")
    return (rho, verdict, len(usable))


def print_record(coin, r, title):
    hd = r["holdout"]
    print(f"\n{B}{C}  ══════ {coin} — {title} ══════{END}")
    print(f"   opt1hyear rank: {DIM}ORIG#{r['rank']}  "
          f"(in-sample net {r['in_sample']['net']:+.0f}%, pf {r['in_sample']['pf']}){END}")
    print(f"   Profit:       {color_net(hd.get('net_pct'))}   (${1000 + hd.get('net_usdt', 0):,.0f} from $1,000)")
    print(f"   {B}Out-of-sample:{END}{color_net(hd.get('oos_net_pct'))}   "
          f"{DIM}{hd.get('oos_trades') or 0} trades, win {hd.get('oos_win_rate') or 0:.1f}% "
          f"— before {SPLIT}, unseen{END}")
    print(f"   In-sample:    {color_net(hd.get('is_net_pct'))}   "
          f"{DIM}{hd.get('is_trades') or 0} trades, win {hd.get('is_win_rate') or 0:.1f}% "
          f"— the fitted year{END}")
    print(f"   Max drawdown: {hd.get('dd_pct', 0):.1f}%")
    print(f"   Win rate:     {hd.get('win_rate') or 0:.1f}% over {hd.get('trades', 0)} trades")
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
        print("no results yet — run full3y-run")
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
    print(f"\n{B}{C}  ══════ THREE-YEAR TEST — TOP {CFG['topN']} CONFIGS PER COIN ══════{END}")
    print(f"   Window: {B}{CFG['holdoutStart'][:10]} → {CFG['holdoutEnd'][:10]}{END}   "
          f"Configs tested: {B}{total:,}{END}   Updated: {datetime.now():%b %d, %H:%M}")
    print(f"   Sizing: {B}${CFG['qtyCash']:,} fixed per trade{END} on a $1,000 account "
          f"{DIM}(no compounding){END}   Coin row = best by {label.split(' (')[0]}")
    print(f"   {DIM}ORIG# = that config's rank in opt1hyear-results (1..{CFG['topN']}).  "
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
        print(f"No results for {coin}. Run full3y-run first.")
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
    # OPT-17: this printed "Recommended: ORIG#<median by OOS net>" beside an
    # Apply command. Taking the median rather than the maximum is the right way
    # to DESCRIBE a distribution, but choosing a config by ANY out-of-sample
    # statistic is selection on the validation window — the same defect as
    # OPT-01, one step less obvious. The median is still reported, as a
    # description; it is no longer a recommendation and carries no apply hint.
    print(f"\n   {DIM}Median config by out-of-sample profit: ORIG#{med_oos['rank']} "
          f"({h(med_oos, 'oos_net_pct'):+.1f}% OOS, {h(med_oos, 'net_pct'):+.1f}% total). "
          f"Top rows are the luckiest of {n} draws, so the median describes the "
          f"distribution far better than the maximum.{END}")
    print(f"   {Y}It is NOT a recommendation. Choosing a config by an out-of-sample "
          f"statistic makes that window a selection criterion (OPT-01/OPT-17); "
          f"pick on the in-sample views, then score the choice once on the frozen "
          f"holdout.{END}")
    rc = rank_correlation_line(rows)
    if rc:
        rho, verdict, used = rc
        print(f"   {DIM}Spearman(in-sample rank, replay net) = {rho:+.2f} over {used} configs "
              f"— {verdict}.{END}")
    print(f"   {DIM}Inputs: {CMD} {coin} RANK#   |   Apply: {APPLY} {coin}{END}\n")


def apply_map(coin):
    rows = load_coin(coin)
    if not rows:
        print(f"no results for {coin}")
        return
    med = sorted(rows, key=lambda r: h(r, "oos_net_pct"))[len(rows) // 2]
    space = json.load(open(os.path.join(HERE, "..", "optimizer1y1h", "params.json")))
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
