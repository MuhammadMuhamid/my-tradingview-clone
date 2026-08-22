#!/usr/bin/env python3
"""Exhaustive IS/OOS win-quality selection for the 5m MTF Lean optimizer."""
from __future__ import annotations

import argparse, json, math, os, sqlite3, sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.join(ROOT, "optimizer1y5m")
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from indexed_results import ResultIndex


def wilson_lower(wr: float, n: int, z: float = 1.96) -> float:
    if not n:
        return 0.0
    p = max(0.0, min(1.0, wr / 100.0))
    den = 1 + z * z / n
    centre = p + z * z / (2 * n)
    spread = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
    return 100 * (centre - spread) / den


def quality(row) -> tuple[float, dict]:
    off, is_score, net, dd, wr, tr, pf, onet, odd, owr, otr, opf = row
    iw, ow = wilson_lower(wr or 0, tr or 0), wilson_lower(owr or 0, otr or 0)
    robust_wr = min(iw, ow)
    net_floor = min(net or 0, onet or 0)
    pf_floor = min(pf or 0, opf or 0)
    dd_worst = max(dd or 99, odd or 99)
    consistency = max(0.0, 1 - abs((wr or 0) - (owr or 0)) / 30)
    score = (
        0.55 * robust_wr
        + 15 * math.tanh(max(0, pf_floor - 1) / 1.25)
        + 15 * math.tanh(max(0, net_floor) / 7.5)
        + 10 * max(0, 1 - min(dd_worst, 10) / 10)
        + 5 * consistency
    )
    return score, {
        "is_wilson_lb": iw, "oos_wilson_lb": ow,
        "robust_wilson_wr": robust_wr, "net_floor": net_floor,
        "pf_floor": pf_floor, "worst_dd": dd_worst,
        "wr_gap": abs((wr or 0) - (owr or 0)),
    }


def read_record(coin: str, offset: int) -> dict:
    with open(os.path.join(HERE, "results", coin + ".jsonl"), "rb") as fh:
        fh.seek(offset)
        return json.loads(fh.readline())


def rationale(params: dict, metrics: dict, q: dict) -> list[str]:
    result = [
        f"Per-entry win rate held at {metrics['win_rate']:.1f}% IS and {metrics['oos_win_rate']:.1f}% OOS "
        f"(95% conservative floor {q['robust_wilson_wr']:.1f}%).",
        f"The weaker side retained {q['net_floor']:.2f}% net and PF {q['pf_floor']:.2f}; "
        f"worst drawdown was {q['worst_dd']:.2f}%.",
    ]
    exit_bits = []
    if params.get("rrUsePartialTp"):
        exit_bits.append("partial profit-taking")
    if params.get("rrUseTrailSl"):
        exit_bits.append(f"a {params.get('rrTrailPct')}% trailing stop")
    result.append(
        "Exit behavior uses " + " and ".join(exit_bits) + "."
        if exit_bits else
        "The result uses a simple full-position exit without partial or trailing bookkeeping."
    )
    filters = []
    for key, label in (("useG1", "G1 momentum"), ("useG3", "G3 flow"),
                       ("useS4", "S4 structure"), ("useS5", "S5 structure")):
        if params.get(key):
            filters.append(label)
    result.append("Active selective confirmations: " + (", ".join(filters) if filters else "fixed MTF base filters") + ".")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-partial", action="store_true")
    args = parser.parse_args()
    base_params = json.load(open(os.path.join(HERE, "base_params.json")))
    base_params.pop("_comment", None)
    sync = ResultIndex(HERE)
    coins = [x.strip() for x in open(os.path.join(HERE, "coins.txt")) if x.strip() and not x.lstrip().startswith("#")]
    for coin in coins:
        sync.sync(coin)
    sync.db.close()
    db = sqlite3.connect(os.path.join(HERE, "index", "leaderboard.sqlite3"))
    output = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "method": {
            "objective": "55% confidence-adjusted weaker-side WR; 15% weaker PF; 15% weaker net; 10% worst DD; 5% WR consistency",
            "strict_gates": "IS trades>=50, OOS trades>=30, both net>0, both PF>=1.10, both DD<=8%",
            "partial_tp_allowed": not args.no_partial,
            "warning": "OOS is consumed by this selection; fresh paper/forward validation is mandatory.",
        },
        "coins": {},
    }
    title = "5m MTF Lean — full-exit win-quality audit" if args.no_partial else "5m MTF Lean — win-quality multi-objective audit"
    md = [
        f"# {title}", "",
        "**Research shortlist only.** OOS was included in selection and is no longer an independent validation set. A fresh forward/paper period is mandatory.", "",
        "Score priority: confidence-adjusted per-entry win rate on the weaker side (55%), weaker-side PF (15%), weaker-side net (15%), worst DD (10%), IS/OOS win-rate consistency (5%).", "",
        "| Coin | Verdict | IS net/DD/WR/PF/T | OOS net/DD/WR/PF/T | Robust WR floor | Quality |",
        "|---|---|---:|---:|---:|---:|",
    ]

    def filter_full_exit(coin: str, rows: list) -> list:
        if not args.no_partial:
            return rows
        kept = []
        path = os.path.join(HERE, "results", coin + ".jsonl")
        with open(path, "rb") as fh:
            for row in sorted(rows, key=lambda r: r[0]):
                fh.seek(row[0])
                if json.loads(fh.readline()).get("params", {}).get("rrUsePartialTp") is False:
                    kept.append(row)
        return kept

    for coin in coins:
        rows = db.execute(
            """SELECT file_offset,score,net,dd,wr,trades,pf,onet,odd,owr,otr,opf
               FROM results WHERE coin=? AND trades>=50 AND otr>=30
               AND net>0 AND onet>0 AND pf>=1.10 AND opf>=1.10
               AND dd<=8 AND odd<=8""", (coin,)
        ).fetchall()
        rows = filter_full_exit(coin, rows)
        strict = True
        if not rows:
            strict = False
            rows = db.execute(
                """SELECT file_offset,score,net,dd,wr,trades,pf,onet,odd,owr,otr,opf
                   FROM results WHERE coin=? AND trades>=50 AND otr>=15
                   AND net>0 AND onet>0 AND pf>1 AND opf>1
                   AND dd<=10 AND odd<=10""", (coin,)
            ).fetchall()
            rows = filter_full_exit(coin, rows)
        if not rows:
            output["coins"][coin] = {"verdict": "NO QUALIFYING CONFIG", "params": None}
            md.append(f"| {coin} | NO QUALIFYING CONFIG | — | — | — | — |")
            continue
        ranked = [(quality(row)[0], quality(row)[1], row) for row in rows]
        score, q, row = max(ranked, key=lambda x: (x[0], x[1]["robust_wilson_wr"], x[1]["pf_floor"], x[1]["net_floor"], -x[1]["worst_dd"]))
        record = read_record(coin, row[0])
        metrics, params = record["metrics"], record.get("params", {})
        breadth = sum(1 for x in ranked if x[0] >= score - 3)
        observed_floor = min(metrics["win_rate"], metrics["oos_win_rate"])
        verdict = (
            "STRONG FORWARD-TEST CANDIDATE" if strict and q["robust_wilson_wr"] >= 45 and q["pf_floor"] >= 1.25 and breadth >= 20 else
            "HIGH-WR FORWARD-TEST CANDIDATE" if strict and observed_floor >= 55 and q["robust_wilson_wr"] >= 40 and q["pf_floor"] >= 1.15 else
            "BALANCED PAPER CANDIDATE" if strict else
            "NO LIVE CONFIG — BEST DIAGNOSTIC ONLY"
        )
        item = {
            "verdict": verdict, "quality_score": round(score, 3), "robustness_near_best": breadth,
            "confidence": {k: round(v, 3) for k, v in q.items()}, "metrics": metrics,
            "params": params, "full_params": {**base_params, **params},
            "why": rationale(params, metrics, q), "timestamp": record.get("ts"),
            "file_offset": row[0],
        }
        output["coins"][coin] = item
        a = f"{metrics['net_pct']:.1f}/{metrics['dd_pct']:.1f}/{metrics['win_rate']:.1f}/{metrics['profit_factor']:.2f}/{metrics['trades']}"
        b = f"{metrics['oos_net_pct']:.1f}/{metrics['oos_dd_pct']:.1f}/{metrics['oos_win_rate']:.1f}/{metrics['oos_profit_factor']:.2f}/{metrics['oos_trades']}"
        md.append(f"| {coin} | {verdict} | {a} | {b} | {q['robust_wilson_wr']:.1f}% | {score:.1f} |")
    for coin, item in output["coins"].items():
        if not item.get("params"):
            continue
        md += ["", f"## {coin} — {item['verdict']}", ""] + [f"- {line}" for line in item["why"]] + ["", "```json", json.dumps(item["params"], ensure_ascii=False, indent=2), "```"]
    db.close()
    stem = "LEAN5M_FULL_EXIT_WIN_QUALITY_2026-08-20" if args.no_partial else "LEAN5M_WIN_QUALITY_2026-08-20"
    json_path, md_path = os.path.join(ROOT, stem + ".json"), os.path.join(ROOT, stem + ".md")
    with open(json_path, "w") as fh:
        json.dump(output, fh, ensure_ascii=False, indent=2)
    with open(md_path, "w") as fh:
        fh.write("\n".join(md) + "\n")
    print(md_path)
    print(json_path)


if __name__ == "__main__":
    main()
