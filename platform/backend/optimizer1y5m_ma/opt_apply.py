#!/usr/bin/env python3
"""Apply a local-optimizer result to the REAL TradingView chart for visual
validation. Same spec syntax as the TV autotuner:

    ma5m-apply DEXEUSDT        best one-year 5m config
    ma5m-apply DEXEUSDT:3      rank-3 one-year 5m result

Maps engine param names back to the chart's in_XX ids (tunables via
params.json ids; seed-context statics via idmap.json) and sets them through
the autotuner's CDP bridge. Stop the TV autotuner daemon first if it is
running, or it will overwrite the inputs on its next eval.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
TUNER = Path("/Users/muhammadmuhamid/Projects/supportandresistance strategy/tv_autotuner")
sys.path.insert(0, str(TUNER))

from autotuner import TVConnection, JS_FIND_STUDY, js_set_inputs, js_set_symbol  # noqa: E402
import time  # noqa: E402


def ranked(coin: str) -> list:
    f = HERE / "results" / f"{coin}.jsonl"
    if not f.exists():
        raise SystemExit(f"No optimizer results for {coin}")
    seen, recs = set(), []
    for line in f.read_text().splitlines():
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        g = tuple(r.get("genome") or [])
        if g in seen or r.get("score") is None:
            continue
        seen.add(g)
        recs.append(r)
    recs.sort(key=lambda r: r["score"], reverse=True)
    return recs


def main() -> None:
    spec = sys.argv[1] if len(sys.argv) > 1 else ""
    if not spec:
        raise SystemExit("usage: ma5m-apply COIN[:rank]")
    rank = None
    if ":" in spec and spec.rsplit(":", 1)[-1].isdigit():
        spec, r = spec.rsplit(":", 1)
        rank = int(r)
    coin = spec.split(":")[-1].upper()

    if rank is None:
        f = HERE / "best" / f"{coin}.json"
        if not f.exists():
            raise SystemExit(f"No best yet for {coin}")
        rec = json.loads(f.read_text())
    else:
        recs = ranked(coin)
        if not (1 <= rank <= len(recs)):
            raise SystemExit(f"{coin} has {len(recs)} results — pick 1..{len(recs)}")
        rec = recs[rank - 1]

    space = json.loads((HERE / "params.json").read_text())["parameters"]
    idmap = json.loads((HERE / "idmap.json").read_text())
    name2id = {v: k for k, v in idmap.items()}

    pairs = {}
    params = rec.get("params") or {}
    for p in space:
        if p["name"] in params:
            pairs[p["id"]] = params[p["name"]]
    # seed-context statics recorded with the result
    ctx = (rec.get("context") or {}).get("ctx") or {}
    for name, v in ctx.items():
        if name in name2id:
            pairs[name2id[name]] = v

    m = rec.get("metrics") or {}
    print(f"Applying {coin} rank {'best' if rank is None else rank}: "
          f"net {m.get('net_pct')}% dd {m.get('dd_pct')}% trades {m.get('trades')} "
          f"({len(pairs)} inputs)")
    tv = TVConnection()
    tv.ensure_tv_running()
    tv.eval(js_set_symbol(f"BINANCE:{coin}"))
    time.sleep(6)
    sid = None
    for _ in range(30):
        sid = tv.eval(JS_FIND_STUDY)
        if sid:
            break
        time.sleep(2)
    if not sid:
        raise SystemExit("strategy study not found on chart")
    tv.eval(js_set_inputs(sid, pairs))
    print("Applied. NOTE: local engine used Nov 1 2025 → today, 0.1% commission — "
          "set the same range/properties in the Strategy Tester to compare.")
    tv.close()


if __name__ == "__main__":
    main()
