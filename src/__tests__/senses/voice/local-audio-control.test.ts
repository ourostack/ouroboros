import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  LocalAudioControlServer,
  acquireJoinLock,
  inspectActiveJoin,
  localAudioPaths,
  readJoinStatus,
  sendLocalAudioControl,
  stopLockHolder,
  lockOwnerAlive,
  writeJoinStatus,
} from "../../../senses/voice/local-audio-control"

let root: string
const servers: LocalAudioControlServer[] = []
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "lac-")) })
afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function handler(overrides: Partial<{ status: () => unknown; leave: () => Promise<void> }> = {}) {
  const calls: string[] = []
  return {
    calls,
    handler: {
      status: overrides.status ?? (() => ({ state: "joined", callSid: "local-audio-abc" })),
      leave: overrides.leave ?? (async () => { calls.push("leave") }),
    } as never,
  }
}

describe("localAudioPaths", () => {
  it("keeps everything under the agent's local-audio state directory", () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    expect(paths.dir).toBe(path.join(root, "slugger.ouro", "state", "voice", "local-audio"))
    expect(paths.socketPath).toBe(path.join(paths.dir, "control.sock"))
    expect(paths.pidFile).toBe(path.join(paths.dir, "join.pid"))
    expect(paths.statusFile).toBe(path.join(paths.dir, "status.json"))
    expect(paths.soxPidFile).toBe(path.join(paths.dir, "sox.pids"))
    expect(paths.callsDir).toBe(path.join(paths.dir, "calls"))
    expect(paths.logFile).toBe(path.join(paths.dir, "join.log"))
    expect(paths.lockFile).toBe(path.join(paths.dir, "join.lock"))
  })

  it("moves the socket to a short private path when the bundle path is too long for a unix socket", () => {
    const long = path.join(root, "x".repeat(120), "slugger.ouro")
    const paths = localAudioPaths(long)
    expect(paths.socketPath.length).toBeLessThan(100)
    expect(paths.socketPath.startsWith(os.tmpdir())).toBe(true)
    expect(localAudioPaths(long).socketPath).toBe(paths.socketPath)
  })
})

describe("LocalAudioControlServer and client", () => {
  it("answers status and leave over a private unix socket and writes its pid file", async () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    const h = handler()
    const server = new LocalAudioControlServer(paths, h.handler)
    servers.push(server)
    await server.start()
    expect(fs.statSync(paths.socketPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(paths.dir).mode & 0o777).toBe(0o700)
    expect(JSON.parse(fs.readFileSync(paths.pidFile, "utf8")).pid).toBe(process.pid)
    expect(await sendLocalAudioControl(paths, "status")).toEqual({ ok: true, status: { state: "joined", callSid: "local-audio-abc" } })
    expect(await sendLocalAudioControl(paths, "leave")).toEqual({ ok: true, status: { state: "joined", callSid: "local-audio-abc" } })
    expect(h.calls).toEqual(["leave"])
    await server.close()
    expect(fs.existsSync(paths.socketPath)).toBe(false)
    expect(fs.existsSync(paths.pidFile)).toBe(false)
  })

  it("rejects unknown commands, junk and oversize input", async () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    const server = new LocalAudioControlServer(paths, handler().handler)
    servers.push(server)
    await server.start()
    const raw = (text: string) => new Promise<string>((resolve) => {
      const socket = net.createConnection(paths.socketPath, () => socket.write(text))
      let out = ""
      socket.on("data", (d) => { out += d.toString() })
      socket.on("close", () => resolve(out))
    })
    expect(JSON.parse(await raw('{"cmd":"format-disk"}\n'))).toEqual({ ok: false, error: "unknown command" })
    expect(JSON.parse(await raw("not json\n"))).toEqual({ ok: false, error: "invalid request" })
    expect(JSON.parse(await raw(`${"x".repeat(5000)}\n`))).toEqual({ ok: false, error: "request too large" })
  })

  it("reports a failing leave handler to the client", async () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    const server = new LocalAudioControlServer(paths, handler({ leave: async () => { throw new Error("stuck") } }).handler)
    servers.push(server)
    await server.start()
    expect(await sendLocalAudioControl(paths, "leave")).toEqual({ ok: false, error: "stuck" })
  })

  it("replaces a stale socket file left by a crashed process", async () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    fs.mkdirSync(paths.dir, { recursive: true })
    fs.writeFileSync(paths.socketPath, "stale")
    const server = new LocalAudioControlServer(paths, handler().handler)
    servers.push(server)
    await server.start()
    expect((await sendLocalAudioControl(paths, "status")).ok).toBe(true)
  })

  it("the client fails fast when nothing is listening", async () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    expect(await sendLocalAudioControl(paths, "status")).toEqual({ ok: false, code: "unreachable", error: "no local audio session is running" })
    fs.mkdirSync(paths.dir, { recursive: true })
    fs.writeFileSync(paths.socketPath, "stale")
    expect((await sendLocalAudioControl(paths, "leave")).ok).toBe(false)
  })

  it("the client gives up on a server that never answers", async () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    fs.mkdirSync(paths.dir, { recursive: true })
    const silent = net.createServer(() => undefined)
    await new Promise<void>((resolve) => silent.listen(paths.socketPath, resolve))
    const result = await sendLocalAudioControl(paths, "status", 50)
    silent.close()
    expect(result).toEqual({ ok: false, code: "timeout", error: "local audio session did not answer in time" })
  })
})

describe("inspectActiveJoin", () => {
  it("returns the live status, or cleans up leftovers only when the socket is truly unreachable", async () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    expect(await inspectActiveJoin(paths)).toBeNull()
    const server = new LocalAudioControlServer(paths, handler().handler)
    servers.push(server)
    await server.start()
    expect(await inspectActiveJoin(paths)).toMatchObject({ callSid: "local-audio-abc" })
    await server.close()
    fs.mkdirSync(paths.dir, { recursive: true })
    fs.writeFileSync(paths.pidFile, "{}")
    fs.writeFileSync(paths.socketPath, "stale")
    expect(await inspectActiveJoin(paths)).toBeNull()
    expect(fs.existsSync(paths.pidFile)).toBe(false)
    expect(fs.existsSync(paths.socketPath)).toBe(false)
  })

  it("never deletes the socket or pid file of a session that is slow to answer", async () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    fs.mkdirSync(paths.dir, { recursive: true })
    const open: net.Socket[] = []
    const silent = net.createServer((socket) => { open.push(socket) })
    await new Promise<void>((resolve) => silent.listen(paths.socketPath, resolve))
    fs.writeFileSync(paths.pidFile, "{}")
    const result = await inspectActiveJoin(paths, 40)
    const kept = [fs.existsSync(paths.pidFile), fs.existsSync(paths.socketPath)]
    open.forEach((socket) => socket.destroy())
    await new Promise<void>((resolve) => silent.close(() => resolve()))
    expect(result).toBeNull()
    expect(kept).toEqual([true, true])
  })

  it("reports a starting session while a live process holds the join lock, and leaves its files alone", async () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    const lock = acquireJoinLock(paths)
    expect(lock.ok).toBe(true)
    fs.writeFileSync(paths.pidFile, "{}")
    fs.writeFileSync(paths.socketPath, "not yet listening")
    expect(await inspectActiveJoin(paths)).toMatchObject({ state: "starting" })
    expect(fs.existsSync(paths.pidFile)).toBe(true)
    expect(fs.existsSync(paths.socketPath)).toBe(true)
    if (lock.ok) lock.release()
  })
})

describe("unreachable versus unreadable sockets", () => {
  it("does not call a socket it may not open 'unreachable', so inspect leaves its files alone", async () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    const server = new LocalAudioControlServer(paths, handler().handler)
    servers.push(server)
    await server.start()
    fs.chmodSync(paths.socketPath, 0o000)
    const reply = await sendLocalAudioControl(paths, "status")
    expect(reply).toMatchObject({ ok: false, code: "protocol", error: expect.stringContaining("EACCES") })
    expect(await inspectActiveJoin(paths)).toBeNull()
    expect(fs.existsSync(paths.socketPath)).toBe(true)
    expect(fs.existsSync(paths.pidFile)).toBe(true)
    fs.chmodSync(paths.socketPath, 0o600)
  })
})

describe("acquireJoinLock", () => {
  it("treats a lock whose pid is not a number as unreadable, and refuses to guess at other open errors", () => {
    const p = localAudioPaths(path.join(root, "slugger.ouro"))
    fs.mkdirSync(p.dir, { recursive: true })
    fs.writeFileSync(p.lockFile, JSON.stringify({ pid: "abc" }))
    expect(acquireJoinLock(p, 777)).toEqual({ ok: false, holderPid: undefined })
    expect(() => acquireJoinLock({ ...p, lockFile: path.join(root, "missing", "join.lock") }, 777)).toThrow(/ENOENT/)
  })

  const paths = () => localAudioPaths(path.join(root, "slugger.ouro"))

  it("is exclusive: a second acquire is refused with the holder's pid, and release frees it", () => {
    const first = acquireJoinLock(paths(), process.pid)
    expect(first.ok).toBe(true)
    expect(fs.statSync(paths().lockFile).mode & 0o777).toBe(0o600)
    expect(acquireJoinLock(paths(), 99999)).toEqual({ ok: false, holderPid: process.pid })
    if (first.ok) first.release()
    expect(fs.existsSync(paths().lockFile)).toBe(false)
    const again = acquireJoinLock(paths(), 99999, () => true)
    expect(again.ok).toBe(true)
  })

  it("reclaims a lock whose holder is dead", () => {
    fs.mkdirSync(paths().dir, { recursive: true })
    fs.writeFileSync(paths().lockFile, JSON.stringify({ pid: 4242, startedAt: "x" }))
    const result = acquireJoinLock(paths(), 777, (pid) => pid !== 4242)
    expect(result.ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(paths().lockFile, "utf8")).pid).toBe(777)
    expect(fs.readdirSync(paths().dir).filter((f) => f.includes("claim"))).toEqual([])
  })

  it("treats an unreadable fresh lock as held, and an old unreadable one as stale", () => {
    fs.mkdirSync(paths().dir, { recursive: true })
    fs.writeFileSync(paths().lockFile, "")
    expect(acquireJoinLock(paths(), 777)).toEqual({ ok: false, holderPid: undefined })
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(paths().lockFile, old, old)
    expect(acquireJoinLock(paths(), 777).ok).toBe(true)
  })

  it("does not delete a lock somebody else took after we judged the old one stale", () => {
    fs.mkdirSync(paths().dir, { recursive: true })
    fs.writeFileSync(paths().lockFile, JSON.stringify({ pid: 4242, startedAt: "x" }))
    let swapped = false
    const result = acquireJoinLock(paths(), 777, (pid) => {
      if (pid === 4242 && !swapped) {
        // Another process reclaims in between: the lock now belongs to pid 888.
        swapped = true
        fs.writeFileSync(paths().lockFile, JSON.stringify({ pid: 888, startedAt: "y" }))
        return false
      }
      return pid === 888
    })
    expect(result).toEqual({ ok: false, holderPid: 888 })
    expect(JSON.parse(fs.readFileSync(paths().lockFile, "utf8")).pid).toBe(888)
  })

  it("release only removes a lock this process still owns", () => {
    const lock = acquireJoinLock(paths(), 555)
    fs.writeFileSync(paths().lockFile, JSON.stringify({ pid: 556, startedAt: "z" }))
    if (lock.ok) lock.release()
    expect(fs.existsSync(paths().lockFile)).toBe(true)
  })

  it("keeps going when the stale lock vanishes while it is being reclaimed", () => {
    fs.mkdirSync(paths().dir, { recursive: true })
    fs.writeFileSync(paths().lockFile, JSON.stringify({ pid: 4242, startedAt: "x" }))
    const result = acquireJoinLock(paths(), 777, () => { fs.rmSync(paths().lockFile, { force: true }); return false })
    expect(result.ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(paths().lockFile, "utf8")).pid).toBe(777)
  })

  it("uses real process liveness by default", () => {
    fs.mkdirSync(paths().dir, { recursive: true })
    fs.writeFileSync(paths().lockFile, JSON.stringify({ pid: 2147483646, startedAt: "x" }))
    expect(acquireJoinLock(paths()).ok).toBe(true)
  })
})

describe("one request per connection", () => {
  it("handles a newline-terminated request exactly once even if more bytes arrive", async () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    // A slow leave keeps the connection open, so the extra bytes reach the server after it answered.
    const leaves: string[] = []
    const h = handler({ leave: async () => { leaves.push("leave"); await new Promise((resolve) => setTimeout(resolve, 150)) } })
    const server = new LocalAudioControlServer(paths, h.handler)
    servers.push(server)
    await server.start()
    const socket = net.createConnection(paths.socketPath)
    let body = ""
    socket.on("data", (c) => { body += c.toString() })
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
    socket.on("error", () => undefined)
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
    socket.write('{"cmd":"leave"}\n')
    await new Promise((resolve) => setTimeout(resolve, 30))
    socket.write("x")
    socket.write("y\n")
    await closed
    expect(leaves).toEqual(["leave"])
    expect(body.trim().split("\n")).toHaveLength(1)
  })
})

describe("join status file", () => {
  it("round-trips and tolerates a missing or corrupt file", () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    expect(readJoinStatus(paths)).toBeNull()
    writeJoinStatus(paths, { state: "failed", reason: "BlackHole 2ch is muted" })
    expect(readJoinStatus(paths)).toMatchObject({ state: "failed", reason: "BlackHole 2ch is muted" })
    fs.writeFileSync(paths.statusFile, "{")
    expect(readJoinStatus(paths)).toBeNull()
  })
})

describe("control socket resilience", () => {
  it("survives a socket error, and a request split across writes", async () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    const server = new LocalAudioControlServer(paths, handler().handler)
    servers.push(server)
    await server.start()
    const flaky = new (await import("events")).EventEmitter()
    ;(server as unknown as { serve: (socket: unknown) => void }).serve(flaky)
    expect(() => flaky.emit("error", new Error("ECONNRESET"))).not.toThrow()
    const split = net.createConnection(paths.socketPath)
    let body = ""
    split.on("data", (chunk) => { body += chunk.toString() })
    await new Promise<void>((resolve) => split.once("connect", () => resolve()))
    split.write('{"cmd":')
    await new Promise((resolve) => setTimeout(resolve, 30))
    split.write('"status"}\n')
    await new Promise<void>((resolve) => split.once("end", () => resolve()))
    expect(JSON.parse(body.trim())).toMatchObject({ ok: true })
  })

  it("reports a handler that fails with something that is not an Error", async () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    const server = new LocalAudioControlServer(paths, handler({ leave: async () => { throw "plain failure" } }).handler)
    servers.push(server)
    await server.start()
    expect(await sendLocalAudioControl(paths, "leave")).toEqual({ ok: false, error: "plain failure" })
  })

  it("reports a reply that is not JSON", async () => {
    const paths = localAudioPaths(path.join(root, "slugger.ouro"))
    fs.mkdirSync(paths.dir, { recursive: true })
    const rogue = net.createServer((socket) => { socket.on("data", () => socket.end("not json\n")) })
    await new Promise<void>((resolve) => rogue.listen(paths.socketPath, resolve))
    const reply = await sendLocalAudioControl(paths, "status")
    await new Promise<void>((resolve) => rogue.close(() => resolve()))
    expect(reply).toEqual({ ok: false, code: "protocol", error: "local audio session sent an unreadable reply" })
  })
})

describe("lockOwnerAlive", () => {
  it("is false for a dead pid or one we may not signal, and checks a recorded start time", () => {
    expect(lockOwnerAlive(2147483646)).toBe(false)
    expect(lockOwnerAlive(1)).toBe(false)
    expect(lockOwnerAlive(process.pid)).toBe(true)
    expect(lockOwnerAlive(process.pid, "Fri Oct  9 11:59:46 2026", () => ({ startTime: "Fri Oct  9 11:59:46 2026" }))).toBe(true)
    expect(lockOwnerAlive(process.pid, "Fri Oct  9 11:59:46 2026", () => ({ startTime: "Sat Oct 10 08:00:00 2026" }))).toBe(false)
    expect(lockOwnerAlive(process.pid, "Fri Oct  9 11:59:46 2026", () => null)).toBe(false)
  })

  it("matches this process's real start time as written by acquireJoinLock", () => {
    const p = localAudioPaths(path.join(root, "slugger.ouro"))
    const lock = acquireJoinLock(p)
    const record = JSON.parse(fs.readFileSync(p.lockFile, "utf8")) as { pid: number; startTime?: string }
    expect(record.pid).toBe(process.pid)
    expect(record.startTime).toEqual(expect.any(String))
    expect(lockOwnerAlive(record.pid, record.startTime)).toBe(true)
    if (lock.ok) lock.release()
  })
})

describe("stopLockHolder", () => {
  const paths = () => localAudioPaths(path.join(root, "slugger.ouro"))
  it("signals a live holder, and does nothing for no lock, our own pid, or a dead holder", () => {
    const kill = vi.fn()
    expect(stopLockHolder(paths(), kill)).toBeNull()
    fs.mkdirSync(paths().dir, { recursive: true })
    fs.writeFileSync(paths().lockFile, JSON.stringify({ pid: process.pid, startedAt: "x" }))
    expect(stopLockHolder(paths(), kill)).toBeNull()
    fs.writeFileSync(paths().lockFile, JSON.stringify({ pid: 2147483646, startedAt: "x" }))
    expect(stopLockHolder(paths(), kill)).toBeNull()
    fs.writeFileSync(paths().lockFile, "")
    expect(stopLockHolder(paths(), kill)).toBeNull()
    expect(kill).not.toHaveBeenCalled()
    fs.writeFileSync(paths().lockFile, JSON.stringify({ pid: 1, startedAt: "x" }))
    expect(stopLockHolder(paths(), kill)).toBeNull()
    expect(kill).not.toHaveBeenCalled()
    expect(stopLockHolder(paths(), kill, () => true)).toBe(1)
    expect(kill).toHaveBeenCalledWith(1, "SIGTERM")
    kill.mockImplementation(() => { throw new Error("EPERM") })
    expect(stopLockHolder(paths(), kill, () => true)).toBeNull()
  })

  it("never signals a reused pid whose start time differs from the lock's", () => {
    const kill = vi.fn()
    fs.mkdirSync(paths().dir, { recursive: true })
    fs.writeFileSync(paths().lockFile, JSON.stringify({ pid: process.ppid, startTime: "Thu Jan  1 00:00:00 1970", startedAt: "x" }))
    expect(stopLockHolder(paths(), kill)).toBeNull()
    expect(kill).not.toHaveBeenCalled()
  })

  it("defaults to the real process.kill", () => {
    fs.mkdirSync(paths().dir, { recursive: true })
    fs.writeFileSync(paths().lockFile, JSON.stringify({ pid: process.ppid, startedAt: "x" }))
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true)
    expect(stopLockHolder(paths())).toBe(process.ppid)
    expect(spy).toHaveBeenCalledWith(process.ppid, "SIGTERM")
    spy.mockRestore()
  })
})
