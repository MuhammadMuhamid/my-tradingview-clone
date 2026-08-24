#!/usr/bin/env python3
"""Assert that documentation matches the repository it describes.

Checks:
  1. Every optimizer tree named in docs/COST-MODELS.md exists on disk.
  2. Every cost-model figure in that table matches the tree's config.json.
  3. Every repository-relative path referenced in a backtick in the root docs
     listed in DOC_PATH_SOURCES exists (or is explicitly known-absent).
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
TREES = ROOT / "platform" / "backend"
COSTS = ROOT / "docs" / "COST-MODELS.md"

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


# ── 1 + 2: cost-model table against config.json ───────────────────────────────

ROW = re.compile(
    r"^\|\s*`(?P<tree>[a-z0-9_]+)`\s*\|\s*(?P<tf>[^|]+?)\s*\|"
    r"\s*(?P<cap>[\d ]+)\s*\|\s*(?P<comm>[\d.]+)\s*\|\s*\*{0,2}(?P<slip>\d+)\*{0,2}\s*\|",
    re.M,
)


def check_cost_models() -> None:
    if not COSTS.exists():
        fail(f"missing {COSTS.relative_to(ROOT)}")
        return
    text = COSTS.read_text()
    rows = list(ROW.finditer(text))
    if not rows:
        fail("docs/COST-MODELS.md has no parsable cost table rows")
        return

    documented = set()
    for m in rows:
        tree = m.group("tree")
        documented.add(tree)
        cfg_path = TREES / tree / "config.json"
        if not cfg_path.exists():
            fail(f"docs/COST-MODELS.md names tree '{tree}' but {cfg_path.relative_to(ROOT)} does not exist")
            continue
        cfg = json.loads(cfg_path.read_text())
        expect = {
            "initialCapital": int(m.group("cap").replace(" ", "")),
            "commissionPct": float(m.group("comm")),
            "slippageTicks": int(m.group("slip")),
        }
        for key, want in expect.items():
            got = cfg.get(key)
            if got is None:
                fail(f"{tree}/config.json has no '{key}' but the docs state {want}")
            elif float(got) != float(want):
                fail(f"{tree}/config.json {key}={got} but docs/COST-MODELS.md says {want}")

    on_disk = {p.parent.name for p in TREES.glob("*/config.json")}
    for tree in sorted(on_disk - documented):
        fail(f"tree '{tree}' has a config.json but is not documented in docs/COST-MODELS.md")


# ── 2b: every tree owns a registry entry the API can route to (X-04) ──────────

REQUIRED_TREE_FIELDS = ("id", "strategy", "timeframe", "system", "kind", "status", "label")
TREE_KINDS = {"search", "walk-forward", "holdout", "replay"}
TREE_STATUSES = {"current", "historical", "not-comparable"}


def check_tree_registry() -> None:
    """A tree the optimizer API cannot reach is finding X-04 all over again.

    The route resolves trees from `<tree>/tree.json`, so a tree that has a
    config.json but no registry entry is invisible to the application and would
    render as an empty, successful leaderboard.
    """
    for cfg in sorted(TREES.glob("*/config.json")):
        tree = cfg.parent.name
        meta_path = cfg.parent / "tree.json"
        if not meta_path.exists():
            fail(f"tree '{tree}' has no tree.json, so the optimizer API cannot route to it (X-04)")
            continue
        try:
            meta = json.loads(meta_path.read_text())
        except json.JSONDecodeError as exc:
            fail(f"{tree}/tree.json is not valid JSON: {exc}")
            continue
        for field in REQUIRED_TREE_FIELDS:
            if not str(meta.get(field, "")).strip():
                fail(f"{tree}/tree.json is missing '{field}'")
        if meta.get("id") not in (tree, None):
            fail(f"{tree}/tree.json declares id '{meta.get('id')}' but lives in '{tree}'")
        if meta.get("kind") not in TREE_KINDS:
            fail(f"{tree}/tree.json has kind '{meta.get('kind')}', not one of {sorted(TREE_KINDS)}")
        if meta.get("status") not in TREE_STATUSES:
            fail(f"{tree}/tree.json has status '{meta.get('status')}', not one of {sorted(TREE_STATUSES)}")


# ── 3: referenced paths exist ─────────────────────────────────────────────────

DOC_PATH_SOURCES = [
    "README.md",
    "docs/ARCHITECTURE.md",
    "docs/COST-MODELS.md",
    "docs/WEBHOOK-CONTRACT.md",
    "docs/REMEDIATION-LEDGER.md",
    "docs/RESEARCH-METHODOLOGY.md",
    "docs/CANDLE-PERFORMANCE.md",
    "docs/WEB-QA.md",
    "docs/ALERTS.md",
]

# A backticked token that looks like a repository path.
PATHISH = re.compile(r"`([A-Za-z0-9_][A-Za-z0-9_./-]*/[A-Za-z0-9_./-]*)`")
# Paths the docs mention precisely because they are absent or are runtime-only.
KNOWN_ABSENT_MARKER = "KNOWN-ABSENT"
# `bg-warn/10`, `text-ink-muted/50` — a utility class, not a path.
TAILWIND_CLASS = re.compile(
    r"(?:bg|text|border|ring|fill|stroke|divide|from|to|via|outline|shadow|accent|decoration|caret|placeholder)"
    r"-[a-z0-9-]+/\d{1,3}"
)


def check_referenced_paths() -> None:
    for rel in DOC_PATH_SOURCES:
        doc = ROOT / rel
        if not doc.exists():
            fail(f"documented source {rel} does not exist")
            continue
        for i, line in enumerate(doc.read_text().splitlines(), start=1):
            if KNOWN_ABSENT_MARKER in line:
                continue
            for candidate in PATHISH.findall(line):
                # `bot:` marks a path in the execution-bot repository.
                if candidate.startswith("bot:"):
                    continue
                if candidate.startswith(("http", "/api/", "api/", "@")):
                    continue
                # `owner/repo` GitHub references are not repository paths.
                if re.fullmatch(r"MuhammadMuhamid/[A-Za-z0-9_.-]+", candidate):
                    continue
                if any(ch in candidate for ch in "<>*{}"):
                    continue
                # A Tailwind utility with an opacity modifier — `bg-warn/10`,
                # `border-down/30` — is a CSS class, not a repository path.
                if TAILWIND_CLASS.fullmatch(candidate):
                    continue
                target = ROOT / candidate.rstrip("/")
                if not target.exists():
                    fail(f"{rel}:{i} references '{candidate}' which does not exist")


check_cost_models()
check_tree_registry()
check_referenced_paths()

if failures:
    print("documentation check failed:", file=sys.stderr)
    for f in failures:
        print(f"  - {f}", file=sys.stderr)
    sys.exit(1)
print("documentation check clean")
