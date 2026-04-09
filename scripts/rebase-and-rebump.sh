#!/usr/bin/env bash
# Automate the rebase-and-rebump dance when a PR loses the alpha-version
# race against a concurrently-merging sibling.
#
# The pain it solves: chain B (PR #361) had to manually rebase + rebump
# its package.json from alpha.278 → 280 → 281 → 282 → 283 because four
# other PRs were merging at the same time. Each round was: fetch main,
# merge, hit conflict on changelog.json + package.json + packages/ouro.bot/
# package.json, manually pick a higher version, regenerate the lockfile,
# commit. ~5 minutes per round, 4 rounds = 20+ minutes of pure churn.
#
# This script does that whole loop in one command:
#
#   1. Fetch origin/main
#   2. Merge origin/main into the current branch
#   3. If the merge conflicts on package.json / packages/ouro.bot/package.json
#      / changelog.json, auto-resolve by:
#        a. Computing next-version = (latest published @ouro.bot/cli@alpha) + 1
#        b. Writing that version into both package.json files
#        c. Updating changelog.json: take both sides of the conflict, keep the
#           main side's existing-version entries, and renumber the local side's
#           added entry to match the new version
#        d. npm install to regenerate the lockfile
#   4. git add the resolved files (only the ones we touched)
#   5. git commit with a descriptive merge message
#
# Use it in place of the manual rebase dance:
#
#   $ ./scripts/rebase-and-rebump.sh
#
# Safe to re-run: if there's no conflict, it just merges normally and exits.
# If there's a NON-version conflict, it bails with the conflict list intact
# so you can resolve it by hand and rerun.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" == "main" ]]; then
  echo "[rebase-and-rebump] refusing to run on main — checkout a feature branch first"
  exit 1
fi

if ! git diff --quiet HEAD; then
  echo "[rebase-and-rebump] working tree dirty — commit or stash before running"
  git status --short
  exit 1
fi

echo "[rebase-and-rebump] fetching origin/main"
git fetch origin main

# If main is already an ancestor, nothing to do.
if git merge-base --is-ancestor origin/main HEAD; then
  echo "[rebase-and-rebump] branch is already up to date with origin/main"
  exit 0
fi

echo "[rebase-and-rebump] merging origin/main into $CURRENT_BRANCH"
if git merge --no-edit origin/main; then
  echo "[rebase-and-rebump] clean merge — nothing to rebump"
  exit 0
fi

# We're now in a conflict state. Inspect what conflicted.
CONFLICTS="$(git diff --name-only --diff-filter=U)"
echo "[rebase-and-rebump] conflicts detected:"
echo "$CONFLICTS" | sed 's/^/  /'

# The version-race conflicts we know how to auto-resolve:
EXPECTED_FILES=(
  "package.json"
  "packages/ouro.bot/package.json"
  "changelog.json"
  "package-lock.json"
)

# If anything outside the expected set conflicted, bail and let the human fix it.
UNEXPECTED=""
while IFS= read -r f; do
  case " ${EXPECTED_FILES[*]} " in
    *" $f "*) ;;
    *) UNEXPECTED="$UNEXPECTED $f" ;;
  esac
done <<< "$CONFLICTS"

if [[ -n "$UNEXPECTED" ]]; then
  echo "[rebase-and-rebump] non-version conflicts found — leaving merge in conflict state:"
  echo "$UNEXPECTED" | tr ' ' '\n' | sed 's/^/  /'
  echo "Resolve those by hand, then re-run this script to handle the version files."
  exit 1
fi

# Compute the next version. Read main's version from the merged (or
# auto-merged) package.json. If package.json conflicted, stage :3 is main's
# side. If it merged cleanly, just read the on-disk file.
if echo "$CONFLICTS" | grep -q '^package.json$'; then
  THEIRS_VERSION="$(git show :3:package.json | node -p "JSON.parse(require('fs').readFileSync(0, 'utf-8')).version")"
else
  THEIRS_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf-8')).version")"
fi
echo "[rebase-and-rebump] main version: $THEIRS_VERSION"

NEXT_VERSION="$(node -e "
  const semver = require('semver')
  const v = process.argv[1]
  const parsed = semver.parse(v)
  if (!parsed) { console.error('unrecognized version: ' + v); process.exit(1) }
  // Prerelease (e.g. 0.1.0-alpha.NNN): increment the prerelease number.
  // Non-prerelease (e.g. 1.2.3): increment patch.
  if (parsed.prerelease.length > 0) {
    console.log(semver.inc(v, 'prerelease'))
  } else {
    console.log(semver.inc(v, 'patch'))
  }
" "$THEIRS_VERSION")"
echo "[rebase-and-rebump] next version: $NEXT_VERSION"

# Resolve package.json: if conflicted, take theirs and bump. If clean, just bump.
if echo "$CONFLICTS" | grep -q '^package.json$'; then
  git checkout --theirs package.json
fi
node -e "
  const fs = require('fs')
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'))
  pkg.version = '$NEXT_VERSION'
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
"
git add package.json

# Same for packages/ouro.bot/package.json.
if echo "$CONFLICTS" | grep -q '^packages/ouro.bot/package.json$'; then
  git checkout --theirs packages/ouro.bot/package.json
fi
node -e "
  const fs = require('fs')
  const pkg = JSON.parse(fs.readFileSync('packages/ouro.bot/package.json', 'utf-8'))
  pkg.version = '$NEXT_VERSION'
  fs.writeFileSync('packages/ouro.bot/package.json', JSON.stringify(pkg, null, 2) + '\n')
"
git add packages/ouro.bot/package.json

# changelog.json: when conflicted, merge both sides and renumber the user's
# added entry. When cleanly merged (only version in changelog.json was
# textually disjoint), just renumber the user's entry in place.
if ! echo "$CONFLICTS" | grep -q '^changelog.json$'; then
  # changelog.json merged cleanly — just renumber whatever entry the user
  # added to match NEXT_VERSION.
  node -e "
    const fs = require('fs')
    const merged = JSON.parse(fs.readFileSync('changelog.json', 'utf-8'))
    const latest = merged.versions[0]
    if (latest) latest.version = '$NEXT_VERSION'
    fs.writeFileSync('changelog.json', JSON.stringify(merged, null, 2) + '\n')
  "
  git add changelog.json
else
  # Conflicted changelog — extract user's entry, prepend to main's file,
  # renumber to NEXT_VERSION.
  node -e "
    const fs = require('fs')
    const { execSync } = require('child_process')

    // Take origin/main's full file as the base (it's well-formed JSON).
    const theirsRaw = execSync('git show :3:changelog.json', { encoding: 'utf-8' })
    const merged = JSON.parse(theirsRaw)

    // Extract user-added entry from ours side (stage :2 = HEAD = user branch).
    // Compare by changes CONTENT, not by version number — both sides may have
    // the same version number (e.g. both are alpha.297) with different changes
    // when PRs race. The user's entry is the one in ours whose changes text
    // doesn't appear in any entry on main's side.
    const oursRaw = execSync('git show :2:changelog.json', { encoding: 'utf-8' })
    const ours = JSON.parse(oursRaw)
    const theirsChangesSet = new Set(
      merged.versions.map((v) => JSON.stringify(v.changes))
    )
    const userEntry = ours.versions.find(
      (v) => !theirsChangesSet.has(JSON.stringify(v.changes))
    )

    if (!userEntry) {
      // No unique entry found — user's entry is identical to theirs.
      // Just take theirs.
      fs.writeFileSync('changelog.json', JSON.stringify(merged, null, 2) + '\n')
      process.exit(0)
    }

    // Renumber the user-added entry to NEXT_VERSION and prepend.
    const renumbered = { ...userEntry, version: '$NEXT_VERSION' }
    merged.versions.unshift(renumbered)

    fs.writeFileSync('changelog.json', JSON.stringify(merged, null, 2) + '\n')
  "
  git add changelog.json
fi

# Regenerate the lockfile.
echo "[rebase-and-rebump] regenerating package-lock.json"
npm install --silent
git add package-lock.json

# Verify all expected files are now resolved.
REMAINING="$(git diff --name-only --diff-filter=U)"
if [[ -n "$REMAINING" ]]; then
  echo "[rebase-and-rebump] unexpectedly still in conflict state for:"
  echo "$REMAINING" | sed 's/^/  /'
  echo "Aborting — resolve manually."
  exit 1
fi

# Commit the merge.
git commit --no-edit

echo ""
echo "[rebase-and-rebump] done. version bumped to $NEXT_VERSION."
echo "Next steps:"
echo "  npm run test:coverage   # confirm gate still green"
echo "  git push                 # push the rebumped branch"
