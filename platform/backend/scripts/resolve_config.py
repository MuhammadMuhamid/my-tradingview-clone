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
    # OPT-11 / X-04: "optimizer" is a directory that does not exist. There is no
    # safe default here — a wrong tree silently resolves a config from the wrong
    # search space — so the argument is required.
    if len(sys.argv) > 3:
        optdir = sys.argv[3]
    else:
        trees = sorted(
            d for d in os.listdir(os.path.join(BASE, ".."))
            if os.path.isfile(os.path.join(BASE, "..", d, "config.json"))
        )
        print(json.dumps({
            "error": "the optimizer tree is required — there is no default. "
                     "A wrong tree resolves a config from the wrong search space.",
            "available": trees,
        }))
        return
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

    # OPT-11: read the COST MODEL FROM THE TREE, not from constants here.
    #
    # This used to hardcode initialCapital 1000, commissionPct 0.1 and
    # slippageTicks 0 regardless of which tree the config came from — a fourth
    # variant that no tree actually uses (X-09). The lean trees run
    # initialCapital 10000 with 2 ticks of slippage. Reproducing a leaderboard
    # row with the wrong friction produces a different number and no indication
    # that anything is wrong.
    #
    # `qty_cash` likewise defaulted to 930, a superseded figure.
    cfg_path = os.path.join(HERE, "config.json")
    try:
        cfg = json.load(open(cfg_path))
    except (OSError, ValueError) as exc:
        print(json.dumps({
            "error": f"cannot read the cost model from {optdir}/config.json: {exc}. "
                     "Refusing to guess — a wrong cost model silently changes every metric.",
        }))
        return

    missing = [k for k in ("initialCapital", "commissionPct", "slippageTicks") if k not in cfg]
    if missing:
        print(json.dumps({
            "error": f"{optdir}/config.json is missing {', '.join(missing)}. "
                     "Refusing to substitute defaults.",
        }))
        return

    qty_cash = float(full.get("qty_cash") or cfg.get("qtyCash") or 0)
    props = {
        "initialCapital": cfg["initialCapital"],
        "qtyCash": qty_cash,
        "qtyType": "percent_of_equity" if qty_pct > 0 else "cash",
        "qtyValue": qty_pct if qty_pct > 0 else qty_cash,
        "commissionPct": cfg["commissionPct"],
        "slippageTicks": cfg["slippageTicks"],
        # Named, so a reproduced number can be checked against the right tree.
        "sourceTree": optdir,
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
