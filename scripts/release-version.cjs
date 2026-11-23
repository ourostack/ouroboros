#!/usr/bin/env node

// The release job's version and changelog, worked out when a change lands on main so no pull request has to carry them.
//
// Counting starts at npm's last release: the newest published version whose commit (npm's gitHead, or its v<version>
// tag) is on this history's first-parent line before the push. Every later first-parent commit that releases
// something (see isReleasableCommit) takes the next number, in order, so numbers already on npm never depend on
// today's rules. Only a commit that moves package.json's version to a new, higher release line (0.2.0-alpha.0 after
// 0.1.0-alpha.N, or 1.0.0) starts counting again from that version. An old-style bump within the line above the count
// (a handover from pull requests that bumped; its own publish may have taken that number) moves the count up to it.
// Any other version change, such as a bump onto or below the count, or a bump and its drop-bump landing together in a
// rebase merge, is an ordinary commit. With nothing on npm, counting starts at the newest version change that went
// above every earlier one (the anchor).
//
// A push publishes once: the version of the newest releasable commit it brought. Every entry since the switch to this
// scheme is rebuilt from main's history on every release, and planning reads no tarball: a version npm has
// gets the change notes added by the commits since the release before it, as the commit npm published it from left
// them, and this push's version gets those since npm's last release (a group with no notes gives its commits'
// subjects). So the notes of a number npm never had (a failed publish, a rebase merge's skipped numbers) go into the
// next version npm has, and no entry names a version npm never had. A commit that set a version (a new line, an
// old-style bump) puts its own changelog.json entry first in the entry it lands in; when npm never had that version,
// changelog.json leaves it out (folded). A note renamed within changes/ is counted once. Entries from before the
// switch come from main's changelog.json as committed.
//
//   node scripts/release-version.cjs version              prints HEAD's version
//   node scripts/release-version.cjs push <before>        for the push before..HEAD, prints version=<v> and
//                                                          release=true|false, for GITHUB_OUTPUT
//   node scripts/release-version.cjs dispatch             the same for a manual run on HEAD; fails unless npm
//                                                          published HEAD's version from HEAD, so an image never
//                                                          carries code npm did not ship
//   node scripts/release-version.cjs apply [<before>] [--version <v> [--npm-changelog]]
//                                                          writes the version and changelog into the release files,
//                                                          prints the version; --version writes <v> (the version npm
//                                                          published from this commit) in place of the planned one;
//                                                          --npm-changelog plans nothing and writes the changelog.json
//                                                          npm published for <v> (the image, so the two never differ)
//   node scripts/release-version.cjs assert-new <version> fails unless <version> is above npm's highest, or HEAD
//                                                          already published it (a re-run)
//   node scripts/release-version.cjs wait-published       waits (RELEASE_WAIT_SECONDS, default 5400) until npm has a
//                                                          version published from HEAD, asking again through npm
//                                                          errors, then prints version=<v>
//
// Planning reads npm's version list and every version's gitHead (two npm view calls). `apply --npm-changelog`
// downloads one tarball (npm pack). `apply` also loads release-bump.cjs (and semver).

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

// The release line a version belongs to: everything but the number this counts (a prerelease's last number, or else
// the patch), as scripts/release-preflight.cjs has it.
function releaseLine(version) {
  const match = SEMVER.exec(String(version))
  if (!match) return undefined
  const prerelease = match[4] ? match[4].split(".") : []
  return prerelease.length > 0 && /^\d+$/.test(prerelease[prerelease.length - 1])
    ? String(version).replace(/\+.*$/, "").replace(/\.\d+$/, "")
    : `${match[1]}.${match[2]}`
}

// Only a move to a new, higher release line restarts the count. Any other version change (an old-style bump, a
// bump and its drop-bump landing together in a rebase merge, a stale bump back) is an ordinary commit.
function startsNewLine(version, from) {
  return SEMVER.test(String(version)) && SEMVER.test(String(from)) &&
    compareVersions(version, from) > 0 && releaseLine(version) !== releaseLine(from)
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

// Removing or renaming a change note (tidying old ones) releases nothing; adding or editing one does.
function releasingFiles(changes) {
  return changes.filter((change) => !(["D", "R"].includes(change.status) && isChangeNotePath(change.file))).map((change) => change.file)
}

// The notes a commit adds. A note renamed within changes/ released under its old name already.
function addedNotes(changes) {
  return changes.filter((change) => change.status === "A" && isChangeNotePath(change.file)).map((change) => change.file)
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

// First-parent commits in `range`, oldest first, with each one's changed files (status and path). Only an exact
// rename (the same content under a new name) counts as one, so a new note is never taken for an old one moved.
function firstParentCommits(git, range) {
  const log = git("log", "--first-parent", "--reverse", "--find-renames=100%", "--diff-merges=first-parent",
    "--name-status", "--format=%x1e%H%x1f%s", range)
  return log.split("\x1e").filter((chunk) => chunk.trim()).map((chunk) => {
    const [header, ...lines] = chunk.split("\n")
    const [sha, subject] = header.split("\x1f")
    // A rename is its old path removed and its new one added, except a note renamed within changes/ (status R).
    const changes = lines.filter(Boolean).flatMap((line) => {
      const [status, first, second] = line.split("\t")
      if (!status.startsWith("R")) return [{ status, file: first }]
      return isChangeNotePath(first) && isChangeNotePath(second)
        ? [{ status: "R", file: second }]
        : [{ status: "D", file: first }, { status: "A", file: second }]
    })
    return { sha, subject, changes }
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
const EMPTY_REGISTRY = { versions: () => [], gitHeads: () => new Map(), gitHead: () => undefined }

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

// npm as the release reads it: the published versions and the commit each was published from (gitHead). The version
// list and the gitHeads are one call each, asked once per registry; a single version's gitHead is asked fresh. Only the
// image reads a tarball: the changelog npm published for its version (changelog).
function npmRegistry(execFileSyncImpl = execFileSync, options = {}) {
  const sleep = options.sleep ?? sleepSync
  const attempts = options.attempts ?? 10
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
    // A version npm does not have yet (E404) has no gitHead.
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
    // The image's changelog is the published package's, so the two never differ. npm can list a version a little
    // before it serves its tarball (ETARGET), so that is waited out.
    changelog: (version) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-version-"))
      try {
        let packed
        for (let attempt = 1; ; attempt += 1) {
          try {
            packed = npm("pack", `${PACKAGE}@${version}`, "--pack-destination", dir, "--json")
            break
          } catch (failure) {
            const said = [failure.stderr, failure.stdout, failure.message].filter(Boolean).join("\n")
            // Retried: ETARGET, and a 404 whose text names this exact version's tarball URL (seen on alpha.1417
            // right after npm-release's metadata check passed; the cause is not established). Nothing else is retried.
            const tarball = `/${PACKAGE}/-/${PACKAGE.split("/").pop()}-${version}.tgz`
            const lagging = /\bETARGET\b/.test(said) || (/\bE404\b/.test(said) && said.includes(tarball))
            if (!lagging || attempt >= attempts) {
              throw new Error(`could not download ${PACKAGE}@${version} from npm after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${said.trim()}`)
            }
            sleep(30_000)
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
  const versionLineCommits = lines(git("log", "--first-parent", "-G", VERSION_LINE, "--format=%H", "HEAD", "--", "package.json"))
  const versionLine = new Set(versionLineCommits)
  const changed = new Map()
  const changesVersion = (sha) => {
    if (!versionLine.has(sha)) return false
    if (!changed.has(sha)) {
      const version = versionAt(sha)
      changed.set(sha, version !== undefined && version !== versionAt(`${sha}^1`))
    }
    return changed.get(sha)
  }
  const newestChange = versionLineCommits.find(changesVersion)
  if (!newestChange) {
    throw new Error("no commit sets package.json's version, so there is no release to count from")
  }

  const pushStart = resolvePushStart(git, input.before)
  const inPush = pushStart
    ? new Set(lines(git("rev-list", "--first-parent", `${pushStart}..HEAD`)))
    : null
  const isInPush = (sha) => (inPush ? inPush.has(sha) : true)

  // HEAD's first-parent line, oldest first: where each release sits, and whether it came before this push.
  const firstParents = lines(git("rev-list", "--first-parent", "--reverse", "HEAD"))
  const position = new Map(firstParents.map((sha, index) => [sha, index]))
  const pushPosition = pushStart ? position.get(pushStart) : undefined
  const releasedBefore = (sha) => {
    if (!pushStart || !position.has(sha)) return false
    return pushPosition !== undefined
      ? position.get(sha) <= pushPosition
      : succeeds("merge-base", "--is-ancestor", sha, pushStart)
  }

  // Every release npm has from this line before the push (npm's gitHead, or its v<version> tag), oldest first; where
  // npm published two versions from one commit, the higher one.
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
  const published = registry.versions().filter((version) => SEMVER.test(version))
  const bySha = new Map()
  for (const version of published) {
    const sha = commitOf(version)
    if (!sha || !releasedBefore(sha)) continue
    if (!bySha.has(sha) || compareVersions(version, bySha.get(sha)) > 0) bySha.set(sha, version)
  }
  const releases = [...bySha].map(([sha, version]) => ({ sha, version })).sort((a, b) => position.get(a.sha) - position.get(b.sha))
  const last = releases[releases.length - 1] ?? null
  if (published.length > 0 && !last && pushStart) {
    throw new Error(
      `none of npm's published versions came from a commit in this history before ${pushStart.slice(0, 12)}, ` +
      "so there is no release to count from",
    )
  }

  // Releases made before this scheme set their own version and wrote their own changelog.json entry; the newest of
  // them (origin) is where the entries rebuilt from git begin. A new release line's first release sets its own
  // version too, but counts as rebuilt, since notes npm skipped before it fold into it.
  const packageSpecs = releases.flatMap((release) => {
    const at = position.get(release.sha)
    return [`${release.sha}:package.json`, ...(at > 0 ? [`${firstParents[at - 1]}:package.json`] : [])]
  })
  const packages = readBlobs(root, execFileSyncImpl, packageSpecs)
  const versionIn = (spec) => {
    try {
      return JSON.parse(packages.get(spec)).version
    } catch {
      return undefined
    }
  }
  let originIndex = -1
  for (let index = releases.length - 1; index >= 0; index -= 1) {
    const { sha, version } = releases[index]
    if (versionIn(`${sha}:package.json`) !== version) continue
    const at = position.get(sha)
    const parentVersion = at > 0 ? versionIn(`${firstParents[at - 1]}:package.json`) : undefined
    if (parentVersion !== undefined && startsNewLine(version, parentVersion)) continue
    originIndex = index
    break
  }
  const rebuilt = releases.slice(originIndex + 1)
  // With nothing on npm, count from the newest version change that went above every earlier one (the anchor). When
  // it starts a new release line, walk from the one before it, so the notes before the line start fold into it.
  let anchor = newestChange
  let noNpmStart = null
  if (!last) {
    const forward = []
    for (const sha of [...versionLineCommits].reverse()) {
      if (!changesVersion(sha)) continue
      const version = versionAt(sha)
      if (!SEMVER.test(String(version))) continue
      if (forward.length === 0 || compareVersions(version, forward[forward.length - 1].version) > 0) forward.push({ sha, version })
    }
    const newest = forward[forward.length - 1]
    const before = forward[forward.length - 2]
    anchor = newest ? newest.sha : newestChange
    noNpmStart = newest && before && startsNewLine(newest.version, before.version) ? before : null
  }
  let walkStart
  if (originIndex >= 0) {
    walkStart = releases[originIndex].sha
  } else if (rebuilt.length > 0) {
    // No release before this scheme is on npm: start at the version change before the oldest rebuilt release.
    walkStart = versionLineCommits.find((sha) => position.get(sha) < position.get(rebuilt[0].sha) && changesVersion(sha)) ?? null
  } else {
    walkStart = noNpmStart ? noNpmStart.sha : anchor
  }
  const countFrom = last ? position.get(last.sha) : position.get(walkStart)
  const releaseAt = new Map(rebuilt.map((release) => [release.sha, release.version]))

  const committed = new Map()
  try {
    for (const entry of JSON.parse(git("show", "HEAD:changelog.json")).versions ?? []) {
      if (entry && typeof entry.version === "string" && Array.isArray(entry.changes)) committed.set(entry.version, entry.changes)
    }
  } catch {
    // No changelog.json at HEAD: every entry comes from notes.
  }

  let base = last ? last.version : versionAt(walkStart)
  let current = base
  let count = 0
  let lineStartInPush = !last && !noNpmStart && isInPush(anchor)
  let pushReleases = false
  const groups = []
  let bucket = []
  // A version's entry: the notes its commits added, as the commit npm published it from left them. A commit that set
  // that very version (a new release line, an old-style bump) puts its own changelog.json entry first. So does one
  // that set a newer version npm never had (a new line whose first version a rebase merge skipped, an old-style bump
  // whose publish failed): its entry moves into this one, and changelog.json loses it (folded).
  const publishedVersions = new Set(published)
  const floor = walkStart ? versionAt(walkStart) : undefined
  const foldable = (version) => !publishedVersions.has(version) &&
    (!SEMVER.test(String(floor)) || compareVersions(version, floor) > 0)
  const folded = new Set()
  const close = (version, at) => {
    const taken = new Set()
    const lines = []
    for (const commit of bucket) {
      const set = commit.setVersion
      if (set === undefined || taken.has(set) || !committed.has(set) || (set !== version && !foldable(set))) continue
      taken.add(set)
      lines.push(...committed.get(set))
      if (set !== version) folded.add(set)
    }
    groups.push({ version, at, commits: bucket, committed: lines })
    bucket = []
  }
  const walk = firstParentCommits(git, walkStart ? `${walkStart}..HEAD` : "HEAD")
  for (const commit of walk) {
    const setVersion = changesVersion(commit.sha) ? versionAt(commit.sha) : undefined
    const releasable = isReleasableCommit(releasingFiles(commit.changes))
    const numbered = {
      sha: commit.sha,
      subject: commit.subject,
      notes: addedNotes(commit.changes),
      setVersion,
    }
    if (position.get(commit.sha) <= countFrom) {
      // Before npm's last release: rebuild the entries of the releases npm has.
      if (releasable || setVersion !== undefined) bucket.push(numbered)
      if (releaseAt.has(commit.sha)) close(releaseAt.get(commit.sha), commit.sha)
      continue
    }
    if (setVersion !== undefined && startsNewLine(setVersion, current)) {
      base = setVersion
      current = setVersion
      count = 0
      if (isInPush(commit.sha)) lineStartInPush = true
    } else if (setVersion !== undefined && SEMVER.test(String(setVersion)) && releaseLine(setVersion) === releaseLine(current) &&
      compareVersions(setVersion, current) > 0) {
      // An old-style bump above the count (a handover from pull requests that bumped): that commit may have published
      // its own number already, so counting goes on from it, never under it.
      base = setVersion
      current = setVersion
      count = 0
      if (isInPush(commit.sha)) pushReleases = true
    } else if (releasable) {
      count += 1
      current = versionAfter(base, count)
      if (isInPush(commit.sha)) pushReleases = true
    } else {
      continue
    }
    bucket.push(numbered)
  }
  // npm never had the numbers counted since its last release, except the one this push publishes, so every one of
  // those commits' notes goes into this push's entry.
  if (bucket.length > 0) close(current, bucket[bucket.length - 1].sha)

  const noteSpecs = (group) => group.commits.flatMap((commit) => commit.notes.map((file) => ({
    at: `${group.at}:${file}`,
    added: `${commit.sha}:${file}`,
  })))
  const blobs = readBlobs(root, execFileSyncImpl, [...new Set(groups.flatMap(noteSpecs).flatMap((spec) => [spec.at, spec.added]))])
  const entries = groups.map((group) => {
    const notes = noteSpecs(group).flatMap((spec) => parseChangeNote(blobs.get(spec.at) ?? blobs.get(spec.added) ?? ""))
    const changes = [...group.committed, ...notes]
    const subjects = group.commits.map((commit) => commit.subject)
    return {
      version: group.version,
      commit: group.at,
      changes: changes.length > 0 ? changes : subjects.length > 0 ? subjects : [walk.find((commit) => commit.sha === group.at)?.subject ?? group.version],
    }
  }).reverse()
  const pushEntry = entries.length > 0 && !releaseAt.has(entries[0].commit) ? entries[0] : null

  return {
    anchor,
    head,
    baseVersion: base,
    published: last ? last.version : null,
    publishedCommit: last ? last.sha : null,
    version: current,
    release: pushReleases || lineStartInPush,
    entries: pushEntry ? [pushEntry] : [],
    history: pushEntry ? entries.slice(1) : entries,
    folded: [...folded].filter((version) => !groups.some((group) => group.version === version)),
  }
}

function applyRelease(input) {
  const { readJson, writeJson, prepareReleaseVersion } = require("./release-bump.cjs")
  const semver = require("semver")
  const root = path.resolve(input.root ?? process.cwd())
  const plan = input.plan
  const warn = input.warn ?? console.error
  const changelogPath = path.join(root, "changelog.json")
  const changelog = readJson(changelogPath)
  if (!Array.isArray(changelog.versions)) {
    throw new Error("changelog.json must contain a versions array")
  }
  // The image takes the version npm published from this commit, so the two never differ.
  const version = input.version ?? plan.version
  if (version !== plan.version) {
    warn(`npm published ${version} from this commit, not the planned ${plan.version}; writing ${version}`)
  }
  const writeVersion = prepareReleaseVersion({ root, version })
  if (Array.isArray(input.changelog)) {
    // The changelog npm published for this version, as it is.
    changelog.versions = input.changelog
    writeVersion()
    writeJson(changelogPath, changelog)
    return version
  }
  // The entries rebuilt from git (this push's, then every release since the switch) win; main's changelog.json keeps
  // every entry from before it.
  const merged = []
  const seen = new Set()
  const rebuilt = [
    ...plan.entries.map((entry) => ({ version: entry.version === plan.version ? version : entry.version, changes: entry.changes })),
    ...(plan.history ?? []).map((entry) => ({ version: entry.version, changes: entry.changes })),
  ]
  // A version npm never had whose committed entry went into a later one is left out.
  const folded = new Set((plan.folded ?? []).filter((entry) => !rebuilt.some((rebuiltEntry) => rebuiltEntry.version === entry)))
  for (const entry of [...rebuilt, ...changelog.versions]) {
    if (seen.has(entry?.version) || folded.has(entry?.version)) continue
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
  return version
}

function runReleaseVersionCli(argv = process.argv.slice(2), deps = {}) {
  const root = deps.root ?? process.cwd()
  const log = deps.log ?? console.log
  const error = deps.error ?? console.error
  const registry = deps.registry ?? npmRegistry(deps.execFileSyncImpl)
  const args = [...argv]
  const npmChangelogFlag = args.indexOf("--npm-changelog")
  if (npmChangelogFlag >= 0) args.splice(npmChangelogFlag, 1)
  const flag = args.indexOf("--version")
  const versionFlag = flag >= 0 ? args.splice(flag, 2)[1] : undefined
  const [command, argument] = args
  if (!["version", "push", "dispatch", "apply", "assert-new", "wait-published"].includes(command) ||
    (["push", "assert-new"].includes(command) && !argument) ||
    (flag >= 0 && (command !== "apply" || !versionFlag || !SEMVER.test(versionFlag))) ||
    (npmChangelogFlag >= 0 && (command !== "apply" || flag < 0))) {
    error(
      "usage: node scripts/release-version.cjs version | push <before> | dispatch | " +
      "apply [<before>] [--version <v> [--npm-changelog]] | assert-new <version> | wait-published",
    )
    return 2
  }
  try {
    const head = () => gitRunner(path.resolve(root), deps.execFileSyncImpl ?? execFileSync)("rev-parse", "HEAD").trim()
    if (command === "wait-published") {
      // The image waits for npm's release of this very commit and takes its version, so the two never differ.
      const now = deps.now ?? Date.now
      const sleep = deps.sleep ?? sleepSync
      const waitSeconds = deps.waitSeconds ?? Number(process.env.RELEASE_WAIT_SECONDS || 5400)
      const fresh = deps.registry ? () => deps.registry : () => npmRegistry(deps.execFileSyncImpl)
      const commit = head()
      const started = now()
      let lastFailure = null
      for (;;) {
        // A failed npm view (a registry blip) is logged and asked again at the next poll, until the deadline.
        let from = []
        try {
          from = [...fresh().gitHeads()].filter(([, sha]) => sha === commit).map(([version]) => version)
            .filter((version) => SEMVER.test(version)).sort(compareVersions)
          lastFailure = null
        } catch (failure) {
          lastFailure = failure instanceof Error ? failure.message : String(failure)
          error(`could not read npm's releases (${lastFailure}); asking again`)
        }
        if (from.length > 0) {
          const version = from[from.length - 1]
          error(`npm published ${version} from ${commit.slice(0, 12)}`)
          log(`version=${version}`)
          return 0
        }
        if (now() - started >= waitSeconds * 1000) {
          throw new Error(
            `npm has published no version from ${commit.slice(0, 12)} after ${waitSeconds}s; coverage.yml's publish ` +
            "job for this commit failed, was cancelled or is still queued, so this commit gets no image" +
            (lastFailure ? `. The last read of npm failed: ${lastFailure}` : ""),
          )
        }
        sleep(30_000)
      }
    }
    if (command === "assert-new") {
      const highest = registry.versions().filter((version) => SEMVER.test(version)).sort((a, b) => compareVersions(b, a))[0]
      if (highest && compareVersions(argument, highest) <= 0 && !(argument === highest && registry.gitHead(argument) === head())) {
        throw new Error(`npm's highest version is ${highest}, so publishing ${argument} would reuse a number or go back; the release plan is wrong`)
      }
      error(`${argument} is above npm's highest (${highest ?? "none"}) or was published from this commit`)
      return 0
    }
    if (command === "apply" && npmChangelogFlag >= 0) {
      // The image: the version npm published from this commit, with the changelog npm published for it. Nothing to plan.
      const written = applyRelease({ root, plan: { version: versionFlag }, version: versionFlag, changelog: registry.changelog(versionFlag), warn: error })
      error(`release files written for ${written}, with the changelog npm published for it`)
      log(written)
      return 0
    }
    // A manual run plans as if HEAD were already out, so it lands on HEAD's own release and its published changelog.
    const before = command === "dispatch" ? head() : argument
    const plan = planRelease({ root, before, registry, execFileSyncImpl: deps.execFileSyncImpl })
    if (command === "version") {
      log(plan.version)
    } else if (command === "apply") {
      const written = applyRelease({ root, plan, version: versionFlag, warn: error })
      error(`release files written for ${written} (counted from ${plan.published ?? `the version change at ${plan.anchor.slice(0, 12)}`})`)
      log(written)
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
