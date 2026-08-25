#!/usr/bin/env python3
"""Render docs/REMEDIATION-LEDGER.md from scripts/ledger/findings.json.

The JSON is the source of truth. Run this after editing it; CI re-runs it with
--check and fails if the committed Markdown differs, so the two cannot drift.
"""
from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "scripts" / "ledger" / "findings.json"
OUT = ROOT / "docs" / "REMEDIATION-LEDGER.md"

DISPOSITIONS = {
    "fixed": "fixed",
    "corrected": "audit finding corrected or stale",
    "preserved": "intentionally preserved",
    "blocked": "blocked by Mahamid/external evidence",
    "deferred": "deferred by an explicit dependency",
    "excluded": "excluded — market report says not worth building",
    "open": "not yet dispositioned",
}

ORDER = ["X", "BE", "BOT", "OPT", "FE", "TV"]
SECTION_TITLE = {
    "X": "Cross-system (`X-*`)",
    "BE": "Platform backend (`BE-*`)",
    "BOT": "Execution bot (`BOT-*`)",
    "OPT": "Research, optimizer and operations (`OPT-*`)",
    "FE": "Platform frontend (`FE-*`)",
    "TV": "Experimental TradingView trees (`TV-*`)",
}


def sort_key(fid: str) -> tuple:
    prefix, num = fid.split("-", 1)
    digits = "".join(c for c in num if c.isdigit())
    return (ORDER.index(prefix), int(digits or 0), num)


def render() -> str:
    data = json.loads(SRC.read_text())
    findings = data["findings"]
    meta = data["meta"]

    seen = set()
    for f in findings:
        if f["id"] in seen:
            raise SystemExit(f"duplicate finding id: {f['id']}")
        seen.add(f["id"])

    counts: dict[str, int] = {}
    for f in findings:
        counts[f["disposition"]] = counts.get(f["disposition"], 0) + 1

    lines: list[str] = []
    w = lines.append
    w("# Remediation ledger")
    w("")
    w("**Status:** current. Generated from `scripts/ledger/findings.json` by")
    w("`scripts/ledger/render.py`; CI fails if the two disagree. Do not hand-edit this file.")
    w("")
    w(f"Audit of {meta['audit_date']}, {len(findings)} findings. Last updated after **{meta['last_phase']}**.")
    w("")
    w("Every finding identifier in the audit's findings register appears here exactly")
    w("once. A finding is marked `fixed` only when code changed and a test or an")
    w("explicit check proves the new behaviour — never because documentation was updated.")
    w("")
    w("## Totals")
    w("")
    w("| Disposition | Count |")
    w("|---|---:|")
    for key, label in DISPOSITIONS.items():
        if counts.get(key):
            w(f"| {label} | {counts[key]} |")
    w(f"| **total** | **{len(findings)}** |")
    w("")
    w("## Scope reserved for Mahamid")
    w("")
    w("No work in this programme performed, attempted or simulated any of the")
    w("following, and no finding is marked `fixed` on the strength of one:")
    w("")
    for item in meta["mahamid_scope"]:
        w(f"- {item}")
    w("")

    for prefix in ORDER:
        group = sorted(
            [f for f in findings if f["id"].startswith(prefix + "-")],
            key=lambda f: sort_key(f["id"]),
        )
        if not group:
            continue
        w(f"## {SECTION_TITLE[prefix]}")
        w("")
        w("| Id | Repo | Status verified | Disposition | Phase | Commit | Evidence | Remaining risk |")
        w("|---|---|---|---|---|---|---|---|")
        for f in group:
            w("| `{id}` | {repo} | {verified} | {disp} | {phase} | {commit} | {evidence} | {risk} |".format(
                id=f["id"],
                repo=f.get("repo", "—"),
                verified=f.get("verified", "—"),
                disp=DISPOSITIONS[f["disposition"]],
                phase=f.get("phase", "—"),
                commit=f"`{f['commit']}`" if f.get("commit") else "—",
                evidence=f.get("evidence", "—"),
                risk=f.get("risk", "—"),
            ))
        w("")
    return "\n".join(lines) + "\n"


def main() -> int:
    text = render()
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text() != text:
            print("docs/REMEDIATION-LEDGER.md is out of date — run scripts/ledger/render.py", file=sys.stderr)
            return 1
        print("remediation ledger in sync")
        return 0
    OUT.write_text(text)
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
