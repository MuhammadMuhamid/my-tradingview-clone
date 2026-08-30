#!/usr/bin/env bash
#
# Start the screener: FastAPI backend on :8000, Next.js UI on :3000.
#
#   ./start.sh          start both, wait until they answer, print the URL
#   ./start.sh --stop   stop both
#   ./start.sh --logs   tail both logs
#
# Safe to run twice: it stops anything it previously started before starting again.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
LOGS="$ROOT/logs"
API_PORT=8000
WEB_PORT=3000

mkdir -p "$LOGS"

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mxxx\033[0m %s\n' "$*" >&2; exit 1; }

# Kill whatever holds a port, by process *group*.
#
# Killing `next-server` by name does not work: its `npm run dev` parent
# immediately respawns it under a new PID, so the port never frees. The port is
# also the only handle that catches a server started outside this script, or one
# left over from a previous session whose pidfile is gone.
kill_port() {
  local port="$1" attempt sig pids pgids
  for attempt in 1 2 3 4 5 6; do
    pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
    [ -z "$pids" ] && return 0

    # Group leaders first, so the supervisor dies with its worker.
    pgids="$(ps -o pgid= -p $pids 2>/dev/null | tr -d ' ' | sort -u || true)"
    sig="TERM"
    [ "$attempt" -ge 4 ] && sig="KILL"

    for pgid in $pgids; do kill -"$sig" -"$pgid" 2>/dev/null || true; done
    for pid  in $pids;  do kill -"$sig"  "$pid"  2>/dev/null || true; done
    sleep 1
  done

  if [ -n "$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)" ]; then
    warn "port $port is still held; something outside this script owns it"
    return 1
  fi
}

stop_all() {
  for name in api web; do
    pidfile="$LOGS/$name.pid"
    if [ -f "$pidfile" ]; then
      pid="$(cat "$pidfile")"
      kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      rm -f "$pidfile"
    fi
  done
  kill_port "$API_PORT" || true
  kill_port "$WEB_PORT" || true
}

# Launch a command in its own session, output redirected, PID recorded.
#
# macOS has no `setsid`, so this uses python3 (already a hard requirement) to
# call it directly. A separate session means the server survives this script
# exiting, and gives `kill_port` a process group that contains the supervisor
# and its workers but nothing of the user's shell.
spawn() {   # spawn <workdir> <logfile> <pidfile> <cmd> [args...]
  local workdir="$1" log="$2" pidfile="$3"
  shift 3
  (
    cd "$workdir" || exit 1
    python3 -c '
import os, sys
os.setsid()
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
os.dup2(fd, 1)
os.dup2(fd, 2)
os.close(fd)
os.execvp(sys.argv[2], sys.argv[2:])
' "$log" "$@" &
    echo $! > "$pidfile"
  )
}

wait_for() {   # wait_for <url> <pidfile> <seconds>
  local url="$1" pidfile="$2" limit="${3:-90}" waited=0 pid
  pid="$(cat "$pidfile" 2>/dev/null || echo '')"
  while [ "$waited" -lt "$limit" ]; do
    if curl -fsS -o /dev/null --max-time 3 "$url" 2>/dev/null; then
      return 0
    fi
    # Fail immediately if the process is gone — waiting out the full timeout on
    # something that already died just hides the error in the log.
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      return 2
    fi
    sleep 2
    waited=$((waited + 2))
    printf '.'
  done
  return 1
}

case "${1:-}" in
  --stop)
    say "Stopping the screener"
    stop_all
    say "Stopped."
    exit 0
    ;;
  --logs)
    exec tail -f "$LOGS/api.log" "$LOGS/web.log"
    ;;
esac

command -v python3 >/dev/null || die "python3 not found"
command -v npm     >/dev/null || die "npm not found — install Node 20 or newer"

say "Stopping anything already running"
stop_all

# --- dependencies, installed only when missing -------------------------
if [ ! -x "$BACKEND/.venv/bin/python" ]; then
  say "Creating the Python virtualenv (first run only)"
  python3 -m venv "$BACKEND/.venv"
  "$BACKEND/.venv/bin/pip" install -q --upgrade pip
  "$BACKEND/.venv/bin/pip" install -q -r "$BACKEND/requirements.txt"
fi

if [ ! -d "$FRONTEND/node_modules" ]; then
  say "Installing frontend packages (first run only)"
  npm --prefix "$FRONTEND" install --silent --no-audit --no-fund
fi

# --- backend -----------------------------------------------------------
say "Starting the API on :$API_PORT"
spawn "$BACKEND" "$LOGS/api.log" "$LOGS/api.pid" \
  "$BACKEND/.venv/bin/python" -m uvicorn app.main:app \
  --host 127.0.0.1 --port "$API_PORT"

# Startup resolves every symbol and backfills three timeframes, so the first
# boot after a restart genuinely takes a minute or so.
printf '    waiting for the exchange to resolve symbols and backfill candles'
if ! wait_for "http://127.0.0.1:$API_PORT/api/health" "$LOGS/api.pid" 240; then
  printf '\n'
  warn "API did not come up. Last lines of $LOGS/api.log:"
  tail -20 "$LOGS/api.log" >&2
  die "startup failed"
fi
printf '\n'

# --- frontend ----------------------------------------------------------
say "Starting the UI on :$WEB_PORT"
spawn "$FRONTEND" "$LOGS/web.log" "$LOGS/web.pid" npm run dev

printf '    waiting for Next.js'
if ! wait_for "http://127.0.0.1:$WEB_PORT" "$LOGS/web.pid" 120; then
  printf '\n'
  warn "UI did not come up. Last lines of $LOGS/web.log:"
  tail -20 "$LOGS/web.log" >&2
  die "startup failed"
fi
printf '\n'

health="$(curl -fsS "http://127.0.0.1:$API_PORT/api/health" 2>/dev/null || echo '{}')"
say "Screener is up."
echo
echo "    UI       http://localhost:$WEB_PORT"
echo "    API      http://127.0.0.1:$API_PORT/api/health"
echo "    health   $health"
echo
echo "    logs     ./start.sh --logs"
echo "    stop     ./start.sh --stop"
