import { spawn, type ChildProcess } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
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
