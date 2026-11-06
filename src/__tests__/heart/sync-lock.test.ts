import { spawn, type ChildProcess } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { Logger } from "../../nerves"
import { setRuntimeLogger } from "../../nerves/runtime"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  SYNC_LOCK_FILE,
  __testHooks,
  acquireSyncLock,
  clearOwnStaleSyncLock,
  tryAcquireSyncLockSync,
} from "../../heart/sync-lock"

let root: string
let children: ChildProcess[] = []

function lockPath(): string {
  return path.join(root, ".git", SYNC_LOCK_FILE)
}
function reclaimPath(): string {
  return `${lockPath()}.reclaim`
}
function readLock(): { pid: number; token: string; procStart: string | null } {
  return JSON.parse(fs.readFileSync(lockPath(), "utf8"))
}
function writeLock(content: unknown): void {
  fs.writeFileSync(lockPath(), typeof content === "string" ? content : JSON.stringify(content))
}
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" })
  const pid = child.pid as number
  await new Promise((resolve) => child.on("exit", resolve))
  return pid
}
async function holdingChild(): Promise<ChildProcess> {
  // A live child process that owns the lock file; it stays alive until the test ends.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  children.push(child)
  writeLock({ pid: child.pid, token: "child-token", procStart: null })
  return child
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-lock-"))
  fs.mkdirSync(path.join(root, ".git"))
})
afterEach(() => {
  __testHooks.beforeUnlink = undefined
  __testHooks.readProcStat = undefined
  __testHooks.beforeRead = undefined
  __testHooks.beforeReclaimStat = undefined
  __testHooks.readPsStart = undefined
  __testHooks.guardRace = undefined
  __testHooks.beforeLockWrite = undefined
  for (const c of children) c.kill("SIGKILL")
  children = []
  fs.rmSync(root, { recursive: true, force: true })
})

describe("sync lock", () => {
  it("writes pid, token and procStart and removes the file on release", async () => {
    const handle = await acquireSyncLock(root, 0)
    expect("busy" in handle).toBe(false)
    const content = readLock()
    expect(content.pid).toBe(process.pid)
    expect(typeof content.token).toBe("string")
    expect(content.token.length).toBeGreaterThan(8)
    expect(content.procStart === null || typeof content.procStart === "string").toBe(true)
    if (process.platform === "linux") expect(content.procStart).toMatch(/^\d+$/)
    ;(handle as { release(): void }).release()
    expect(fs.existsSync(lockPath())).toBe(false)
  })

  it("release leaves a lock that another holder now owns", () => {
    const handle = tryAcquireSyncLockSync(root) as { release(): void }
    writeLock({ pid: process.pid, token: "someone-else", procStart: null })
    handle.release()
    expect(readLock().token).toBe("someone-else")
    handle.release()
    fs.rmSync(lockPath())
    handle.release()
  })

  it("a second caller in another process waits then reports busy with the holder pid", async () => {
    const child = await holdingChild()
    const started = Date.now()
    const result = await acquireSyncLock(root, 250)
    expect(result).toEqual({ busy: true, holderPid: child.pid })
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
  }, 20000)

  it("acquires once the holder releases while waiting", async () => {
    const first = tryAcquireSyncLockSync(root) as { release(): void }
    setTimeout(() => first.release(), 150)
    const second = await acquireSyncLock(root, 2000)
    expect("busy" in second).toBe(false)
    ;(second as { release(): void }).release()
  })

  it("reclaims a lock whose pid has exited", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    const handle = tryAcquireSyncLockSync(root)
    expect("busy" in handle).toBe(false)
    expect(readLock().pid).toBe(process.pid)
    expect(fs.existsSync(reclaimPath())).toBe(false)
  })

  it("reclaims a lock left by the same pid from an earlier boot", () => {
    writeLock({ pid: process.pid, token: "old", procStart: null })
    const handle = tryAcquireSyncLockSync(root)
    expect("busy" in handle).toBe(false)
    expect(readLock().token).not.toBe("old")
  })

  it("never reclaims a live holder's lock", () => {
    const parent = process.ppid
    writeLock({ pid: parent, token: "live", procStart: null })
    expect(tryAcquireSyncLockSync(root)).toEqual({ busy: true, holderPid: parent })
    expect(readLock().token).toBe("live")
  })

  it("treats a live pid with a permission error as live", () => {
    writeLock({ pid: 1, token: "init", procStart: null })
    expect(tryAcquireSyncLockSync(root)).toEqual({ busy: true, holderPid: 1 })
  })

  it("two concurrent reclaimers: exactly one wins", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    let bResult: unknown
    let hookCalls = 0
    __testHooks.beforeUnlink = () => {
      hookCalls++
      // A holds the reclaim file and is paused before unlinking; B runs now.
      __testHooks.beforeUnlink = undefined
      bResult = tryAcquireSyncLockSync(root)
    }
    const a = tryAcquireSyncLockSync(root)
    expect(hookCalls).toBe(1)
    expect("busy" in (a as object)).toBe(false)
    expect(bResult).toMatchObject({ busy: true })
    expect(readLock().token).toBeDefined()
    expect(fs.existsSync(reclaimPath())).toBe(false)
  })

  it("a reclaimer that finds the lock changed under it does not unlink it", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    // Not stale by the time the reclaim file is held.
    let calls = 0
    __testHooks.beforeUnlink = () => {
      calls++
    }
    const realPid = process.ppid
    let reads = 0
    __testHooks.beforeRead = () => {
      // The second read happens while the reclaimer holds the reclaim file.
      if (++reads === 2) writeLock({ pid: realPid, token: "live", procStart: null })
    }
    expect(tryAcquireSyncLockSync(root)).toEqual({ busy: true, holderPid: realPid })
    expect(calls).toBe(0)
    expect(readLock().token).toBe("live")
    expect(fs.existsSync(reclaimPath())).toBe(false)
  })

  it("a fresh reclaim file makes the caller busy", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    fs.writeFileSync(reclaimPath(), "")
    expect(tryAcquireSyncLockSync(root)).toMatchObject({ busy: true })
    expect(readLock().token).toBe("dead")
  })

  it("a stale reclaim file older than 30 s is cleared", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    fs.writeFileSync(reclaimPath(), "")
    const old = new Date(Date.now() - 31_000)
    fs.utimesSync(reclaimPath(), old, old)
    const handle = tryAcquireSyncLockSync(root)
    expect("busy" in handle).toBe(false)
    expect(fs.existsSync(reclaimPath())).toBe(false)
  })

  it("a reclaim file that vanishes while being inspected is tolerated", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    fs.writeFileSync(reclaimPath(), "")
    __testHooks.beforeReclaimStat = () => fs.rmSync(reclaimPath(), { force: true })
    // Retry finds the reclaim file gone and takes over.
    expect("busy" in tryAcquireSyncLockSync(root)).toBe(false)
  })

  it("procStart mismatch is stale (hooked proc reader)", () => {
    const holder = process.ppid
    writeLock({ pid: holder, token: "x", procStart: "111" })
    __testHooks.readProcStat = () => "42 (a) b) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 222 23"
    const handle = tryAcquireSyncLockSync(root)
    expect("busy" in handle).toBe(false)
  })

  it("procStart that matches keeps the lock live", () => {
    const holder = process.ppid
    writeLock({ pid: holder, token: "x", procStart: "222" })
    __testHooks.readProcStat = () => "42 (a) b) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 222 23"
    expect(tryAcquireSyncLockSync(root)).toEqual({ busy: true, holderPid: holder })
  })

  it.skipIf(process.platform !== "linux")("procStart mismatch is stale", () => {
    writeLock({ pid: process.ppid, token: "x", procStart: "1" })
    const handle = tryAcquireSyncLockSync(root)
    expect("busy" in handle).toBe(false)
  })

  it("an unreadable proc stat gives null procStart", () => {
    __testHooks.readProcStat = () => null
    __testHooks.readPsStart = () => null
    tryAcquireSyncLockSync(root)
    expect(readLock().procStart).toBeNull()
  })

  it("the default proc reader returns null when the stat file is missing", () => {
    writeLock({ pid: process.ppid, token: "x", procStart: null })
    expect(tryAcquireSyncLockSync(root)).toMatchObject({ busy: true })
    const handle = (() => {
      fs.rmSync(lockPath())
      return tryAcquireSyncLockSync(root)
    })()
    expect("busy" in handle).toBe(false)
  })

  it("a malformed fresh lock is busy with no holder; an old one is reclaimed", () => {
    writeLock("{not json")
    expect(tryAcquireSyncLockSync(root)).toEqual({ busy: true, holderPid: null })
    writeLock(JSON.stringify({ pid: "x" }))
    expect(tryAcquireSyncLockSync(root)).toEqual({ busy: true, holderPid: null })
    const old = new Date(Date.now() - 31_000)
    fs.utimesSync(lockPath(), old, old)
    const handle = tryAcquireSyncLockSync(root)
    expect("busy" in handle).toBe(false)
  })

  it("a lock that disappears between the exclusive create and the read is retried", () => {
    // Lock exists at create time, gone at read time.
    writeLock({ pid: process.ppid, token: "x", procStart: null })
    __testHooks.beforeRead = () => {
      __testHooks.beforeRead = undefined
      fs.rmSync(lockPath(), { force: true })
    }
    expect("busy" in tryAcquireSyncLockSync(root)).toBe(false)
  })

  it("a lock removed while the reclaimer holds the reclaim file is retried", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    let reads = 0
    __testHooks.beforeRead = () => {
      if (++reads === 2) fs.rmSync(lockPath(), { force: true })
    }
    expect("busy" in tryAcquireSyncLockSync(root)).toBe(false)
    expect(fs.existsSync(reclaimPath())).toBe(false)
  })

  it("a proc stat with too few fields gives null procStart", () => {
    __testHooks.readProcStat = () => "1 (a) S"
    __testHooks.readPsStart = () => null
    tryAcquireSyncLockSync(root)
    expect(readLock().procStart).toBeNull()
  })

  it("rethrows a read error that is not a missing file", () => {
    fs.mkdirSync(lockPath())
    expect(() => tryAcquireSyncLockSync(root)).toThrow()
  })

  it("propagates unexpected filesystem errors", () => {
    expect(() => tryAcquireSyncLockSync(path.join(root, "missing"))).toThrow()
  })
})

const backdate = (p: string): void => {
  const old = new Date(Date.now() - 31_000)
  fs.utimesSync(p, old, old)
}
const PROC_STAT = (ticks: string): string => `42 (a) b) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${ticks} 23`

describe("regression: reclaim guard ownership (I1)", () => {
  it("a reclaimer paused past 30 s while holding the guard does not take the lock from the one that cleared its guard", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    let b: unknown
    __testHooks.beforeUnlink = () => {
      __testHooks.beforeUnlink = undefined
      backdate(reclaimPath()) // A has been paused 31 s holding the guard
      b = tryAcquireSyncLockSync(root) // B clears A's guard as stale and reclaims
    }
    const a = tryAcquireSyncLockSync(root)
    const holders = [a, b].filter((r) => !("busy" in (r as object)))
    expect(holders).toHaveLength(1)
    expect("busy" in (a as object)).toBe(true)
    expect(readLock().pid).toBe(process.pid)
    expect(fs.existsSync(reclaimPath())).toBe(false)
  })

  it("two reclaimers racing on a crashed reclaimer's stale guard: at most one holds the lock", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    fs.writeFileSync(reclaimPath(), "crashed-token")
    backdate(reclaimPath())
    let b: unknown
    __testHooks.beforeUnlink = () => {
      __testHooks.beforeUnlink = undefined
      // B judges C's fresh guard stale (emulated by backdating it) and clears it.
      __testHooks.beforeReclaimStat = () => {
        __testHooks.beforeReclaimStat = undefined
        backdate(reclaimPath())
      }
      b = tryAcquireSyncLockSync(root)
    }
    const c = tryAcquireSyncLockSync(root)
    expect([c, b].filter((r) => !("busy" in (r as object)))).toHaveLength(1)
  })

  it("a guard swapped in after it was judged stale is put back, not deleted", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    fs.writeFileSync(reclaimPath(), "old")
    backdate(reclaimPath())
    __testHooks.guardRace = (phase) => {
      if (phase !== "beforeRename") return
      fs.rmSync(reclaimPath())
      fs.writeFileSync(reclaimPath(), "fresh-owner")
    }
    expect(tryAcquireSyncLockSync(root)).toMatchObject({ busy: true })
    expect(fs.readFileSync(reclaimPath(), "utf8")).toBe("fresh-owner")
    expect(fs.readdirSync(path.join(root, ".git")).filter((f) => f.includes(".stale."))).toEqual([])
  })

  it("a guard swapped in and a new one created meanwhile: the moved guard is dropped, the new one kept", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    fs.writeFileSync(reclaimPath(), "old")
    backdate(reclaimPath())
    __testHooks.guardRace = (phase) => {
      if (phase === "beforeRename") {
        fs.rmSync(reclaimPath())
        fs.writeFileSync(reclaimPath(), "fresh-owner")
      } else {
        fs.writeFileSync(reclaimPath(), "newest-owner")
      }
    }
    expect(tryAcquireSyncLockSync(root)).toMatchObject({ busy: true })
    expect(fs.readFileSync(reclaimPath(), "utf8")).toBe("newest-owner")
  })

  it("a guard that disappears before it can be renamed is retried", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    fs.writeFileSync(reclaimPath(), "old")
    backdate(reclaimPath())
    __testHooks.guardRace = (phase) => {
      if (phase === "beforeRename") fs.rmSync(reclaimPath())
    }
    expect("busy" in tryAcquireSyncLockSync(root)).toBe(false)
  })

  it("a guard recreated by another process right after being cleared leaves the caller busy", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    fs.writeFileSync(reclaimPath(), "old")
    backdate(reclaimPath())
    __testHooks.guardRace = (phase) => {
      if (phase === "afterRename") fs.writeFileSync(reclaimPath(), "other-process")
    }
    expect(tryAcquireSyncLockSync(root)).toMatchObject({ busy: true })
    expect(fs.readFileSync(reclaimPath(), "utf8")).toBe("other-process")
  })

  it("a reclaimer whose guard is taken after it created the lock releases it and reports busy", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    __testHooks.beforeUnlink = () => {
      // Pass the pre-unlink check, then lose the guard while the new lock is written.
      __testHooks.beforeLockWrite = () => {
        __testHooks.beforeLockWrite = undefined
        fs.writeFileSync(reclaimPath(), "someone-else")
      }
    }
    expect(tryAcquireSyncLockSync(root)).toMatchObject({ busy: true })
    expect(fs.existsSync(lockPath())).toBe(false)
    expect(fs.readFileSync(reclaimPath(), "utf8")).toBe("someone-else")
  })
})

describe("regression: unknown start time is live (I2)", () => {
  it("a live pid whose /proc entry and ps are unreadable keeps its lock", () => {
    writeLock({ pid: process.ppid, token: "live", procStart: "12345" })
    __testHooks.readProcStat = () => null
    __testHooks.readPsStart = () => null
    expect(tryAcquireSyncLockSync(root)).toEqual({ busy: true, holderPid: process.ppid })
    expect(readLock().token).toBe("live")
  })

  it("an own-pid lock without our token is stale even when the start time is unreadable", () => {
    writeLock({ pid: process.pid, token: "old", procStart: "12345" })
    __testHooks.readProcStat = () => null
    __testHooks.readPsStart = () => null
    expect("busy" in tryAcquireSyncLockSync(root)).toBe(false)
  })
})

describe("portable start time (I3)", () => {
  it("without /proc the start time comes from ps, and a different ps value is stale", () => {
    __testHooks.readProcStat = () => null
    __testHooks.readPsStart = () => "Thu Nov  5 09:00:00 2026"
    const handle = tryAcquireSyncLockSync(root) as { release(): void }
    expect(readLock().procStart).toBe("Thu Nov  5 09:00:00 2026")
    handle.release()
    writeLock({ pid: process.ppid, token: "x", procStart: "Wed Nov  4 01:00:00 2026" })
    expect("busy" in tryAcquireSyncLockSync(root)).toBe(false)
  })

  it("the same ps value keeps the lock live", () => {
    __testHooks.readProcStat = () => null
    __testHooks.readPsStart = () => "Thu Nov  5 09:00:00 2026"
    writeLock({ pid: process.ppid, token: "x", procStart: "Thu Nov  5 09:00:00 2026" })
    expect(tryAcquireSyncLockSync(root)).toEqual({ busy: true, holderPid: process.ppid })
  })

  it("on Linux /proc field 22 is used and ps is not consulted", () => {
    __testHooks.readProcStat = () => PROC_STAT("777")
    __testHooks.readPsStart = () => {
      throw new Error("ps must not run")
    }
    tryAcquireSyncLockSync(root)
    expect(readLock().procStart).toBe("777")
  })

  it("on Linux with /proc unreadable, ps is the fallback", () => {
    __testHooks.readProcStat = () => null
    __testHooks.readPsStart = () => "Thu Nov  5 09:00:00 2026"
    tryAcquireSyncLockSync(root)
    expect(readLock().procStart).toBe("Thu Nov  5 09:00:00 2026")
  })

  it("start times in different formats are unknown, not a mismatch", () => {
    writeLock({ pid: process.ppid, token: "x", procStart: "12345" })
    __testHooks.readProcStat = () => null
    __testHooks.readPsStart = () => "Thu Nov  5 09:00:00 2026"
    expect(tryAcquireSyncLockSync(root)).toEqual({ busy: true, holderPid: process.ppid })
  })

  it("the real ps reports a start time for this process", () => {
    tryAcquireSyncLockSync(root)
    expect(readLock().procStart).toEqual(expect.any(String))
  })

  it("a missing ps binary counts as unknown", () => {
    const oldPath = process.env.PATH
    process.env.PATH = ""
    try {
      __testHooks.readProcStat = () => null
      writeLock({ pid: process.ppid, token: "x", procStart: "Thu Nov  5 09:00:00 2026" })
      expect(tryAcquireSyncLockSync(root)).toEqual({ busy: true, holderPid: process.ppid })
    } finally {
      process.env.PATH = oldPath
    }
  })

  it("a ps that prints nothing counts as unknown", () => {
    __testHooks.readProcStat = () => null
    writeLock({ pid: process.ppid, token: "x", procStart: "Thu Nov  5 09:00:00 2026" })
    const oldPath = process.env.PATH
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-ps-"))
    fs.writeFileSync(path.join(bin, "ps"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    process.env.PATH = bin
    try {
      expect(tryAcquireSyncLockSync(root)).toEqual({ busy: true, holderPid: process.ppid })
    } finally {
      process.env.PATH = oldPath
      fs.rmSync(bin, { recursive: true, force: true })
    }
  })
})

describe("minor fixes", () => {
  it("a non-finite wait is a single attempt", async () => {
    writeLock({ pid: process.ppid, token: "live", procStart: null })
    expect(await acquireSyncLock(root, Number.NaN)).toEqual({ busy: true, holderPid: process.ppid })
  })

  it("busy is reported once per wait, not per poll", async () => {
    writeLock({ pid: process.ppid, token: "live", procStart: null })
    const warns: string[] = []
    const logger = {
      debug() {},
      info() {},
      error() {},
      warn: (e: { event: string }) => void warns.push(e.event),
    }
    setRuntimeLogger(logger as unknown as Logger)
    try {
      await acquireSyncLock(root, 350)
    } finally {
      setRuntimeLogger(null)
    }
    expect(warns).toEqual(["heart.sync_lock_busy"])
  })

  it("a fresh guard reports the live state, not the dead pid, as holder", async () => {
    writeLock({ pid: await exitedPid(), token: "dead", procStart: null })
    fs.writeFileSync(reclaimPath(), "x")
    expect(tryAcquireSyncLockSync(root)).toEqual({ busy: true, holderPid: null })
  })

  it("a failed write leaves no empty lock behind", () => {
    __testHooks.beforeLockWrite = () => {
      throw new Error("ENOSPC")
    }
    expect(() => tryAcquireSyncLockSync(root)).toThrow("ENOSPC")
    expect(fs.existsSync(lockPath())).toBe(false)
  })
})

describe("clearOwnStaleSyncLock", () => {
  it("removes a lock left by this pid from an earlier boot", () => {
    writeLock({ pid: process.pid, token: "old", procStart: null })
    clearOwnStaleSyncLock(root)
    expect(fs.existsSync(lockPath())).toBe(false)
  })

  it("keeps a lock this process holds, another pid's lock, an unreadable lock and a missing lock", () => {
    const handle = tryAcquireSyncLockSync(root) as { release(): void }
    clearOwnStaleSyncLock(root)
    expect(fs.existsSync(lockPath())).toBe(true)
    handle.release()
    writeLock({ pid: process.ppid, token: "x", procStart: null })
    clearOwnStaleSyncLock(root)
    expect(fs.existsSync(lockPath())).toBe(true)
    writeLock("garbage")
    clearOwnStaleSyncLock(root)
    expect(fs.existsSync(lockPath())).toBe(true)
    fs.rmSync(lockPath())
    clearOwnStaleSyncLock(root)
  })
})
