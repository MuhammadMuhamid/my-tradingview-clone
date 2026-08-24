#!/usr/bin/env python3
"""Exhaustive win-quality selection for the 15m MTF Lean optimizer.

This intentionally treats IS and OOS symmetrically because the requested research
question is "best on both sides".  Consequently OOS is consumed by selection and
the output is a paper/forward-test shortlist, never a live validation result.
"""
from __future__ import annotations

import argparse, json, math, os, sqlite3, sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.join(ROOT, "lean_optimizer15m")
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from indexed_results import ResultIndex


def wilson_lower(wr: float, n: int, z: float = 1.96) -> float:
    if not n: return 0.0
    p = max(0.0, min(1.0, wr / 100.0))
    den = 1 + z*z/n
    centre = p + z*z/(2*n)
    spread = z * math.sqrt((p*(1-p) + z*z/(4*n))/n)
    return 100 * (centre-spread)/den


def quality(row) -> tuple[float, dict]:
    off, is_score, net, dd, wr, tr, pf, onet, odd, owr, otr, opf = row
    iw, ow = wilson_lower(wr or 0, tr or 0), wilson_lower(owr or 0, otr or 0)
    robust_wr = min(iw, ow)
    net_floor = min(net or 0, onet or 0)
    pf_floor = min(pf or 0, opf or 0)
    dd_worst = max(dd or 99, odd or 99)
    consistency = max(0.0, 1 - abs((wr or 0)-(owr or 0))/30)
    # Win reliability dominates. Other components prevent high-WR/poor-payoff traps.
    score = (
        0.55 * robust_wr
        + 15 * math.tanh(max(0, pf_floor-1) / 1.25)
        + 15 * math.tanh(max(0, net_floor) / 7.5)
        + 10 * max(0, 1-min(dd_worst, 10)/10)
        + 5 * consistency
    )
    return score, {"is_wilson_lb": iw, "oos_wilson_lb": ow,
                   "robust_wilson_wr": robust_wr, "net_floor": net_floor,
                   "pf_floor": pf_floor, "worst_dd": dd_worst,
                   "wr_gap": abs((wr or 0)-(owr or 0))}


def read_record(coin: str, offset: int) -> dict:
    with open(os.path.join(HERE, "results", coin + ".jsonl"), "rb") as fh:
        fh.seek(offset)
        return json.loads(fh.readline())


def rationale(p: dict, m: dict, q: dict) -> list[str]:
    out = [
        f"Win rate held at {m['win_rate']:.1f}% IS and {m['oos_win_rate']:.1f}% OOS "
        f"(95% conservative floor {q['robust_wilson_wr']:.1f}%).",
        f"The weaker side still produced {q['net_floor']:.2f}% net and PF {q['pf_floor']:.2f}; "
        f"worst drawdown was {q['worst_dd']:.2f}%.",
    ]
    exit_bits=[]
    if p.get("rrUsePartialTp"): exit_bits.append("partial profit-taking")
    if p.get("rrUseTrailSl"): exit_bits.append(f"a {p.get('rrTrailPct')}% trailing stop")
    if exit_bits: out.append("Exit behavior uses " + " and ".join(exit_bits) + ", which can protect the higher hit rate during reversals.")
    else: out.append("The result does not depend on partial exits or trailing-stop bookkeeping, making execution simpler to reproduce.")
    filters=[]
    for key,label in (("useG1","G1 momentum"),("useG3","G3 flow"),("useS4","S4 structure"),("useS5","S5 structure")):
        if p.get(key): filters.append(label)
    out.append("Active selective confirmations: " + (", ".join(filters) if filters else "the fixed MTF base filters") + ".")
    return out


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--no-partial", action="store_true", help="require rrUsePartialTp=false")
    args=ap.parse_args()
    base_params=json.load(open(os.path.join(HERE,"base_params.json")))
    base_params.pop("_comment", None)
    sync = ResultIndex(HERE)
    coins=[x.strip() for x in open(os.path.join(HERE,"coins.txt")) if x.strip() and not x.lstrip().startswith("#")]
    for c in coins: sync.sync(c)
    sync.db.close()
    db=sqlite3.connect(os.path.join(HERE,"index","leaderboard.sqlite3"))
    output={"generated_utc":datetime.now(timezone.utc).isoformat(),
            "method":{"objective":"55% confidence-adjusted weaker-side WR; 15% weaker PF; 15% weaker net; 10% worst DD; 5% WR consistency",
                      "strict_gates":"IS trades>=50, OOS trades>=30, both net>0, both PF>=1.10, both DD<=8%",
                      "partial_tp_allowed":not args.no_partial,
                      "warning":"OOS is optimized here and is consumed; forward/paper validation is mandatory."},"coins":{}}
    title="15m MTF Lean — full-exit win-quality audit" if args.no_partial else "15m MTF Lean — win-quality multi-objective audit"
    md=[f"# {title}","",
        "**Research shortlist only.** OOS was included in selection and is therefore no longer an independent validation set. A fresh forward/paper period is mandatory.","",
        "Score priority: confidence-adjusted win rate on the weaker side (55%), weaker-side PF (15%), weaker-side net (15%), worst DD (10%), IS/OOS win-rate consistency (5%).","",
        "| Coin | Verdict | IS net/DD/WR/PF/T | OOS net/DD/WR/PF/T | Robust WR floor | Quality |","|---|---|---:|---:|---:|---:|"]
    for coin in coins:
        rows=db.execute("""SELECT file_offset,score,net,dd,wr,trades,pf,onet,odd,owr,otr,opf
                           FROM results WHERE coin=? AND trades>=50 AND otr>=30
                           AND net>0 AND onet>0 AND pf>=1.10 AND opf>=1.10
                           AND dd<=8 AND odd<=8""",(coin,)).fetchall()
        def eligible_full_exit(source_rows):
            if not args.no_partial: return source_rows
            kept=[]
            # Offsets are sorted to keep the scan sequential even for coins with
            # tens of thousands of metric-qualified records.
            path=os.path.join(HERE,"results",coin+".jsonl")
            with open(path,"rb") as fh:
                for row in sorted(source_rows,key=lambda r:r[0]):
                    fh.seek(row[0]); rec=json.loads(fh.readline())
                    if rec.get("params",{}).get("rrUsePartialTp") is False: kept.append(row)
            return kept
        rows=eligible_full_exit(rows)
        strict=True
        if not rows:
            strict=False
            # Best available diagnostic config; it is explicitly not endorsed.
            rows=db.execute("""SELECT file_offset,score,net,dd,wr,trades,pf,onet,odd,owr,otr,opf
                               FROM results WHERE coin=? AND trades>=50 AND otr>=15
                               AND net>0 AND onet>0 AND pf>1 AND opf>1
                               AND dd<=10 AND odd<=10""",(coin,)).fetchall()
            rows=eligible_full_exit(rows)
        if not rows:
            output["coins"][coin]={"verdict":"NO QUALIFYING CONFIG","params":None}
            md.append(f"| {coin} | NO QUALIFYING CONFIG | — | — | — | — |")
            continue
        ranked=[]
        for row in rows:
            s,q=quality(row); ranked.append((s,q,row))
        s,q,row=max(ranked,key=lambda x:(x[0],x[1]["robust_wilson_wr"],x[1]["pf_floor"],x[1]["net_floor"],-x[1]["worst_dd"]))
        rec=read_record(coin,row[0]); m=rec["metrics"]; p=rec.get("params",{})
        # Breadth around a useful region is a guard against isolated lucky points.
        breadth=sum(1 for x in ranked if x[0] >= s-3)
        observed_floor=min(m["win_rate"], m["oos_win_rate"])
        verdict=("STRONG FORWARD-TEST CANDIDATE" if strict and q["robust_wilson_wr"]>=45 and q["pf_floor"]>=1.25 and breadth>=20
                 else "HIGH-WR FORWARD-TEST CANDIDATE" if strict and observed_floor>=55 and q["robust_wilson_wr"]>=40 and q["pf_floor"]>=1.15
                 else "BALANCED PAPER CANDIDATE" if strict
                 else "NO LIVE CONFIG — BEST DIAGNOSTIC ONLY")
        item={"verdict":verdict,"quality_score":round(s,3),"robustness_near_best":breadth,
              "confidence":{k:round(v,3) for k,v in q.items()},"metrics":m,"params":p,
              "full_params":{**base_params, **p},
              "why":rationale(p,m,q),"timestamp":rec.get("ts")}
        output["coins"][coin]=item
        a=f"{m['net_pct']:.1f}/{m['dd_pct']:.1f}/{m['win_rate']:.1f}/{m['profit_factor']:.2f}/{m['trades']}"
        b=f"{m['oos_net_pct']:.1f}/{m['oos_dd_pct']:.1f}/{m['oos_win_rate']:.1f}/{m['oos_profit_factor']:.2f}/{m['oos_trades']}"
        md.append(f"| {coin} | {verdict} | {a} | {b} | {q['robust_wilson_wr']:.1f}% | {s:.1f} |")
    for coin,x in output["coins"].items():
        if not x.get("params"): continue
        md += ["",f"## {coin} — {x['verdict']}",""]+[f"- {z}" for z in x["why"]]+["","```json",json.dumps(x["params"],ensure_ascii=False,indent=2),"```"]
    db.close()
    stamp=datetime.now(timezone.utc).date().isoformat()
    stem=f"LEAN15M_FULL_EXIT_WIN_QUALITY_{stamp}" if args.no_partial else f"LEAN15M_WIN_QUALITY_{stamp}"
    jp=os.path.join(ROOT,stem+".json")
    mp=os.path.join(ROOT,stem+".md")
    with open(jp,"w") as f: json.dump(output,f,ensure_ascii=False,indent=2)
    with open(mp,"w") as f: f.write("\n".join(md)+"\n")
    print(mp); print(jp)

if __name__ == "__main__": main()
