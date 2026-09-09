#!/usr/bin/env bash
# Value-free secret scan over tracked source.
#
# It never prints a matched value — only the file and line — so a real finding
# does not leak the credential into a CI log. Known non-credentials (SHA-256
# verification digests, generated content hashes, lockfile integrity hashes)
# are allow-listed by path with a reason.
set -uo pipefail
cd "$(dirname "$0")/../.."

fail=0
report() { echo "::error file=$1,line=$2::$3"; fail=1; }

# Paths whose long hex strings are verification digests or generated hashes,
# not secrets. Each entry is justified in 02_FINDINGS_REGISTER.md §X-13.
is_allowed() {
  local file="$1" message="$2" content="$3" cleaned
  case "$1" in
    */package-lock.json|package-lock.json) return 0 ;;
    platform/deployment/aws/security_audit_*.mjs) return 0 ;;   # sha256 of the EXPECTED secret
    platform/deployment/aws/audit_live_lean15m_exact.mjs) return 0 ;; # config fingerprints
    */graphify-out/*) return 0 ;;                                # generated content hashes
    # CONTRACT_FINGERPRINT is a sha256 digest of this file's own source, used to
    # detect drift between the two repositories' vendored copies. The module is
    # import-free and holds no configuration, so a credential there would be
    # both pointless and obvious in review.
    */contract/webhookContract.ts)
      [ "$message" = "credential-shaped hex literal in tracked source" ] || return 1
      cleaned="$(printf '%s' "$content" | sed -E \
        's/sha256:v[0-9]+:[0-9a-f]{64}/sha256:<verified-contract-digest>/g')"
      ! grep -Eq '[0-9a-f]{40,}' <<<"$cleaned"
      return
      ;;
    platform/frontend/tests/fixtures/p2_btcusdt_15m_exact_bar.json|\
    platform/screener/backend/tests/fixtures/p2_differential_corpus.json|\
    platform/screener/backend/tests/fixtures/p3_classical_differential_corpus.json)
      [ "$message" = "credential-shaped hex literal in tracked source" ] || return 1
      # These immutable public-OHLC corpora carry only named SHA-256 fields.
      # Remove those exact JSON fields, then fail closed if any other long hex
      # token remains on the same (sometimes minified) line.
      cleaned="$(printf '%s' "$content" | sed -E \
        's/"(window_ohlc_sha256|ohlc_sha256)"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"/"<verified-public-ohlc-digest>"/g')"
      ! grep -Eq '[0-9a-f]{40,}' <<<"$cleaned"
      return
      ;;
    *.png|*.jpg|*.jpeg|*.pdf|*.zip|*.gz) return 0 ;;
  esac
  return 1
}

scan() {
  local pattern="$1" message="$2"
  while IFS=: read -r file line content; do
    [ -z "$file" ] && continue
    is_allowed "$file" "$message" "$content" && continue
    report "$file" "$line" "$message"
  done < <(git grep -InE "$pattern" -- \
      ':!*.png' ':!*.jpg' ':!*.jpeg' ':!*.pdf' ':!*.zip' 2>/dev/null || true)
}

# `git grep -E` is POSIX ERE: it has no \b, so boundaries are spelled out.
# A 40+ character lowercase-hex run is the shape of the bot webhook secret.
scan '[0-9a-f]{40,}' 'credential-shaped hex literal in tracked source'
# AWS access keys, private keys, JWT literals.
scan 'AKIA[0-9A-Z]{16}' 'AWS access key id in tracked source'
scan 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' 'private key material in tracked source'
scan 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.' 'JWT literal in tracked source'
# Piping a remote script straight into a shell.
scan 'curl[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(ba)?sh' 'remote script piped into a shell'

if [ "$fail" -ne 0 ]; then
  echo "secret scan failed — see the annotations above (values are never printed)" >&2
  exit 1
fi
echo "secret scan clean"
