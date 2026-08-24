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
    "docs/OPERATIONS.md",
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


# ── 4: a documented search space must match the params.json it describes ─────


def space_size(tree: pathlib.Path) -> tuple[int, int] | None:
    """(parameter count, combination count) read from a tree's params.json."""
    params = tree / "params.json"
    if not params.exists():
        return None
    try:
        parameters = json.loads(params.read_text())["parameters"]
    except (json.JSONDecodeError, KeyError, TypeError):
        fail(f"{tree.name}/params.json has no readable `parameters` list")
        return None
    combos = 1
    for p in parameters:
        combos *= max(1, len(p.get("values") or []))
    return len(parameters), combos


DOC_TUNABLES = re.compile(r"\*\*(?P<n>\d+) tunables kept", re.M)
DOC_COMBOS = re.compile(r"Space is \*\*(?P<n>[\d,]+)\*\* combinations", re.M)


def check_documented_space() -> None:
    """OPT-15: `PARAMETER_REDUCTION.md` said 7 tunables and 185,220 combinations.

    Measured from `params.json`: 8 and 370,440 — `useSuperTrend` was restored to
    the search and the document was never updated. The figures are recomputed
    here so the two cannot drift apart again.
    """
    for doc in sorted(TREES.glob("*/PARAMETER_REDUCTION.md")):
        tree = doc.parent
        actual = space_size(tree)
        if actual is None:
            fail(f"{tree.name}/PARAMETER_REDUCTION.md exists but the tree has no params.json")
            continue
        n_params, n_combos = actual
        text = doc.read_text()
        m = DOC_TUNABLES.search(text)
        if not m:
            fail(f"{tree.name}/PARAMETER_REDUCTION.md must state '**N tunables kept**'")
        elif int(m.group("n")) != n_params:
            fail(f"{tree.name}/PARAMETER_REDUCTION.md says {m.group('n')} tunables, "
                 f"params.json has {n_params}")
        m = DOC_COMBOS.search(text)
        if not m:
            fail(f"{tree.name}/PARAMETER_REDUCTION.md must state 'Space is **N** combinations'")
        elif int(m.group("n").replace(",", "")) != n_combos:
            fail(f"{tree.name}/PARAMETER_REDUCTION.md says {m.group('n')} combinations, "
                 f"params.json has {n_combos:,}")


# ── 5: a walk-forward tree must say whether it validates the live space ──────


def check_walkforward_space() -> None:
    """OPT-02: `lean_wf_15m/config.json` claimed its search space was 'exactly as
    lean_optimizer15m has it (qty_pct_equity still searched)'. Both halves were
    false — 30 parameters against 18, and the production tree pins
    `qty_pct_equity` to 0 — so the current production space had no walk-forward
    evidence at all and nothing said so.

    Each walk-forward tree therefore declares `spaceDivergesFromProduction`, and
    that claim is recomputed here against the two `params.json` files.
    """
    trees = {}
    for meta_path in sorted(TREES.glob("*/tree.json")):
        try:
            trees[meta_path.parent.name] = json.loads(meta_path.read_text())
        except json.JSONDecodeError:
            continue   # reported by check_tree_registry
    production = {
        (m["strategy"], m["timeframe"]): name
        for name, m in trees.items() if m.get("kind") == "search"
    }
    for name, meta in trees.items():
        if meta.get("kind") != "walk-forward":
            continue
        declared = meta.get("spaceDivergesFromProduction")
        if declared is None:
            fail(f"{name}/tree.json must declare `spaceDivergesFromProduction` (OPT-02)")
            continue
        counterpart = production.get((meta["strategy"], meta["timeframe"]))
        if counterpart is None:
            fail(f"{name} is a walk-forward for {meta['strategy']} {meta['timeframe']}, "
                 "which has no production search tree")
            continue

        def names(tree_name: str) -> set[str] | None:
            f = TREES / tree_name / "params.json"
            if not f.exists():
                return None
            try:
                return {p["name"] for p in json.loads(f.read_text())["parameters"]}
            except (json.JSONDecodeError, KeyError, TypeError):
                return None

        mine, theirs = names(name), names(counterpart)
        if mine is None or theirs is None:
            fail(f"cannot compare {name} with {counterpart}: a params.json is missing or unreadable")
            continue
        actually_diverges = mine != theirs
        if actually_diverges != bool(declared):
            fail(
                f"{name}/tree.json says spaceDivergesFromProduction={declared}, but its space "
                f"{'differs from' if actually_diverges else 'matches'} {counterpart} "
                f"({len(mine)} vs {len(theirs)} parameters)"
            )


check_cost_models()
check_tree_registry()
check_documented_space()
check_walkforward_space()
check_referenced_paths()

if failures:
    print("documentation check failed:", file=sys.stderr)
    for f in failures:
        print(f"  - {f}", file=sys.stderr)
    sys.exit(1)
print("documentation check clean")
