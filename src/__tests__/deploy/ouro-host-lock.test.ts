// The host lock that keeps eval runs and the Butler's upgrade and rollback apart on a shared Docker host (#1760).
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

const SCRIPT = path.resolve(__dirname, "../../../deploy/unraid/ouro-host-lock.mjs")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lock: any
beforeAll(async () => { lock = await import(/* @vite-ignore */ SCRIPT) })

let root = ""
let dir = ""
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "host-lock-test-"))
  dir = path.join(root, "ouro-host.d")
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const T0 = Date.parse("2026-11-23T12:00:00Z")
const io = (extra: Record<string, unknown> = {}) => ({ now: () => T0, host: "sanctuary", alive: () => true, ...extra })
const owner = () => JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"))

describe("tryAcquire", () => {
  it("takes a free lock and writes its holder, pid, host and expiry inside it", () => {
    const got = lock.tryAcquire(dir, { holder: "eval minimax", ttlMs: 60_000, pid: 4242 }, io())
    expect(got).toEqual({ acquired: true, token: expect.stringMatching(/^[0-9a-f]{32}$/), owner: expect.any(Object) })
    expect(owner()).toEqual({ holder: "eval minimax", token: got.token, pid: 4242, host: "sanctuary", acquiredAt: "2026-11-23T12:00:00.000Z", expiresAt: "2026-11-23T12:01:00.000Z" })
    expect(fs.existsSync(`${dir}.guard`)).toBe(false)
  })

  it("leaves a held lock alone and names its holder", () => {
    const first = lock.tryAcquire(dir, { holder: "butler:ship 0.1.0-alpha.1000", ttlMs: 60_000, pid: null }, io())
    const second = lock.tryAcquire(dir, { holder: "eval minimax", ttlMs: 60_000, pid: 1 }, io())
    expect(second).toEqual({ acquired: false, owner: expect.objectContaining({ holder: "butler:ship 0.1.0-alpha.1000", token: first.token }) })
    expect(lock.describeOwner(second.owner)).toBe("butler:ship 0.1.0-alpha.1000 (on sanctuary) until 2026-11-23T12:01:00.000Z")
    expect(owner().token).toBe(first.token)
  })

  it("breaks a lock whose expiry has passed, and says whose it was", () => {
    const old = lock.tryAcquire(dir, { holder: "eval gpt", ttlMs: 60_000, pid: null }, io())
    const got = lock.tryAcquire(dir, { holder: "butler:ship", ttlMs: 60_000, pid: null }, io({ now: () => T0 + 60_000 }))
    expect(got).toEqual(expect.objectContaining({ acquired: true, broke: expect.objectContaining({ token: old.token }), staleBecause: "it expired at 2026-11-23T12:01:00.000Z" }))
    expect(owner().holder).toBe("butler:ship")
  })

  it("breaks a lock whose holding process on this host has died, before its expiry", () => {
    lock.tryAcquire(dir, { holder: "eval opus", ttlMs: 3_600_000, pid: 777 }, io())
    const busy = lock.tryAcquire(dir, { holder: "butler:ship", ttlMs: 60_000, pid: null }, io({ alive: (pid: number) => pid !== 777 }))
    expect(busy).toEqual(expect.objectContaining({ acquired: true, staleBecause: "its process 777 on sanctuary is gone" }))
  })

  it("does not judge a process on another host by this host's process table", () => {
    lock.tryAcquire(dir, { holder: "eval opus", ttlMs: 3_600_000, pid: 777 }, io({ host: "elsewhere" }))
    expect(lock.tryAcquire(dir, { holder: "butler:ship", ttlMs: 60_000, pid: null }, io({ alive: () => false })).acquired).toBe(false)
  })

  it("breaks a lock whose owner file is unreadable once it is older than the grace, and not before", () => {
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, "owner.json"), "{half")
    const made = fs.statSync(dir).mtimeMs
    expect(lock.tryAcquire(dir, { holder: "a", ttlMs: 1000, pid: null }, io({ now: () => made + 1000 })).acquired).toBe(false)
    const got = lock.tryAcquire(dir, { holder: "a", ttlMs: 1000, pid: null }, io({ now: () => made + lock.UNWRITTEN_GRACE_MS + 1 }))
    expect(got).toEqual(expect.objectContaining({ acquired: true, staleBecause: expect.stringMatching(/no readable owner/) }))
  })

  it("lets the holder of a live token adopt it with its own pid and a fresh expiry, and no one else", () => {
    const ship = lock.tryAcquire(dir, { holder: "butler:ship 1.0.0", ttlMs: 60_000, pid: null }, io())
    const other = lock.tryAcquire(dir, { holder: "butler upgrade", ttlMs: 600_000, pid: 99, adopt: "f".repeat(32) }, io())
    expect(other.acquired).toBe(false)
    const got = lock.tryAcquire(dir, { holder: "butler upgrade 1.0.0", ttlMs: 600_000, pid: 99, adopt: ship.token }, io({ now: () => T0 + 1000 }))
    expect(got).toEqual(expect.objectContaining({ acquired: true, token: ship.token, adopted: true }))
    expect(owner()).toEqual(expect.objectContaining({ holder: "butler upgrade 1.0.0", token: ship.token, pid: 99, expiresAt: "2026-11-23T12:10:01.000Z" }))
    expect(lock.heldBy(dir, ship.token, io({ alive: (pid: number) => pid !== 99 }))).toBe(false)
  })

  it("takes a fresh lock when the token to adopt is no longer the live holder", () => {
    const ship = lock.tryAcquire(dir, { holder: "butler:ship", ttlMs: 60_000, pid: null }, io())
    const got = lock.tryAcquire(dir, { holder: "butler upgrade", ttlMs: 60_000, pid: 99, adopt: ship.token }, io({ now: () => T0 + 60_000 }))
    expect(got).toEqual(expect.objectContaining({ acquired: true, staleBecause: expect.stringMatching(/expired/) }))
    expect(got.token).not.toBe(ship.token)
  })

  it("breaks a stale guard only if it is still the guard it judged stale", () => {
    fs.mkdirSync(`${dir}.guard`)
    const old = new Date(Date.now() - lock.GUARD_STALE_MS - 5_000)
    fs.utimesSync(`${dir}.guard`, old, old)
    let swapped = false
    // Another breaker wins the race: it removes the stale guard and takes a fresh one before this one acts.
    const beforeBreak = () => { if (!swapped) { swapped = true; fs.rmdirSync(`${dir}.guard`); fs.mkdirSync(`${dir}.guard`) } }
    expect(() => lock.tryAcquire(dir, { holder: "a", ttlMs: 1000, pid: null }, { host: "sanctuary", alive: () => true, guardWaitMs: 50, beforeBreak })).toThrow(/guard .* is busy/)
    expect(swapped).toBe(true)
    expect(fs.existsSync(`${dir}.guard`)).toBe(true)
    expect(fs.readdirSync(root).filter((f) => f.includes("broken"))).toEqual([])
  })

  it("breaks a guard left behind by a process that died inside it, and waits on a fresh one", () => {
    fs.mkdirSync(`${dir}.guard`)
    const made = fs.statSync(`${dir}.guard`).mtimeMs
    expect(() => lock.tryAcquire(dir, { holder: "a", ttlMs: 1000, pid: null }, io({ now: () => made, guardWaitMs: 20 }))).toThrow(/guard .* is busy/)
    expect(lock.tryAcquire(dir, { holder: "a", ttlMs: 1000, pid: null }, io({ now: () => made + lock.GUARD_STALE_MS + 1 })).acquired).toBe(true)
  })
})

describe("release, heldBy and blocker", () => {
  it("releases only for the token that holds it", () => {
    const got = lock.tryAcquire(dir, { holder: "eval", ttlMs: 60_000, pid: null }, io())
    expect(lock.release(dir, "not-it", io())).toBe(false)
    expect(fs.existsSync(dir)).toBe(true)
    expect(lock.release(dir, got.token, io())).toBe(true)
    expect(fs.existsSync(dir)).toBe(false)
    expect(lock.release(dir, got.token, io())).toBe(false)
  })

  it("says whether a token holds a live lock", () => {
    const got = lock.tryAcquire(dir, { holder: "eval", ttlMs: 60_000, pid: null }, io())
    expect(lock.heldBy(dir, got.token, io())).toBe(true)
    expect(lock.heldBy(dir, "other", io())).toBe(false)
    expect(lock.heldBy(dir, got.token, io({ now: () => T0 + 60_000 }))).toBe(false)
    expect(lock.heldBy(path.join(root, "none"), got.token, io())).toBe(false)
  })

  it("names the live holder that is not the given token, and nobody for a free, own or stale lock", () => {
    expect(lock.blocker(dir, undefined, io())).toBeNull()
    const got = lock.tryAcquire(dir, { holder: "eval", ttlMs: 60_000, pid: null }, io())
    expect(lock.blocker(dir, undefined, io())).toEqual(expect.objectContaining({ holder: "eval" }))
    expect(lock.blocker(dir, got.token, io())).toBeNull()
    expect(lock.blocker(dir, undefined, io({ now: () => T0 + 60_000 }))).toBeNull()
  })
})

// The command line, as the eval (hold) and butler:ship (acquire, release) run it over ssh.
function cli(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, OURO_HOST_LOCK_DIR: dir, ...env }, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  let err = ""
  child.stdout.setEncoding("utf8").on("data", (c: string) => { out += c })
  child.stderr.setEncoding("utf8").on("data", (c: string) => { err += c })
  const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)))
  const line = (pattern: RegExp) => new Promise<string>((resolve, reject) => {
    const check = () => { const m = pattern.exec(out); if (m) resolve(m[0]) }
    child.stdout.on("data", check)
    void exited.then(() => { check(); reject(new Error(`exited before ${pattern}: ${out} ${err}`)) })
  })
  return { child, exited, line, out: () => out, err: () => err }
}

describe("command line", () => {
  it("acquire prints the token; a second acquire with no wait reports the holder and exits 3; release frees it", async () => {
    const a = cli(["acquire", "--holder", "butler:ship 1.0.0", "--ttl", "600"])
    expect(await a.exited).toBe(0)
    const token = /@@LOCK acquired ([0-9a-f]{32})/.exec(a.out())![1]!
    const b = cli(["acquire", "--holder", "eval", "--ttl", "600", "--wait", "0"])
    expect(await b.exited).toBe(3)
    expect(b.out()).toMatch(/@@LOCK held butler:ship 1\.0\.0 \(on .+\) until /)
    const c = cli(["check", "--token", token])
    expect(await c.exited).toBe(0)
    const r = cli(["release", "--token", token])
    expect(await r.exited).toBe(0)
    expect(r.out()).toMatch(/@@LOCK released/)
    expect(fs.existsSync(dir)).toBe(false)
    const d = cli(["check", "--token", token])
    expect(await d.exited).toBe(1)
  })

  it("hold keeps the lock with its own pid until its stdin closes, then releases it", async () => {
    const h = cli(["hold", "--holder", "eval minimax", "--ttl", "600"])
    const token = (await h.line(/@@LOCK acquired [0-9a-f]{32}/)).split(" ")[2]
    expect(owner()).toEqual(expect.objectContaining({ holder: "eval minimax", token, pid: h.child.pid }))
    h.child.stdin.end()
    expect(await h.exited).toBe(0)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it("hold stops waiting when its session ends before the lock frees", async () => {
    const a = cli(["acquire", "--holder", "butler:ship", "--ttl", "600"])
    await a.exited
    const h = cli(["hold", "--holder", "eval", "--ttl", "600", "--wait", "30"], { OURO_HOST_LOCK_POLL_MS: "50" })
    await h.line(/@@LOCK waiting butler:ship/)
    h.child.stdin.end()
    expect(await h.exited).toBe(3)
    expect(owner().holder).toBe("butler:ship")
  })

  it("hold releases on SIGTERM too", async () => {
    const h = cli(["hold", "--holder", "eval", "--ttl", "600"])
    await h.line(/@@LOCK acquired/)
    h.child.kill("SIGTERM")
    await h.exited
    expect(fs.existsSync(dir)).toBe(false)
  })

  it("waits for a held lock up to --wait, and takes it when it frees", async () => {
    const a = cli(["acquire", "--holder", "butler:ship", "--ttl", "600"])
    await a.exited
    const token = /@@LOCK acquired ([0-9a-f]{32})/.exec(a.out())![1]!
    const h = cli(["hold", "--holder", "eval", "--ttl", "600", "--wait", "30"], { OURO_HOST_LOCK_POLL_MS: "50" })
    await h.line(/@@LOCK waiting butler:ship/)
    await cli(["release", "--token", token]).exited
    await h.line(/@@LOCK acquired/)
    h.child.stdin.end()
    expect(await h.exited).toBe(0)
  })

  it("refuses a command it does not know, and a missing holder or ttl", async () => {
    expect(await cli(["grab"]).exited).toBe(2)
    expect(await cli(["acquire", "--ttl", "5"]).exited).toBe(2)
    expect(await cli(["acquire", "--holder", "x"]).exited).toBe(2)
    expect(await cli(["release"]).exited).toBe(2)
  })
})
