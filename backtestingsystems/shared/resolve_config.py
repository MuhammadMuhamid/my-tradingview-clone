#!/usr/bin/env python3
"""Resolve a coin's optimizer config by the SAME ORIG# the `opt-results`
leaderboard shows. Reads the frozen sqlite index (index/leaderboard.sqlite3),
maps ORIG# -> file_offset -> the exact record in results/<coin>.jsonl, and
prints the full runnable params (base_params + record.params) + metrics +
properties as JSON. This is drift-proof: it never re-ranks the live file, so it
always matches what the user screenshotted.

    python3 scripts/resolve_config.py ALLOUSDT 263
"""
import json
import os
import sqlite3
import sys

BASE = os.path.dirname(os.path.abspath(__file__))


def main() -> None:
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: resolve_config.py COIN ORIG# [optimizer_dir]"}))
        return
    coin = sys.argv[1].upper()
    orig = int(sys.argv[2])
    optdir = sys.argv[3] if len(sys.argv) > 3 else "optimizer"
    HERE = os.path.join(BASE, "..", optdir)
    db = sqlite3.connect(os.path.join(HERE, "index", "leaderboard.sqlite3"))
    row = db.execute(
        """
        WITH r AS (
          SELECT file_offset, net, dd, wr, trades, pf,
                 row_number() OVER (ORDER BY score DESC, file_offset ASC) AS orig
          FROM results WHERE coin=?
        ) SELECT file_offset, net, dd, wr, trades, pf FROM r WHERE orig=?
        """,
        (coin, orig),
    ).fetchone()
    if not row:
        n = db.execute("SELECT count(*) FROM results WHERE coin=?", (coin,)).fetchone()[0]
        print(json.dumps({"error": f"{coin}: ORIG# {orig} not in index (has {n} indexed configs — run opt-results {coin} first)"}))
        return
    offset = row[0]
    with open(os.path.join(HERE, "results", coin + ".jsonl"), "rb") as fh:
        fh.seek(offset)
        rec = json.loads(fh.readline())
    base = json.load(open(os.path.join(HERE, "base_params.json")))
    full = {**base, **(rec.get("params") or {})}
    m = rec.get("metrics") or {}
    qty_pct = float(full.get("qty_pct_equity") or 0)
    qty_cash = float(full.get("qty_cash") or 930)
    props = {
        "initialCapital": 1000,
        "qtyCash": qty_cash,
        "qtyType": "percent_of_equity" if qty_pct > 0 else "cash",
        "qtyValue": qty_pct if qty_pct > 0 else qty_cash,
        "commissionPct": 0.1,
        "slippageTicks": 0,
    }
    print(json.dumps({
        "orig": orig,
        "params": full,
        "metrics": {
            "net_pct": m.get("net_pct"), "dd_pct": m.get("dd_pct"),
            "win_rate": m.get("win_rate"), "trades": m.get("trades"),
            "profit_factor": m.get("profit_factor"),
        },
        "properties": props,
    }))


main()
