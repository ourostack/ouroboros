import { execFileSync } from "child_process"
import { randomBytes } from "crypto"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"

/** File name of the per-bundle sync lock, kept under `.git/`. */
export const SYNC_LOCK_FILE = "ouro-sync.lock"

const RECLAIM_STALE_MS = 30_000
const POLL_MS = 100

export interface SyncLockHandle {
  release(): void
}

export type SyncLockBusy = { busy: true; holderPid: number | null }

interface LockContent {
  pid: number
  token: string
  procStart: string | null
}

/**
 * Test seams.
 * @internal Not part of the public API; production code must not set these.
 */
export const __testHooks: {
  /** Runs while a reclaimer holds the guard, after it judged the lock stale and before it unlinks. */
  beforeUnlink?: () => void
  /** Runs after a reclaimer unlinked the stale lock and before it creates its own. */
  afterUnlink?: () => void
  /** Replaces `process.platform`. */
  platform?: () => NodeJS.Platform
  /** Replaces the raw read of `/proc/<pid>/stat`. May return null or throw for "unreadable". */
  readProcStat?: (pid: number) => string | null
  /** Replaces the raw `ps -o lstart= -p <pid>` exec. May return null or throw for "failed". */
  readPsStart?: (pid: number) => string | null
  /** Forgets the cached start time of this process. */
  resetOwnStartTime(): void
  /** Runs at the start of every lock read. */
  beforeRead?: () => void
  /** Runs before the guard is inspected after an exclusive-create collision. */
  beforeReclaimStat?: () => void
  /** Runs just before and just after a stale guard is renamed aside. */
  guardRace?: (phase: "beforeRename" | "afterRename") => void
  /** Runs before the lock content is written. */
  beforeLockWrite?: () => void
} = {
  resetOwnStartTime() {
    ownStartTime = undefined
  },
}

const heldTokens = new Set<string>()

function lockFilePath(agentRoot: string): string {
  return path.join(agentRoot, ".git", SYNC_LOCK_FILE)
}

const PS_ENV_OVERRIDES = { LC_ALL: "C", TZ: "UTC" }

function readProcStat(pid: number): string | null {
  try {
    return __testHooks.readProcStat ? __testHooks.readProcStat(pid) : fs.readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch {
    return null
  }
}

function readPsStart(pid: number): string | null {
  try {
    const out = __testHooks.readPsStart
      ? __testHooks.readPsStart(pid)
      : execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
          encoding: "utf8",
          timeout: 2000,
          stdio: ["ignore", "pipe", "ignore"],
          // lstart prints local time in the caller's locale; pin both so every process sees one string.
          env: { ...process.env, ...PS_ENV_OVERRIDES },
        })
    const trimmed = out === null ? "" : out.trim()
    return trimmed === "" ? null : trimmed
  } catch {
    return null
  }
}

/**
 * Process start time as an opaque string, or null when unknown. Linux: field 22
 * of `/proc/<pid>/stat` (the command name, field 2, may hold spaces and parens,
 * so parse past the last `)`). Elsewhere, or when /proc is unreadable: the
 * trimmed output of `ps -o lstart=` under a pinned locale and time zone.
 */
function processStartTime(pid: number): string | null {
  if ((__testHooks.platform?.() ?? process.platform) === "linux") {
    const stat = readProcStat(pid)
    if (stat !== null) {
      // `rest` begins at field 3.
      const field = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[22 - 3]
      if (field !== undefined) return field
    }
  }
  return readPsStart(pid)
}

/** This process's own start time cannot change, so it is read once, lazily, when the read succeeds. */
let ownStartTime: string | null | undefined
function ownProcessStartTime(): string | null {
  if (ownStartTime !== undefined) return ownStartTime
  // Cache only a successful read; a failed one is retried on the next attempt.
  const read = processStartTime(process.pid)
  if (read !== null) ownStartTime = read
  return read
}

/** /proc ticks are all digits; `ps` lstart never is. Values of different formats cannot be compared. */
const isProcFormat = (value: string): boolean => /^\d+$/.test(value)

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function isStale(content: LockContent): boolean {
  if (!pidAlive(content.pid)) return true
  if (content.procStart !== null) {
    // Stale only when both start times are known, in the same format, and differ.
    // An unreadable start time means unknown, and a live pid with unknown start is live.
    const now = content.pid === process.pid ? ownProcessStartTime() : processStartTime(content.pid)
    if (now !== null && isProcFormat(now) === isProcFormat(content.procStart) && now !== content.procStart) return true
  }
  return content.pid === process.pid && !heldTokens.has(content.token)
}

type ReadResult =
  | { kind: "missing" }
  | { kind: "malformed"; raw: string; ageMs: number }
  | { kind: "ok"; raw: string; content: LockContent }

function readLock(lockPath: string): ReadResult {
  __testHooks.beforeRead?.()
  let fd: number
  try {
    fd = fs.openSync(lockPath, "r")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" }
    throw err
  }
  let raw: string
  let ageMs: number
  try {
    // Content and mtime come from one descriptor, so the file cannot vanish between them.
    raw = fs.readFileSync(fd, "utf8")
    ageMs = Date.now() - fs.fstatSync(fd).mtimeMs
  } finally {
    fs.closeSync(fd)
  }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed.pid === "number" && typeof parsed.token === "string") {
      return { kind: "ok", raw, content: { pid: parsed.pid, token: parsed.token, procStart: parsed.procStart ?? null } }
    }
  } catch {
    // fall through to malformed
  }
  // Corrupt-lock rule: a lock that does not parse is busy while fresh, because a writer may be
  // between create and write. Once its mtime is older than 30 s it is stale and may be reclaimed.
  return { kind: "malformed", raw, ageMs }
}

function judge(result: Exclude<ReadResult, { kind: "missing" }>): { stale: boolean; holderPid: number | null } {
  if (result.kind === "ok") return { stale: isStale(result.content), holderPid: result.content.pid }
  return { stale: result.ageMs > RECLAIM_STALE_MS, holderPid: null }
}

function makeHandle(lockPath: string, token: string): SyncLockHandle {
  return {
    release() {
      heldTokens.delete(token)
      const current = readLock(lockPath)
      if (current.kind === "ok" && current.content.token === token) fs.rmSync(lockPath, { force: true })
    },
  }
}

/** Exclusive create. Returns null if the lock already exists. */
function createLock(lockPath: string): SyncLockHandle | null {
  const token = randomBytes(16).toString("hex")
  const content: LockContent = { pid: process.pid, token, procStart: ownProcessStartTime() }
  let fd: number
  try {
    fd = fs.openSync(lockPath, "wx")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null
    throw err
  }
  try {
    __testHooks.beforeLockWrite?.()
    fs.writeSync(fd, JSON.stringify(content))
  } catch (err) {
    // Do not leave an empty lock that would read as busy until it ages out.
    fs.closeSync(fd)
    fs.rmSync(lockPath, { force: true })
    throw err
  }
  fs.closeSync(fd)
  heldTokens.add(token)
  return makeHandle(lockPath, token)
}

const guardPathOf = (lockPath: string): string => `${lockPath}.reclaim`

function guardOwned(guardPath: string, token: string): boolean {
  try {
    return fs.readFileSync(guardPath, "utf8") === token
  } catch {
    return false
  }
}

/** Create the guard with O_EXCL, holding a random token, and fsync it. Returns null if it exists. */
function createGuard(guardPath: string): string | null {
  const token = randomBytes(16).toString("hex")
  let fd: number
  try {
    fd = fs.openSync(guardPath, "wx")
  } catch (err) {
    /* v8 ignore next -- only a collision is expected; other errors are real faults @preserve */
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    return null
  }
  try {
    fs.writeSync(fd, token)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  return token
}

/**
 * Clear a guard older than 30 s without ever deleting a guard that is not the one judged stale:
 * rename it aside, read the renamed file's token, and delete only on a match. On a mismatch it is
 * not restored; the call reports busy.
 */
function clearStaleGuard(guardPath: string): "busy" | "cleared" | "gone" {
  let judgedToken: string
  let ageMs: number
  try {
    __testHooks.beforeReclaimStat?.()
    ageMs = Date.now() - fs.statSync(guardPath).mtimeMs
    judgedToken = fs.readFileSync(guardPath, "utf8")
  } catch {
    return "gone"
  }
  if (ageMs <= RECLAIM_STALE_MS) return "busy"
  const moved = `${guardPath}.stale.${randomBytes(8).toString("hex")}`
  __testHooks.guardRace?.("beforeRename")
  try {
    fs.renameSync(guardPath, moved)
  } catch {
    return "gone"
  }
  __testHooks.guardRace?.("afterRename")
  if (fs.readFileSync(moved, "utf8") === judgedToken) {
    fs.rmSync(moved, { force: true })
    return "cleared"
  }
  // We moved a guard that is not the one we judged. Never put it back: restoring a guard that
  // another reclaimer may already have outlived is how two processes end up holding the lock.
  // Its owner's ownership re-check finds the guard gone and gives up. We delete only our aside copy.
  fs.rmSync(moved, { force: true })
  return "busy"
}

/**
 * Take over a stale lock. One guard file (O_EXCL, holding our token) guards the whole
 * sequence, so two reclaimers cannot both move a lock. Ownership of the guard is checked
 * before the unlink and after the create; a reclaimer that lost its guard gives up.
 */
function reclaim(lockPath: string, staleRaw: string): SyncLockHandle | SyncLockBusy | "retry" {
  const guardPath = guardPathOf(lockPath)
  let guard = createGuard(guardPath)
  if (guard === null) {
    const cleared = clearStaleGuard(guardPath)
    if (cleared === "gone") return "retry"
    if (cleared === "busy") return { busy: true, holderPid: null }
    guard = createGuard(guardPath)
    if (guard === null) return { busy: true, holderPid: null }
  }
  const token = guard
  try {
    const current = readLock(lockPath)
    if (current.kind === "missing") return "retry"
    const verdict = judge(current)
    if (!verdict.stale || current.raw !== staleRaw) return { busy: true, holderPid: verdict.holderPid }
    __testHooks.beforeUnlink?.()
    // Accepted residual (M14): between this ownership check and the unlink below, a guard that was
    // judged stale and cleared by another reclaimer can still let a third contender reclaim the
    // lock in the same gap, so two holders are possible when three reclaimers meet a guard left by
    // a crashed one. It needs a crash plus a 30 s pause plus three contenders in one window, and
    // every closing option (a lock-file lease, a held flock) costs more than the exposure.
    if (!guardOwned(guardPath, token)) return { busy: true, holderPid: null }
    fs.rmSync(lockPath, { force: true })
    __testHooks.afterUnlink?.()
    const handle = createLock(lockPath)
    // Only a fresh acquirer (not a reclaimer) can have created the lock since our unlink.
    if (!handle) return "retry"
    if (!guardOwned(guardPath, token)) {
      handle.release()
      return { busy: true, holderPid: null }
    }
    emitNervesEvent({
      component: "heart",
      event: "heart.sync_lock_reclaimed",
      message: "reclaimed a stale bundle sync lock",
      meta: { lockPath, previousPid: verdict.holderPid },
    })
    return handle
  } finally {
    if (guardOwned(guardPath, token)) fs.rmSync(guardPath, { force: true })
  }
}

function attemptOnce(lockPath: string): SyncLockHandle | SyncLockBusy {
  let busy: SyncLockBusy = { busy: true, holderPid: null }
  for (let i = 0; i < 3; i++) {
    const created = createLock(lockPath)
    if (created) return created
    const existing = readLock(lockPath)
    if (existing.kind === "missing") continue
    const verdict = judge(existing)
    busy = { busy: true, holderPid: verdict.holderPid }
    if (!verdict.stale) break
    const outcome = reclaim(lockPath, existing.raw)
    if (outcome === "retry") continue
    if ("busy" in outcome) {
      busy = outcome
      break
    }
    return outcome
  }
  return busy
}

function emitBusy(lockPath: string, busy: SyncLockBusy): void {
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.sync_lock_busy",
    message: "bundle sync lock is held",
    meta: { lockPath, holderPid: busy.holderPid },
  })
}

/** One synchronous attempt. */
export function tryAcquireSyncLockSync(agentRoot: string): SyncLockHandle | SyncLockBusy {
  const lockPath = lockFilePath(agentRoot)
  const result = attemptOnce(lockPath)
  if ("busy" in result) emitBusy(lockPath, result)
  return result
}

/** The signal's own reason, or an AbortError when it has none. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The sync lock wait was aborted", "AbortError")
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal as AbortSignal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    // The timer stays ref'd on purpose: a one-shot caller (`ouro sync`) that waits on a busy lock
    // must keep the process alive until it gets the lock or times out.
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Polls every 100 ms for up to `waitMs`. `Infinity` waits until the lock is acquired; NaN or a
 * negative value is a single attempt. An aborted `signal` rejects with its reason (an AbortError by default).
 */
export async function acquireSyncLock(
  agentRoot: string,
  waitMs: number,
  signal?: AbortSignal,
): Promise<SyncLockHandle | SyncLockBusy> {
  const lockPath = lockFilePath(agentRoot)
  const deadline = Date.now() + (waitMs > 0 ? waitMs : 0)
  for (;;) {
    if (signal?.aborted) throw abortReason(signal)
    const result = attemptOnce(lockPath)
    if (!("busy" in result)) return result
    if (Date.now() >= deadline) {
      emitBusy(lockPath, result)
      return result
    }
    await pause(Math.min(POLL_MS, Math.max(1, deadline - Date.now())), signal)
  }
}

/** Daemon boot: drop a lock this pid left behind in an earlier life. */
export function clearOwnStaleSyncLock(agentRoot: string): void {
  const lockPath = lockFilePath(agentRoot)
  const existing = readLock(lockPath)
  if (existing.kind !== "ok") return
  if (existing.content.pid === process.pid && !heldTokens.has(existing.content.token)) {
    fs.rmSync(lockPath, { force: true })
  }
}
