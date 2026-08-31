#!/usr/bin/env python3
"""Validate current platform documentation without cloning sibling repos.

The research repository owns cost-model, tree-registry and search-space checks.
This checker owns platform-local Markdown links and repository file citations.
Cross-repository citations must use an explicit `research:`, `backtesting:` or
`bot:` prefix when written as code; HTTPS links are not fetched in CI.
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DOC_PATH_SOURCES = [
    "README.md",
    "platform/README.md",
    "docs/ARCHITECTURE.md",
    "docs/WEBHOOK-CONTRACT.md",
    "docs/REMEDIATION-LEDGER.md",
    "docs/CANDLE-PERFORMANCE.md",
    "docs/WEB-QA.md",
    "docs/ALERTS.md",
    "docs/OPERATIONS.md",
    "docs/SECURITY-AUDIT-2026-08-31.md",
]

MARKDOWN_LINK = re.compile(r"\[[^]]+\]\(([^)]+)\)")
PATHISH = re.compile(r"`([A-Za-z0-9_][A-Za-z0-9_./:-]*/[A-Za-z0-9_./-]*)`")
FILE_CITATION = re.compile(r"\.(?:md|ts|tsx|js|mjs|py|json|sh|sql|yml|yaml)$")
TAILWIND_CLASS = re.compile(
    r"(?:bg|text|border|ring|fill|stroke|divide|from|to|via|outline|shadow|accent|"
    r"decoration|caret|placeholder)-[a-z0-9-]+/\d{1,3}"
)
CROSS_REPO_PREFIXES = ("research:", "backtesting:", "bot:")

failures: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def check_document(rel: str) -> None:
    doc = ROOT / rel
    if not doc.exists():
        fail(f"documented source {rel} does not exist")
        return

    for line_no, line in enumerate(doc.read_text().splitlines(), start=1):
        if "KNOWN-ABSENT" in line:
            continue

        for link in MARKDOWN_LINK.findall(line):
            target_text = link.split("#", 1)[0]
            if not target_text or target_text.startswith(
                ("http://", "https://", "mailto:", "#")
            ):
                continue
            if not (doc.parent / target_text).resolve().exists():
                fail(f"{rel}:{line_no} links to '{link}' which does not exist")

        # A link label may describe another repository; its target was checked
        # above. Backtick citations outside links are the authoritative paths.
        prose = MARKDOWN_LINK.sub("", line)
        for candidate in PATHISH.findall(prose):
            if candidate.startswith(CROSS_REPO_PREFIXES):
                continue
            if candidate.startswith(("http", "/api/", "api/", "@")):
                continue
            if re.fullmatch(r"MuhammadMuhamid/[A-Za-z0-9_.-]+", candidate):
                continue
            if any(ch in candidate for ch in "<>*{}"):
                continue
            if TAILWIND_CLASS.fullmatch(candidate) or not FILE_CITATION.search(candidate):
                continue
            if not (ROOT / candidate.rstrip("/")).exists():
                fail(f"{rel}:{line_no} references '{candidate}' which does not exist")


for source in DOC_PATH_SOURCES:
    check_document(source)

if failures:
    print("documentation check failed:", file=sys.stderr)
    for failure in failures:
        print(f"  - {failure}", file=sys.stderr)
    sys.exit(1)

print("documentation check clean")
