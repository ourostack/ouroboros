#!/usr/bin/env bash
# Post-push verification: re-run the strict release gate until both immutable references are
# readable. Only observed absence (both refs absent, or one of the two absent) is retried, because a
# registry read right after our own push can lag. Mismatch, auth/network errors, empty or invalid
# manifests fail at once, and nothing is ever republished.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: container-post-push-verify.sh <version-reference> <sha-reference> <attempts> <delay-seconds>" >&2
  exit 2
fi

gate="$(cd "$(dirname "$0")" && pwd)/container-image-release-gate.sh"
version_reference="$1"
sha_reference="$2"
attempts="$3"
delay="$4"

for attempt in $(seq 1 "$attempts"); do
  error_file=$(mktemp)
  set +e
  output=$("$gate" "$version_reference" "$sha_reference" 2>"$error_file")
  status=$?
  set -e
  errors=$(cat "$error_file")
  rm -f "$error_file"

  if [ "$status" -eq 0 ] && [ "$output" != "publish=true" ]; then
    printf '%s\n' "$output"
    exit 0
  fi

  if [ "$status" -eq 0 ] || [[ "$errors" == partial\ publication:* ]]; then
    printf 'attempt %s/%s: references not yet readable after push (%s)\n' "$attempt" "$attempts" "${errors:-both absent}" >&2
    if [ "$attempt" -lt "$attempts" ]; then
      sleep "$delay"
      continue
    fi
    printf 'references still not readable after %s attempts\n' "$attempts" >&2
    exit 1
  fi

  printf '%s\n' "$errors" >&2
  exit 1
done
