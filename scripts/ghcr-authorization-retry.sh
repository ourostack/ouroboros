#!/usr/bin/env bash

# GHCR's token endpoint sometimes answers a valid token with a bare "denied: denied", and the same command
# passes a moment later. This runs a GHCR login or push up to three times and retries only that answer.
# A real permission problem reads "denied: permission_denied: ..." and fails on the first attempt.

set -uo pipefail

denial='denied: denied'

usage() {
  echo "usage: ghcr-authorization-retry.sh <command> [argument...]" >&2
  echo "       ghcr-authorization-retry.sh --is-denial <log-file>" >&2
  exit 64
}

if [ "${1:-}" = "--is-denial" ]; then
  [ "$#" -eq 2 ] || usage
  grep -qF -- "$denial" "$2"
  exit
fi

[ "$#" -gt 0 ] || usage

read -r -a delays <<<"${GHCR_RETRY_DELAYS:-10 30}"
max_attempts=3
log=$(mktemp)
trap 'rm -f "$log"' EXIT

attempt=1
while :; do
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if [ "$attempt" -ge "$max_attempts" ] || ! grep -qF -- "$denial" "$log"; then
    exit "$status"
  fi
  delay=${delays[$((attempt - 1))]:-30}
  echo "::warning::GHCR denied authorization on attempt $attempt of $max_attempts; retrying in ${delay}s"
  sleep "$delay"
  attempt=$((attempt + 1))
done
