#!/usr/bin/env bash
# Pull requests no longer bump the version: the release job on main sets it when the change lands
# (scripts/release-version.cjs). This name is kept for habit; it now drops an old-style bump instead of redoing it,
# moving the branch's changelog.json lines into a change note under changes/ and merging main.
#
#   $ ./scripts/rebase-and-rebump.sh      same as: npm run release:drop-bump
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-drop-bump.cjs" "$@"
