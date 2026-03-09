#!/usr/bin/env node

/**
 * Validates that the current package.json version has a corresponding
 * non-empty changelog entry in changelog.json.
 *
 * Exit 0 if valid, exit 1 with clear error if not.
 * No escape hatch -- all version bumps must have a changelog entry.
 */

function validateChangelog(_version, _changelog) {
  throw new Error("not implemented")
}

// When run as a script, validate against real files
if (require.main === module) {
  throw new Error("not implemented")
}

module.exports = { validateChangelog }
