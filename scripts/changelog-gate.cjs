#!/usr/bin/env node

/**
 * Validates that the current package.json version has a corresponding
 * non-empty changelog entry in changelog.json.
 *
 * Exit 0 if valid, exit 1 with clear error if not.
 * No escape hatch -- all version bumps must have a changelog entry.
 */

const path = require("path")
const fs = require("fs")

function validateChangelog(version, changelog) {
  if (!changelog || !Array.isArray(changelog.versions)) {
    return { ok: false, error: `changelog.json is missing or has no "versions" array` }
  }

  const entry = changelog.versions.find((v) => v.version === version)

  if (!entry) {
    return {
      ok: false,
      error: `no changelog entry for version ${version}. Every version bump requires a changelog entry in changelog.json.`,
    }
  }

  if (!Array.isArray(entry.changes) || entry.changes.length === 0) {
    return {
      ok: false,
      error: `changelog entry for version ${version} has empty changes. Add at least one meaningful change description.`,
    }
  }

  return { ok: true }
}

// When run as a script, validate against real files
if (require.main === module) {
  const packageJsonPath = path.resolve(__dirname, "../package.json")
  const changelogPath = path.resolve(__dirname, "../changelog.json")

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"))
  const changelog = JSON.parse(fs.readFileSync(changelogPath, "utf-8"))

  const result = validateChangelog(packageJson.version, changelog)

  if (!result.ok) {
    console.error(`changelog gate: FAIL`)
    console.error(result.error)
    process.exit(1)
  }

  console.log(`changelog gate: pass (${packageJson.version})`)
}

module.exports = { validateChangelog }
