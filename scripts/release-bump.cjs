#!/usr/bin/env node

const fs = require("fs")
const path = require("path")
const semver = require("semver")

const CHANGED_FILES = [
  "package.json",
  "package-lock.json",
  "packages/ouro.bot/package.json",
  "changelog.json",
]

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    version: "",
    changes: [],
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--root") {
      const next = argv[index + 1]
      if (!next) throw new Error("--root requires a value")
      options.root = path.resolve(next)
      index += 1
      continue
    }
    if (arg === "--version") {
      const next = argv[index + 1]
      if (!next) throw new Error("--version requires a value")
      options.version = next
      index += 1
      continue
    }
    if (arg === "--change") {
      const next = argv[index + 1]
      if (!next) throw new Error("--change requires a value")
      options.changes.push(next)
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  return options
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function normalizeChanges(changes) {
  return changes.map((change) => String(change).trim()).filter(Boolean)
}

function assertValidInput(input) {
  if (!semver.valid(input.version)) {
    throw new Error("release version must be valid semver")
  }

  const changes = normalizeChanges(input.changes)
  if (changes.length === 0) {
    throw new Error("at least one --change entry is required")
  }

  return changes
}

function updateChangelog(changelog, version, changes) {
  if (!Array.isArray(changelog.versions)) {
    throw new Error("changelog.json must contain a versions array")
  }

  const existingIndex = changelog.versions.findIndex((entry) => entry?.version === version)
  if (existingIndex > 0) {
    throw new Error(`changelog entry for ${version} already exists below the top entry`)
  }

  const nextEntry = { version, changes }
  if (existingIndex === 0) {
    changelog.versions[0] = nextEntry
  } else {
    changelog.versions.unshift(nextEntry)
  }
}

function bumpReleaseVersion(input) {
  const root = path.resolve(input.root ?? process.cwd())
  const version = input.version
  const changes = assertValidInput({ version, changes: input.changes ?? [] })

  const packageJsonPath = path.join(root, "package.json")
  const packageLockPath = path.join(root, "package-lock.json")
  const wrapperPackageJsonPath = path.join(root, "packages/ouro.bot/package.json")
  const changelogPath = path.join(root, "changelog.json")

  const packageJson = readJson(packageJsonPath)
  const packageLock = readJson(packageLockPath)
  const wrapperPackageJson = readJson(wrapperPackageJsonPath)
  const changelog = readJson(changelogPath)

  packageJson.version = version
  packageLock.version = version
  if (!packageLock.packages || !packageLock.packages[""]) {
    throw new Error('package-lock.json must contain packages[""] root metadata')
  }
  packageLock.packages[""].version = version
  wrapperPackageJson.version = version
  updateChangelog(changelog, version, changes)

  writeJson(packageJsonPath, packageJson)
  writeJson(packageLockPath, packageLock)
  writeJson(wrapperPackageJsonPath, wrapperPackageJson)
  writeJson(changelogPath, changelog)

  return {
    version,
    changedFiles: [...CHANGED_FILES],
  }
}

if (require.main === module) {
  try {
    const result = bumpReleaseVersion(parseArgs(process.argv.slice(2)))
    console.log(`release metadata bumped to ${result.version}`)
    for (const file of result.changedFiles) {
      console.log(`updated ${file}`)
    }
  } catch (error) {
    console.error("release bump: FAIL")
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

module.exports = {
  bumpReleaseVersion,
  parseArgs,
}
