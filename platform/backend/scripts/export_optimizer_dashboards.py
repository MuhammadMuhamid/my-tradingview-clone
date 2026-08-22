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
# Keyed by the API's optimizerKey(timeframe, system): the leaderboard route reads
# <family>.json from OPTIMIZER_DASHBOARD_DIR. Only ma_rr_v9 uses these snapshots —
# srtrend_v10 is served straight from its tree, so sr_optimizer1h is not listed.
# The "current" (Nov 1, 2025) trees were removed on 2026-07-30.
SYSTEMS = {
    "optimizer1y15m": ("one-year", "15m"),
    "optimizer1y1h": ("one-year", "1h"),
    # MTF Confluence Lean, 5-minute chart TF, one-year window (added 2026-08-10).
    "optimizer1y5m": ("one-year", "5m"),
}


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


for key, (system, timeframe) in SYSTEMS.items():
    export(key, system, timeframe)
