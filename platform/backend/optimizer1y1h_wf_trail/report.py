#!/usr/bin/env python3
"""Walk-forward report.

Reads folds/<foldId>/<coin>.json and answers the question the whole exercise
exists for: how much of the in-sample edge survives on data the optimizer never
saw, and which SELECTION RULE generalises best.

  python3 optimizer1y1h_wf/report.py            # everything found so far
  python3 optimizer1y1h_wf/report.py --md out.md

Safe to run while wf.ts is still going — it simply reports on completed folds.
"""
import json, os, sys, glob, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
RULES = ["peak", "plateau", "multi"]
LABEL = {"peak": "A peak (current optimizer)", "plateau": "B plateau centre", "multi": "C multi-factor Pareto"}


def load():
    out = []
    for f in sorted(glob.glob(os.path.join(HERE, "folds", "*", "*.json"))):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if d.get("skipped") or "rules" not in d:
            continue
        out.append(d)
    return out


def compound(returns):
    m = 1.0
    for r in returns:
        m *= (1 + r / 100.0)
    return (m - 1) * 100


def main():
    recs = load()
    if not recs:
        print("no completed fold results yet")
        return
    folds = sorted({r["fold"] for r in recs})
    coins = sorted({r["symbol"] for r in recs})
    L = []
    A = L.append
    A("# Walk-Forward Validation — Results")
    A("")
    A(f"Folds completed: {', '.join(folds)} · coins: {len(coins)} · coin-folds: {len(recs)}")
    A("")
    A("Training used an expanding window ending at each fold's test start; the test block is")
    A("the following 2 months, never seen during training. Costs: 0.1%/side commission plus")
    A("2 ticks of slippage, applied identically in training and test.")
    A("")

    # ── headline: degradation per rule ────────────────────────────────────────
    A("## 1. Does the edge survive out-of-sample?")
    A("")
    A("| Selection rule | Coin-folds | Mean train net% | Mean test net% | Degradation | Test win rate | % of coin-folds profitable OOS | Mean test DD% |")
    A("|---|---|---|---|---|---|---|---|")
    summary = {}
    for rule in RULES:
        tr, te, wr, dd, pos, n = [], [], [], [], 0, 0
        for r in recs:
            v = r["rules"].get(rule)
            if not v or not v.get("test_metrics"):
                continue
            t, s = v["train_metrics"], v["test_metrics"]
            if t.get("net_pct") is None or s.get("net_pct") is None:
                continue
            # normalise train to a 2-month rate so the comparison is like-for-like
            months = (2,)  # test block length
            tr.append(t["net_pct"]); te.append(s["net_pct"])
            if s.get("win_rate") is not None and s.get("trades"):
                wr.append(s["win_rate"])
            if s.get("dd_pct") is not None:
                dd.append(s["dd_pct"])
            pos += 1 if s["net_pct"] > 0 else 0
            n += 1
        if n == 0:
            continue
        summary[rule] = dict(n=n, train=st.mean(tr), test=st.mean(te), pos=100.0 * pos / n,
                             wr=st.mean(wr) if wr else None, dd=st.mean(dd) if dd else None,
                             test_list=te)
        s_ = summary[rule]
        A(f"| {LABEL[rule]} | {n} | {s_['train']:.0f}% | **{s_['test']:.1f}%** | "
          f"{100 * s_['test'] / s_['train'] if s_['train'] else 0:.1f}% of train | "
          f"{s_['wr']:.1f}% | {s_['pos']:.0f}% | {s_['dd']:.1f}% |")
    A("")
    A("`Degradation` compares mean test net% against mean train net%. Train windows are 12–22")
    A("months and test blocks are 2 months, so the ratio is NOT expected to be 100% — what")
    A("matters is the comparison BETWEEN rules, and whether test net% is reliably positive.")
    A("")

    # ── stitched OOS equity per coin ──────────────────────────────────────────
    A("## 2. Stitched out-of-sample track record per coin")
    A("")
    A("Each coin's test-block returns compounded in sequence — a continuous OOS equity curve.")
    A("")
    A("| Coin | Folds | " + " | ".join(f"{r} OOS total" for r in RULES) + " | Best rule |")
    A("|---|---|" + "---|" * (len(RULES) + 1))
    per_coin = {}
    for coin in coins:
        rows = sorted([r for r in recs if r["symbol"] == coin], key=lambda r: r["fold"])
        cells, tots = [], {}
        for rule in RULES:
            rets = [r["rules"][rule]["test_metrics"]["net_pct"] for r in rows
                    if r["rules"].get(rule) and r["rules"][rule].get("test_metrics")
                    and r["rules"][rule]["test_metrics"].get("net_pct") is not None]
            if rets:
                tots[rule] = compound(rets)
                cells.append(f"{tots[rule]:+.0f}%")
            else:
                cells.append("—")
        best = max(tots, key=tots.get) if tots else "—"
        per_coin[coin] = tots
        A(f"| {coin} | {len(rows)} | " + " | ".join(cells) + f" | {best} |")
    A("")

    # ── per fold ──────────────────────────────────────────────────────────────
    A("## 3. Per-fold out-of-sample result (rule C, multi-factor)")
    A("")
    A("| Fold | Test window | Coins | Mean test net% | Median | Profitable | Mean trades |")
    A("|---|---|---|---|---|---|---|")
    for f in folds:
        rows = [r for r in recs if r["fold"] == f and r["rules"].get("multi", {}).get("test_metrics")]
        if not rows:
            continue
        nets = [r["rules"]["multi"]["test_metrics"]["net_pct"] for r in rows]
        trs = [r["rules"]["multi"]["test_metrics"]["trades"] or 0 for r in rows]
        w = rows[0]["test"]
        A(f"| {f} | {w['start'][:10]} → {w['end'][:10]} | {len(rows)} | {st.mean(nets):+.1f}% | "
          f"{st.median(nets):+.1f}% | {100 * sum(1 for x in nets if x > 0) / len(nets):.0f}% | {st.mean(trs):.0f} |")
    A("")

    # ── verdict ───────────────────────────────────────────────────────────────
    A("## 4. Verdict")
    A("")
    if summary:
        best_rule = max(summary, key=lambda r: summary[r]["test"])
        b = summary[best_rule]
        A(f"- Best-generalising selection rule: **{LABEL[best_rule]}** "
          f"(mean OOS {b['test']:+.1f}% per 2-month block, {b['pos']:.0f}% of coin-folds profitable).")
        pooled = [x for r in RULES if r in summary for x in summary[r]["test_list"]]
        A(f"- Pooled across all rules and coin-folds: mean {st.mean(pooled):+.1f}%, "
          f"median {st.median(pooled):+.1f}%, {100 * sum(1 for x in pooled if x > 0) / len(pooled):.0f}% profitable.")
        A("")
        A("Use the per-coin table in §2 to decide allocation: a coin that is positive across most")
        A("folds under the same rule is carrying a real edge. A coin that is positive only in the")
        A("folds where the market trended is carrying beta.")
    txt = "\n".join(L)
    if "--md" in sys.argv:
        dst = sys.argv[sys.argv.index("--md") + 1]
        open(dst, "w").write(txt)
        print(f"written {dst}")
    else:
        print(txt)


if __name__ == "__main__":
    main()
