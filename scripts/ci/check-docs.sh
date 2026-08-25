#!/usr/bin/env bash
# Documentation regression check (roadmap D10).
#
# Two failures the audit found repeatedly are cheap to catch mechanically:
#   1. a document naming a directory that does not exist;
#   2. a cost-model figure that disagrees with the config.json it describes.
# Both are checked here. No network, no database, no build.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec python3 scripts/ci/check_docs.py
