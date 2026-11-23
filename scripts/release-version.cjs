#!/usr/bin/env node

// The release job's version and changelog, worked out when a change lands on main so no pull request has to carry them.
//
// Counting starts at npm's last release: the newest published version whose commit (npm's gitHead, or its v<version>
// tag) is in this push's history before the push. Every later first-parent commit that releases something (see
// isReleasableCommit) takes the next number, in order. Numbers already on npm never depend on today's rules. A commit
// that changes package.json's version starts a new line from that version. It must go above npm's last release and
// any version an earlier commit set, or the release stops rather than reuse a number; it may land on a number counted
// since npm's release, since npm never had that one. With nothing on npm, counting starts at the last commit that
// changed the version (the anchor).
//
// A push publishes once: the version of the newest releasable commit it brought. npm never had the numbers counted
// between its last release and this push, so that version's changelog entry holds the change notes of every numbered
// commit since npm's last release, as the push's last numbered commit left them (a commit with no notes gives its
// subject). Below it come main's changelog.json, then the older entries npm's last release carried, main's copy
// winning where both have a version.
//
//   node scripts/release-version.cjs version              prints HEAD's version
//   node scripts/release-version.cjs push <before>        for the push before..HEAD, prints version=<v> and
//                                                          release=true|false, for GITHUB_OUTPUT
//   node scripts/release-version.cjs dispatch             the same for a manual run on HEAD; fails unless npm
//                                                          published HEAD's version from HEAD, so an image never
//                                                          carries code npm did not ship
//   node scripts/release-version.cjs apply [<before>] [--changelog <file>]
//                                                          writes the version and changelog into the release files,
//                                                          prints the version; with --changelog, the file's versions
//                                                          are the changelog, as written
//   node scripts/release-version.cjs assert-new <version> fails unless <version> is above npm's highest, or HEAD
//                                                          already published it (a re-run)
//   node scripts/release-version.cjs published-changelog <version> <out>
//                                                          waits (RELEASE_WAIT_SECONDS, default 5400) for npm to
//                                                          publish <version> from HEAD, then writes the changelog
//                                                          its tarball carries to <out>
//
// Planning reads npm's version list and every version's gitHead (two npm view calls). Only `apply` and
// `published-changelog` download a tarball (npm pack), waiting out ETARGET while npm cannot serve a new version yet;
// `apply` falls back to an older release's changelog if it still cannot. `apply` also loads release-bump.cjs (and
// semver).

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
const EMPTY_REGISTRY = { versions: () => [], gitHeads: () => new Map(), gitHead: () => undefined, changelog: () => [] }

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

// npm as the release reads it: the published versions, the commit each was published from (gitHead), and the
// changelog a version's tarball carries. The version list and the gitHeads are one call each, asked once; a single
// version's gitHead is asked fresh, since a wait polls it. npm can list a version before it serves the tarball
// (ETARGET), so fetching one waits that out, bounded, as scripts/npm-publish-idempotency.cjs does.
function npmRegistry(execFileSyncImpl = execFileSync, { attempts = 20, intervalMs = 15_000, sleep = sleepSync } = {}) {
  const npm = (...args) => execFileSyncImpl("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 })
  const once = (fn) => {
    let value
    let done = false
    return () => {
      if (!done) {
        value = fn()
        done = true
      }
      return value
    }
  }
  const versions = once(() => {
    const parsed = JSON.parse(npm("view", PACKAGE, "versions", "--json"))
    return Array.isArray(parsed) ? parsed : [parsed]
  })
  // A range of every version's major.minor.patch with -0 takes in their prereleases too.
  const gitHeads = once(() => {
    const cores = [...new Set(versions().map((version) => String(version).split(/[-+]/)[0]))]
    const heads = new Map()
    if (cores.length === 0) return heads
    const output = npm("view", `${PACKAGE}@${cores.map((core) => `>=${core}-0`).join(" || ")}`, "gitHead")
    for (const line of String(output).split("\n")) {
      const match = /^\S+@(\S+) '([0-9a-f]{40})'$/.exec(line.trim())
      if (match) heads.set(match[1], match[2])
    }
    return heads
  })
  return {
    versions,
    gitHeads,
    // A version npm does not have yet (E404) has no gitHead, so a wait can keep polling for it.
    gitHead: (version) => {
      const known = gitHeads().get(version)
      if (known) return known
      try {
        return npm("view", `${PACKAGE}@${version}`, "gitHead").trim() || undefined
      } catch (failure) {
        const said = `${failure.stderr ?? ""}${failure.message ?? ""}`
        if (/\bE404\b/.test(said)) return undefined
        throw new Error(`could not read ${PACKAGE}@${version}'s gitHead from npm: ${said.trim()}`)
      }
    },
    changelog: (version) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-version-"))
      try {
        let packed
        for (let attempt = 1; ; attempt += 1) {
          try {
            packed = npm("pack", `${PACKAGE}@${version}`, "--pack-destination", dir, "--json")
            break
          } catch (failure) {
            const said = `${failure.stderr ?? ""}${failure.stdout ?? ""}${failure.message ?? ""}`
            if (!/\bETARGET\b/.test(said) || attempt >= attempts) {
              throw new Error(`could not download ${PACKAGE}@${version} from npm after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${said.trim()}`)
            }
            sleep(intervalMs)
          }
        }
        const [{ filename }] = JSON.parse(packed)
        const text = execFileSyncImpl("tar", ["-xzOf", path.join(dir, filename), "package/changelog.json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
        const entries = JSON.parse(text).versions
        if (!Array.isArray(entries)) throw new Error(`${PACKAGE}@${version}'s changelog.json has no versions array`)
        return entries
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

// When npm cannot serve the last release's tarball, apply reads the changelog of one of these older ones instead.
const FALLBACK_RELEASES = 5

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
  const heads = registry.gitHeads()
  const commitOf = (version) => {
    const fromNpm = heads.get(version)
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
  const fallbacks = []
  for (const version of published) {
    const sha = commitOf(version)
    if (!sha || !succeeds("cat-file", "-e", `${sha}^{commit}`) || !releasedBefore(sha)) continue
    if (!last) last = { version, sha }
    else fallbacks.push(version)
    if (fallbacks.length >= FALLBACK_RELEASES) break
  }
  if (published.length > 0 && !last && pushStart) {
    throw new Error(
      `none of npm's published versions came from a commit in this history before ${pushStart.slice(0, 12)}, ` +
      "so there is no release to count from",
    )
  }

  // With nothing on npm, count from the version change before the anchor, so the anchor too must move forward.
  const previousAnchor = last ? null : versionLineCommits.slice(anchorIndex + 1).find(changesVersion)
  const start = last ? last.sha : previousAnchor ?? anchor
  let base = last ? last.version : versionAt(start)
  let current = base
  let count = 0
  // A version change must go above what npm last released, and above any version an earlier change set. Numbers
  // counted since npm's release were never published, so a change may land on one of them.
  let floor = base
  let floorSource = last ? "the version npm last released before it" : "the version set before it"
  let lineStartInPush = !last && !previousAnchor && isInPush(anchor)
  const numbered = []
  const pushCommits = []

  for (const commit of firstParentCommits(git, `${start}..HEAD`)) {
    if (changesVersion(commit.sha)) {
      const version = versionAt(commit.sha)
      if (!SEMVER.test(version) || compareVersions(version, floor) <= 0) {
        throw new Error(
          `${commit.sha.slice(0, 12)} (${commit.subject}) sets package.json's version to ${version}, which is not ` +
          `above ${floor}, ${floorSource}. A release never reuses or goes back to a number: revert that version ` +
          `change (npm run release:drop-bump on its branch), or set a version above ${floor}.`,
        )
      }
      floor = version
      floorSource = "the version an earlier commit set"
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
      numbered.push(entry)
      if (isInPush(commit.sha)) pushCommits.push(entry)
    }
  }
  // npm never had the numbers counted since its last release, except the one this push publishes, so every one of
  // those commits' notes goes into this push's entry.
  const groups = numbered.length > 0 ? [numbered] : []

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
    fallbacks,
    version: current,
    release: pushCommits.length > 0 || lineStartInPush,
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
  if (Array.isArray(input.changelog)) {
    changelog.versions = input.changelog
    writeVersion()
    writeJson(changelogPath, changelog)
    return plan.version
  }
  const registry = input.registry ?? EMPTY_REGISTRY
  const warn = input.warn ?? console.error
  let history = []
  if (plan.published) {
    let lastFailure
    history = null
    for (const version of [plan.published, ...(plan.fallbacks ?? [])]) {
      try {
        history = registry.changelog(version)
        break
      } catch (failure) {
        lastFailure = failure
        warn(`could not read ${version}'s changelog from npm (${failure instanceof Error ? failure.message : failure}); trying an older release`)
      }
    }
    if (!history) {
      throw new Error(`could not read the changelog of any release npm has before this push: ${lastFailure instanceof Error ? lastFailure.message : lastFailure}`)
    }
  }
  // This push's entry first, then main's changelog.json (so a fix to an older entry wins), then what npm's last
  // release carried besides.
  const merged = []
  const seen = new Set()
  for (const entry of [...plan.entries.map((e) => ({ version: e.version, changes: e.changes })), ...changelog.versions, ...history]) {
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
  const args = [...argv]
  const flag = args.indexOf("--changelog")
  const changelogFile = flag >= 0 ? args.splice(flag, 2)[1] : undefined
  const [command, argument, extra] = args
  if (!["version", "push", "dispatch", "apply", "assert-new", "published-changelog"].includes(command) ||
    (["push", "assert-new"].includes(command) && !argument) ||
    (command === "published-changelog" && !(argument && extra)) ||
    (flag >= 0 && (command !== "apply" || !changelogFile))) {
    error(
      "usage: node scripts/release-version.cjs version | push <before> | dispatch | apply [<before>] [--changelog <file>] | " +
      "assert-new <version> | published-changelog <version> <out>",
    )
    return 2
  }
  try {
    const head = () => gitRunner(path.resolve(root), deps.execFileSyncImpl ?? execFileSync)("rev-parse", "HEAD").trim()
    if (command === "published-changelog") {
      // The image waits for npm's release of this very commit, then carries the changelog npm shipped with it.
      const now = deps.now ?? Date.now
      const sleep = deps.sleep ?? sleepSync
      const waitSeconds = deps.waitSeconds ?? Number(process.env.RELEASE_WAIT_SECONDS || 5400)
      const intervalMs = 30_000
      const commit = head()
      const started = now()
      for (;;) {
        const from = registry.gitHead(argument)
        if (from === commit) break
        if (from) {
          throw new Error(`npm published ${argument} from ${from.slice(0, 12)}, not ${commit.slice(0, 12)}, so this commit's image must not carry that release`)
        }
        if (now() - started >= waitSeconds * 1000) {
          throw new Error(`npm has not published ${argument} from ${commit.slice(0, 12)} after ${waitSeconds}s; the npm job has not finished or failed`)
        }
        sleep(intervalMs)
      }
      fs.writeFileSync(extra, `${JSON.stringify({ versions: registry.changelog(argument) }, null, 2)}\n`)
      error(`wrote the changelog npm published with ${argument} to ${extra}`)
      return 0
    }
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
      const given = changelogFile ? JSON.parse(fs.readFileSync(changelogFile, "utf8")).versions : undefined
      if (changelogFile && !Array.isArray(given)) throw new Error(`${changelogFile} has no versions array`)
      applyRelease({ root, plan, registry, warn: error, changelog: given })
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
