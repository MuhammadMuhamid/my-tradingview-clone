#!/usr/bin/env python3
"""Extract the top-N configs per coin from the live 1h leaderboard index.

Ordering is `score DESC, file_offset ASC` — identical to what
`opt1hyear-results <coin> best` prints, so this is the same set you see there.

    python3 holdout1h/extract_top.py [--top 1000]

Writes holdout1h/configs/<coin>.json. Read-only against the optimizer tree.
"""
import json, os, sqlite3, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OPT = os.path.join(HERE, "..", "optimizer1y1h")
OUTDIR = os.path.join(HERE, "configs")

top = 1000
if "--top" in sys.argv:
    top = int(sys.argv[sys.argv.index("--top") + 1])

coins = [l.strip() for l in open(os.path.join(OPT, "coins.txt"))
         if l.strip() and not l.startswith("#")]
os.makedirs(OUTDIR, exist_ok=True)
db = sqlite3.connect(f"file:{os.path.join(OPT, 'index', 'leaderboard.sqlite3')}?mode=ro", uri=True)

for coin in coins:
    rows = db.execute(
        "SELECT file_offset,score,net,dd,wr,trades,pf FROM results WHERE coin=? "
        "ORDER BY score DESC, file_offset ASC LIMIT ?", (coin, top)).fetchall()
    if not rows:
        print(f"{coin:14} no leaderboard rows — skipped")
        continue
    out = []
    with open(os.path.join(OPT, "results", f"{coin}.jsonl"), "rb") as fh:
        for i, (off, score, net, dd, wr, trades, pf) in enumerate(rows, 1):
            fh.seek(off)
            try:
                rec = json.loads(fh.readline())
            except Exception:
                continue
            out.append({"rank": i,
                        "in_sample": {"score": score, "net": net, "dd": dd,
                                      "wr": wr, "trades": trades, "pf": pf},
                        "params": rec["params"]})
    with open(os.path.join(OUTDIR, f"{coin}.json"), "w") as fh:
        json.dump(out, fh)
    print(f"{coin:14} {len(out):>5} configs  (best score {rows[0][1]:.1f}, worst kept {rows[-1][1]:.1f})")
db.close()
