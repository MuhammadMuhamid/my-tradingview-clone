#!/usr/bin/env bash
# Paired Platform release/rollback discipline: read/report only. Never mutates
# Git history, never touches a database beyond read-only queries this script
# itself opens, never starts/stops production.
#
# Usage:
#   scripts/release.sh identity
#   scripts/release.sh gate [--peer-bot-root <path>]
#   scripts/release.sh rollback-check --since <git-ref> [--database-url <postgres-url>]
set -euo pipefail

# macOS ships an unset/invalid locale in some shells; PostgreSQL refuses to
# start without a valid LC_ALL (see scripts/db.sh).
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."
BACKEND="backend"
MIGRATIONS_DIR="$BACKEND/src/db/migrations"
CONTRACT_DIR="$BACKEND/src/contract"

sha256_text() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  else shasum -a 256 | awk '{print $1}'; fi
}

migration_files() { find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -exec basename {} \; | sort; }
migration_set_sha256() { migration_files | tr '\n' ',' | sha256_text; }

realization_contract_version() {
  grep -m1 'REALIZATION_CONTRACT_VERSION *=' "$CONTRACT_DIR/realizationEventContract.ts" | grep -oE '[0-9]+' | head -1
}
webhook_contract_version() {
  grep -m1 '^export const CONTRACT_VERSION' "$CONTRACT_DIR/webhookContract.ts" | grep -oE '[0-9]+' | head -1
}
webhook_contract_fingerprint() {
  grep -m1 'sha256:v' "$CONTRACT_DIR/webhookContract.ts" | sed -E 's/.*"(sha256:v[^"]+)".*/\1/'
}

print_identity() {
  echo "platform_commit=$(git rev-parse HEAD)"
  if [ -z "$(git status --short)" ]; then echo "platform_worktree=clean"; else echo "platform_worktree=dirty"; fi
  echo "platform_migration_head=$(migration_files | tail -1)"
  echo "platform_migration_count=$(migration_files | wc -l | tr -d ' ')"
  echo "platform_migration_set_sha256=$(migration_set_sha256)"
  echo "platform_realization_contract_version=$(realization_contract_version)"
  echo "platform_webhook_contract_version=$(webhook_contract_version)"
  echo "platform_webhook_contract_fingerprint=$(webhook_contract_fingerprint)"
  echo "platform_postgres_required_major=15"
  echo "platform_postgres_production_major=16"
  echo "platform_node_version=$(node --version 2>/dev/null || echo unavailable)"
}

cmd="${1:-}"
[ -n "$cmd" ] || { echo "usage: $0 identity|gate|rollback-check ..." >&2; exit 2; }
shift

case "$cmd" in
  identity)
    print_identity
    ;;

  gate)
    PEER_BOT_ROOT=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --peer-bot-root) PEER_BOT_ROOT="$2"; shift 2 ;;
        *) echo "gate: unknown argument: $1" >&2; exit 2 ;;
      esac
    done
    fail=0
    echo "=== identity ==="
    print_identity
    echo "=== worktree ==="
    if [ -z "$(git status --short)" ]; then
      echo "clean"
    else
      echo "FAIL: worktree is not clean" >&2
      git status --short >&2
      fail=1
    fi
    echo "=== runtime/dependency availability ==="
    for tool in node npm psql pg_dump pg_restore; do
      if command -v "$tool" >/dev/null 2>&1; then
        echo "$tool: $(command -v "$tool")"
      else
        echo "FAIL: required tool not found: $tool" >&2
        fail=1
      fi
    done
    [ -d "$BACKEND/node_modules" ] || { echo "FAIL: $BACKEND/node_modules missing; run npm ci" >&2; fail=1; }
    echo "=== cross-repo contract identity ==="
    if [ -n "$PEER_BOT_ROOT" ]; then
      for f in webhookContract.ts realizationEventContract.ts; do
        if diff -q "$CONTRACT_DIR/$f" "$PEER_BOT_ROOT/backend/src/contract/$f" >/dev/null 2>&1; then
          echo "$f: identical to $PEER_BOT_ROOT"
        else
          echo "FAIL: $f differs from $PEER_BOT_ROOT/backend/src/contract/$f" >&2
          fail=1
        fi
      done
    else
      echo "skipped (no --peer-bot-root given)"
    fi
    echo "=== focused typecheck ==="
    if ! (cd "$BACKEND" && npm run --silent typecheck); then
      echo "FAIL: typecheck" >&2
      fail=1
    fi
    echo "=== focused realization tests ==="
    test_files=("$BACKEND/tests/realizationEvents.test.ts")
    for tool in psql pg_ctl initdb createdb pg_dump pg_restore; do
      command -v "$tool" >/dev/null 2>&1 || { echo "skipping realizationRecovery.test.ts (missing $tool)"; tool_missing=1; }
    done
    [ -z "${tool_missing:-}" ] && test_files+=("$BACKEND/tests/realizationRecovery.test.ts")
    if [ -n "$PEER_BOT_ROOT" ]; then
      test_files+=("$BACKEND/tests/crossRepositoryRealization.test.ts")
    fi
    if ! (cd "$BACKEND" && TRADING_SCENE_BOT_ROOT="$PEER_BOT_ROOT" \
        node --env-file=tests/test.env --import tsx --test \
        "${test_files[@]/#$BACKEND\//}"); then
      echo "FAIL: focused realization tests" >&2
      fail=1
    fi
    echo "=== gate result ==="
    if [ "$fail" -eq 0 ]; then echo "PASS"; else echo "FAIL"; exit 1; fi
    ;;

  rollback-check)
    SINCE=""
    DATABASE_URL_ARG=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --since) SINCE="$2"; shift 2 ;;
        --database-url) DATABASE_URL_ARG="$2"; shift 2 ;;
        *) echo "rollback-check: unknown argument: $1" >&2; exit 2 ;;
      esac
    done
    [ -n "$SINCE" ] || { echo "usage: $0 rollback-check --since <git-ref> [--database-url <url>]" >&2; exit 2; }

    BASELINE_FILES="$(git ls-tree -r --name-only "$SINCE" -- "$MIGRATIONS_DIR" 2>/dev/null | grep '\.sql$' | xargs -n1 basename 2>/dev/null | sort || true)"
    CURRENT_FILES="$(migration_files)"
    NEW_FILES="$(comm -13 <(printf '%s\n' "$BASELINE_FILES") <(printf '%s\n' "$CURRENT_FILES"))"

    echo "=== rollback-check: Platform current state -> code at $SINCE ==="
    if [ -z "$NEW_FILES" ]; then
      echo "no migrations were added since $SINCE"
      echo "classification=BACKWARD_COMPATIBLE"
      echo "next_step=Old Platform code may be started directly against this database. No restore required."
      exit 0
    fi

    echo "migrations introduced since $SINCE:"
    echo "$NEW_FILES" | sed 's/^/  /'

    verdict=BACKWARD_COMPATIBLE
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      path="$MIGRATIONS_DIR/$file"
      [ -f "$path" ] || { echo "UNKNOWN: migration file missing on disk: $file" >&2; verdict=UNKNOWN; continue; }
      # Destructive/structural patterns old code could not safely tolerate.
      if grep -qiE 'drop +table|drop +column|alter +column|rename +to|rename +column|truncate' "$path"; then
        echo "ROLLBACK_INCOMPATIBLE: $file contains a structural/destructive statement" >&2
        verdict=ROLLBACK_INCOMPATIBLE
      fi
      # Any newly added column must be nullable-or-defaulted, never a bare NOT NULL.
      if grep -iE 'add +column' "$path" | grep -qiE 'not +null' && \
         ! grep -iE 'add +column' "$path" | grep -qiE 'not +null.*default|default.*not +null'; then
        echo "ROLLBACK_INCOMPATIBLE: $file adds a NOT NULL column without a default" >&2
        verdict=ROLLBACK_INCOMPATIBLE
      fi
    done <<< "$NEW_FILES"

    if [ -n "$DATABASE_URL_ARG" ]; then
      echo "=== live evidence ==="
      applied="$(psql --dbname="$DATABASE_URL_ARG" -XAtq -v ON_ERROR_STOP=1 \
        -c "SELECT coalesce(string_agg(filename, ',' ORDER BY filename), '') FROM schema_migrations" 2>&1)" || {
        echo "UNKNOWN: could not read schema_migrations from $DATABASE_URL_ARG" >&2
        verdict=UNKNOWN
      }
      if [ -n "${applied:-}" ]; then
        missing=0
        while IFS= read -r file; do
          [ -n "$file" ] || continue
          case ",$applied," in *",$file,"*) ;; *) missing=1 ;; esac
        done <<< "$NEW_FILES"
        if [ "$missing" -eq 1 ]; then
          echo "UNKNOWN: not every migration introduced since $SINCE is recorded as applied" >&2
          verdict=UNKNOWN
        else
          echo "all migrations introduced since $SINCE are applied"
        fi
        bot_rows="$(psql --dbname="$DATABASE_URL_ARG" -XAtq -v ON_ERROR_STOP=1 \
          -c "SELECT count(*) FROM realised_pnl WHERE source_system = 'BOT_CUSTOM_V1'" 2>/dev/null || echo unknown)"
        echo "realised_pnl rows with Bot-authoritative provenance: $bot_rows (informational; old code never UPDATEs or DELETEs realised_pnl, so these rows are preserved either way)"
      fi
    else
      echo "(no --database-url given; static migration analysis only)"
    fi

    echo "classification=$verdict"
    case "$verdict" in
      BACKWARD_COMPATIBLE)
        echo "next_step=Old Platform code may be started directly against this database. No restore required."
        exit 0
        ;;
      *)
        echo "next_step=Do not start old Platform code against this database. Verify the pre-release backup and restore into a fresh database before running old code." >&2
        exit 1
        ;;
    esac
    ;;

  *)
    echo "usage: $0 identity|gate|rollback-check ..." >&2
    exit 2
    ;;
esac
