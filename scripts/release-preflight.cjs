#!/usr/bin/env node

const { execSync } = require("child_process")
const path = require("path")
const fs = require("fs")

const { validateChangelog } = require("./changelog-gate.cjs")
const { validatePackageAssets } = require("./package-assets.cjs")

function splitLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function parseArgs(argv) {
  const options = { baseRef: "origin/main" }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--base-ref") {
      const next = argv[index + 1]
      if (!next) {
        throw new Error("--base-ref requires a value")
      }
      options.baseRef = next
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function versionBumpRequired(changedFiles) {
  return changedFiles.some(
    (file) => file === "package.json" ||
      file.startsWith("skills/") ||
      file.startsWith("scripts/") ||
      (file.startsWith("src/") && !file.startsWith("src/__tests__/")),
  )
}

function wrapperPackageChanged(changedFiles) {
  return changedFiles.some((file) => file.startsWith("packages/ouro.bot/"))
}

function pathRequiresChangelogFreshness(file) {
  return file.startsWith("scripts/") ||
    file.startsWith("skills/") ||
    (file.startsWith("src/") && !file.startsWith("src/__tests__/")) ||
    (file.startsWith("packages/ouro.bot/") && file !== "packages/ouro.bot/package.json")
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function latestCommitForPath(baseRef, file, execSyncImpl) {
  try {
    return execSyncImpl(
      `git log --format=%H --max-count=1 ${shellQuote(`${baseRef}..HEAD`)} -- ${shellQuote(file)}`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim()
  } catch {
    return ""
  }
}

function isAncestorCommit(ancestor, descendant, execSyncImpl) {
  try {
    execSyncImpl(`git merge-base --is-ancestor ${shellQuote(ancestor)} ${shellQuote(descendant)}`, {
      stdio: ["ignore", "ignore", "ignore"],
    })
    return true
  } catch {
    return false
  }
}

function collectUncommittedFiles(execSyncImpl) {
  const workingTreeFiles = splitLines(
    execSyncImpl("git diff --name-only HEAD", { encoding: "utf-8" }),
  )
  const untrackedFiles = splitLines(
    execSyncImpl("git ls-files --others --exclude-standard", { encoding: "utf-8" }),
  )

  return new Set([...workingTreeFiles, ...untrackedFiles])
}

function formatPathList(files) {
  const shown = files.slice(0, 8).join(", ")
  return files.length > 8 ? `${shown}, and ${files.length - 8} more` : shown
}

function assessChangelogFreshness(input) {
  const freshnessFiles = input.changedFiles.filter(pathRequiresChangelogFreshness)
  if (freshnessFiles.length === 0) {
    return { ok: true, message: "changelog freshness: skipped (no releasable implementation paths)" }
  }

  const topEntry = Array.isArray(input.changelog?.versions) ? input.changelog.versions[0] : undefined
  if (!topEntry || topEntry.version !== input.currentVersion) {
    return {
      ok: false,
      message:
        `changelog entry for version ${input.currentVersion} must be the top changelog entry when releasable implementation paths change.`,
    }
  }

  if (!input.changedFiles.includes("changelog.json")) {
    return {
      ok: false,
      message:
        `changelog.json must be updated alongside releasable implementation changes: ${formatPathList(freshnessFiles)}`,
    }
  }

  const uncommittedFiles = collectUncommittedFiles(input.execSyncImpl)
  const uncommittedFreshnessFiles = freshnessFiles.filter((file) => uncommittedFiles.has(file))
  const changelogUncommitted = uncommittedFiles.has("changelog.json")
  if (uncommittedFreshnessFiles.length > 0 && !changelogUncommitted) {
    return {
      ok: false,
      message:
        `changelog.json must be updated in the working tree after uncommitted releasable changes: ${formatPathList(uncommittedFreshnessFiles)}`,
    }
  }

  if (changelogUncommitted) {
    return { ok: true, message: "changelog freshness: pass" }
  }

  const changelogCommit = latestCommitForPath(input.baseRef, "changelog.json", input.execSyncImpl)
  if (!changelogCommit) {
    return {
      ok: false,
      message:
        `changelog.json must be committed on this branch alongside releasable implementation changes: ${formatPathList(freshnessFiles)}`,
    }
  }

  const staleFiles = freshnessFiles.filter((file) => {
    if (uncommittedFiles.has(file)) {
      return false
    }
    const fileCommit = latestCommitForPath(input.baseRef, file, input.execSyncImpl)
    return fileCommit && !isAncestorCommit(fileCommit, changelogCommit, input.execSyncImpl)
  })

  if (staleFiles.length > 0) {
    return {
      ok: false,
      message:
        `changelog.json is older than releasable implementation changes; update it after touching: ${formatPathList(staleFiles)}`,
    }
  }

  return { ok: true, message: "changelog freshness: pass" }
}

function collectChangedFiles(baseRef, execSyncImpl) {
  const committedFiles = splitLines(
    execSyncImpl(`git diff --name-only "${baseRef}...HEAD"`, { encoding: "utf-8" }),
  )
  const workingTreeFiles = splitLines(
    execSyncImpl("git diff --name-only HEAD", { encoding: "utf-8" }),
  )
  const untrackedFiles = splitLines(
    execSyncImpl("git ls-files --others --exclude-standard", { encoding: "utf-8" }),
  )

  return Array.from(new Set([...committedFiles, ...workingTreeFiles, ...untrackedFiles])).sort()
}

function assessWrapperPublishSync(input) {
  if (input.localVersion !== input.cliVersion) {
    return {
      ok: false,
      message: `ouro.bot wrapper version ${input.localVersion} must match @ouro.bot/cli version ${input.cliVersion}`,
    }
  }

  if (!wrapperPackageChanged(input.changedFiles)) {
    return {
      ok: true,
      message: "wrapper package unchanged",
    }
  }

  if (input.publishedVersion === input.localVersion) {
    return {
      ok: false,
      message: `ouro.bot wrapper changed but ouro.bot@${input.localVersion} is already published; bump packages/ouro.bot/package.json before merging`,
    }
  }

  return {
    ok: true,
    message: "wrapper package changed and local wrapper version is unpublished",
  }
}

function readJson(filePath, readFileSyncImpl) {
  return JSON.parse(readFileSyncImpl(filePath, "utf8"))
}

function publishedVersionFor(packageName, version, execSyncImpl) {
  try {
    return execSyncImpl(`npm view "${packageName}@${version}" version`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return ""
  }
}

function runReleasePreflight(options = {}, deps = {}) {
  const baseRef = options.baseRef ?? "origin/main"
  const execSyncImpl = deps.execSyncImpl ?? execSync
  const readFileSyncImpl = deps.readFileSyncImpl ?? fs.readFileSync
  const packageJsonPath = deps.packageJsonPath ?? path.resolve(__dirname, "../package.json")
  const packageRoot = deps.packageRoot ?? path.resolve(__dirname, "..")
  const wrapperPackageJsonPath =
    deps.wrapperPackageJsonPath ?? path.resolve(__dirname, "../packages/ouro.bot/package.json")
  const changelogPath = deps.changelogPath ?? path.resolve(__dirname, "../changelog.json")

  const changedFiles = collectChangedFiles(baseRef, execSyncImpl)
  const releasableChanged = versionBumpRequired(changedFiles)
  const packageJson = readJson(packageJsonPath, readFileSyncImpl)
  const wrapperPackageJson = readJson(wrapperPackageJsonPath, readFileSyncImpl)
  const changelog = readJson(changelogPath, readFileSyncImpl)

  const messages = []
  const errors = []

  if (releasableChanged) {
    const publishedCliVersion = publishedVersionFor("@ouro.bot/cli", packageJson.version, execSyncImpl)
    if (publishedCliVersion === packageJson.version) {
      errors.push(
        `@ouro.bot/cli@${packageJson.version} is already published on npm.\n\n` +
          `Bump the version before merging:\n` +
          `  npm version prerelease --preid=alpha\n` +
          `  git push`,
      )
    } else {
      messages.push(`@ouro.bot/cli@${packageJson.version} is not yet published — ready to merge and publish`)
    }
  } else {
    messages.push("No releasable src/ or packaged skills changes detected — version bump not required")
  }

  const changelogResult = validateChangelog(packageJson.version, changelog)
  if (!changelogResult.ok) {
    errors.push(changelogResult.error)
  } else {
    messages.push(`changelog gate: pass (${packageJson.version})`)
    const changelogFreshnessResult = assessChangelogFreshness({
      baseRef,
      changedFiles,
      currentVersion: packageJson.version,
      changelog,
      execSyncImpl,
    })
    if (!changelogFreshnessResult.ok) {
      errors.push(changelogFreshnessResult.message)
    } else {
      messages.push(changelogFreshnessResult.message)
    }
  }

  const wrapperResult = assessWrapperPublishSync({
    changedFiles,
    localVersion: wrapperPackageJson.version,
    cliVersion: packageJson.version,
    publishedVersion: publishedVersionFor("ouro.bot", wrapperPackageJson.version, execSyncImpl),
  })
  if (!wrapperResult.ok) {
    errors.push(wrapperResult.message)
  } else {
    messages.push(wrapperResult.message)
  }

  const packageAssetResult = validatePackageAssets(packageRoot)
  if (!packageAssetResult.ok) {
    errors.push(packageAssetResult.message)
  } else {
    messages.push(packageAssetResult.message)
  }

  return {
    ok: errors.length === 0,
    baseRef,
    changedFiles,
    releasableChanged,
    messages,
    errors,
  }
}

if (require.main === module) {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`release preflight: FAIL`)
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  const result = runReleasePreflight(options)
  for (const message of result.messages) {
    console.log(message)
  }

  if (!result.ok) {
    console.error("release preflight: FAIL")
    for (const error of result.errors) {
      console.error(error)
    }
    process.exit(1)
  }

  console.log("release preflight: pass")
}

module.exports = {
  assessChangelogFreshness,
  assessWrapperPublishSync,
  collectChangedFiles,
  parseArgs,
  pathRequiresChangelogFreshness,
  runReleasePreflight,
  splitLines,
  versionBumpRequired,
  wrapperPackageChanged,
}
