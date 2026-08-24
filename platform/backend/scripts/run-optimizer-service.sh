#!/usr/bin/env bash
# launchd wrapper for one optimizer tree.
#
#   run-optimizer-service.sh <tree-id>
#
# OPT-23 / BE-30: this hardcoded an absolute path under a different username and
# mixed `/usr/local/bin/node` (Intel Homebrew) with `/opt/homebrew/...`
# (Apple Silicon) in the same file. It could not run on any other checkout, and
# not on either architecture as written. Everything is now derived from the
# script's own location, with overrides for the machine's tooling.
set -euo pipefail

BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TREE="${1:-}"

die() { echo "run-optimizer-service: $*" >&2; exit 1; }

[ -n "$TREE" ] || die "usage: $0 <tree-id>"
# The tree registry is the same one the API routes through: a tree without a
# tree.json is not a tree, and starting a daemon against one is finding X-04
# in daemon form.
[ -f "$BACKEND/$TREE/tree.json" ] || die "no optimizer tree '$TREE' in $BACKEND (it needs a tree.json)"
[ -f "$BACKEND/$TREE/optimizer.ts" ] || die "tree '$TREE' has no optimizer.ts — it is not a search tree"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -x "$NODE_BIN" ] || die "no node on PATH — set NODE_BIN"

# pg_isready ships beside postgres. Look on PATH first, then the two Homebrew
# prefixes, rather than assuming one architecture.
PG_ISREADY="${PG_ISREADY:-$(command -v pg_isready || true)}"
if [ -z "$PG_ISREADY" ]; then
  for candidate in /opt/homebrew/opt/postgresql@16/bin/pg_isready \
                   /usr/local/opt/postgresql@16/bin/pg_isready; do
    [ -x "$candidate" ] && PG_ISREADY="$candidate" && break
  done
fi
[ -x "$PG_ISREADY" ] || die "no pg_isready found — set PG_ISREADY"

PG_HOST="${PGHOST:-127.0.0.1}"
PG_PORT="${PGPORT:-5433}"
PG_DB="${PGDATABASE:-platform}"
PG_USER="${PGUSER:-platform}"

# launchd starts services concurrently after login. Do not create optimizer
# workers until the local database is accepting connections; otherwise workers
# can retain failed startup connections and appear alive while making no
# progress. Bounded, so a database that never comes up fails the service
# instead of leaving it spinning for ever.
WAIT_SECONDS="${DB_WAIT_SECONDS:-300}"
waited=0
until "$PG_ISREADY" -h "$PG_HOST" -p "$PG_PORT" -d "$PG_DB" -U "$PG_USER" >/dev/null 2>&1; do
  sleep 2
  waited=$((waited + 2))
  [ "$waited" -lt "$WAIT_SECONDS" ] || die "database $PG_HOST:$PG_PORT not ready after ${WAIT_SECONDS}s"
done

cd "$BACKEND"

# Run the optimizer as a SINGLE process that launchd supervises directly.
#
# This previously exec'd tsx/dist/cli.mjs, which spawns the real optimizer as a
# CHILD. launchd then supervised the wrapper while the work happened one level
# down, and `launchctl bootout` repeatedly left BOTH processes alive (observed
# 2026-08-21 on ma-1y5m: two PIDs still burning CPU 40 minutes after the service
# unloaded). A survivor writes into a tree you have just wiped, mixing
# stale-config records into fresh results -- which silently corrupted one wipe.
#
# Invoking node with tsx's loader flags ourselves removes the wrapper entirely,
# so there is one PID per tree and bootout actually stops it. The loader path is
# turned into a file:// URL by node itself rather than by hand, because the
# checkout path may contain a space and must be percent-encoded exactly.
LOADER_URL="$("$NODE_BIN" -e 'console.log(require("url").pathToFileURL(process.argv[1]).href)' "$BACKEND/node_modules/tsx/dist/loader.mjs")"

exec "$NODE_BIN" \
  --require "$BACKEND/node_modules/tsx/dist/preflight.cjs" \
  --import "$LOADER_URL" \
  "$TREE/optimizer.ts" --daemon --round "${OPTIMIZER_ROUND:-50}"
