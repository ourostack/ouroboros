import * as fs from "node:fs"
import * as path from "node:path"

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
        fs.rmSync(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for the ${name} lock`)
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
  try {
    return await fn()
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}
