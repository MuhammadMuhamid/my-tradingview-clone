#!/usr/bin/env python3
"""Select robust, high-win-quality MA+R:R 15m configs across IS and OOS.

OOS is intentionally used for model selection here, so the resulting rows are
paper/forward-test candidates rather than independently validated live edges.
"""
from __future__ import annotations

import json, math, os, sqlite3, sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.join(ROOT, "optimizer1y15m")
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from indexed_results import ResultIndex


def wilson(wr: float, n: int, z: float = 1.96) -> float:
    if not n:
        return 0.0
    p = max(0.0, min(1.0, wr / 100.0))
    d = 1 + z*z/n
    return 100 * (p + z*z/(2*n) - z*math.sqrt((p*(1-p)+z*z/(4*n))/n)) / d


def grade(row):
    off, raw_score, net, dd, wr, trades, pf, onet, odd, owr, otr, opf = row
    iw, ow = wilson(wr or 0, trades or 0), wilson(owr or 0, otr or 0)
    q = {
        "robust_wilson_wr": min(iw, ow),
        "is_wilson_wr": iw,
        "oos_wilson_wr": ow,
        "net_floor": min(net or 0, onet or 0),
        "pf_floor": min(pf or 0, opf or 0),
        "worst_dd": max(dd or 99, odd or 99),
        "wr_gap": abs((wr or 0) - (owr or 0)),
    }
    consistency = max(0.0, 1-q["wr_gap"]/30)
    # Reliability dominates; PF/net and DD prevent high-WR payoff traps.
    score = (0.55*q["robust_wilson_wr"]
             + 15*math.tanh(max(0, q["pf_floor"]-1)/1.25)
             + 15*math.tanh(max(0, q["net_floor"])/7.5)
             + 10*max(0, 1-min(q["worst_dd"], 10)/10)
             + 5*consistency)
    return score, q


def record(coin, offset):
    with open(os.path.join(HERE, "results", coin+".jsonl"), "rb") as f:
        f.seek(offset)
        return json.loads(f.readline())


def main():
    cfg = json.load(open(os.path.join(HERE, "config.json")))
    search = json.load(open(os.path.join(HERE, "params.json")))
    base = json.load(open(os.path.join(HERE, "base_params.json")))
    base.pop("_comment", None)
    coins = [x.strip() for x in open(os.path.join(HERE, "coins.txt"))
             if x.strip() and not x.lstrip().startswith("#")]
    space = math.prod(len(p["values"]) for p in search["parameters"])

    idx = ResultIndex(HERE)
    counts = {c: idx.sync(c) for c in coins}
    db = idx.db
    generated = datetime.now().astimezone().isoformat()
    out = {
        "generated": generated,
        "system": "optyear-results / MA + R:R / 15m",
        "period": cfg.get("range", {}),
        "execution": {"initial_capital": cfg.get("initialCapital"),
                      "commission_pct_per_side": cfg.get("commissionPct"),
                      "slippage_ticks": cfg.get("slippageTicks"),
                      "cash_per_trade": base.get("qty_cash")},
        "method": {
            "priority": "55% weaker-side Wilson WR, 15% weaker-side PF, 15% weaker-side net, 10% worst DD, 5% WR consistency",
            "strict_gates": "IS trades>=50; OOS trades>=30; net positive both; PF>=1.10 both; DD<=8% both",
            "warning": "OOS was used in selection and is consumed. Fresh paper/forward validation is mandatory."
        },
        "search_space_per_coin": space,
        "coins": {}
    }
    md = ["# MA + R:R 15m one-year win-quality audit", "",
          f"Generated: {generated}", "",
          "**Research shortlist only.** IS and OOS were both used to select these rows, so OOS is no longer independent. Paper/forward-test before risking capital.", "",
          f"Execution model: ${cfg.get('initialCapital',0):,.0f} initial capital, ${base.get('qty_cash',0):,.0f} fixed cash/trade, {cfg.get('commissionPct')}% commission/side, {cfg.get('slippageTicks')} ticks slippage.", "",
          f"Search space: {space:,} combinations/coin. Current indexed coverage varies by coin and the optimizer remains live.", "",
          "| Coin | Verdict | IS net/DD/WR/PF/T | OOS net/DD/WR/PF/T | Conservative WR | Coverage | Orig rank |", "|---|---|---:|---:|---:|---:|---:|"]

    strict_sql = """SELECT file_offset,score,net,dd,wr,trades,pf,onet,odd,owr,otr,opf
                    FROM results WHERE coin=? AND trades>=50 AND otr>=30
                    AND net>0 AND onet>0 AND pf>=1.10 AND opf>=1.10
                    AND dd<=8 AND odd<=8"""
    diagnostic_sql = """SELECT file_offset,score,net,dd,wr,trades,pf,onet,odd,owr,otr,opf
                        FROM results WHERE coin=? AND trades>=40 AND otr>=20
                        AND net>0 AND onet>0 AND pf>1 AND opf>1
                        AND dd<=12 AND odd<=12"""
    for coin in coins:
        rows = db.execute(strict_sql, (coin,)).fetchall()
        strict = bool(rows)
        if not rows:
            rows = db.execute(diagnostic_sql, (coin,)).fetchall()
        if not rows:
            verdict = "NO ROBUST TWO-WINDOW CONFIG"
            reason = "No evaluated row passed even the relaxed two-window profitability, trade-count, PF and drawdown gates."
            out["coins"][coin] = {"verdict": verdict, "reason": reason, "indexed": counts[coin], "coverage_pct": round(100*counts[coin]/space,2), "params": None}
            md.append(f"| {coin} | {verdict} | — | — | — | {100*counts[coin]/space:.1f}% | — |")
            continue
        ranked = [(grade(r)[0], grade(r)[1], r) for r in rows]
        score, q, row = max(ranked, key=lambda x: (x[0], x[1]["robust_wilson_wr"], x[1]["pf_floor"], x[1]["net_floor"], -x[1]["worst_dd"]))
        rec = record(coin, row[0]); m = rec["metrics"]; p = rec.get("params", {})
        breadth = sum(1 for s, _, _ in ranked if s >= score-3)
        observed_floor = min(m["win_rate"], m["oos_win_rate"])
        if strict and q["robust_wilson_wr"] >= 48 and q["pf_floor"] >= 1.35 and breadth >= 10:
            verdict = "STRONG PAPER CANDIDATE"
        elif strict and observed_floor >= 58 and q["robust_wilson_wr"] >= 40 and q["pf_floor"] >= 1.15:
            verdict = "HIGH-WR PAPER CANDIDATE"
        elif strict:
            verdict = "BALANCED PAPER CANDIDATE"
        else:
            verdict = "DIAGNOSTIC ONLY — GATES FAILED"
        orig_rank = db.execute("SELECT 1+count(*) FROM results WHERE coin=? AND (score>? OR (score=? AND file_offset<?))", (coin,row[1],row[1],row[0])).fetchone()[0]
        why = [
            f"WR {m['win_rate']:.1f}% IS / {m['oos_win_rate']:.1f}% OOS; weaker 95% Wilson floor {q['robust_wilson_wr']:.1f}%.",
            f"Weaker PF {q['pf_floor']:.2f}, weaker net {q['net_floor']:.2f}%, worst DD {q['worst_dd']:.2f}%.",
            f"{breadth:,} eligible rows sit within 3 quality points of the winner; this is {'a broader plateau' if breadth >= 10 else 'a narrow result requiring extra caution'}."
        ]
        item = {"verdict": verdict, "quality_score": round(score,3), "original_optimizer_rank": orig_rank,
                "indexed": counts[coin], "coverage_pct": round(100*counts[coin]/space,2),
                "eligible_rows": len(rows), "near_best_breadth": breadth,
                "confidence": {k:round(v,3) for k,v in q.items()}, "metrics": m,
                "tuned_params": p, "full_params": {**base, **p}, "why": why, "timestamp": rec.get("ts")}
        out["coins"][coin] = item
        a = f"{m['net_pct']:.1f}/{m['dd_pct']:.1f}/{m['win_rate']:.1f}/{m['profit_factor']:.2f}/{m['trades']}"
        b = f"{m['oos_net_pct']:.1f}/{m['oos_dd_pct']:.1f}/{m['oos_win_rate']:.1f}/{m['oos_profit_factor']:.2f}/{m['oos_trades']}"
        md.append(f"| {coin} | {verdict} | {a} | {b} | {q['robust_wilson_wr']:.1f}% | {100*counts[coin]/space:.1f}% | {orig_rank:,} |")

    for coin, item in out["coins"].items():
        if not item.get("tuned_params"):
            continue
        md += ["", f"## {coin} — {item['verdict']}", ""]
        md += [f"- {x}" for x in item["why"]]
        md += ["", "Tuned inputs:", "", "```json", json.dumps(item["tuned_params"], ensure_ascii=False, indent=2), "```"]

    db.close()
    stamp = datetime.now().astimezone().date().isoformat()
    stem = os.path.join(ROOT, f"MA15M_YEAR_WIN_QUALITY_{stamp}")
    with open(stem+".json", "w") as f: json.dump(out, f, ensure_ascii=False, indent=2)
    with open(stem+".md", "w") as f: f.write("\n".join(md)+"\n")
    print(stem+".md"); print(stem+".json")


if __name__ == "__main__":
    main()
