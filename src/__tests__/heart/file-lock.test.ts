import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withFileLock } from "../../heart/file-lock"

let dir = ""
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-")) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe("withFileLock", () => {
  it("runs one holder at a time and releases the lock afterwards, even when the holder throws", async () => {
    const order: string[] = []
    const hold = (label: string) => withFileLock(dir, "x", async () => {
      order.push(`${label}:start`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push(`${label}:end`)
      return label
    }, { pollMs: 2 })
    expect(await Promise.all([hold("a"), hold("b")])).toEqual(["a", "b"])
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"])
    await expect(withFileLock(dir, "x", () => { throw new Error("boom") })).rejects.toThrow("boom")
    expect(fs.existsSync(path.join(dir, "x.lock"))).toBe(false)
  })

  it("breaks a lock whose holder died", async () => {
    const lock = path.join(dir, "y.lock")
    fs.mkdirSync(lock)
    const old = new Date(Date.now() - 10_000)
    fs.utimesSync(lock, old, old)
    expect(await withFileLock(dir, "y", () => "ok", { staleMs: 1_000 })).toBe("ok")
  })

  it("lets only one of several waiters break the same stale lock, and leaves no debris", async () => {
    const lock = path.join(dir, "w.lock")
    fs.mkdirSync(lock)
    const old = new Date(Date.now() - 10_000)
    fs.utimesSync(lock, old, old)
    const running: number[] = []
    let overlap = 0
    const hold = () => withFileLock(dir, "w", async () => {
      running.push(1)
      overlap = Math.max(overlap, running.length)
      await new Promise((resolve) => setTimeout(resolve, 10))
      running.pop()
    }, { staleMs: 1_000, pollMs: 2 })
    await Promise.all([hold(), hold(), hold(), hold()])
    expect(overlap).toBe(1)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it("gives up on a lock that stays busy", async () => {
    fs.mkdirSync(path.join(dir, "z.lock"))
    await expect(withFileLock(dir, "z", () => "never", { waitMs: 20, pollMs: 5 })).rejects.toThrow("timed out waiting for the z lock")
  })

  it("surfaces an error that is not contention", async () => {
    await expect(withFileLock(dir, "missing/parent", () => "never")).rejects.toThrow(/ENOENT/u)
  })
})
