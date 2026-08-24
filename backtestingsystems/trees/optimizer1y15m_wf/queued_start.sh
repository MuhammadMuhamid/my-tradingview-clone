#!/bin/zsh
# Start the 15m walk-forward only once the 1h walk-forward has finished.
#
# Both runs want 6 workers on a 10-core box, and the 1h run is already going.
# Running them concurrently would roughly double both ETAs and starve the two
# live optimizer services as well, so this waits instead of competing.
#
#   ./optimizer1y15m_wf/queued_start.sh &        # queue it
#   kill $(cat optimizer1y15m_wf/.queue.pid)     # cancel while still waiting
#
# Once running, stop the walk-forward itself with:
#   kill -INT $(cat optimizer1y15m_wf/.wf15.pid)
set -u
HERE="${0:A:h}"
BACKEND="${HERE:h}"
LOCK_1H="$BACKEND/optimizer1y1h_wf/.wf.pid"
LOG="$HERE/wf15.log"

echo "$$" > "$HERE/.queue.pid"

while [[ -f "$LOCK_1H" ]] && kill -0 "$(cat "$LOCK_1H" 2>/dev/null)" 2>/dev/null; do
  sleep 300
done

echo "1h walk-forward finished at $(date -u +%Y-%m-%dT%H:%M:%SZ) — starting 15m run" >> "$LOG"
cd "$BACKEND" || exit 1
exec npx tsx optimizer1y15m_wf/wf.ts >> "$LOG" 2>&1
