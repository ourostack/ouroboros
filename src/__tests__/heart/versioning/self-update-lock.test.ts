import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  SELF_UPDATE_LOCK_MAX_AGE_MS,
  acquireSelfUpdateLock,
  isSelfUpdateLockHeld,
  selfUpdateLockPath,
} from "../../../heart/versioning/self-update-lock"

const NOW = Date.parse("2026-11-27T22:00:00.000Z")

let cliHome: string

beforeEach(() => {
  cliHome = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-self-update-lock-"))
})

afterEach(() => {
  fs.rmSync(cliHome, { recursive: true, force: true })
})

function lockHeldBy(pid: number, ageMs = 0): void {
  fs.writeFileSync(selfUpdateLockPath(cliHome), `${pid}\n`)
  const writtenAt = new Date(NOW - ageMs)
  fs.utimesSync(selfUpdateLockPath(cliHome), writtenAt, writtenAt)
}

const alive = (pids: number[]) => (pid: number) => pids.includes(pid)

describe("self-update lock", () => {
  it("lets one process hold it at a time and frees it on release", () => {
    const first = acquireSelfUpdateLock(cliHome, { pid: 100, isPidAlive: alive([100, 200]), now: () => NOW })
    expect(first).not.toBeNull()
    expect(acquireSelfUpdateLock(cliHome, { pid: 200, isPidAlive: alive([100, 200]), now: () => NOW })).toBeNull()

    first!()

    expect(fs.existsSync(selfUpdateLockPath(cliHome))).toBe(false)
    expect(acquireSelfUpdateLock(cliHome, { pid: 200, isPidAlive: alive([100, 200]), now: () => NOW })).not.toBeNull()
  })

  it("takes over a lock whose owner crashed", () => {
    lockHeldBy(100)

    const release = acquireSelfUpdateLock(cliHome, { pid: 200, isPidAlive: alive([200]), now: () => NOW })

    expect(release).not.toBeNull()
    expect(fs.readFileSync(selfUpdateLockPath(cliHome), "utf8")).toBe("200\n")
  })

  it("takes over a lock older than any pass, even when its pid now belongs to another process", () => {
    lockHeldBy(100, SELF_UPDATE_LOCK_MAX_AGE_MS + 1)

    expect(acquireSelfUpdateLock(cliHome, { pid: 200, isPidAlive: alive([100, 200]), now: () => NOW })).not.toBeNull()
  })

  it("keeps a lock a live owner took recently, however long its install runs", () => {
    lockHeldBy(100, SELF_UPDATE_LOCK_MAX_AGE_MS - 1)

    expect(acquireSelfUpdateLock(cliHome, { pid: 200, isPidAlive: alive([100, 200]), now: () => NOW })).toBeNull()
  })

  it("does not remove a lock another process took over after this one went stale", () => {
    const stale = acquireSelfUpdateLock(cliHome, { pid: 100, isPidAlive: alive([100]), now: () => NOW })
    lockHeldBy(200)

    stale!()

    expect(fs.readFileSync(selfUpdateLockPath(cliHome), "utf8")).toBe("200\n")
  })

  it("reports the lock held only when another live process owns it", () => {
    const deps = { pid: 100, isPidAlive: alive([100, 200]), now: () => NOW }
    expect(isSelfUpdateLockHeld(cliHome, deps)).toBe(false)

    lockHeldBy(100)
    expect(isSelfUpdateLockHeld(cliHome, deps)).toBe(false)

    lockHeldBy(200)
    expect(isSelfUpdateLockHeld(cliHome, deps)).toBe(true)

    lockHeldBy(300)
    expect(isSelfUpdateLockHeld(cliHome, deps)).toBe(false)

    fs.writeFileSync(selfUpdateLockPath(cliHome), "not a pid\n")
    expect(isSelfUpdateLockHeld(cliHome, deps)).toBe(false)
  })

  it("uses this process and the real clock by default", () => {
    // No process on this machine has a pid this high, so the lock it names is stale.
    fs.writeFileSync(selfUpdateLockPath(cliHome), "99999999\n")
    expect(isSelfUpdateLockHeld(cliHome)).toBe(false)

    const release = acquireSelfUpdateLock(cliHome)

    expect(fs.readFileSync(selfUpdateLockPath(cliHome), "utf8")).toBe(`${process.pid}\n`)
    expect(isSelfUpdateLockHeld(cliHome)).toBe(false)
    release!()
  })

  it("creates the CLI home when it is missing", () => {
    const missing = path.join(cliHome, "nested", ".ouro-cli")

    expect(acquireSelfUpdateLock(missing, { pid: 100, isPidAlive: alive([100]), now: () => NOW })).not.toBeNull()
    expect(fs.existsSync(selfUpdateLockPath(missing))).toBe(true)
  })
})
