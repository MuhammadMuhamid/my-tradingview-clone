#!/usr/bin/env python3
"""Holdout report for opt1hyear-results.

    python3 holdout1h/report.py                 # print
    python3 holdout1h/report.py --md out.md     # write markdown

Two halves:
  1. The leaderboards you asked for — best config per coin by net, PF, DD, win%.
  2. The part that says whether those leaderboards mean anything: does in-sample
     rank predict holdout result, and does the top-1000 population beat simply
     holding the coin? With 1000 candidates the single best holdout result is
     itself a lucky draw, so the distribution is the trustworthy signal.

Safe to run while run.ts is still going — it reports on whatever is on disk.
"""
from __future__ import annotations
import glob, json, math, os, statistics as st, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")


def load():
    data = {}
    for f in sorted(glob.glob(os.path.join(OUT, "*.jsonl"))):
        coin = os.path.basename(f)[:-6]
        rows = []
        for line in open(f):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            h = r.get("holdout") or {}
            if h.get("net_pct") is None:
                continue
            rows.append(r)
        if rows:
            data[coin] = rows
    return data


def spearman(xs, ys):
    """Rank correlation, robust to the wild outliers holdout returns produce."""
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
    mx, my = st.mean(rx), st.mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else 0.0



def coin_detail(coin):
    """Drill-down for one coin: distribution, then the configs worth looking at."""
    f = os.path.join(OUT, coin.upper() + ".jsonl")
    if not os.path.exists(f):
        print(f"no holdout results for {coin}")
        return
    rows = [json.loads(l) for l in open(f) if l.strip()]
    rows = [r for r in rows if (r.get("holdout") or {}).get("net_pct") is not None]
    nets = sorted(r["holdout"]["net_pct"] for r in rows)
    bh = rows[0]["holdout"].get("buy_hold_pct") or 0.0
    n = len(nets)
    print(f"\n{coin.upper()} — {n} configs replayed on unseen history")
    print(f"  buy & hold over the same window : {bh:+.1f}%")
    print(f"  holdout net:  min {nets[0]:+.1f}%   p25 {nets[n//4]:+.1f}%   MEDIAN {nets[n//2]:+.1f}%   "
          f"p75 {nets[3*n//4]:+.1f}%   max {nets[-1]:+.1f}%")
    print(f"  profitable: {100*sum(1 for x in nets if x>0)/n:.0f}%    beat buy&hold: "
          f"{100*sum(1 for r in rows if r['holdout']['net_pct']>bh)/n:.0f}%")

    # The median-performing config is the honest representative of the population:
    # not the luckiest draw, and its params sit in the middle of what survived.
    mid = sorted(rows, key=lambda r: r["holdout"]["net_pct"])[n//2]
    top = sorted(rows, key=lambda r: r["holdout"]["net_pct"], reverse=True)[0]
    for label, r in (("MEDIAN config (use this one)", mid), ("best holdout config (luckiest draw)", top)):
        h = r["holdout"]; i = r["in_sample"]
        print(f"\n  --- {label} ---")
        print(f"  in-sample rank #{r['rank']}  (in-sample net {i['net']:+.0f}%, pf {i['pf']}, {i['trades']} trades)")
        print(f"  holdout: net {h['net_pct']:+.1f}%  dd {h['dd_pct']:.1f}%  win {h['win_rate'] or 0:.1f}%  "
              f"pf {h['profit_factor'] or 0:.2f}  trades {h['trades']}")
        print("  params: " + json.dumps(r["params"], separators=(", ", "=")).replace('"', ""))


def apply_map(coin):
    """TradingView input ids for the MEDIAN surviving config (the one to trade)."""
    f = os.path.join(OUT, coin.upper() + ".jsonl")
    if not os.path.exists(f):
        print(f"no holdout results for {coin}")
        return
    rows = [json.loads(l) for l in open(f) if l.strip()]
    rows = [r for r in rows if (r.get("holdout") or {}).get("net_pct") is not None]
    mid = sorted(rows, key=lambda r: r["holdout"]["net_pct"])[len(rows) // 2]
    space = json.load(open(os.path.join(HERE, "..", "optimizer1y1h", "params.json")))
    idmap = {p["name"]: p["id"] for p in space["parameters"]}
    out = {idmap[k]: v for k, v in mid["params"].items() if k in idmap}
    h = mid["holdout"]
    print(f"{coin.upper()} — median surviving config (in-sample rank #{mid['rank']})")
    print(f"  holdout: net {h['net_pct']:+.1f}%  dd {h['dd_pct']:.1f}%  pf {h['profit_factor'] or 0:.2f}  trades {h['trades']}")
    print(json.dumps(out, indent=1))


def main():
    argv = sys.argv[1:]
    if "--md" in argv:
        i = argv.index("--md")
        argv = argv[:i] + argv[i + 2:]
    args = [a for a in argv if not a.startswith("--")]
    if "--apply" in sys.argv:
        apply_map(args[0] if args else sys.argv[sys.argv.index("--apply") + 1])
        return
    if "--coin" in sys.argv:
        coin_detail(sys.argv[sys.argv.index("--coin") + 1])
        return
    if args:                      # positional coin, like `opt1hyear-results zecusdt`
        coin_detail(args[0])
        return
    data = load()
    if not data:
        print("no holdout results yet")
        return
    L, A = [], lambda s: L.append(s)

    A("# opt1hyear-results — Holdout Validation (pre-optimizer history)")
    A("")
    A("Every config below was chosen by the optimizer on **2025-07-20 → 2026-07-30**, then")
    A("replayed here over history it never saw, ending **2025-07-19**.")
    A("")
    A("Sizing is a **fixed $1,000 per trade** (no compounding, no leverage effect), commission")
    A("0.1%/side, slippage 2 ticks. The live leaderboard compounds at 100% of equity, so its")
    A("net% figures are not comparable with these and are far larger by construction.")
    A("")

    tot = sum(len(v) for v in data.values())
    A(f"Coins with a usable holdout: **{len(data)}** · configs replayed: **{tot:,}**")
    A("")

    # ── 1. per-coin summary ───────────────────────────────────────────────────
    A("## 1. Did the top-1000 population survive?")
    A("")
    A("| Coin | Configs | Holdout months | Mean net | Median net | % profitable | Buy & hold | Median vs B&H | Beat B&H |")
    A("|---|---|---|---|---|---|---|---|---|")
    for coin, rows in sorted(data.items(), key=lambda kv: -st.median([r["holdout"]["net_pct"] for r in kv[1]])):
        nets = [r["holdout"]["net_pct"] for r in rows]
        bh = rows[0]["holdout"].get("buy_hold_pct") or 0.0
        beat = 100 * sum(1 for x in nets if x > bh) / len(nets)
        mo = ""
        A(f"| **{coin}** | {len(rows)} | {mo} | {st.mean(nets):+.1f}% | {st.median(nets):+.1f}% | "
          f"{100*sum(1 for x in nets if x>0)/len(nets):.0f}% | {bh:+.1f}% | {st.median(nets)-bh:+.1f} pts | {beat:.0f}% |")
    A("")

    # ── 2. does in-sample rank predict anything ───────────────────────────────
    A("## 2. Does the leaderboard ordering predict holdout performance?")
    A("")
    A("Spearman rank correlation between in-sample rank (1 = best) and holdout net%.")
    A("Positive means better in-sample rank → better holdout result. ~0 means the ordering is noise.")
    A("")
    A("| Coin | rank vs holdout net | Top-50 median | Bottom-50 median | Top-50 better? |")
    A("|---|---|---|---|---|")
    rhos = []
    for coin, rows in sorted(data.items()):
        rows = sorted(rows, key=lambda r: r["rank"])
        rk = [-r["rank"] for r in rows]           # negate so higher = better rank
        hn = [r["holdout"]["net_pct"] for r in rows]
        rho = spearman(rk, hn)
        rhos.append(rho)
        t50 = st.median(hn[:50]) if len(hn) >= 50 else st.median(hn)
        b50 = st.median(hn[-50:]) if len(hn) >= 50 else st.median(hn)
        A(f"| {coin} | **{rho:+.2f}** | {t50:+.1f}% | {b50:+.1f}% | {'yes' if t50 > b50 else 'no'} |")
    A("")
    A(f"**Mean rank correlation across coins: {st.mean(rhos):+.2f}**")
    A("")

    # ── 3. the leaderboards asked for ─────────────────────────────────────────
    A("## 3. Best config per coin on the holdout")
    A("")
    A("Ranked four ways, as requested. Read §2 first — where the rank correlation is near zero,")
    A("these winners are the luckiest of 1000 draws rather than the best strategies.")
    A("")
    for label, key, rev, fmt in [
        ("Highest net %", "net_pct", True, "{:+.1f}%"),
        ("Highest profit factor", "profit_factor", True, "{:.2f}"),
        ("Lowest drawdown (net > 0)", "dd_pct", False, "{:.1f}%"),
        ("Highest win rate (net > 0)", "win_rate", True, "{:.1f}%"),
    ]:
        A(f"### {label}")
        A("")
        A("| Coin | In-sample rank | Holdout net | DD | Win% | PF | Trades | B&H |")
        A("|---|---|---|---|---|---|---|---|")
        for coin, rows in sorted(data.items()):
            pool = [r for r in rows if r["holdout"].get(key) is not None]
            if key in ("dd_pct", "win_rate"):
                pool = [r for r in pool if r["holdout"]["net_pct"] > 0]
            if not pool:
                continue
            best = sorted(pool, key=lambda r: r["holdout"][key], reverse=rev)[0]
            h = best["holdout"]
            A(f"| {coin} | #{best['rank']} | {h['net_pct']:+.1f}% | {h['dd_pct']:.1f}% | "
              f"{h['win_rate'] or 0:.1f}% | {h['profit_factor'] or 0:.2f} | {h['trades']} | {h.get('buy_hold_pct') or 0:+.1f}% |")
        A("")

    txt = "\n".join(L)
    if "--md" in sys.argv:
        dst = sys.argv[sys.argv.index("--md") + 1]
        open(dst, "w").write(txt)
        print(f"written {dst}")
    else:
        print(txt)


if __name__ == "__main__":
    main()
