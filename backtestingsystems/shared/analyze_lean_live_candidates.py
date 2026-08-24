#!/usr/bin/env python3
"""Select provisional Lean configs without pretending OOS is a second optimizer.

The GA ranks IS only.  For each coin we walk that IS ranking and accept the first
row that clears fixed, pre-declared OOS/risk gates.  OOS is therefore a veto,
not a quantity maximised across millions of trials.  The report still labels the
OOS window consumed: a later forward/paper window is required before live use.
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
import sys
import argparse
from collections import Counter
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from indexed_results import ResultIndex
SYSTEMS = {
    "5m": {"dir": "optimizer1y5m", "min_is": 100, "min_oos": 30},
    "15m": {"dir": "lean_optimizer15m", "min_is": 50, "min_oos": 15},
}


def read_at(path: str, offset: int) -> dict:
    with open(path, "rb") as fh:
        fh.seek(offset)
        return json.loads(fh.readline())


def safe(v, default=0.0):
    return default if v is None else float(v)


def classify(m: dict, min_oos: int, held_share: float, survivor_count: int) -> tuple[str, list[str]]:
    reasons = []
    if safe(m.get("oos_net_pct")) <= 0: reasons.append("OOS net is not positive")
    if safe(m.get("oos_profit_factor")) < 1.05: reasons.append("OOS PF < 1.05")
    if int(m.get("oos_trades") or 0) < min_oos: reasons.append("too few OOS entries")
    if safe(m.get("oos_dd_pct")) > 8: reasons.append("OOS DD > 8%")
    if survivor_count < 8: reasons.append("fewer than 8 distinct IS+OOS survivors")
    if held_share < 0.01: reasons.append("<1% of tested configs held both windows")
    if reasons: return "NO LIVE CONFIG", reasons
    if held_share >= 0.10 and survivor_count >= 40 and safe(m.get("oos_profit_factor")) >= 1.20:
        return "STRONG PAPER CANDIDATE", ["broad IS+OOS survival and adequate sample"]
    return "PAPER CANDIDATE", ["passed fixed gates, but forward validation is still required"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--system", choices=["5m", "15m"], action="append")
    args = parser.parse_args()
    selected_systems = args.system or list(SYSTEMS)
    output = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "method": "highest IS score that clears fixed OOS veto gates; OOS not maximised",
        "systems": {},
    }
    md = [
        "# MTF Confluence Lean — provisional live-candidate audit",
        "",
        "**Important:** these are not promises of future profit. The OOS window has now been used as a selection veto, so it is no longer untouched. Every candidate must pass a later forward/paper-trading window before real money.",
        "",
    ]
    for tf in selected_systems:
        spec = SYSTEMS[tf]
        here = os.path.join(ROOT, spec["dir"])
        cfg = json.load(open(os.path.join(here, "config.json")))
        space = json.load(open(os.path.join(here, "params.json")))["parameters"]
        option_count = {p["name"]: len(p["values"]) for p in space}
        conn = sqlite3.connect(os.path.join(here, "index", "leaderboard.sqlite3"))
        coins = [x.strip() for x in open(os.path.join(here, "coins.txt"))
                 if x.strip() and not x.lstrip().startswith("#")]
        # The default no-argument CLI reads best/*.json and does not guarantee
        # every raw JSONL tail is indexed. Force the complete incremental sync
        # before making cross-coin claims.
        syncer = ResultIndex(here)
        for coin in coins:
            syncer.sync(coin)
            print(f"synced {tf} {coin}", flush=True)
        syncer.db.close()
        sysout = {"config": cfg, "coins": {}}
        md += [f"## {tf} system", "", "| Coin | Verdict | IS net/DD/PF/trades | OOS net/DD/PF/trades | Held breadth | IS rank |", "|---|---|---:|---:|---:|---:|"]
        for coin in coins:
            total = conn.execute("SELECT count(*) FROM results WHERE coin=? AND onet IS NOT NULL", (coin,)).fetchone()[0]
            held = conn.execute("SELECT count(*) FROM results WHERE coin=? AND net>0 AND onet>0 AND pf>1 AND opf>1", (coin,)).fetchone()[0]
            held_share = held / total if total else 0
            rows = conn.execute("""
                SELECT file_offset,score,net,dd,wr,trades,pf,onet,odd,owr,otr,opf
                FROM results WHERE coin=? ORDER BY score DESC,file_offset ASC
            """, (coin,)).fetchall()
            chosen = None
            rank = None
            # OOS is a fixed veto only. We never sort by any OOS field.
            for i, row in enumerate(rows, 1):
                off, score, net, dd, wr, tr, pf, onet, odd, owr, otr, opf = row
                if (tr or 0) < spec["min_is"] or (otr or 0) < spec["min_oos"]: continue
                if safe(net) <= 0 or safe(onet) <= 0: continue
                if safe(pf) < 1.10 or safe(opf) < 1.05: continue
                if safe(dd) > 8 or safe(odd) > 8: continue
                chosen, rank = read_at(os.path.join(here, "results", coin + ".jsonl"), off), i
                break

            # Agreement among the strongest 40 survivors: useful for identifying
            # parameters that sit on a plateau, not for changing the chosen row.
            surv_rows = conn.execute("""
                SELECT file_offset FROM results
                WHERE coin=? AND net>0 AND onet>0 AND pf>1 AND opf>1
                ORDER BY score DESC,file_offset ASC LIMIT 40
            """, (coin,)).fetchall()
            surv = [read_at(os.path.join(here, "results", coin + ".jsonl"), x[0]) for x in surv_rows]
            consensus = {}
            if surv:
                for name, k in option_count.items():
                    vals = [r.get("params", {}).get(name) for r in surv]
                    c = Counter(json.dumps(v, sort_keys=True) for v in vals)
                    valj, n = c.most_common(1)[0]
                    p0 = 1 / max(k, 1)
                    denom = math.sqrt(len(vals) * p0 * (1-p0)) if k > 1 else 0
                    z = (n-len(vals)*p0)/denom if denom else 0
                    if z >= 2:
                        consensus[name] = {"value": json.loads(valj), "share": round(n/len(vals), 3), "z": round(z, 2)}

            if chosen:
                m = chosen["metrics"]
                verdict, why = classify(m, spec["min_oos"], held_share, held)
                record = {
                    "verdict": verdict, "why": why, "is_rank": rank,
                    "tested_unique": total, "survivors": held, "held_share": round(held_share, 5),
                    "metrics": m, "params": chosen.get("params", {}),
                    "consensus": consensus, "timestamp": chosen.get("ts"),
                }
                isn = f"{safe(m.get('net_pct')):.1f}/{safe(m.get('dd_pct')):.1f}/{safe(m.get('profit_factor')):.2f}/{int(m.get('trades') or 0)}"
                osn = f"{safe(m.get('oos_net_pct')):.1f}/{safe(m.get('oos_dd_pct')):.1f}/{safe(m.get('oos_profit_factor')):.2f}/{int(m.get('oos_trades') or 0)}"
                md.append(f"| {coin} | {verdict} | {isn} | {osn} | {held_share:.1%} ({held:,}) | {rank:,} |")
            else:
                record = {
                    "verdict": "NO LIVE CONFIG", "why": ["no IS-ranked row cleared all fixed OOS/risk gates"],
                    "tested_unique": total, "survivors": held, "held_share": round(held_share, 5),
                    "params": None, "consensus": consensus,
                }
                md.append(f"| {coin} | NO LIVE CONFIG | — | — | {held_share:.1%} ({held:,}) | — |")
            sysout["coins"][coin] = record
        conn.close()
        output["systems"][tf] = sysout
        md.append("")

        for coin, rec in sysout["coins"].items():
            if not rec.get("params"): continue
            m = rec["metrics"]
            md += [f"### {tf} — {coin}: {rec['verdict']}", "",
                   f"IS rank {rec['is_rank']:,}; IS {m['net_pct']}% net / {m['dd_pct']}% DD / PF {m['profit_factor']} / {m['trades']} entries. "
                   f"OOS {m['oos_net_pct']}% net / {m['oos_dd_pct']}% DD / PF {m['oos_profit_factor']} / {m['oos_trades']} entries.",
                   f"Survival breadth: {rec['survivors']:,}/{rec['tested_unique']:,} ({rec['held_share']:.1%}).",
                   "", "```json", json.dumps(rec["params"], ensure_ascii=False, indent=2), "```", ""]

    json_path = os.path.join(ROOT, "LEAN_LIVE_CANDIDATES_2026-08-19.json")
    md_path = os.path.join(ROOT, "LEAN_LIVE_CANDIDATES_2026-08-19.md")
    with open(json_path, "w") as fh: json.dump(output, fh, ensure_ascii=False, indent=2)
    with open(md_path, "w") as fh: fh.write("\n".join(md) + "\n")
    print(md_path)
    print(json_path)


if __name__ == "__main__":
    main()
