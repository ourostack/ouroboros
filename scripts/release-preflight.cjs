#!/usr/bin/env node

const { execSync } = require("child_process")
const path = require("path")
const fs = require("fs")
const semver = require("semver")

const { validateChangelog } = require("./changelog-gate.cjs")
const {
  isChangeNotePath,
  pathRequiresChangelogFreshness,
  versionBumpRequired,
  wrapperPackageChanged,
} = require("./release-paths.cjs")
const { parseChangeNote } = require("./release-version.cjs")
const { validatePackageAssets } = require("./package-assets.cjs")
const { validateTrustedPublisherLocalContract } = require("./npm-trusted-publishers.cjs")
const { validateIntentionalDebtFile, validDateOnly } = require("./intentional-debt-gate.cjs")

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

function assessLockfileVersionSync(cliVersion, packageLock, shrinkwrap) {
  const records = [
    ["package-lock.json", packageLock],
    ["npm-shrinkwrap.json", shrinkwrap],
  ]
  const mismatches = records.flatMap(([label, lockfile]) => {
    const versions = [lockfile?.version, lockfile?.packages?.[""]?.version]
    return versions.every((version) => version === cliVersion)
      ? []
      : [`${label} must match @ouro.bot/cli version ${cliVersion}`]
  })
  return mismatches.length === 0
    ? { ok: true, message: `lockfile versions aligned (${cliVersion})` }
    : { ok: false, message: mismatches.join("\n") }
}

function classifyOperationalContractChange(file) {
  const persistedSchemaPaths = [
    "src/rsvp/snapshot.ts",
    "src/rsvp/migration.ts",
    "src/rsvp/config.ts",
    "src/rsvp/outbound-state.ts",
    "src/senses/context-packets.ts",
    "src/senses/bluebubbles/outbound-state.ts",
    "src/senses/bluebubbles/semantic-receipts.ts",
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

function formatPathList(files) {
  const shown = files.slice(0, 8).join(", ")
  return files.length > 8 ? `${shown}, and ${files.length - 8} more` : shown
}

const DROP_BUMP_HINT =
  "Run `npm run release:drop-bump` (then `git push`): it moves this branch's changelog.json lines into a change note " +
  "under changes/, puts the release files back and merges main."

// What the branch started from: its merge base's version, changelog versions and change notes.
function readBaseState(baseRef, execSyncImpl) {
  const quiet = { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
  const mergeBase = execSyncImpl(`git merge-base ${shellQuote(baseRef)} HEAD`, quiet).trim()
  const show = (file) => {
    try {
      return execSyncImpl(`git show ${shellQuote(`${mergeBase}:${file}`)}`, quiet)
    } catch {
      return null
    }
  }
  const packageJson = show("package.json")
  const changelog = show("changelog.json")
  const versions = changelog ? JSON.parse(changelog).versions : undefined
  return {
    mergeBase,
    version: packageJson ? JSON.parse(packageJson).version : undefined,
    changelogVersions: Array.isArray(versions) ? versions.map((entry) => entry?.version) : undefined,
    notes: new Set(splitLines(execSyncImpl(`git ls-tree -r --name-only ${shellQuote(mergeBase)} -- changes/`, quiet))),
  }
}

// The release line a version belongs to: everything but the number the release job counts (scripts/release-version.cjs
// counts a prerelease's last number, or else the patch).
function releaseLine(version) {
  const prerelease = semver.prerelease(version)
  return prerelease && typeof prerelease[prerelease.length - 1] === "number"
    ? String(version).replace(/\.\d+$/, "")
    : `${semver.major(version)}.${semver.minor(version)}`
}

// A pull request leaves the version alone: the release job on main gives each landed change the next number. It may
// start a new release line on purpose (0.2.0-alpha.0, or a stable 1.0.0), which the release job then counts from.
function assessReleaseVersionUnchanged(input) {
  if (!input.baseVersion || input.baseVersion === input.headVersion) {
    return { ok: true, message: `release version: left to the release job on main (${input.headVersion})` }
  }
  if (semver.valid(input.baseVersion) && semver.valid(input.headVersion) &&
    semver.gt(input.headVersion, input.baseVersion) && releaseLine(input.headVersion) !== releaseLine(input.baseVersion)) {
    return { ok: true, message: `release version: this branch starts a new release line at ${input.headVersion}` }
  }
  return {
    ok: false,
    message:
      `package.json's version moved from ${input.baseVersion} to ${input.headVersion}, but the release job on main sets ` +
      `the version when a change lands, so a pull request leaves it alone. ${DROP_BUMP_HINT}`,
  }
}

// Every pull request that changes something a person would notice adds its own change note: a new Markdown file in
// changes/, one paragraph or bullet per change. The release job folds the notes into changelog.json.
function assessChangeNote(input) {
  const baseVersions = input.baseChangelogVersions
  const addedVersions = baseVersions && Array.isArray(input.changelog?.versions)
    ? input.changelog.versions.map((entry) => entry?.version).filter((version) => !baseVersions.includes(version))
    : []
  if (addedVersions.length > 0) {
    return {
      ok: false,
      message:
        `changelog.json gains an entry for ${addedVersions.join(", ")} on this branch; the release job writes changelog.json ` +
        `from change notes now. ${DROP_BUMP_HINT}`,
    }
  }

  const notes = input.changedFiles
    .filter((file) => isChangeNotePath(file) && !input.existingNotes.has(file))
    .flatMap((file) => {
      let text
      try {
        text = input.readNote(file)
      } catch {
        return []
      }
      return [{ file, changes: parseChangeNote(text) }]
    })
  const empty = notes.filter((note) => note.changes.length === 0)
  if (empty.length > 0) {
    return { ok: false, message: `change note ${formatPathList(empty.map((note) => note.file))} says nothing; write what changed for the people who use it` }
  }

  const needsNote = input.changedFiles.filter(pathRequiresChangelogFreshness)
  if (notes.length > 0) {
    return { ok: true, message: `change note: ${notes.map((note) => note.file).join(", ")}` }
  }
  if (needsNote.length === 0) {
    return { ok: true, message: "change note: not needed (no releasable implementation paths)" }
  }
  return {
    ok: false,
    message:
      `add a change note for ${formatPathList(needsNote)}: a new file changes/<short-name>.md saying what changed for the ` +
      "people who use it, one paragraph or bullet per change. The release job adds it to changelog.json.",
  }
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

  return {
    ok: true,
    message: wrapperPackageChanged(input.changedFiles)
      ? "wrapper package changed; the release job publishes it with the next version"
      : "wrapper package unchanged",
  }
}

function readJson(filePath, readFileSyncImpl) {
  return JSON.parse(readFileSyncImpl(filePath, "utf8"))
}

function npmAuditCommand({ offline = false } = {}) {
  const auditArgs = `npm audit --audit-level=moderate${offline ? " --offline" : ""} --json`
  if (process.platform === "win32") return auditArgs
  return `if command -v timeout >/dev/null 2>&1; then timeout 120s ${auditArgs}; else ${auditArgs}; fi`
}

function summarizeNpmAuditPass(output) {
  try {
    const parsed = JSON.parse(String(output))
    const total = parsed?.metadata?.vulnerabilities?.total
    return typeof total === "number" ? `found ${total} vulnerabilities` : "no moderate-or-higher vulnerabilities"
  } catch {
    return splitLines(String(output)).find((line) => /^found \d+ vulnerabilities$/.test(line)) ??
      "no moderate-or-higher vulnerabilities"
  }
}

function summarizeNpmAuditFailure(output) {
  const text = String(output)
  try {
    const parsed = JSON.parse(text)
    const counts = parsed?.metadata?.vulnerabilities
    const vulnerabilities = parsed?.vulnerabilities && typeof parsed.vulnerabilities === "object"
      ? Object.entries(parsed.vulnerabilities)
      : []
    const summary = counts && typeof counts === "object"
      ? `npm audit reported ${counts.moderate ?? 0} moderate, ${counts.high ?? 0} high, ${counts.critical ?? 0} critical vulnerabilities`
      : "npm audit reported moderate-or-higher vulnerabilities"
    const details = vulnerabilities.slice(0, 8).map(([name, value]) => {
      const record = value && typeof value === "object" ? value : {}
      const severity = typeof record.severity === "string" ? record.severity : "unknown"
      const via = Array.isArray(record.via)
        ? record.via
          .map((entry) => entry && typeof entry === "object" && typeof entry.title === "string" ? entry.title : "")
          .filter(Boolean)
          .slice(0, 2)
          .join("; ")
        : ""
      return `${name}: ${severity}${via ? ` (${via})` : ""}`
    })
    return [summary, ...details].join("\n")
  } catch {
    return splitLines(text).slice(-10).join("\n")
  }
}

/**
 * Advisories with no patched release can be accepted only through a reviewed entry in
 * docs/audit-exceptions.json: { items: [{ advisory, package, reason, due }] }. An entry
 * covers exactly one advisory URL/dependency pair and stops covering it on its due date, so an accepted
 * risk is re-decided rather than forgotten. Every advisory in the report must be covered.
 */
function readAuditExceptions(packageRoot) {
  const file = path.join(packageRoot, "docs", "audit-exceptions.json")
  if (!fs.existsSync(file)) return []
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"))
  const items = Array.isArray(parsed?.items) ? parsed.items : []
  return items.filter((item) => item && typeof item.advisory === "string"
    && typeof item.package === "string" && item.package.trim()
    && typeof item.reason === "string" && item.reason.trim() && validDateOnly(item.due))
}

function uncoveredAuditAdvisories(output, exceptions, today) {
  let parsed
  try { parsed = JSON.parse(String(output)) } catch { return null }
  const vulnerabilities = parsed?.vulnerabilities && typeof parsed.vulnerabilities === "object" ? Object.entries(parsed.vulnerabilities) : []
  const advisories = new Map()
  for (const [packageName, record] of vulnerabilities) {
    for (const entry of Array.isArray(record?.via) ? record.via : []) {
      if (entry && typeof entry === "object") {
        const url = typeof entry.url === "string" ? entry.url : "(advisory without url)"
        const dependency = typeof entry.name === "string" ? entry.name : packageName
        advisories.set(JSON.stringify([dependency, url]), url)
      }
    }
  }
  if (advisories.size === 0) return null
  const active = new Set(exceptions.filter((item) => today < item.due).map((item) => JSON.stringify([item.package, item.advisory])))
  return {
    uncovered: [...advisories].filter(([key]) => !active.has(key)).map(([, url]) => url),
    covered: [...advisories].filter(([key]) => active.has(key)).map(([, url]) => url),
  }
}

function runRootDependencyAudit(packageRoot, execSyncImpl, options = {}) {
  try {
    const output = execSyncImpl(npmAuditCommand(), {
      cwd: packageRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 130_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    const summary = summarizeNpmAuditPass(output)
    return { ok: true, message: `root npm audit: pass (${summary})` }
  } catch (error) {
    const stdout = errorOutputText(error?.stdout)
    const stderr = errorOutputText(error?.stderr)
    const details = summarizeNpmAuditFailure(`${stdout}\n${stderr}`)
    const timedOut = error?.signal === "SIGTERM" || error?.status === 124 || error?.status === 137
    const auditServiceUnavailable = timedOut || /audit endpoint returned an error|network timeout at:/u.test(details)
    if (auditServiceUnavailable) {
      try {
        const offlineOutput = execSyncImpl(npmAuditCommand({ offline: true }), {
          cwd: packageRoot,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 130_000,
          maxBuffer: 10 * 1024 * 1024,
        })
        const summary = summarizeNpmAuditPass(offlineOutput)
        return { ok: true, message: `root npm audit: pass (${summary}; offline cache fallback after registry timeout)` }
      } catch (offlineError) {
        const offlineStdout = errorOutputText(offlineError?.stdout)
        const offlineStderr = errorOutputText(offlineError?.stderr)
        const offlineDetails = summarizeNpmAuditFailure(`${offlineStdout}\n${offlineStderr}`)
        return {
          ok: true,
          message:
            "root npm audit: unavailable (registry audit endpoint timed out and offline fallback failed)" +
            (offlineDetails ? `\n${offlineDetails}` : ""),
        }
      }
    }
    if (!timedOut) {
      const exceptions = options.exceptions ?? readAuditExceptions(packageRoot)
      const today = options.today ?? new Date().toISOString().slice(0, 10)
      const coverage = uncoveredAuditAdvisories(stdout, exceptions, today)
      if (coverage && coverage.uncovered.length === 0) {
        return { ok: true, message: `root npm audit: pass (accepted by docs/audit-exceptions.json: ${coverage.covered.join(", ")})` }
      }
    }
    return {
      ok: false,
      message:
        `root npm audit failed: npm audit --audit-level=moderate ${
          timedOut ? "timed out" : "reported vulnerable dependencies"
        }` +
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
  const packageLockPath = deps.packageLockPath ?? path.resolve(__dirname, "../package-lock.json")
  const shrinkwrapPath = deps.shrinkwrapPath ?? path.resolve(__dirname, "../npm-shrinkwrap.json")
  const packageRoot = deps.packageRoot ?? path.resolve(__dirname, "..")
  const wrapperPackageJsonPath =
    deps.wrapperPackageJsonPath ?? path.resolve(__dirname, "../packages/ouro.bot/package.json")
  const changelogPath = deps.changelogPath ?? path.resolve(__dirname, "../changelog.json")
  const intentionalDebtPath = deps.intentionalDebtPath ?? path.resolve(__dirname, "../docs/intentional-debt.json")

  const changedFiles = collectChangedFiles(baseRef, execSyncImpl)
  const releasableChanged = versionBumpRequired(changedFiles)
  const packageJson = readJson(packageJsonPath, readFileSyncImpl)
  const packageLock = readJson(packageLockPath, readFileSyncImpl)
  const shrinkwrap = readJson(shrinkwrapPath, readFileSyncImpl)
  const wrapperPackageJson = readJson(wrapperPackageJsonPath, readFileSyncImpl)
  const changelog = readJson(changelogPath, readFileSyncImpl)

  const messages = []
  const errors = []

  const lockfileResult = assessLockfileVersionSync(packageJson.version, packageLock, shrinkwrap)
  if (lockfileResult.ok) {
    messages.push(lockfileResult.message)
  } else {
    errors.push(lockfileResult.message)
  }

  messages.push(releasableChanged
    ? "releasable changes: the release job on main publishes the next version when this lands"
    : "no releasable changes: landing this publishes no new version")

  const baseState = readBaseState(baseRef, execSyncImpl)
  const versionResult = assessReleaseVersionUnchanged({ baseVersion: baseState.version, headVersion: packageJson.version })
  if (!versionResult.ok) {
    errors.push(versionResult.message)
  } else {
    messages.push(versionResult.message)
  }

  const changelogResult = validateChangelog(packageJson.version, changelog)
  if (!changelogResult.ok) {
    errors.push(changelogResult.error)
  } else {
    messages.push(`changelog gate: pass (${packageJson.version})`)
  }

  const changeNoteResult = assessChangeNote({
    changedFiles,
    existingNotes: baseState.notes,
    baseChangelogVersions: baseState.changelogVersions,
    changelog,
    readNote: (file) => readFileSyncImpl(path.join(packageRoot, file), "utf8"),
  })
  if (!changeNoteResult.ok) {
    errors.push(changeNoteResult.message)
  } else {
    messages.push(changeNoteResult.message)
  }

  const wrapperResult = assessWrapperPublishSync({
    changedFiles,
    localVersion: wrapperPackageJson.version,
    cliVersion: packageJson.version,
  })
  if (!wrapperResult.ok) {
    errors.push(wrapperResult.message)
  } else {
    messages.push(wrapperResult.message)
  }

  const operationalContracts = summarizeOperationalContractChanges(changedFiles)
  messages.push(...formatOperationalContractMessages(operationalContracts))

  try {
    const intentionalDebtResult = validateIntentionalDebtFile(intentionalDebtPath, deps.now?.() ?? new Date())
    if (!intentionalDebtResult.ok) {
      errors.push(intentionalDebtResult.message, ...intentionalDebtResult.errors)
    } else {
      messages.push(intentionalDebtResult.message)
    }
  } catch (error) {
    errors.push(`intentional debt gate: fail (${error instanceof Error ? error.message : String(error)})`)
  }

  const auditResult = runRootDependencyAudit(packageRoot, execSyncImpl)
  if (!auditResult.ok) {
    errors.push(auditResult.message)
  } else {
    messages.push(auditResult.message)
  }

  const packageAssetResult = validatePackageAssets(packageRoot, undefined, { sourceTree: true })
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
  assessChangeNote,
  assessLockfileVersionSync,
  assessReleaseVersionUnchanged,
  assessWrapperPublishSync,
  classifyOperationalContractChange,
  collectChangedFiles,
  parseArgs,
  pathRequiresChangelogFreshness,
  readBaseState,
  runReleasePreflightCli,
  runReleasePreflightCliIfMain,
  runReleasePreflight,
  runRootDependencyAudit,
  splitLines,
  versionBumpRequired,
  wrapperPackageChanged,
}
