#!/usr/bin/env node

// The release job's version and changelog, worked out from main's history so no pull request has to carry them.
//
// The anchor is the last commit on main's first-parent line that changed package.json's version. It releases that
// version (the base). After it, every commit that releases something (see isReleasableCommit) takes the next number,
// in order, and its changelog entry is the change notes it added under changes/, or its subject when it added none.
// The same commit always gets the same version, so every job and workflow that asks agrees without talking to npm.
//
//   node scripts/release-version.cjs version   prints HEAD's version
//   node scripts/release-version.cjs apply     writes it and the changelog into the release files, prints the version
//   node scripts/release-version.cjs notes     prints HEAD's changelog entry, one change per paragraph
//   node scripts/release-version.cjs commit    prints the commit that released HEAD's version (HEAD, when it releases)

// `version`, `commit` and `notes` need only git and Node, so a job can ask before installing dependencies; `apply`
// loads release-bump.cjs (and semver) when it runs.

const { execFileSync } = require("child_process")
const fs = require("fs")
const path = require("path")

const { isChangeNotePath, versionBumpRequired, wrapperPackageChanged } = require("./release-paths.cjs")

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

// package.json's own version line; dependency versions sit deeper and never match.
const VERSION_LINE = '^  "version": '

function versionAfter(base, steps) {
  const match = SEMVER.exec(String(base))
  if (!match) {
    throw new Error(`release base ${base} is not valid semver`)
  }
  const [, major, minor, patch, prerelease] = match
  const parts = prerelease ? prerelease.split(".") : []
  const last = parts[parts.length - 1]
  if (last !== undefined && /^\d+$/.test(last)) {
    return `${major}.${minor}.${patch}-${[...parts.slice(0, -1), Number(last) + steps].join(".")}`
  }
  return `${major}.${minor}.${Number(patch) + steps}`
}

// Each paragraph, and each "- " or "* " bullet, is one changelog line. Heading lines are skipped.
function parseChangeNote(text) {
  const items = []
  let current = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) {
      if (current) items.push(current)
      current = null
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      if (current) items.push(current)
      current = bullet[1]
      continue
    }
    current = current ? `${current} ${line}` : line
  }
  if (current) items.push(current)
  return items
}

function isReleasableCommit(files) {
  return versionBumpRequired(files) || wrapperPackageChanged(files) || files.some(isChangeNotePath)
}

function gitRunner(root, execFileSyncImpl) {
  return (...args) => execFileSyncImpl("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  })
}

// Commits after the anchor on the first-parent line, oldest first, with the files each changed and the notes it added.
function commitsAfter(git, anchor) {
  const log = git("log", "--first-parent", "--reverse", "--no-renames", "--diff-merges=first-parent",
    "--name-status", "--format=%x1e%H%x1f%s", `${anchor}..HEAD`)
  return log.split("\x1e").filter((chunk) => chunk.trim()).map((chunk) => {
    const [header, ...lines] = chunk.split("\n")
    const [sha, subject] = header.split("\x1f")
    const changes = lines.filter(Boolean).map((line) => {
      const [status, file] = line.split("\t")
      return { status, file }
    })
    return {
      sha,
      subject,
      files: changes.map((change) => change.file),
      addedNotes: changes.filter((change) => change.status === "A" && isChangeNotePath(change.file)).map((change) => change.file),
    }
  })
}

function planRelease(input = {}) {
  const root = path.resolve(input.root ?? process.cwd())
  const git = gitRunner(root, input.execFileSyncImpl ?? execFileSync)

  if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
    throw new Error("the release version needs main's full history; check out with fetch-depth: 0")
  }
  const head = git("rev-parse", "HEAD").trim()
  const anchor = git("log", "--first-parent", "-G", VERSION_LINE, "--format=%H", "-1", "HEAD", "--", "package.json").trim()
  if (!anchor) {
    throw new Error("no commit sets package.json's version, so there is no release to count from")
  }
  const baseVersion = JSON.parse(git("show", `${anchor}:package.json`)).version

  const entries = []
  for (const commit of commitsAfter(git, anchor)) {
    if (!isReleasableCommit(commit.files)) continue
    const notes = commit.addedNotes.flatMap((file) => parseChangeNote(git("show", `${commit.sha}:${file}`)))
    entries.unshift({
      version: versionAfter(baseVersion, entries.length + 1),
      commit: commit.sha,
      changes: notes.length > 0 ? notes : [commit.subject],
    })
  }

  return {
    anchor,
    head,
    baseVersion,
    version: entries[0]?.version ?? baseVersion,
    entries,
  }
}

function applyRelease(input) {
  const { readJson, writeJson, prepareReleaseVersion } = require("./release-bump.cjs")
  const root = path.resolve(input.root ?? process.cwd())
  const plan = input.plan
  const changelogPath = path.join(root, "changelog.json")
  const changelog = readJson(changelogPath)
  if (!Array.isArray(changelog.versions)) {
    throw new Error("changelog.json must contain a versions array")
  }
  const writeVersion = prepareReleaseVersion({ root, version: plan.version })
  const planned = new Set(plan.entries.map((entry) => entry.version))
  changelog.versions = [
    ...plan.entries.map((entry) => ({ version: entry.version, changes: entry.changes })),
    ...changelog.versions.filter((entry) => !planned.has(entry?.version)),
  ]
  writeVersion()
  writeJson(changelogPath, changelog)
  return plan.version
}

// The commit whose landing gave HEAD its version: HEAD itself when HEAD releases something.
function releaseCommit(plan) {
  return plan.entries[0]?.commit ?? plan.anchor
}

function notesFor(root, plan) {
  if (plan.entries.length > 0) return plan.entries[0].changes
  const entry = JSON.parse(fs.readFileSync(path.join(root, "changelog.json"), "utf8")).versions?.find((candidate) => candidate?.version === plan.version)
  return entry?.changes ?? []
}

function runReleaseVersionCli(argv = process.argv.slice(2), deps = {}) {
  const root = deps.root ?? process.cwd()
  const log = deps.log ?? console.log
  const error = deps.error ?? console.error
  const [command] = argv
  if (!["version", "apply", "notes", "commit"].includes(command)) {
    error("usage: node scripts/release-version.cjs version|apply|notes|commit")
    return 2
  }
  try {
    const plan = planRelease({ root, execFileSyncImpl: deps.execFileSyncImpl })
    if (command === "apply") {
      applyRelease({ root, plan })
      error(`release files written for ${plan.version} (base ${plan.baseVersion} at ${plan.anchor.slice(0, 12)}, ${plan.entries.length} release(s) since)`)
    }
    log(command === "notes" ? notesFor(root, plan).join("\n\n") : command === "commit" ? releaseCommit(plan) : plan.version)
    return 0
  } catch (failure) {
    error("release version: FAIL")
    error(failure instanceof Error ? failure.message : String(failure))
    return 1
  }
}

if (require.main === module) {
  process.exitCode = runReleaseVersionCli()
}

module.exports = {
  applyRelease,
  isReleasableCommit,
  parseChangeNote,
  planRelease,
  runReleaseVersionCli,
  versionAfter,
}
