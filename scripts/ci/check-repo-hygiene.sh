#!/usr/bin/env bash
# Repository hygiene regressions that are cheap to catch mechanically.
#
# Each rule here corresponds to a finding this programme fixed, and exists so
# the fix cannot quietly come back:
#
#   1. OPT-23 / BE-30 — no absolute home directory in tracked source. Every
#      launch agent and the optimizer wrapper hardcoded one, so nothing in the
#      operational layer ran on any other machine.
#   2. TV-01 — nothing logs in to, drives or scrapes TradingView.
#   3. TV-02..TV-06 — nothing opens a browser remote-debugging port.
#   4. The research archive is evidence, not a dependency: no live code path may
#      import or execute anything under research-archive/.
#
# No network, no database, no build.
set -uo pipefail
cd "$(dirname "$0")/../.."

fail=0
report() { echo "  - $1" >&2; fail=1; }

# Tracked files only, and never the archive's own explanatory documents.
tracked() { git ls-files -z "$@"; }

echo "repository hygiene:"

# ── 1. absolute home directories ─────────────────────────────────────────────
# `/Users/<name>/` or `/home/<name>/` in anything tracked. The launch-agent
# template that EXPLAINS the old path is allowed to name it once.
while IFS= read -r -d '' file; do
  case "$file" in
    */graphify-out/*|docs/REMEDIATION-LEDGER.md|scripts/ledger/findings.json) continue ;;
    platform/backend/launchd/com.alphaweb.clone-backend.plist) continue ;;
    scripts/ci/check-repo-hygiene.sh) continue ;;
  esac
  if grep -Eq '(/Users/|/home/)[A-Za-z0-9._-]+/' "$file" 2>/dev/null; then
    report "$file hardcodes an absolute home directory (OPT-23, BE-30)"
  fi
done < <(tracked)

# ── 2. TradingView account automation ────────────────────────────────────────
while IFS= read -r -d '' file; do
  case "$file" in
    */graphify-out/*|research-archive/*/ARCHIVED.md|research-archive/README.md) continue ;;
    docs/REMEDIATION-LEDGER.md|scripts/ledger/findings.json) continue ;;
    OPTIMIZATION_SYSTEM_BLUEPRINT.md|scripts/ci/check-repo-hygiene.sh) continue ;;
  esac
  if grep -Eq 'TV_PASSWORD|tradingview\.com/accounts/signin|password_input' "$file" 2>/dev/null; then
    report "$file automates a TradingView login (TV-01)"
  fi
done < <(tracked)

# ── 3. remote debugging ports ────────────────────────────────────────────────
while IFS= read -r -d '' file; do
  case "$file" in
    */graphify-out/*|research-archive/*/ARCHIVED.md|research-archive/README.md) continue ;;
    docs/REMEDIATION-LEDGER.md|scripts/ledger/findings.json) continue ;;
    scripts/ci/check-repo-hygiene.sh) continue ;;
  esac
  if grep -Eq 'remote-debugging-port|localhost:9222|127\.0\.0\.1:9222' "$file" 2>/dev/null; then
    report "$file opens or connects to a browser remote-debugging port (TV-02..TV-06)"
  fi
done < <(tracked)

# ── 4. the archive is not a dependency ───────────────────────────────────────
while IFS= read -r -d '' file; do
  case "$file" in
    research-archive/*|*/graphify-out/*) continue ;;
    docs/REMEDIATION-LEDGER.md|scripts/ledger/findings.json) continue ;;
    OPTIMIZATION_SYSTEM_BLUEPRINT.md|scripts/ci/check-repo-hygiene.sh|.gitignore) continue ;;
    *.md) continue ;;   # documents may LINK to the archive; code may not use it.
  esac
  if grep -Eq 'research-archive|from ["'"'"']\.\./tv_autotuner|import autotuner' "$file" 2>/dev/null; then
    report "$file depends on the retired research archive"
  fi
done < <(tracked)

if [ "$fail" -ne 0 ]; then
  echo "repository hygiene check failed" >&2
  exit 1
fi
echo "  clean"
