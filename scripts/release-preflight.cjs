#!/usr/bin/env node

const { execSync } = require("child_process")
const path = require("path")
const fs = require("fs")

const { validateChangelog } = require("./changelog-gate.cjs")
const { validatePackageAssets } = require("./package-assets.cjs")
const { validateTrustedPublisherLocalContract } = require("./npm-trusted-publishers.cjs")

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

function classifyOperationalContractChange(file) {
  const persistedSchemaPaths = [
    "src/rsvp/snapshot.ts",
    "src/rsvp/migration.ts",
    "src/rsvp/config.ts",
    "src/rsvp/outbound-state.ts",
    "src/senses/context-packets.ts",
    "src/senses/bluebubbles/outbound-state.ts",
    "src/heart/run-ledger.ts",
    "src/heart/autonomy-budget.ts",
  ]
  if (persistedSchemaPaths.includes(file)) {
    return {
      kind: "persisted-schema",
      message: `persisted schema changed: ${file}`,
    }
  }

  if (file.startsWith("src/__fixtures__/") || file.endsWith(".fixture.json") || file.endsWith(".trace.json")) {
    return {
      kind: "replay-fixture",
      message: `replay fixture changed: ${file}`,
    }
  }

  if (
    file === "src/heart/daemon/doctor.ts" ||
    file === "src/rsvp/diagnostics.ts" ||
    file === "src/rsvp/incident-bundle.ts"
  ) {
    return {
      kind: "doctor-category",
      message: `doctor category/check surface changed: ${file}`,
    }
  }

  return null
}

function summarizeOperationalContractChanges(changedFiles) {
  const changes = changedFiles
    .map(classifyOperationalContractChange)
    .filter(Boolean)
  const priority = ["persisted-schema", "replay-fixture", "doctor-category"]
  const kinds = priority.filter((kind) => changes.some((change) => change.kind === kind))
  return { kinds, messages: changes.map((change) => change.message) }
}

function formatOperationalContractMessages(operationalContracts) {
  return operationalContracts.kinds.length > 0
    ? [`operational contracts: ${operationalContracts.kinds.join(", ")}`, ...operationalContracts.messages]
    : []
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

  return changelogUncommitted
    ? { ok: true, message: "changelog freshness: pass" }
    : assessCommittedChangelogFreshness({
      baseRef: input.baseRef,
      freshnessFiles,
      execSyncImpl: input.execSyncImpl,
    })
}

function assessCommittedChangelogFreshness(input) {
  const changelogCommit = latestCommitForPath(input.baseRef, "changelog.json", input.execSyncImpl)
  return changelogCommit
    ? assessCommittedChangelogOrder({
      baseRef: input.baseRef,
      freshnessFiles: input.freshnessFiles,
      changelogCommit,
      execSyncImpl: input.execSyncImpl,
    })
    : {
      ok: false,
      message:
        `changelog.json must be committed on this branch alongside releasable implementation changes: ${formatPathList(input.freshnessFiles)}`,
    }
}

function assessCommittedChangelogOrder(input) {
  const staleFiles = input.freshnessFiles.filter((file) => {
    const fileCommit = latestCommitForPath(input.baseRef, file, input.execSyncImpl)
    return fileCommit && !isAncestorCommit(fileCommit, input.changelogCommit, input.execSyncImpl)
  })

  return staleFiles.length > 0
    ? {
      ok: false,
      message:
        `changelog.json is older than releasable implementation changes; update it after touching: ${formatPathList(staleFiles)}`,
    }
    : { ok: true, message: "changelog freshness: pass" }
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

function runRootDependencyAudit(packageRoot, execSyncImpl) {
  try {
    const output = execSyncImpl("npm audit --audit-level=moderate", {
      cwd: packageRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const summary = splitLines(String(output)).find((line) => /^found \d+ vulnerabilities$/.test(line)) ??
      "no moderate-or-higher vulnerabilities"
    return { ok: true, message: `root npm audit: pass (${summary})` }
  } catch (error) {
    const stdout = errorOutputText(error?.stdout)
    const stderr = errorOutputText(error?.stderr)
    const details = splitLines(`${stdout}\n${stderr}`).slice(-10).join("\n")
    return {
      ok: false,
      message:
        `root npm audit failed: npm audit --audit-level=moderate reported vulnerable dependencies` +
        (details ? `\n${details}` : ""),
    }
  }
}

function errorOutputText(value) {
  return value && typeof value.toString === "function" ? value.toString() : ""
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
          `  npm run release:bump -- --version <next-version> --change "Describe this release."\n` +
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

  const operationalContracts = summarizeOperationalContractChanges(changedFiles)
  messages.push(...formatOperationalContractMessages(operationalContracts))

  const auditResult = runRootDependencyAudit(packageRoot, execSyncImpl)
  if (!auditResult.ok) {
    errors.push(auditResult.message)
  } else {
    messages.push(auditResult.message)
  }

  const packageAssetResult = validatePackageAssets(packageRoot)
  if (!packageAssetResult.ok) {
    errors.push(packageAssetResult.message)
  } else {
    messages.push(packageAssetResult.message)
  }

  const trustedPublisherResult = validateTrustedPublisherLocalContract({
    repoRoot: packageRoot,
    readFileSyncImpl,
  })
  if (!trustedPublisherResult.ok) {
    errors.push(...trustedPublisherResult.errors)
  } else {
    messages.push(...trustedPublisherResult.messages)
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

function runReleasePreflightCli(argv = process.argv.slice(2), deps = {}) {
  const consoleLog = deps.consoleLog ?? console.log
  const consoleError = deps.consoleError ?? console.error
  const exit = deps.exit ?? process.exit
  const runReleasePreflightImpl = deps.runReleasePreflightImpl ?? runReleasePreflight
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    consoleError(`release preflight: FAIL`)
    consoleError(error instanceof Error ? error.message : String(error))
    return exit(1)
  }

  const result = runReleasePreflightImpl(options)
  for (const message of result.messages) {
    consoleLog(message)
  }

  if (result.ok) {
    consoleLog("release preflight: pass")
    return 0
  } else {
    consoleError("release preflight: FAIL")
    for (const error of result.errors) {
      consoleError(error)
    }
    return exit(1)
  }
}

function runReleasePreflightCliIfMain(moduleRef = module, requireRef = require, runCli = runReleasePreflightCli) {
  return requireRef.main !== moduleRef ? undefined : runCli()
}

runReleasePreflightCliIfMain()

module.exports = {
  assessChangelogFreshness,
  assessWrapperPublishSync,
  classifyOperationalContractChange,
  collectChangedFiles,
  parseArgs,
  pathRequiresChangelogFreshness,
  runReleasePreflightCli,
  runReleasePreflightCliIfMain,
  runReleasePreflight,
  runRootDependencyAudit,
  splitLines,
  versionBumpRequired,
  wrapperPackageChanged,
}
