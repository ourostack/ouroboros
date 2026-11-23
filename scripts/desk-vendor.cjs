// Puts the Desk release that desk.lock.json pins at vendor/desk, where the package ships it.
//
// Every Ouro agent runs Desk's own MCP server from that folder (src/repertoire/desk-mcp.ts), the same server Claude Code,
// Codex and Copilot run from the Desk plugin, so there is one Desk and no second implementation.
// The lock names a commit on ourostack/desk's `release` branch and the Git tree of plugins/desk at it; the copy is
// fetched with Git and refused unless its tree matches, then kept in a per-user cache so other worktrees reuse it offline.
//
//   node scripts/desk-vendor.cjs            make vendor/desk match the lock (build runs this)
//   node scripts/desk-vendor.cjs --update   pin the newest Desk release, then vendor it

const childProcess = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const STAMP = ".ouro-desk.json"
const SHA = /^[0-9a-f]{40}$/

function readLock(repoRoot, deps = defaultDeps()) {
  const lock = JSON.parse(deps.readFileSync(path.join(repoRoot, "desk.lock.json"), "utf8"))
  for (const key of ["repository", "branch", "path", "version"]) {
    if (typeof lock[key] !== "string" || lock[key] === "") throw new Error(`desk.lock.json: ${key} must be a non-empty string`)
  }
  if (!SHA.test(lock.commit ?? "") || !SHA.test(lock.tree ?? "")) throw new Error("desk.lock.json: commit and tree must be full 40-character Git hashes")
  return lock
}

function vendorDir(repoRoot) {
  return path.join(repoRoot, "vendor", "desk")
}

function cacheDir(lock, deps = defaultDeps()) {
  return path.join(deps.homedir(), ".cache", "ouroboros", "desk", lock.tree)
}

// A copy is current when its stamp names the locked tree.
function holdsTree(dir, lock, deps = defaultDeps()) {
  try {
    return JSON.parse(deps.readFileSync(path.join(dir, STAMP), "utf8")).tree === lock.tree
  } catch {
    return false
  }
}

function git(args, cwd, deps) {
  const result = deps.spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || result.error?.message || "").trim()}`)
  }
  return String(result.stdout).trim()
}

// Fetches the locked commit into a scratch repository and unpacks plugins/desk, refusing a tree that is not the locked one.
function fetchLockedTree(lock, deps = defaultDeps()) {
  const scratch = deps.mkdtempSync(path.join(deps.tmpdir(), "ouro-desk-"))
  try {
    git(["init", "-q"], scratch, deps)
    git(["fetch", "-q", "--depth", "1", deps.remoteUrl(lock.repository), lock.commit], scratch, deps)
    const tree = git(["rev-parse", `${lock.commit}:${lock.path}`], scratch, deps)
    if (tree !== lock.tree) throw new Error(`${lock.repository}@${lock.commit}:${lock.path} is tree ${tree}, but desk.lock.json pins ${lock.tree}`)
    const tar = path.join(scratch, "desk.tar")
    git(["archive", "--format=tar", `--output=${tar}`, lock.commit, lock.path], scratch, deps)
    const unpacked = path.join(scratch, "unpacked")
    deps.mkdirSync(unpacked, { recursive: true })
    const extracted = deps.spawnSync("tar", ["-xf", tar, "-C", unpacked], { encoding: "utf8" })
    if (extracted.status !== 0) throw new Error(`tar could not unpack Desk: ${String(extracted.stderr).trim()}`)
    const out = path.join(scratch, "desk")
    deps.renameSync(path.join(unpacked, ...lock.path.split("/")), out)
    deps.writeFileSync(path.join(out, STAMP), `${JSON.stringify({ repository: lock.repository, version: lock.version, commit: lock.commit, tree: lock.tree }, null, 2)}\n`)
    return { dir: out, scratch }
  } catch (error) {
    deps.rmSync(scratch, { recursive: true, force: true })
    throw error
  }
}

function replaceDir(from, to, deps) {
  deps.rmSync(to, { recursive: true, force: true })
  deps.mkdirSync(path.dirname(to), { recursive: true })
  deps.cpSync(from, to, { recursive: true })
}

/** Makes vendor/desk hold the locked Desk tree: already there, copied from the per-user cache, or fetched. */
function ensureVendored(repoRoot, deps = defaultDeps()) {
  const lock = readLock(repoRoot, deps)
  const target = vendorDir(repoRoot)
  if (holdsTree(target, lock, deps)) return { source: "current", version: lock.version }
  const cached = cacheDir(lock, deps)
  if (holdsTree(cached, lock, deps)) {
    replaceDir(cached, target, deps)
    return { source: "cache", version: lock.version }
  }
  const fetched = fetchLockedTree(lock, deps)
  try {
    replaceDir(fetched.dir, target, deps)
    try {
      replaceDir(fetched.dir, cached, deps)
    } catch {
      // The cache only saves a later fetch; vendor/desk is already right.
    }
  } finally {
    deps.rmSync(fetched.scratch, { recursive: true, force: true })
  }
  return { source: "fetched", version: lock.version }
}

/** Pins the newest commit on Desk's release branch in desk.lock.json, then vendors it. */
function updateLock(repoRoot, deps = defaultDeps()) {
  const lock = readLock(repoRoot, deps)
  const url = deps.remoteUrl(lock.repository)
  const line = git(["ls-remote", url, `refs/heads/${lock.branch}`], repoRoot, deps)
  const commit = line.split(/\s+/)[0]
  if (!SHA.test(commit)) throw new Error(`no ${lock.branch} branch on ${lock.repository}`)
  const scratch = deps.mkdtempSync(path.join(deps.tmpdir(), "ouro-desk-pin-"))
  let next
  try {
    git(["init", "-q"], scratch, deps)
    git(["fetch", "-q", "--depth", "1", url, commit], scratch, deps)
    const tree = git(["rev-parse", `${commit}:${lock.path}`], scratch, deps)
    const version = JSON.parse(git(["show", `${commit}:${lock.path}/plugin.json`], scratch, deps)).version
    next = { ...lock, version, commit, tree }
  } finally {
    deps.rmSync(scratch, { recursive: true, force: true })
  }
  deps.writeFileSync(path.join(repoRoot, "desk.lock.json"), `${JSON.stringify(next, null, 2)}\n`)
  return { previous: lock.version, version: next.version, vendored: ensureVendored(repoRoot, deps) }
}

function runCli(argv = process.argv.slice(2), deps = defaultDeps()) {
  const repoRoot = path.resolve(__dirname, "..")
  try {
    if (argv.includes("--update")) {
      const result = updateLock(repoRoot, deps)
      deps.writeStdout(`Desk pinned at ${result.version} (was ${result.previous}) and vendored\n`)
    } else {
      const result = ensureVendored(repoRoot, deps)
      deps.writeStdout(`Desk ${result.version} at vendor/desk (${result.source})\n`)
    }
    return 0
  } catch (error) {
    deps.writeStderr(`desk-vendor: ${error.message}\n`)
    return 1
  }
}

function defaultDeps() {
  return {
    cpSync: fs.cpSync,
    homedir: os.homedir,
    mkdirSync: fs.mkdirSync,
    mkdtempSync: fs.mkdtempSync,
    readFileSync: fs.readFileSync,
    remoteUrl: (repository) => `https://github.com/${repository}.git`,
    renameSync: fs.renameSync,
    rmSync: fs.rmSync,
    spawnSync: childProcess.spawnSync,
    tmpdir: os.tmpdir,
    writeFileSync: fs.writeFileSync,
    writeStderr: (text) => process.stderr.write(text),
    writeStdout: (text) => process.stdout.write(text),
  }
}

if (require.main === module) {
  process.exitCode = runCli()
}

module.exports = { STAMP, cacheDir, ensureVendored, fetchLockedTree, holdsTree, readLock, runCli, updateLock, vendorDir }
