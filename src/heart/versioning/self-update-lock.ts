import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * One lock for everything that installs or activates a CLI release on this
 * machine: the unattended `ouro self-update` pass and the update check in
 * `ouro up`. Without it, the `ouro up` a pass runs to restart the daemon can
 * install a newer release in the middle of the pass (2026-11-27).
 *
 * The lock file holds its owner's pid. A crashed owner never wedges it: the
 * lock is stale once that pid is gone, or once the file is older than any pass
 * can run, which also covers a crashed owner whose pid now belongs to an
 * unrelated process.
 */
export const SELF_UPDATE_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000

export interface SelfUpdateLockDeps {
  /** This process's pid; defaults to process.pid. */
  pid?: number
  isPidAlive?: (pid: number) => boolean
  now?: () => number
}

export function selfUpdateLockPath(cliHome: string): string {
  return path.join(cliHome, "self-update.lock")
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function lockOwnerPid(cliHome: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(selfUpdateLockPath(cliHome), "utf8"), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** The pid holding the lock while it still counts, or null when nobody holds it or the lock is stale. */
function liveLockOwner(cliHome: string, deps: SelfUpdateLockDeps): number | null {
  const pid = lockOwnerPid(cliHome)
  if (pid === null) return null
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive
  if (!isPidAlive(pid)) return null
  let writtenAtMs: number
  try {
    writtenAtMs = fs.statSync(selfUpdateLockPath(cliHome)).mtimeMs
  } catch {
    /* v8 ignore next -- the lock vanished between reading and stat-ing it @preserve */
    return null
  }
  const now = deps.now ?? (() => Date.now())
  return now() - writtenAtMs > SELF_UPDATE_LOCK_MAX_AGE_MS ? null : pid
}

/** True when another live process holds the lock. */
export function isSelfUpdateLockHeld(cliHome: string, deps: SelfUpdateLockDeps = {}): boolean {
  const owner = liveLockOwner(cliHome, deps)
  return owner !== null && owner !== (deps.pid ?? process.pid)
}

/**
 * Takes the lock and returns its release, or null while another process holds
 * it. Release removes the file only while it still names this process.
 */
export function acquireSelfUpdateLock(cliHome: string, deps: SelfUpdateLockDeps = {}): (() => void) | null {
  const file = selfUpdateLockPath(cliHome)
  const pid = deps.pid ?? process.pid
  fs.mkdirSync(cliHome, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600)
      fs.writeSync(fd, `${pid}\n`)
      fs.closeSync(fd)
      return () => {
        if (lockOwnerPid(cliHome) !== pid) return
        try { fs.unlinkSync(file) } catch { /* v8 ignore next -- already released @preserve */ }
      }
    } catch (error) {
      /* v8 ignore next -- permission or disk errors are not a held lock @preserve */
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const owner = liveLockOwner(cliHome, deps)
      if (owner !== null) {
        emitNervesEvent({
          component: "daemon",
          event: "daemon.self_update_lock_busy",
          message: "another process is installing or activating a CLI release",
          meta: { owner, pid },
        })
        return null
      }
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.self_update_lock_reclaimed",
        message: "took over a self-update lock whose owner is gone or that is older than any pass",
        meta: { stalePid: lockOwnerPid(cliHome), pid },
      })
      try { fs.unlinkSync(file) } catch { /* v8 ignore next -- raced with the owner releasing it @preserve */ }
    }
  }
  /* v8 ignore next -- two processes reclaimed the same stale lock at once and the other won @preserve */
  return null
}
