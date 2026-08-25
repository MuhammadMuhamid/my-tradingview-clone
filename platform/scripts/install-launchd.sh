#!/usr/bin/env bash
# Render the launch-agent TEMPLATES in this repository for THIS checkout.
#
# Findings OPT-23 and BE-30: every plist and the optimizer wrapper hardcoded an
# absolute path under a different username — 38 occurrences across 15 files —
# and mixed Intel and Apple-Silicon Homebrew prefixes, so nothing in the
# operational layer could run on any other machine. The plists are now templates
# carrying __CHECKOUT__, __NODE_BIN__ and __PG_BIN__, and this script fills them
# in from the checkout it is run from and the tools actually on PATH.
#
#   platform/scripts/install-launchd.sh                 # render to ./rendered-launchd
#   platform/scripts/install-launchd.sh ~/Library/LaunchAgents
#
# It renders files and stops. It never calls launchctl: arming a service is a
# decision to start emitting, and it belongs to whoever runs the machine.
set -euo pipefail

CHECKOUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="${1:-$CHECKOUT/rendered-launchd}"

die() { echo "install-launchd: $*" >&2; exit 1; }

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -x "$NODE_BIN" ] || die "no node on PATH — set NODE_BIN to the interpreter to use"

# postgres is only needed by the database agent. Look where Homebrew puts it on
# both architectures, then fall back to PATH.
PG_BIN="${PG_BIN:-}"
if [ -z "$PG_BIN" ]; then
  for candidate in /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin; do
    [ -x "$candidate/postgres" ] && PG_BIN="$candidate" && break
  done
fi
if [ -z "$PG_BIN" ] && command -v postgres >/dev/null 2>&1; then
  PG_BIN="$(dirname "$(command -v postgres)")"
fi

mkdir -p "$TARGET"
rendered=0
skipped=0
for template in "$CHECKOUT"/platform/backend/launchd/*.plist "$CHECKOUT"/platform/launchd/*.plist; do
  [ -e "$template" ] || continue
  name="$(basename "$template")"
  if grep -q "__PG_BIN__/" "$template" && [ -z "$PG_BIN" ]; then
    echo "skip  $name — needs postgres, and none was found (set PG_BIN)"
    skipped=$((skipped + 1))
    continue
  fi
  sed -e "s|__CHECKOUT__|$CHECKOUT|g" \
      -e "s|__NODE_BIN__|$NODE_BIN|g" \
      -e "s|__PG_BIN__|${PG_BIN:-}|g" \
      "$template" > "$TARGET/$name"
  if grep -q "__[A-Z_]*__" "$TARGET/$name"; then
    die "$name still contains an unfilled placeholder after rendering"
  fi
  echo "write $TARGET/$name"
  rendered=$((rendered + 1))
done

echo
echo "rendered $rendered agent(s), skipped $skipped, into $TARGET"
echo "Nothing was loaded. Review each file, then load the ones you want:"
echo "  launchctl load -w $TARGET/<name>.plist"
echo
echo "The backend agent sets LIVE_RUNNER_ENABLED=false on purpose. Loading it"
echo "with that flipped starts a SECOND live signal emitter (finding X-06)."
