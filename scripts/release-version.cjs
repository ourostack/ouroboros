#!/usr/bin/env node

// The release job's version and changelog, worked out from main's history so no pull request has to carry them.
//
// The anchor is the last commit on main's first-parent line that changed package.json's version. It releases that
// version (the base). After it, every commit that releases something (see isReleasableCommit) takes the next number,
// in order. Only commits made once change notes exist (changes/README.md is in the tree) count. The same commit
// always gets the same number, so every job and workflow that asks agrees without talking to npm or to each other.
//
// A push publishes once: the version of the newest releasable commit it brought, with every change note from all of
// its commits in that version's changelog entry. A push of several commits (a rebase merge) therefore skips the
// numbers of its earlier commits. Earlier entries are rebuilt from history: the release tags (v<version>, which the
// GitHub release job puts on each push's last commit) mark where each published push ended, and a release that has
// no tag yet gets an entry per commit. A commit's entry is the notes it added under changes/, or its subject.
//
//   node scripts/release-version.cjs version          prints HEAD's version
//   node scripts/release-version.cjs push <before>    for the push before..HEAD, prints version=<v> and
//                                                      release=true|false, for GITHUB_OUTPUT
//   node scripts/release-version.cjs dispatch          the same for a manual run on HEAD; fails when HEAD's code is
//                                                      not what HEAD's version shipped
//   node scripts/release-version.cjs apply [<before>]  writes the version and changelog into the release files,
//                                                      prints the version

// `version`, `push` and `dispatch` need only git and Node, so a job can ask before installing dependencies; `apply`
// loads release-bump.cjs (and semver) when it runs.

const { execFileSync } = require("child_process")
const path = require("path")

const { NOTES_README, isChangeNotePath, versionBumpRequired, wrapperPackageChanged } = require("./release-paths.cjs")

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

// First-parent commits in `range`, oldest first, with each one's changed files (status and path).
function firstParentCommits(git, range) {
  const log = git("log", "--first-parent", "--reverse", "--no-renames", "--diff-merges=first-parent",
    "--name-status", "--format=%x1e%H%x1f%s", range)
  return log.split("\x1e").filter((chunk) => chunk.trim()).map((chunk) => {
    const [header, ...lines] = chunk.split("\n")
    const [sha, subject] = header.split("\x1f")
    const changes = lines.filter(Boolean).map((line) => {
      const [status, file] = line.split("\t")
      return { status, file }
    })
    return { sha, subject, changes, files: changes.map((change) => change.file) }
  })
}

function lines(output) {
  return String(output).split("\n").map((line) => line.trim()).filter(Boolean)
}

// The blobs at `specs` (<commit>:<path>), read in one `git cat-file --batch` call.
function readBlobs(root, execFileSyncImpl, specs) {
  if (specs.length === 0) return new Map()
  const output = execFileSyncImpl("git", ["cat-file", "--batch"], {
    cwd: root,
    input: `${specs.join("\n")}\n`,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  })
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output)
  const blobs = new Map()
  let offset = 0
  for (const spec of specs) {
    const newline = buffer.indexOf(10, offset)
    const header = buffer.subarray(offset, newline).toString("utf8").split(" ")
    offset = newline + 1
    if (header[1] !== "blob") continue
    const size = Number(header[2])
    blobs.set(spec, buffer.subarray(offset, offset + size).toString("utf8"))
    offset += size + 1
  }
  return blobs
}

// Commits that carry a release tag, as commit -> versions named by its v<version> tags.
function releaseTags(git) {
  const tagged = new Map()
  for (const line of lines(git("for-each-ref", "refs/tags", "--format=%(refname:strip=2)%1f%(objectname)%1f%(*objectname)"))) {
    const [name, object, peeled] = line.split("\x1f")
    const match = /^v(.+)$/.exec(name)
    if (!match) continue
    const commit = peeled || object
    if (!tagged.has(commit)) tagged.set(commit, new Set())
    tagged.get(commit).add(match[1])
  }
  return tagged
}

// The commit the push started from, when git knows it as an ancestor of HEAD. Otherwise (a new branch's all-zero
// sha, a typo, a missing argument) the push is taken to be HEAD alone.
function resolvePushStart(git, before) {
  const candidate = typeof before === "string" ? before.trim() : ""
  if (/^[0-9a-f]{4,64}$/i.test(candidate) && !/^0+$/.test(candidate)) {
    try {
      const sha = git("rev-parse", "--verify", "-q", `${candidate}^{commit}`).trim()
      git("merge-base", "--is-ancestor", sha, "HEAD")
      return sha
    } catch {
      // Not a commit, or not behind HEAD: fall through.
    }
  }
  try {
    return git("rev-parse", "--verify", "-q", "HEAD^1").trim()
  } catch {
    return null
  }
}

function planRelease(input = {}) {
  const root = path.resolve(input.root ?? process.cwd())
  const execFileSyncImpl = input.execFileSyncImpl ?? execFileSync
  const git = gitRunner(root, execFileSyncImpl)

  if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
    throw new Error("the release version needs main's full history; check out with fetch-depth: 0")
  }
  const head = git("rev-parse", "HEAD").trim()
  const lastVersionChange = (ref) =>
    git("log", "--first-parent", "-G", VERSION_LINE, "--format=%H", "-1", ref, "--", "package.json").trim()
  const anchor = lastVersionChange("HEAD")
  if (!anchor) {
    throw new Error("no commit sets package.json's version, so there is no release to count from")
  }
  const versionAt = (sha) => JSON.parse(git("show", `${sha}:package.json`)).version
  const baseVersion = versionAt(anchor)

  // Counting starts where change notes do: the first commit that added changes/README.md, and the version in force
  // there. Everything older was released by bumps that pull requests carried.
  const notesStart = lines(git("log", "--first-parent", "--reverse", "--diff-filter=A", "--format=%H", "HEAD", "--", NOTES_README))[0]
  if (!notesStart) {
    throw new Error(`${NOTES_README} is not in this history, so no landed change has a release number yet`)
  }
  const firstAnchor = lastVersionChange(notesStart)
  if (!firstAnchor) {
    throw new Error(`no commit before ${NOTES_README} arrived sets package.json's version, so there is no release to count from`)
  }
  const versionChanges = new Set(lines(git("log", "--first-parent", "-G", VERSION_LINE, "--format=%H", `${firstAnchor}..HEAD`, "--", "package.json")))
  const tags = releaseTags(git)
  const pushStart = resolvePushStart(git, input.before)
  const inPush = pushStart
    ? new Set(lines(git("rev-list", "--first-parent", `${pushStart}..HEAD`)))
    : null
  const isInPush = (sha) => (inPush ? inPush.has(sha) : true)

  // Number every releasable commit, then group them into the releases that published them.
  const commits = firstParentCommits(git, `${firstAnchor}..HEAD`)
  let notesExist = firstAnchor === notesStart
  let base = versionAt(firstAnchor)
  let count = 0
  let current = base
  const numbered = []
  const groups = []
  let pending = []
  const flushTogether = () => {
    if (pending.length > 0) groups.push(pending)
    pending = []
  }
  const flushApart = () => {
    for (const commit of pending) groups.push([commit])
    pending = []
  }

  for (const commit of commits) {
    for (const change of commit.changes) {
      if (change.file !== NOTES_README) continue
      if (change.status === "A") notesExist = true
      if (change.status === "D") notesExist = false
    }
    if (versionChanges.has(commit.sha)) {
      flushApart()
      base = versionAt(commit.sha)
      count = 0
      current = base
      continue
    }
    if (notesExist && isReleasableCommit(commit.files)) {
      count += 1
      current = versionAfter(base, count)
      const entry = {
        sha: commit.sha,
        version: current,
        subject: commit.subject,
        notes: commit.changes.filter((change) => change.status === "A" && isChangeNotePath(change.file)).map((change) => change.file),
      }
      numbered.push(entry)
      pending.push(entry)
    }
    if (isInPush(commit.sha)) continue
    if (tags.get(commit.sha)?.has(current)) flushTogether()
    if (commit.sha === pushStart) flushApart()
  }
  // What is left is this push's own commits, which publish together.
  const pushCommits = pending
  flushTogether()

  const blobs = readBlobs(root, execFileSyncImpl, numbered.flatMap((commit) => commit.notes.map((file) => `${commit.sha}:${file}`)))
  const entries = groups.map((group) => {
    const notes = group.flatMap((commit) => commit.notes.flatMap((file) => parseChangeNote(blobs.get(`${commit.sha}:${file}`) ?? "")))
    const last = group[group.length - 1]
    return {
      version: last.version,
      commit: last.sha,
      changes: notes.length > 0 ? notes : group.map((commit) => commit.subject),
    }
  }).reverse()

  return {
    anchor,
    head,
    baseVersion,
    version: current,
    release: pushCommits.length > 0 || isInPush(anchor),
    headTagged: tags.get(head)?.has(current) ?? false,
    entries,
  }
}

function applyRelease(input) {
  const { readJson, writeJson, prepareReleaseVersion } = require("./release-bump.cjs")
  const semver = require("semver")
  const root = path.resolve(input.root ?? process.cwd())
  const plan = input.plan
  const changelogPath = path.join(root, "changelog.json")
  const changelog = readJson(changelogPath)
  if (!Array.isArray(changelog.versions)) {
    throw new Error("changelog.json must contain a versions array")
  }
  const writeVersion = prepareReleaseVersion({ root, version: plan.version })
  const planned = new Set(plan.entries.map((entry) => entry.version))
  const merged = [
    ...plan.entries.map((entry) => ({ version: entry.version, changes: entry.changes })),
    ...changelog.versions.filter((entry) => !planned.has(entry?.version)),
  ]
  // Newest first. An entry whose version is not semver keeps its place after the ones that are.
  const valid = merged.filter((entry) => semver.valid(entry?.version))
  changelog.versions = [
    ...valid.sort((left, right) => semver.rcompare(left.version, right.version)),
    ...merged.filter((entry) => !semver.valid(entry?.version)),
  ]
  writeVersion()
  writeJson(changelogPath, changelog)
  return plan.version
}

function runReleaseVersionCli(argv = process.argv.slice(2), deps = {}) {
  const root = deps.root ?? process.cwd()
  const log = deps.log ?? console.log
  const error = deps.error ?? console.error
  const [command, before] = argv
  if (!["version", "push", "dispatch", "apply"].includes(command) || (command === "push" && !before)) {
    error("usage: node scripts/release-version.cjs version | push <before> | dispatch | apply [<before>]")
    return 2
  }
  try {
    const plan = planRelease({ root, before, execFileSyncImpl: deps.execFileSyncImpl })
    if (command === "version") {
      log(plan.version)
    } else if (command === "apply") {
      applyRelease({ root, plan })
      error(`release files written for ${plan.version} (base ${plan.baseVersion} at ${plan.anchor.slice(0, 12)})`)
      log(plan.version)
    } else if (command === "dispatch") {
      if (!plan.release && !plan.headTagged) {
        throw new Error(
          `${plan.head.slice(0, 12)} releases nothing: ${plan.version} shipped an earlier commit's code, so an image ` +
          `built here would carry the wrong code under that tag. Run it on the commit tagged v${plan.version}.`,
        )
      }
      log(`version=${plan.version}\nrelease=true`)
    } else {
      error(plan.release
        ? `this push releases ${plan.version}`
        : `this push releases nothing; ${plan.version} came from an earlier push`)
      log(`version=${plan.version}\nrelease=${plan.release}`)
    }
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
