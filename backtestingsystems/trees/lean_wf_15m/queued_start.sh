#!/bin/zsh
# Start the MTF Lean walk-forward once the trailing-stop walk-forward has finished.
# Both want 6 workers on a 10-core box; running them together roughly doubles both.
#
#   ./lean_wf_15m/queued_start.sh &          # queue it
#   kill $(cat lean_wf_15m/.queue.pid)       # cancel while still waiting
#
# Once running, stop it cleanly (keeps completed coin-folds) with:
#   kill -INT $(cat lean_wf_15m/.wflean.pid)
set -u
HERE="${0:A:h}"
BACKEND="${HERE:h}"
LOCK_TRAIL="$BACKEND/optimizer1y1h_wf_trail/.wftrail.pid"
LOG="$HERE/wflean.log"

echo "$$" > "$HERE/.queue.pid"

while [[ -f "$LOCK_TRAIL" ]] && kill -0 "$(cat "$LOCK_TRAIL" 2>/dev/null)" 2>/dev/null; do
  sleep 300
done

echo "trailing walk-forward finished at $(date -u +%Y-%m-%dT%H:%M:%SZ) — starting MTF Lean run" >> "$LOG"
cd "$BACKEND" || exit 1
exec npx tsx lean_wf_15m/wf.ts >> "$LOG" 2>&1
