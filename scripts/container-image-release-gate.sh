#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: container-image-release-gate.sh <version-reference> <sha-reference>" >&2
  exit 64
fi

version_reference="$1"
sha_reference="$2"

if [[ ! "$version_reference" =~ ^ghcr\.io/ourostack/ouroboros-butler:[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
  || [[ ! "$sha_reference" =~ ^ghcr\.io/ourostack/ouroboros-butler:sha-[0-9a-f]{40}$ ]]; then
  echo "release references must use canonical immutable package-version and full commit-SHA tags" >&2
  exit 64
fi

# One registry read per reference: its manifest bytes are hashed here, never fetched a second time, because the
# registry can answer a read just after a push differently from the read before it.
inspect_reference() {
  local reference="$1"
  local raw_file
  local error_file
  local errors
  local status
  local digest

  raw_file=$(mktemp)
  error_file=$(mktemp)
  set +e
  docker buildx imagetools inspect --raw "$reference" >"$raw_file" 2>"$error_file"
  status=$?
  set -e
  errors=$(cat "$error_file")

  if [ "$status" -eq 0 ]; then
    digest=$(sha256sum "$raw_file" | awk '{ print "sha256:" $1 }')
    if [ ! -s "$raw_file" ]; then
      rm -f "$raw_file" "$error_file"
      printf 'registry inspection returned an empty manifest for %s\n' "$reference" >&2
      return 1
    fi
    rm -f "$raw_file" "$error_file"
    if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      printf 'registry inspection returned an invalid digest for %s: %s\n' "$reference" "$digest" >&2
      return 1
    fi
    printf 'present\t%s\n' "$digest"
    return 0
  fi
  rm -f "$raw_file" "$error_file"

  if [ "$errors" = "ERROR: $reference: not found" ]; then
    printf 'absent\n'
    return 0
  fi

  printf 'registry inspection failed for %s: %s\n' "$reference" "$errors" >&2
  return 1
}

version_result=$(inspect_reference "$version_reference")
sha_result=$(inspect_reference "$sha_reference")

version_state=${version_result%%$'\t'*}
sha_state=${sha_result%%$'\t'*}

if [ "$version_state" = "absent" ] && [ "$sha_state" = "absent" ]; then
  printf 'publish=true\n'
  exit 0
fi

if [ "$version_state" != "present" ] || [ "$sha_state" != "present" ]; then
  printf 'partial publication: version=%s sha=%s\n' "$version_state" "$sha_state" >&2
  exit 1
fi

version_digest=${version_result#*$'\t'}
sha_digest=${sha_result#*$'\t'}
if [ "$version_digest" != "$sha_digest" ]; then
  printf 'immutable digest mismatch: version=%s sha=%s\n' "$version_digest" "$sha_digest" >&2
  exit 1
fi

printf 'publish=false\ndigest=%s\n' "$version_digest"
