#!/usr/bin/env bash
# Self-contained local Postgres for the platform (no Docker, no brew service).
# Data lives in platform/.pgdata, listens on 127.0.0.1:5433.
# Usage: scripts/db.sh init|start|stop|status|psql
set -euo pipefail

# macOS ships an unset/invalid locale in some shells; postgres refuses to start
# ("postmaster became multithreaded during startup") without a valid LC_ALL.
export LC_ALL="en_US.UTF-8"

# BE-30: this was a single Apple-Silicon Homebrew prefix, so the script could
# not run on an Intel Mac or on a machine where postgres lives anywhere else.
# PATH first, then both Homebrew prefixes, then a named failure.
if [ -z "${PG_BIN:-}" ]; then
  if command -v pg_ctl >/dev/null 2>&1; then
    PG_BIN="$(dirname "$(command -v pg_ctl)")"
  else
    for candidate in /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin; do
      [ -x "$candidate/pg_ctl" ] && PG_BIN="$candidate" && break
    done
  fi
fi
if [ -z "${PG_BIN:-}" ] || [ ! -x "$PG_BIN/pg_ctl" ]; then
  echo "db.sh: no PostgreSQL 16 found. Install it, or set PG_BIN to its bin directory." >&2
  exit 1
fi
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$DIR/.pgdata"
LOG="$DATA/postgres.log"
PORT=5433
DB=platform
USER=platform

case "${1:-}" in
  init)
    if [ -d "$DATA" ]; then echo "already initialized: $DATA"; exit 0; fi
    "$PG_BIN/initdb" -D "$DATA" -U "$USER" --encoding=UTF8 --no-locale
    echo "port = $PORT" >> "$DATA/postgresql.conf"
    echo "listen_addresses = '127.0.0.1'" >> "$DATA/postgresql.conf"
    "$PG_BIN/pg_ctl" -D "$DATA" -l "$LOG" start
    "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U "$USER" "$DB"
    echo "initialized and started. DATABASE_URL=postgres://$USER@localhost:$PORT/$DB"
    ;;
  start)
    "$PG_BIN/pg_ctl" -D "$DATA" -l "$LOG" start
    ;;
  stop)
    "$PG_BIN/pg_ctl" -D "$DATA" stop
    ;;
  status)
    "$PG_BIN/pg_ctl" -D "$DATA" status
    ;;
  psql)
    shift
    "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U "$USER" -d "$DB" "$@"
    ;;
  *)
    echo "usage: $0 init|start|stop|status|psql"
    exit 1
    ;;
esac
