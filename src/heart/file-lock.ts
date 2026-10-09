import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

export interface FileLockOptions {
  /** A lock held longer than this is taken to belong to a dead process and is broken. */
  staleMs?: number
  /** How long to wait for a busy lock before giving up. */
  waitMs?: number
  pollMs?: number
}

const DEFAULT_STALE_MS = 120_000
const DEFAULT_WAIT_MS = 45_000
const DEFAULT_POLL_MS = 25

/**
 * Breaks a stale lock by renaming it to a name only this caller knows, then removing that. Two waiters both seeing the
 * same stale lock cannot both break it: only one rename succeeds, and the loser never touches a lock a third process
 * has since taken under the original name.
 */
function breakStaleLock(lock: string): boolean {
  const broken = `${lock}.broken-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    fs.renameSync(lock, broken)
  } catch {
    /* v8 ignore next -- the loser of a break race finds the lock already renamed away, and simply retries @preserve */
    return false
  }
  removeLock(broken)
  return true
}

/** The lock directory is always empty, so removing it never recurses; another process may already have broken it as stale. */
function removeLock(lock: string): void {
  try {
    fs.rmdirSync(lock)
  } catch {
    /* v8 ignore next -- a lock broken as stale by another process is already gone @preserve */
    return
  }
}

/**
 * Runs `fn` while holding a named lock in `dir`. The lock is a directory, because creating one is atomic across
 * processes, which matters here: the Butler's senses (Telegram, A2A, the private runtime) are separate processes that
 * share one bundle on disk.
 */
export async function withFileLock<T>(dir: string, name: string, fn: () => Promise<T> | T, options: FileLockOptions = {}): Promise<T> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, `${name}.lock`)
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      /* v8 ignore next -- a holder releasing between the failed mkdir and this stat reads as an old lock, which is then simply retried @preserve */
      const heldSince = fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0
      if (Date.now() - heldSince > staleMs) {
        /* v8 ignore next -- only the waiter whose rename won reports the break @preserve */
        if (breakStaleLock(lock)) emitNervesEvent({ level: "warn", component: "heart", event: "heart.file_lock_broken", message: "broke a lock whose holder never released it", meta: { name, heldMs: Date.now() - heldSince } })
        continue
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for the ${name} lock`)
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
  try {
    return await fn()
  } finally {
    removeLock(lock)
  }
}
