#!/bin/zsh
set -eu

BACKEND="/Users/muhammadmuhamid/Projects/supportandresistance strategy/platform/backend"
# Optimizer trees moved out of platform/ on 2026-08-22 so platform/ holds only
# the TradingView clone. The engine still lives in the backend (one copy, no
# drift) and is reached by relative import from each tree.
TREES="/Users/muhammadmuhamid/Projects/supportandresistance strategy/backtestingsystems/trees"
OPTIMIZER_DIR="$1"
PG_ISREADY="/opt/homebrew/opt/postgresql@16/bin/pg_isready"

# launchd starts services concurrently after login. Do not create optimizer
# workers until the local database is accepting connections; otherwise workers
# can retain failed startup connections and appear alive while making no progress.
until "$PG_ISREADY" -h 127.0.0.1 -p 5433 -d platform -U platform >/dev/null 2>&1; do
  sleep 2
done

# Stay in platform/backend as the working directory: dotenv/config loads .env
# from CWD, and moving the cd to backtestingsystems/ left ALERT_ENCRYPTION_KEY
# empty so every eval threw. The tree is addressed by absolute path instead;
# its imports resolve from the FILE location, not CWD.
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
# turned into a file:// URL by node itself rather than by hand, because BACKEND
# contains a space and must be percent-encoded exactly.
LOADER_URL="$(/usr/local/bin/node -e 'console.log(require("url").pathToFileURL(process.argv[1]).href)' "$BACKEND/node_modules/tsx/dist/loader.mjs")"

exec /usr/local/bin/node \
  --require "$BACKEND/node_modules/tsx/dist/preflight.cjs" \
  --import "$LOADER_URL" \
  "$TREES/$OPTIMIZER_DIR/optimizer.ts" --daemon --round 50
