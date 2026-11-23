#!/usr/bin/env bash
# Usage: npm-verify-exact-version.sh <package> <version>
# Asks npm for the exact version until it is served or VERSION_DEADLINE_SECONDS passes
# (POLL_INTERVAL_SECONDS between asks). On failure prints bounded diagnostics; a failing
# diagnostic read never hides the failure, which always exits 1 with the ::error:: line.
set -uo pipefail

package="$1"
expected="$2"
ref="${package}@${expected}"
deadline_seconds="${VERSION_DEADLINE_SECONDS:?VERSION_DEADLINE_SECONDS is required}"
interval="${POLL_INTERVAL_SECONDS:-15}"
started=$(date +%s)
deadline=$((started + deadline_seconds))
last_error=""
last_detail=""
actual=""

while :; do
  # Keep npm's own error so a failure says why (E404 vs network vs auth), not just "missing".
  npm_err=$(mktemp)
  actual=$(npm view "$ref" version 2>"$npm_err" || echo "")
  last_error=$(grep -m1 -E 'npm (error|warn)' "$npm_err" || true)
  last_detail=$(grep -E '^npm (error|warn)' "$npm_err" | head -n 12 | cut -c1-300 || true)
  rm -f "$npm_err"
  if [ "$actual" = "$expected" ]; then
    echo "${ref} verified at ${expected} after $(( $(date +%s) - started ))s"
    exit 0
  fi
  [ "$(date +%s)" -ge "$deadline" ] && break
  echo "${ref} serves ${actual:-missing}, expected ${expected}${last_error:+ (${last_error})}; retrying after npm propagation delay"
  sleep "$interval"
done

# Where the version is and is not visible, so a failure separates absence from an access or
# registry problem. Each read is bounded and best effort.
echo "::group::${ref} diagnostics at $(date -u +%H:%M:%SZ)"
echo "last npm output (first 12 lines, 300 characters each):"
echo "${last_detail:-none}"
echo "registry: $(npm config get registry 2>&1 | head -n 1 | cut -c1-200 || true)"
if listed=$(npm view "$package" versions --json 2>&1); then
  if printf '%s' "$listed" | grep -qF "\"${expected}\""; then echo "version list: includes ${expected}"; else echo "version list: does not include ${expected}"; fi
else
  echo "version list read failed: $(printf '%s' "$listed" | head -n 3 | cut -c1-300)"
fi
echo "dist-tags: $(npm view "$package" dist-tags --json 2>&1 | tr -d '\n' | cut -c1-300 || true)"
echo "::endgroup::"
echo "::error::${ref} serves ${actual:-missing}, expected ${expected} after $(( $(date +%s) - started ))s${last_error:+ (${last_error})}"
exit 1
