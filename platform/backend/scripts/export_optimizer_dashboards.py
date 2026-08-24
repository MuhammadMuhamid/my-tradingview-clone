#!/usr/bin/env python3
"""Build small web-dashboard snapshots without loading JSONL histories in RAM."""
from __future__ import annotations

import glob
import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "dashboard"))
# X-04: this used to be a hand-written map keyed by the API's old
# optimizerKey(timeframe, system), which is why three trees that exist on disk
# were never exported and one entry named a tree that does not exist. The
# leaderboard route now reads `<tree id>.json` from OPTIMIZER_DASHBOARD_DIR, and
# the set of trees comes from the same registry the API uses: every directory
# under ROOT that owns a `tree.json`.


def load(path: str, fallback):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return fallback


def update_counts(here: str) -> dict[str, int]:
    cache_file = os.path.join(here, "index", "raw_counts.json")
    cache = load(cache_file, {})
    current = {}
    for path in sorted(glob.glob(os.path.join(here, "results", "*.jsonl"))):
        name, size = os.path.basename(path), os.path.getsize(path)
        prior = cache.get(name) or {}
        old_size, count = int(prior.get("size", 0)), int(prior.get("count", 0))
        if size < old_size:
            old_size, count = 0, 0
        if size > old_size:
            with open(path, "rb") as fh:
                fh.seek(old_size)
                count += sum(chunk.count(b"\n") for chunk in iter(lambda: fh.read(8 * 1024 * 1024), b""))
        current[name] = {"size": size, "count": count}
    os.makedirs(os.path.dirname(cache_file), exist_ok=True)
    tmp = cache_file + ".dashboard.tmp"
    with open(tmp, "w") as fh:
        json.dump(current, fh, separators=(",", ":"))
    os.replace(tmp, cache_file)
    return {name[:-6]: item["count"] for name, item in current.items()}


def export(family: str, system: str, timeframe: str) -> None:
    here = os.path.join(ROOT, family)
    cfg = load(os.path.join(here, "config.json"), {})
    counts = update_counts(here)
    rows = []
    for path in sorted(glob.glob(os.path.join(here, "best", "*.json"))):
        rec = load(path, None)
        if not rec:
            continue
        symbol = os.path.basename(path)[:-5]
        rows.append({
            "symbol": symbol,
            "score": rec.get("score"),
            "metrics": rec.get("metrics") or {},
            "tests": counts.get(symbol, 0),
        })
    rows.sort(key=lambda r: r["score"] if r["score"] is not None else float("-inf"), reverse=True)
    snapshot = {
        "system": system,
        "timeframe": cfg.get("timeframe", timeframe),
        "range": cfg.get("range", {}),
        "totalBacktests": sum(counts.values()),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "leaderboard": rows,
    }
    os.makedirs(OUT, exist_ok=True)
    tmp = os.path.join(OUT, family + ".json.tmp")
    with open(tmp, "w") as fh:
        json.dump(snapshot, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, os.path.join(OUT, family + ".json"))


def registered_trees() -> list[tuple[str, str, str]]:
    out = []
    for entry in sorted(os.listdir(ROOT)):
        meta = load(os.path.join(ROOT, entry, "tree.json"), None)
        if not meta:
            continue
        # Search trees are the only ones that publish a best/ leaderboard; the
        # walk-forward, holdout and replay trees publish fold reports instead.
        if meta.get("kind") != "search":
            continue
        out.append((entry, meta.get("system", ""), meta.get("timeframe", "")))
    return out


trees = registered_trees()
if not trees:
    print(f"no optimizer tree with a tree.json under {ROOT}", file=sys.stderr)
    raise SystemExit(1)
for key, system, timeframe in trees:
    export(key, system, timeframe)
    print(f"exported {key}")
