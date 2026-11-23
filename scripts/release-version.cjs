#!/usr/bin/env node

// The release job's version and changelog, worked out when a change lands on main so no pull request has to carry them.
//
// Counting starts at npm's last release: the newest published version whose commit (npm's gitHead, or its v<version>
// tag) is in this push's history before the push. Every later first-parent commit that releases something (see
// isReleasableCommit) takes the next number, in order. Numbers already on npm never depend on today's rules. A commit
// that changes package.json's version starts a new line from that version, and must move the version forward; one
// that does not stops the release rather than reuse a number. With nothing on npm, counting starts at the last commit
// that changed the version (the anchor).
//
// A push publishes once: the version of the newest releasable commit it brought, with every change note from all of
// its commits, as its last commit left them, in that version's changelog entry. A push of several commits (a rebase
// merge) therefore skips the numbers of its earlier commits. Earlier entries are the changelog npm's last release
// carried, plus one per numbered commit since. A commit's entry is the notes it added under changes/, or its subject.
//
//   node scripts/release-version.cjs version              prints HEAD's version
//   node scripts/release-version.cjs push <before>        for the push before..HEAD, prints version=<v> and
//                                                          release=true|false, for GITHUB_OUTPUT
//   node scripts/release-version.cjs dispatch             the same for a manual run on HEAD; fails unless npm
//                                                          published HEAD's version from HEAD, so an image never
//                                                          carries code npm did not ship
//   node scripts/release-version.cjs apply [<before>]     writes the version and changelog into the release files,
//                                                          prints the version
//   node scripts/release-version.cjs assert-new <version> fails unless <version> is above npm's highest, or HEAD
//                                                          already published it (a re-run)
//
// Every command reads npm (npm view, and npm pack for the last release's changelog). `apply` also loads
// release-bump.cjs (and semver).

const { execFileSync } = require("child_process")
const fs = require("fs")
const os = require("os")
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

// Semver precedence, without loading semver, so a job can plan before installing dependencies.
function compareVersions(left, right) {
  const parse = (version) => {
    const match = SEMVER.exec(String(version))
    if (!match) throw new Error(`${version} is not valid semver`)
    return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split(".") : [] }
  }
  const a = parse(left)
  const b = parse(right)
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1
  }
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length === 0 ? 0 : a.pre.length === 0 ? 1 : -1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
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

// Removing a change note (tidying old ones) releases nothing; adding or editing one does.
function releasingFiles(changes) {
  return changes.filter((change) => !(change.status === "D" && isChangeNotePath(change.file))).map((change) => change.file)
}

function isReleasableCommit(files) {
  return versionBumpRequired(files) || wrapperPackageChanged(files) || files.some(isChangeNotePath)
}

function gitRunner(root, execFileSyncImpl) {
  // quotePath off: a path that is not ASCII is printed as is, not quoted and escaped.
  return (...args) => execFileSyncImpl("git", ["-c", "core.quotePath=false", ...args], {
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

const PACKAGE = "@ouro.bot/cli"
const EMPTY_REGISTRY = { versions: () => [], gitHead: () => undefined, changelog: () => [] }

// npm as the release plan reads it: the published versions, the commit each was published from, and the changelog
// a version's tarball carries. Each answer is asked once.
function npmRegistry(execFileSyncImpl = execFileSync) {
  const npm = (...args) => execFileSyncImpl("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 })
  const memo = (fn) => {
    const cache = new Map()
    return (key) => {
      if (!cache.has(key)) cache.set(key, fn(key))
      return cache.get(key)
    }
  }
  return {
    versions: memo(() => {
      const parsed = JSON.parse(npm("view", PACKAGE, "versions", "--json"))
      return Array.isArray(parsed) ? parsed : [parsed]
    }),
    gitHead: memo((version) => npm("view", `${PACKAGE}@${version}`, "gitHead").trim() || undefined),
    changelog: memo((version) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-version-"))
      try {
        const [packed] = JSON.parse(npm("pack", `${PACKAGE}@${version}`, "--pack-destination", dir, "--json"))
        const text = execFileSyncImpl("tar", ["-xzOf", path.join(dir, packed.filename), "package/changelog.json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
        const versions = JSON.parse(text).versions
        if (!Array.isArray(versions)) throw new Error(`${PACKAGE}@${version}'s changelog.json has no versions array`)
        return versions
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }),
  }
}

const NEWEST_RELEASES_TRIED = 20

function planRelease(input = {}) {
  const root = path.resolve(input.root ?? process.cwd())
  const execFileSyncImpl = input.execFileSyncImpl ?? execFileSync
  const registry = input.registry ?? EMPTY_REGISTRY
  const git = gitRunner(root, execFileSyncImpl)
  const succeeds = (...args) => {
    try {
      git(...args)
      return true
    } catch {
      return false
    }
  }

  if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
    throw new Error("the release version needs main's full history; check out with fetch-depth: 0")
  }
  const head = git("rev-parse", "HEAD").trim()
  if (!succeeds("cat-file", "-e", `HEAD:${NOTES_README}`)) {
    throw new Error(`${NOTES_README} is missing at HEAD, so this history has no change notes to release; restore it`)
  }
  const versionAt = (sha) => {
    try {
      return JSON.parse(git("show", `${sha}:package.json`)).version
    } catch {
      return undefined
    }
  }
  // -G finds every commit whose diff touches the version line; only those whose version differs from their first
  // parent's changed it (moving or reformatting the line does not).
  const changesVersion = (sha) => {
    const version = versionAt(sha)
    return version !== undefined && version !== versionAt(`${sha}^1`)
  }
  const versionLineCommits = lines(git("log", "--first-parent", "-G", VERSION_LINE, "--format=%H", "HEAD", "--", "package.json"))
  const anchorIndex = versionLineCommits.findIndex(changesVersion)
  const anchor = versionLineCommits[anchorIndex]
  if (!anchor) {
    throw new Error("no commit sets package.json's version, so there is no release to count from")
  }

  const pushStart = resolvePushStart(git, input.before)
  const inPush = pushStart
    ? new Set(lines(git("rev-list", "--first-parent", `${pushStart}..HEAD`)))
    : null
  const isInPush = (sha) => (inPush ? inPush.has(sha) : true)

  // npm's last release before this push: the newest published version whose commit HEAD's history had then.
  const commitOf = (version) => {
    const fromNpm = registry.gitHead(version)
    if (fromNpm && /^[0-9a-f]{40}$/.test(fromNpm)) return fromNpm
    try {
      return git("rev-parse", "--verify", "-q", `refs/tags/v${version}^{commit}`).trim()
    } catch {
      return undefined
    }
  }
  const releasedBefore = (sha) => Boolean(pushStart) && succeeds("merge-base", "--is-ancestor", sha, pushStart)
  const published = registry.versions().filter((version) => SEMVER.test(version)).sort((a, b) => compareVersions(b, a))
  let last = null
  for (const version of published.slice(0, NEWEST_RELEASES_TRIED)) {
    const sha = commitOf(version)
    if (sha && succeeds("cat-file", "-e", `${sha}^{commit}`) && releasedBefore(sha)) {
      last = { version, sha }
      break
    }
  }
  if (published.length > 0 && !last && pushStart) {
    throw new Error(
      `none of npm's published versions came from a commit in this history before ${pushStart.slice(0, 12)} ` +
      `(tried the newest ${Math.min(published.length, NEWEST_RELEASES_TRIED)}), so there is no release to count from`,
    )
  }

  // With nothing on npm, count from the version change before the anchor, so the anchor too must move forward.
  const previousAnchor = last ? null : versionLineCommits.slice(anchorIndex + 1).find(changesVersion)
  const start = last ? last.sha : previousAnchor ?? anchor
  let base = last ? last.version : versionAt(start)
  let current = base
  let count = 0
  let lineStartInPush = !last && !previousAnchor && isInPush(anchor)
  const earlier = []
  const pushCommits = []

  for (const commit of firstParentCommits(git, `${start}..HEAD`)) {
    if (changesVersion(commit.sha)) {
      const version = versionAt(commit.sha)
      if (!SEMVER.test(version) || compareVersions(version, current) <= 0) {
        throw new Error(
          `${commit.sha.slice(0, 12)} (${commit.subject}) sets package.json's version to ${version}, which is not ` +
          `above ${current}, the version already released before it. A release never reuses or goes back to a ` +
          `number: revert that version change (npm run release:drop-bump on its branch), or set a version above ${current}.`,
        )
      }
      base = version
      current = version
      count = 0
      if (isInPush(commit.sha)) lineStartInPush = true
      continue
    }
    if (isReleasableCommit(releasingFiles(commit.changes))) {
      count += 1
      current = versionAfter(base, count)
      const entry = {
        sha: commit.sha,
        version: current,
        subject: commit.subject,
        notes: commit.changes.filter((change) => change.status === "A" && isChangeNotePath(change.file)).map((change) => change.file),
      }
      if (isInPush(commit.sha)) pushCommits.push(entry)
      else earlier.push(entry)
    }
  }
  const groups = [...earlier.map((entry) => [entry]), ...(pushCommits.length > 0 ? [pushCommits] : [])]

  // A group's notes as its last commit left them, or as they were added when a later commit removed them.
  const noteSpecs = (group) => group.flatMap((commit) => commit.notes.map((file) => ({
    at: `${group[group.length - 1].sha}:${file}`,
    added: `${commit.sha}:${file}`,
  })))
  const specs = groups.flatMap(noteSpecs)
  const blobs = readBlobs(root, execFileSyncImpl, [...new Set(specs.flatMap((spec) => [spec.at, spec.added]))])
  const entries = groups.map((group) => {
    const notes = noteSpecs(group).flatMap((spec) => parseChangeNote(blobs.get(spec.at) ?? blobs.get(spec.added) ?? ""))
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
    baseVersion: base,
    published: last ? last.version : null,
    publishedCommit: last ? last.sha : null,
    version: current,
    release: pushCommits.length > 0 || lineStartInPush,
    entries,
    history: last ? registry.changelog(last.version) : [],
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
  // This push's entries first, then what npm's last release carried, then what main's changelog.json has besides.
  const merged = []
  const seen = new Set()
  for (const entry of [...plan.entries.map((e) => ({ version: e.version, changes: e.changes })), ...(plan.history ?? []), ...changelog.versions]) {
    if (seen.has(entry?.version)) continue
    seen.add(entry?.version)
    merged.push(entry)
  }
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
  const registry = deps.registry ?? npmRegistry(deps.execFileSyncImpl)
  const [command, argument] = argv
  if (!["version", "push", "dispatch", "apply", "assert-new"].includes(command) ||
    (["push", "assert-new"].includes(command) && !argument)) {
    error("usage: node scripts/release-version.cjs version | push <before> | dispatch | apply [<before>] | assert-new <version>")
    return 2
  }
  try {
    const head = () => gitRunner(path.resolve(root), deps.execFileSyncImpl ?? execFileSync)("rev-parse", "HEAD").trim()
    if (command === "assert-new") {
      const highest = registry.versions().filter((version) => SEMVER.test(version)).sort((a, b) => compareVersions(b, a))[0]
      if (highest && compareVersions(argument, highest) <= 0 && !(argument === highest && registry.gitHead(argument) === head())) {
        throw new Error(`npm's highest version is ${highest}, so publishing ${argument} would reuse a number or go back; the release plan is wrong`)
      }
      error(`${argument} is above npm's highest (${highest ?? "none"}) or was published from this commit`)
      return 0
    }
    // A manual run plans as if HEAD were already out, so it lands on HEAD's own release and its published changelog.
    const before = command === "dispatch" ? head() : argument
    const plan = planRelease({ root, before, registry, execFileSyncImpl: deps.execFileSyncImpl })
    if (command === "version") {
      log(plan.version)
    } else if (command === "apply") {
      applyRelease({ root, plan })
      error(`release files written for ${plan.version} (counted from ${plan.published ?? `the version change at ${plan.anchor.slice(0, 12)}`})`)
      log(plan.version)
    } else if (command === "dispatch") {
      const published = registry.gitHead(plan.version)
      if (!published) {
        throw new Error(`npm has no ${plan.version}, so there is no published release to rebuild an image for. A push to main publishes it.`)
      }
      if (published !== plan.head) {
        throw new Error(
          `${plan.version} was published from ${published.slice(0, 12)}, not ${plan.head.slice(0, 12)}, so an image ` +
          `built here would carry code npm never shipped under that tag. A manual run only rebuilds main's head when ` +
          `main's head published its version.`,
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
  compareVersions,
  npmRegistry,
  isReleasableCommit,
  parseChangeNote,
  planRelease,
  runReleaseVersionCli,
  versionAfter,
}
