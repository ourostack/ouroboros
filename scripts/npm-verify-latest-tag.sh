#!/usr/bin/env bash
# Usage: npm-verify-latest-tag.sh <package> <published-version>
# Waits until the package's latest dist-tag reads <published-version> or later, for up to
# LATEST_DEADLINE_SECONDS (POLL_INTERVAL_SECONDS between reads). On failure prints bounded,
# read-only diagnostics from different registry read paths; a failing diagnostic never hides
# the failure, which always exits 1 with the ::error:: line. It never writes a tag.
set -uo pipefail

package="$1"
published="$2"
deadline_seconds="${LATEST_DEADLINE_SECONDS:?LATEST_DEADLINE_SECONDS is required}"
interval="${POLL_INTERVAL_SECONDS:-15}"
started=$(date +%s)
deadline=$((started + deadline_seconds))

while :; do
  if result=$(node scripts/npm-dist-tag-policy.cjs latest-check "$package" "$published" 2>&1); then
    echo "$result"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then break; fi
  echo "${result}; retrying after npm propagation delay"
  sleep "$interval"
done

# The same tag read through paths that differ in endpoint and caching, so a failure can be told
# apart: a stale cached read, a tag the registry never set, or a later publisher moving it.
# These reads establish what each path returned at this moment, not why.
echo "::group::${package} latest diagnostics at $(date -u +%H:%M:%SZ)"
echo "npm view dist-tags: $(npm view "$package" dist-tags --json 2>&1 | tr -d '\n ' | cut -c1-300 || true)"
echo "npm dist-tag ls: $(npm dist-tag ls "$package" 2>&1 | tr '\n' ' ' | cut -c1-300 || true)"
endpoint="https://registry.npmjs.org/-/package/${package}/dist-tags"
if headers=$(curl -sS -m 20 -D - -o /tmp/npm-latest-body "$endpoint" 2>&1); then
  echo "dist-tags endpoint: $(tr -d '\n ' < /tmp/npm-latest-body | cut -c1-300)"
  echo "dist-tags endpoint headers: $(printf '%s' "$headers" | grep -iE '^(HTTP|age|cache-control|date|x-served-by|x-cache)' | tr -d '\r' | tr '\n' ';' | cut -c1-400)"
else
  echo "dist-tags endpoint read failed: $(printf '%s' "$headers" | head -n 3 | cut -c1-300)"
fi
if times=$(npm view "$package" time --json 2>&1); then
  echo "latest publish times: $(printf '%s' "$times" | grep -E '"[0-9]+\.[0-9]+\.[0-9]+' | tail -n 4 | tr -d '\n ' | cut -c1-400)"
else
  echo "publish times read failed: $(printf '%s' "$times" | head -n 3 | cut -c1-300)"
fi
echo "::endgroup::"
echo "::error::${result}"
exit 1
