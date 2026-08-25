#!/usr/bin/env python3
"""Apply a batch of ledger updates to scripts/ledger/findings.json.

Usage:
    python3 scripts/ledger/update.py <<'JSON'
    {"last_phase": "...", "updates": {"X-05": {"disposition": "fixed", ...}}}
    JSON
"""
from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "scripts" / "ledger" / "findings.json"

payload = json.load(sys.stdin)
data = json.loads(SRC.read_text())
by_id = {f["id"]: f for f in data["findings"]}

if "last_phase" in payload:
    data["meta"]["last_phase"] = payload["last_phase"]

unknown = [k for k in payload.get("updates", {}) if k not in by_id]
if unknown:
    raise SystemExit(f"unknown finding ids: {unknown}")

for fid, patch in payload.get("updates", {}).items():
    by_id[fid].update(patch)

SRC.write_text(json.dumps(data, indent=1) + "\n")
print(f"updated {len(payload.get('updates', {}))} findings")
