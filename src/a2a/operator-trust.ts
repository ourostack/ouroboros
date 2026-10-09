import { randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import { inspectTrustedDirectory, inspectTrustedJson, type TrustedJson } from "./trusted-files"

/**
 * Operator-set grants live in a trust directory outside the agent bundle: `/etc/ouro/trust/<agent>/` by default, or
 * `<OURO_OPERATOR_TRUST_DIR>/<agent>/` when that variable replaces the trust root. The agent's own uid cannot write there, and the bundle's recursive
 * `chown` during an in-place upgrade cannot reach it. A file in it counts only when the whole chain above it passes
 * the trusted-files check (real directories, root-owned, closed to group and other writes, up to `/`).
 */
export const OPERATOR_TRUST_ROOT = "/etc/ouro/trust"
export const TRUST_DIR_ENV = "OURO_OPERATOR_TRUST_DIR"

let trustRoot = OPERATOR_TRUST_ROOT

/** Tests keep trust directories under their private temp root instead of `/etc`. Refused outside a test runner. */
export function overrideTrustRootForTests(root: string | undefined): void {
  if (process.env.VITEST === undefined) throw new Error("overrideTrustRootForTests is for tests only")
  trustRoot = root ?? OPERATOR_TRUST_ROOT
}

/** The agent a bundle root belongs to: `~/AgentBundles/sanctuary.ouro` is `sanctuary`. */
export function agentNameFromRoot(agentRoot: string): string {
  return path.basename(agentRoot).replace(/\.ouro$/u, "")
}

/**
 * The real path of `target`, resolved once. The deepest ancestor that exists is resolved through every symlink and the rest of
 * the (not yet created) tail is appended, so a configured `/etc/ouro/trust` becomes `/private/etc/ouro/trust` on macOS and the
 * ancestor check then walks the directories the grants actually sit in.
 */
function resolveReal(target: string): string {
  const tail: string[] = []
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    try {
      return path.join(fs.realpathSync(current), ...tail)
    } catch {
      /* v8 ignore next -- the filesystem root always resolves, so this loop never runs out of ancestors @preserve */
      if (path.dirname(current) === current) return path.resolve(target)
      tail.unshift(path.basename(current))
    }
  }
}

/**
 * Where this agent's operator-set grants live: `<trust root>/<agent>`. `OURO_OPERATOR_TRUST_DIR` replaces the trust root
 * (`/etc/ouro/trust`) and keeps the per-agent subdirectory, so one setting serves every agent on the host.
 */
export function operatorTrustDir(agentRoot: string): string {
  const override = process.env[TRUST_DIR_ENV]
  const root = override && override.trim().length > 0 ? override : trustRoot
  return path.join(resolveReal(root), agentNameFromRoot(agentRoot))
}

export function operatorTrustFile(agentRoot: string, fileName: string): string {
  return path.join(operatorTrustDir(agentRoot), fileName)
}

export type GrantFileView<T> =
  | { state: "trusted"; grants: Record<string, T>; ignored: string[] }
  | { state: "missing"; grants: Record<string, never>; ignored: string[] }
  | { state: "untrusted"; reason: string; grants: Record<string, never>; ignored: string[] }

/**
 * Reads `{ schemaVersion: 1, grants: { <friendId>: entry } }` from the trust directory. A file that is not trusted, not
 * JSON or not this shape is `untrusted` and holds no grants; a missing file is `missing`. Within a trusted file, an
 * entry that fails `valid` is dropped and its friend id is listed in `ignored`.
 */
export function readGrantFile<T>(agentRoot: string, fileName: string, valid: (entry: unknown) => entry is T): GrantFileView<T> {
  const raw: TrustedJson = inspectTrustedJson(operatorTrustFile(agentRoot, fileName))
  if (raw.state === "missing") return { state: "missing", grants: {}, ignored: [] }
  if (raw.state === "untrusted") return { state: "untrusted", reason: raw.reason, grants: {}, ignored: [] }
  const file = raw.value as { schemaVersion?: unknown; grants?: unknown } | null
  const grants = file?.grants
  if (!file || typeof file !== "object" || file.schemaVersion !== 1 || !grants || typeof grants !== "object" || Array.isArray(grants)) {
    return { state: "untrusted", reason: "file is not { schemaVersion: 1, grants: {...} }", grants: {}, ignored: [] }
  }
  const kept: Record<string, T> = {}
  const ignored: string[] = []
  for (const [friendId, entry] of Object.entries(grants)) {
    if (valid(entry)) kept[friendId] = entry
    else ignored.push(friendId)
  }
  return { state: "trusted", grants: kept, ignored }
}

/** Why the operator command refused to write. The message says what to fix. */
export class TrustDirectoryError extends Error {}

const isRoot = (): boolean => process.geteuid?.() === 0

let fchownHook: ((fd: number, uid: number, gid: number) => void) | undefined

/** Tests are not root, so they watch ownership changes instead of making them. Refused outside a test runner. */
export function overrideFchownForTests(hook: ((fd: number, uid: number, gid: number) => void) | undefined): void {
  if (process.env.VITEST === undefined) throw new Error("overrideFchownForTests is for tests only")
  fchownHook = hook
}

function chownToRoot(fd: number): void {
  if (fchownHook) fchownHook(fd, 0, 0)
  /* v8 ignore next -- the real fchown only succeeds as root; tests watch the hook instead @preserve */
  else fs.fchownSync(fd, 0, 0)
}

/**
 * Makes sure the trust directory exists and is trusted. A missing directory is created root-owned 0755, one component
 * at a time, but only below an ancestor that is already trusted. An existing directory (or ancestor) that is not
 * trusted is refused: the command never takes ownership of something the agent could have made.
 */
export function ensureTrustDirectory(dir: string): void {
  const missing: string[] = []
  let base = path.resolve(dir)
  for (;;) {
    const result = inspectTrustedDirectory(base)
    if (result.state === "trusted") break
    if (result.state === "untrusted") throw new TrustDirectoryError(`refusing to write: ${base} is not trusted (${result.reason}). Fix its owner and mode as root; this command never takes ownership of an existing directory.`)
    missing.push(base)
    base = path.dirname(base)
  }
  for (const next of missing.reverse()) {
    fs.mkdirSync(next, { mode: 0o755 })
    const fd = fs.openSync(next, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try {
      if (isRoot()) chownToRoot(fd)
      fs.fchmodSync(fd, 0o755)
    } finally {
      fs.closeSync(fd)
    }
  }
}

/** Flushes a directory's entries to disk, so a rename or a new file in it survives a crash. */
function fsyncDirectory(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try {
    fs.fsyncSync(fd)
    directoryFlushHook?.(dir)
  } finally {
    fs.closeSync(fd)
  }
}

let directoryFlushHook: ((dir: string) => void) | undefined

/** Tests watch directory flushes (the ESM fs namespace cannot be spied on). Refused outside a test runner. */
export function overrideDirectoryFlushForTests(hook: ((dir: string) => void) | undefined): void {
  if (process.env.VITEST === undefined) throw new Error("overrideDirectoryFlushForTests is for tests only")
  directoryFlushHook = hook
}

const LOCK_FILE = ".lock"
const LOCK_STALE_MS = 2 * 60_000
let lockTimeoutMs = 5000
let lockWaitHook: (() => void) | undefined

/** Tests shorten the wait for a held lock and can act while it waits. Refused outside a test runner. */
export function overrideLockTimeoutForTests(timeoutMs: number | undefined, onWait?: () => void): void {
  if (process.env.VITEST === undefined) throw new Error("overrideLockTimeoutForTests is for tests only")
  lockTimeoutMs = timeoutMs ?? 5000
  lockWaitHook = onWait
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Runs a read-modify-write of the trust files under an exclusive lock file in the trust directory, so two grant commands
 * cannot both read the old file and then overwrite each other. The lock is created with O_EXCL; a lock older than two minutes
 * belongs to a writer that died and is taken over. A lock that stays held past the wait names the file to remove.
 */
export function withTrustedWriteLock<T>(agentRoot: string, fn: () => T): T {
  const dir = operatorTrustDir(agentRoot)
  ensureTrustDirectory(dir)
  const lock = path.join(dir, LOCK_FILE)
  const deadline = Date.now() + lockTimeoutMs
  for (;;) {
    try {
      createExclusive(lock, `pid ${process.pid} at ${new Date().toISOString()}\n`)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let age = 0
      try { age = Date.now() - fs.lstatSync(lock).mtimeMs } catch { continue }
      if (age > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue }
      if (Date.now() >= deadline) throw new TrustDirectoryError(`refusing to write: another grant command is writing to ${dir} (lock file ${lock}). If none is running, remove that file and retry. Nothing was written.`)
      lockWaitHook?.()
      sleepSync(25)
    }
  }
  try {
    return fn()
  } finally {
    fs.rmSync(lock, { force: true })
  }
}

/** Creates `file` exclusively (never through a link or over anything), owned by root with mode 0644 when run as root, and fsyncs it. */
function createExclusive(file: string, body: string | Buffer): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try {
    if (isRoot()) chownToRoot(fd)
    fs.fchmodSync(fd, 0o644)
    fs.writeFileSync(fd, body)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function rawBytes(file: string): Buffer | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd) : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * Replaces one file in the trust directory. The previous bytes are kept beside it as a timestamped backup, created the
 * same safe way. The new file is written to an exclusive random temporary name, owned and moded through its descriptor,
 * fsynced and renamed into place, so a reader never sees a half-written file and nothing already on disk is followed.
 */
export function writeTrustedFile(agentRoot: string, fileName: string, body: string, now: Date): { backup: string | null } {
  const dir = operatorTrustDir(agentRoot)
  ensureTrustDirectory(dir)
  const file = path.join(dir, fileName)
  const previous = rawBytes(file)
  let backup: string | null = null
  if (previous) {
    backup = `${file}.bak-${now.toISOString().replace(/[:.]/gu, "-")}`
    createExclusive(backup, previous)
    fsyncDirectory(dir)
  }
  const tmp = path.join(dir, `.${fileName}.${randomBytes(8).toString("hex")}.tmp`)
  try {
    createExclusive(tmp, body)
    fs.renameSync(tmp, file)
    fsyncDirectory(dir)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
  emitNervesEvent({ component: "senses", event: "senses.a2a_trust_file_written", message: "wrote an operator-set trust file", meta: { file, backedUp: backup !== null } })
  return { backup }
}

/** A short human line about the file's state for `list` output and warnings. */
export function describeGrantFile(view: GrantFileView<unknown>, file: string): string {
  if (view.state === "trusted") return `trusted: ${file}`
  if (view.state === "missing") return `not present: ${file}`
  return `NOT TRUSTED: ${file} (${view.reason}); no grant in it is honoured`
}
