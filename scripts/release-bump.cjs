#!/usr/bin/env node

const fs = require("fs")
const path = require("path")
const semver = require("semver")

const CHANGED_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "packages/ouro.bot/package.json",
  "changelog.json",
  "deploy/unraid/sanctuary.xml",
  "deploy/unraid/sanctuary.ouro/bundle-meta.json",
]

const SANCTUARY_REPOSITORY = /<Repository>ghcr\.io\/ourostack\/ouroboros-butler:[^<]+<\/Repository>/g
const SANCTUARY_NAME = /<Name>ouro-butler<\/Name>/g

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    version: "",
    changes: [],
    replace: false,
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
    if (arg === "--replace") {
      options.replace = true
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

// Re-running the bump for the top version APPENDS its new change lines (a follow-up
// fix commit needs its own line, and silently dropping the earlier ones was D-042).
// --replace rewrites the entry instead, e.g. to swap out a placeholder.
function updateChangelog(changelog, version, changes, replace = false) {
  if (!Array.isArray(changelog.versions)) {
    throw new Error("changelog.json must contain a versions array")
  }

  const existingIndex = changelog.versions.findIndex((entry) => entry?.version === version)
  if (existingIndex > 0) {
    throw new Error(`changelog entry for ${version} already exists below the top entry`)
  }

  if (existingIndex === 0) {
    const existing = replace || !Array.isArray(changelog.versions[0].changes) ? [] : changelog.versions[0].changes
    changelog.versions[0] = { version, changes: [...existing, ...changes.filter((change) => !existing.includes(change))] }
  } else {
    changelog.versions.unshift({ version, changes })
  }
}

function updateSanctuaryRepository(template, version) {
  if ((template.match(SANCTUARY_NAME) ?? []).length !== 1) {
    throw new Error("sanctuary.xml must contain exactly one Docker-valid ouro-butler Name")
  }
  const matches = template.match(SANCTUARY_REPOSITORY) ?? []
  if (matches.length !== 1) {
    throw new Error("deploy/unraid/sanctuary.xml must contain exactly one Butler Repository tag")
  }
  return template.replace(SANCTUARY_REPOSITORY, `<Repository>ghcr.io/ourostack/ouroboros-butler:${version}</Repository>`)
}

function validateSanctuaryBundleMeta(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.runtimeVersion !== "string" || value.bundleSchemaVersion !== 3) {
    throw new Error("deploy/unraid/sanctuary.ouro/bundle-meta.json must be a schema-3 runtime metadata object")
  }
  return value
}

const VERSION_FILES = CHANGED_FILES.filter((file) => file !== "changelog.json")

// Reads and checks every release file except changelog.json for `version`, and returns the function that writes them,
// so a caller can check its own files too before anything is written.
function prepareReleaseVersion(input) {
  const root = path.resolve(input.root ?? process.cwd())
  const version = input.version
  if (!semver.valid(version)) {
    throw new Error("release version must be valid semver")
  }

  const packageJsonPath = path.join(root, "package.json")
  const packageLockPath = path.join(root, "package-lock.json")
  const shrinkwrapPath = path.join(root, "npm-shrinkwrap.json")
  const wrapperPackageJsonPath = path.join(root, "packages/ouro.bot/package.json")
  const sanctuaryTemplatePath = path.join(root, "deploy/unraid/sanctuary.xml")
  const sanctuaryBundleMetaPath = path.join(root, "deploy/unraid/sanctuary.ouro/bundle-meta.json")

  const packageJson = readJson(packageJsonPath)
  const packageLock = readJson(packageLockPath)
  const shrinkwrap = readJson(shrinkwrapPath)
  const wrapperPackageJson = readJson(wrapperPackageJsonPath)
  const sanctuaryTemplate = updateSanctuaryRepository(fs.readFileSync(sanctuaryTemplatePath, "utf8"), version)
  const sanctuaryBundleMeta = validateSanctuaryBundleMeta(readJson(sanctuaryBundleMetaPath))

  packageJson.version = version
  packageLock.version = version
  if (!packageLock.packages || !packageLock.packages[""]) {
    throw new Error('package-lock.json must contain packages[""] root metadata')
  }
  packageLock.packages[""].version = version
  shrinkwrap.version = version
  if (!shrinkwrap.packages || !shrinkwrap.packages[""]) {
    throw new Error('npm-shrinkwrap.json must contain packages[""] root metadata')
  }
  shrinkwrap.packages[""].version = version
  wrapperPackageJson.version = version
  sanctuaryBundleMeta.runtimeVersion = version

  return () => {
    writeJson(packageJsonPath, packageJson)
    writeJson(packageLockPath, packageLock)
    writeJson(shrinkwrapPath, shrinkwrap)
    writeJson(wrapperPackageJsonPath, wrapperPackageJson)
    fs.writeFileSync(sanctuaryTemplatePath, sanctuaryTemplate)
    writeJson(sanctuaryBundleMetaPath, sanctuaryBundleMeta)
    return { version, changedFiles: [...VERSION_FILES] }
  }
}

// Writes `version` into every release file except changelog.json, checking each before writing any.
function writeReleaseVersion(input) {
  return prepareReleaseVersion(input)()
}

function bumpReleaseVersion(input) {
  const root = path.resolve(input.root ?? process.cwd())
  const version = input.version
  const changes = assertValidInput({ version, changes: input.changes ?? [] })

  const changelogPath = path.join(root, "changelog.json")
  const changelog = readJson(changelogPath)
  const commitVersion = prepareReleaseVersion({ root, version })
  updateChangelog(changelog, version, changes, input.replace === true)

  commitVersion()
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
  CHANGED_FILES,
  VERSION_FILES,
  bumpReleaseVersion,
  parseArgs,
  prepareReleaseVersion,
  readJson,
  writeJson,
  writeReleaseVersion,
}
