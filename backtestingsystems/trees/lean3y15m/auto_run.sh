#!/bin/zsh
# Wait for the 15m+5m backfill to finish, then start the 3-year lean test.
# Detached from any terminal, so it survives quitting Claude Code / closing the shell.
#
#   nohup ./lean3y15m/auto_run.sh > lean3y15m/auto_run.log 2>&1 &
#   kill $(cat lean3y15m/.auto.pid)     # cancel
set -u
HERE="${0:A:h}"; BACKEND="${HERE:h}"
echo "$$" > "$HERE/.auto.pid"
cd "$BACKEND" || exit 1

# The 5m feed must reach 2023-08 before the run, or S4 (a 5m filter ANDed into
# every entry) silently blocks all trades in the earlier half of the window.
while pgrep -f "lean3y15m/backfill" >/dev/null 2>&1; do sleep 60; done
echo "backfill finished $(date -u +%Y-%m-%dT%H:%M:%SZ) — starting 3-year lean test"

exec npx tsx lean3y15m/run.ts --workers 5
