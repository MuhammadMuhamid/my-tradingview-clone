#!/usr/bin/env python3
"""Extract the top-N MTF Lean 15m configs per coin, ranked by optimizer score.

Scans lean_optimizer15m/results/*.jsonl directly rather than the tree's sqlite
index — that index is stale (9 of 19 coins had zero rows when last checked), so
trusting it would silently test the wrong configs.

Ordering is `score DESC, file order ASC`, matching what `lean15m-results <coin>`
would show once its index is rebuilt.

    python3 lean3y15m/extract_top.py [--top 1000]
"""
import heapq, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OPT = os.path.join(HERE, "..", "lean_optimizer15m")
OUTDIR = os.path.join(HERE, "configs")

top = 1000
if "--top" in sys.argv:
    top = int(sys.argv[sys.argv.index("--top") + 1])

coins = [l.strip() for l in open(os.path.join(OPT, "coins.txt"))
         if l.strip() and not l.startswith("#")]
os.makedirs(OUTDIR, exist_ok=True)

for coin in coins:
    path = os.path.join(OPT, "results", f"{coin}.jsonl")
    if not os.path.exists(path):
        print(f"{coin:14} no results file — skipped")
        continue
    heap = []          # (score, -seq) so ties keep the earlier record, like the CLI
    seq = 0
    with open(path, "rb") as fh:
        for raw in fh:
            i = raw.rfind(b'"score":')
            if i < 0:
                continue
            j = i + 8
            while j < len(raw) and raw[j] in b' ':
                j += 1
            k = j
            while k < len(raw) and raw[k] in b'-+.0123456789eE':
                k += 1
            try:
                score = float(raw[j:k])
            except ValueError:
                continue
            seq += 1
            item = (score, -seq, raw)
            if len(heap) < top:
                heapq.heappush(heap, item)
            elif item > heap[0]:
                heapq.heapreplace(heap, item)
    ranked = sorted(heap, key=lambda t: (-t[0], -t[1]))
    out = []
    for rank, (score, _, raw) in enumerate(ranked, 1):
        try:
            rec = json.loads(raw)
        except Exception:
            continue
        m = rec.get("metrics") or {}
        out.append({"rank": rank,
                    "in_sample": {"score": score, "net": m.get("net_pct"), "dd": m.get("dd_pct"),
                                  "wr": m.get("win_rate"), "trades": m.get("trades"),
                                  "legs": m.get("legs"), "pf": m.get("profit_factor")},
                    "params": rec["params"]})
    with open(os.path.join(OUTDIR, f"{coin}.json"), "w") as fh:
        json.dump(out, fh)
    print(f"{coin:14} {len(out):>5} configs from {seq:>7} evals  "
          f"(best score {ranked[0][0]:.1f}, worst kept {ranked[-1][0]:.1f})")
