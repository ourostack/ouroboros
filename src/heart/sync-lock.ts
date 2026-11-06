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

/** Test seams. Not part of the public API. */
export const __testHooks: {
  /** Runs while a reclaimer holds the reclaim file, after it judged the lock stale and before it unlinks. */
  beforeUnlink?: () => void
  /** Replaces the read of `/proc/<pid>/stat`. */
  readProcStat?: (pid: number) => string | null
  /** Runs at the start of every lock read. */
  beforeRead?: () => void
  /** Runs before the reclaim file is inspected after an exclusive-create collision. */
  beforeReclaimStat?: () => void
} = {}

const heldTokens = new Set<string>()

function lockFilePath(agentRoot: string): string {
  return path.join(agentRoot, ".git", SYNC_LOCK_FILE)
}

function readProcStat(pid: number): string | null {
  if (__testHooks.readProcStat) return __testHooks.readProcStat(pid)
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch {
    return null
  }
}

/** Field 22 of `/proc/<pid>/stat`. The command name (field 2) may hold spaces and parens, so parse past the last `)`. */
function processStartTime(pid: number): string | null {
  const stat = readProcStat(pid)
  if (stat === null) return null
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  // `rest` begins at field 3.
  return rest[22 - 3] ?? null
}

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
  if (content.procStart !== null && content.procStart !== processStartTime(content.pid)) return true
  return content.pid === process.pid && !heldTokens.has(content.token)
}

type ReadResult =
  | { kind: "missing" }
  | { kind: "malformed"; raw: string; ageMs: number }
  | { kind: "ok"; raw: string; content: LockContent }

function readLock(lockPath: string): ReadResult {
  __testHooks.beforeRead?.()
  let raw: string
  try {
    raw = fs.readFileSync(lockPath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" }
    throw err
  }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed.pid === "number" && typeof parsed.token === "string") {
      return { kind: "ok", raw, content: { pid: parsed.pid, token: parsed.token, procStart: parsed.procStart ?? null } }
    }
  } catch {
    // fall through to malformed
  }
  // A writer may be between create and write; age decides whether it is abandoned.
  let ageMs = 0
  try {
    ageMs = Date.now() - fs.statSync(lockPath).mtimeMs
  } catch /* v8 ignore next 3 -- the file vanished between read and stat @preserve */ {
    return { kind: "missing" }
  }
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
  const content: LockContent = { pid: process.pid, token, procStart: processStartTime(process.pid) }
  let fd: number
  try {
    fd = fs.openSync(lockPath, "wx")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null
    throw err
  }
  try {
    fs.writeSync(fd, JSON.stringify(content))
  } finally {
    fs.closeSync(fd)
  }
  heldTokens.add(token)
  return makeHandle(lockPath, token)
}

/**
 * Take over a stale lock. One reclaim file (O_EXCL) guards the whole
 * sequence, so two reclaimers cannot both move a lock.
 */
function reclaim(lockPath: string, staleRaw: string): SyncLockHandle | SyncLockBusy | "retry" {
  const reclaimPath = `${lockPath}.reclaim`
  for (let attempt = 0; ; attempt++) {
    try {
      fs.closeSync(fs.openSync(reclaimPath, "wx"))
      break
    } catch (err) {
      /* v8 ignore next -- only a collision is expected; other errors are real faults @preserve */
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      let ageMs: number
      try {
        __testHooks.beforeReclaimStat?.()
        ageMs = Date.now() - fs.statSync(reclaimPath).mtimeMs
      } catch {
        return "retry"
      }
      if (ageMs <= RECLAIM_STALE_MS || attempt > 0) return { busy: true, holderPid: null }
      fs.rmSync(reclaimPath, { force: true })
    }
  }
  try {
    const current = readLock(lockPath)
    if (current.kind === "missing") return "retry"
    const verdict = judge(current)
    if (!verdict.stale || current.raw !== staleRaw) return { busy: true, holderPid: verdict.holderPid }
    __testHooks.beforeUnlink?.()
    fs.rmSync(lockPath, { force: true })
    const handle = createLock(lockPath)
    if (handle) {
      emitNervesEvent({
        component: "heart",
        event: "heart.sync_lock_reclaimed",
        message: "reclaimed a stale bundle sync lock",
        meta: { lockPath, previousPid: verdict.holderPid },
      })
      return handle
    }
    /* v8 ignore next -- the reclaim file excludes other reclaimers; only a fresh acquirer could win the race @preserve */
    return "retry"
  } finally {
    fs.rmSync(reclaimPath, { force: true })
  }
}

/** One synchronous attempt. */
export function tryAcquireSyncLockSync(agentRoot: string): SyncLockHandle | SyncLockBusy {
  const lockPath = lockFilePath(agentRoot)
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
      busy = { busy: true, holderPid: outcome.holderPid ?? busy.holderPid }
      break
    }
    return outcome
  }
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.sync_lock_busy",
    message: "bundle sync lock is held",
    meta: { lockPath, holderPid: busy.holderPid },
  })
  return busy
}

/** Polls every 100 ms for up to `waitMs`. */
export async function acquireSyncLock(agentRoot: string, waitMs: number): Promise<SyncLockHandle | SyncLockBusy> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const result = tryAcquireSyncLockSync(agentRoot)
    if (!("busy" in result) || Date.now() >= deadline) return result
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(1, deadline - Date.now()))))
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
