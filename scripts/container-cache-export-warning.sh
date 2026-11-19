#!/usr/bin/env bash

# The build cache is an optimization: the publish step sets ignore-error=true on cache-to, so BuildKit keeps
# an image push, attestation or solve failure fatal and drops only a failed cache export. BuildKit still
# marks that export step "ERROR" in the plain build log. This reads that log and says so as a workflow
# warning, so a cache outage never passes silently. It always exits 0: it reports, it never decides.

set -uo pipefail

[ "$#" -eq 1 ] || { echo "usage: container-cache-export-warning.sh <plain-build-log>" >&2; exit 64; }

# A build step's name and its error share the "#<n>" id, e.g. "#35 exporting to GitHub Actions Cache" and "#35 ERROR: internal".
failure=$(awk '
  /^#[0-9]+ exporting to GitHub Actions Cache/ { cache[$1] = 1 }
  /^#[0-9]+ ERROR:/ && ($1 in cache) { sub(/^#[0-9]+ /, ""); print; exit }
' "$1")

if [ -n "$failure" ]; then
  echo "::warning::The GitHub Actions build cache export failed ($failure). The image, its attestations and its push succeeded; the next build starts with a colder cache."
fi
