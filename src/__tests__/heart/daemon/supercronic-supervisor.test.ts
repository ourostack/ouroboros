import { EventEmitter } from "node:events"
import { once } from "node:events"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { SupercronicSupervisor } from "../../../heart/daemon/supercronic-supervisor"
import type { ScheduledTaskJob } from "../../../heart/daemon/task-scheduler"

function job(agent: string, taskId: string, command = `/usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke ${agent} --habit ${taskId} --trigger cron`): ScheduledTaskJob {
  return { id: `${agent}:${taskId}`, agent, taskId, schedule: "*/15 * * * *", lastRun: null, command, taskPath: `/tmp/${taskId}.md` }
}

function fixture(
  processAlive: (pid: number) => boolean = (pid) => pid === 42,
  processCommand: (pid: number) => string | null = (pid) => pid === 42 ? "/usr/local/bin/supercronic -split-logs -inotify /scheduler/sanctuary.crontab" : null,
) {
  const files = new Map<string, string>()
  const child = Object.assign(new EventEmitter(), { pid: 42, kill: vi.fn() })
  child.kill.mockImplementation(() => { queueMicrotask(() => child.emit("exit", 0, "SIGTERM")); return true })
  const spawn = vi.fn(() => child)
  const supervisor = new SupercronicSupervisor({
    binaryPath: "/usr/local/bin/supercronic",
    crontabPath: "/scheduler/sanctuary.crontab",
    pidPath: "/scheduler/sanctuary.pid",
    deps: {
      mkdir: vi.fn(),
      readFile: (path) => files.get(path) ?? (() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }) })(),
      durableWrite: (path, content) => { files.set(path, content) },
      removeFile: (path) => { files.delete(path) },
      processAlive,
      processCommand,
      spawn,
      setTimer: vi.fn(() => ({ fixture: true }) as unknown as ReturnType<typeof setTimeout>),
      clearTimer: vi.fn(),
    },
  })
  return { supervisor, child, spawn, files }
}

describe("SupercronicSupervisor", () => {
  it("owns one child and deterministically merges isolated namespace views", () => {
    const f = fixture()
    f.supervisor.start()
    const habits = f.supervisor.namespace("habit:sanctuary")
    const awaits = f.supervisor.namespace("await:sanctuary")
    habits.sync([job("sanctuary", "sanctuary-health")])
    awaits.sync([job("sanctuary", "await.disk", "/usr/local/bin/node ouro-entry.js poke sanctuary --await disk --trigger cron")])

    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(f.files.get("/scheduler/sanctuary.crontab")).toBe([
      "# ouro:await:sanctuary:sanctuary:await.disk",
      "*/15 * * * * /usr/local/bin/node ouro-entry.js poke sanctuary --await disk --trigger cron",
      "# ouro:habit:sanctuary:sanctuary:sanctuary-health",
      "*/15 * * * * /usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke sanctuary --habit sanctuary-health --trigger cron",
      "",
    ].join("\n"))
    expect(habits.list()).toEqual(["sanctuary-health"])
    expect(f.supervisor.verifyNamespace("habit:sanctuary", [job("sanctuary", "sanctuary-health")])).toBe(true)
    expect(f.supervisor.verificationOutput()).toBe(f.files.get("/scheduler/sanctuary.crontab"))
    expect(f.supervisor.authenticatedSnapshot("habit:sanctuary")).toEqual({
      schemaVersion: "supercronic-supervisor-snapshot-v1",
      daemonPid: process.pid,
      childCount: 1,
      childPid: 42,
      healthy: true,
      binaryPath: "/usr/local/bin/supercronic",
      args: ["-split-logs", "-inotify", "/scheduler/sanctuary.crontab"],
      crontabPath: "/scheduler/sanctuary.crontab",
      namespace: "habit:sanctuary",
      manifest: [job("sanctuary", "sanctuary-health")],
      renderedCrontab: f.files.get("/scheduler/sanctuary.crontab"),
    })

    habits.removeAll()
    expect(f.files.get("/scheduler/sanctuary.crontab")).toContain("--await disk")
    expect(f.files.get("/scheduler/sanctuary.crontab")).not.toContain("sanctuary-health")
  })

  it("sorts multiple jobs within one namespace by stable job id", () => {
    const f = fixture()
    const habits = f.supervisor.namespace("habit:sanctuary")
    habits.sync([job("sanctuary", "z-last"), job("sanctuary", "a-first")])
    expect(habits.list()).toEqual(["a-first", "z-last"])
    expect(f.files.get("/scheduler/sanctuary.crontab")!.indexOf("a-first"))
      .toBeLessThan(f.files.get("/scheduler/sanctuary.crontab")!.indexOf("z-last"))
  })

  it("refuses invalid namespaces, newline injection, and a second live owner", () => {
    const f = fixture()
    expect(() => f.supervisor.namespace("habit:../escape")).toThrow("invalid Supercronic namespace")
    expect(() => f.supervisor.namespace("habit:sanctuary").sync([job("sanctuary", "bad\njob")])).toThrow("invalid Supercronic job")

    const live = fixture(() => true, () => "/usr/local/bin/supercronic -split-logs -inotify /scheduler/sanctuary.crontab")
    live.files.set("/scheduler/sanctuary.pid", "123\n")
    expect(() => live.supervisor.start()).toThrow("already running")
  })

  it("removes stale prior pid files when the pid belongs to another process", () => {
    const f = fixture((pid) => pid === 123 || pid === 42, (pid) => pid === 123 ? "/opt/ouro/node dist/heart/daemon/daemon-entry.js" : "/usr/local/bin/supercronic -split-logs -inotify /scheduler/sanctuary.crontab")
    f.files.set("/scheduler/sanctuary.pid", "123\n")

    expect(() => f.supervisor.start()).not.toThrow()

    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(f.files.get("/scheduler/sanctuary.pid")).toBe("42\n")
  })

  it("marks child health and stops only the owned child", async () => {
    const f = fixture()
    f.supervisor.start()
    expect(f.supervisor.isHealthy()).toBe(true)
    await f.supervisor.stop()
    expect(f.child.kill).toHaveBeenCalledWith("SIGTERM")
    expect(f.files.has("/scheduler/sanctuary.pid")).toBe(false)
    expect(() => f.supervisor.authenticatedSnapshot("habit:sanctuary")).toThrow(/healthy child/u)
  })

  it("uses the production filesystem, process, child, and timer adapters safely", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-supercronic-defaults-"))
    const supervisor = new SupercronicSupervisor({
      binaryPath: process.execPath,
      crontabPath: path.join(root, "nested", "sanctuary.crontab"),
    })
    const file = path.join(root, "nested", "adapter.txt")
    try {
      supervisor.deps.mkdir(path.dirname(file))
      supervisor.deps.durableWrite(file, "content\n", 0o600)
      expect(supervisor.deps.readFile(file)).toBe("content\n")
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(supervisor.deps.processAlive(process.pid)).toBe(true)
      expect(supervisor.deps.processAlive(2_147_483_647)).toBe(false)

      const callback = vi.fn()
      const timer = supervisor.deps.setTimer(callback, 60_000)
      supervisor.deps.clearTimer(timer)
      expect(callback).not.toHaveBeenCalled()

      const child = supervisor.deps.spawn(process.execPath, ["-e", "process.exit(0)"])
      await once(child, "exit")

      supervisor.deps.removeFile(file)
      expect(fs.existsSync(file)).toBe(false)
      expect(() => supervisor.deps.removeFile(file)).not.toThrow()
      expect(() => supervisor.deps.removeFile(path.dirname(file))).toThrow()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("covers manifest validation, listing, and verification failures", () => {
    const f = fixture(() => false)
    const habits = f.supervisor.namespace("habit:sanctuary")
    expect(habits.list()).toEqual([])
    expect(f.supervisor.verificationOutput()).toBe("")
    expect(f.supervisor.verifyNamespace("habit:sanctuary", [])).toBe(false)

    for (const invalid of [
      { ...job("sanctuary", "health"), id: "bad\nid" },
      { ...job("sanctuary", "health"), taskId: "bad\ntask" },
      { ...job("sanctuary", "health"), schedule: "bad\nschedule" },
      { ...job("sanctuary", "health"), command: "bad\0command" },
    ]) expect(() => habits.sync([invalid])).toThrow("invalid Supercronic job")
    const duplicate = job("sanctuary", "health")
    expect(() => habits.sync([duplicate, duplicate])).toThrow("duplicate Supercronic job")

    habits.sync([duplicate])
    f.supervisor.start()
    expect(() => f.supervisor.start()).not.toThrow()
    expect(f.supervisor.isHealthy()).toBe(false)
    expect(f.supervisor.verifyNamespace("await:sanctuary", [duplicate])).toBe(false)

    const healthy = fixture()
    const view = healthy.supervisor.namespace("habit:sanctuary")
    view.sync([duplicate])
    healthy.supervisor.start()
    expect(healthy.supervisor.verifyNamespace("habit:sanctuary", [])).toBe(false)
    expect(healthy.supervisor.verifyNamespace("habit:sanctuary", [{ ...duplicate, id: "missing" }])).toBe(false)
    expect(healthy.supervisor.verifyNamespace("habit:sanctuary", [{ ...duplicate, schedule: "0 * * * *" }])).toBe(false)
    expect(healthy.supervisor.verifyNamespace("habit:sanctuary", [{ ...duplicate, command: "other" }])).toBe(false)
    healthy.files.set("/scheduler/sanctuary.crontab", "drifted")
    expect(healthy.supervisor.verifyNamespace("habit:sanctuary", [duplicate])).toBe(false)
    expect(healthy.supervisor.verificationOutput()).toBe("")
    healthy.files.delete("/scheduler/sanctuary.crontab")
    expect(healthy.supervisor.verifyNamespace("habit:sanctuary", [duplicate])).toBe(false)
    expect(healthy.supervisor.verificationOutput()).toBe("")
  })

  it("fails closed when an authenticated snapshot lacks an exact verified namespace", () => {
    const f = fixture()
    const view = f.supervisor.namespace("habit:sanctuary")
    view.sync([job("sanctuary", "z-last"), job("sanctuary", "a-first")])
    f.supervisor.start()
    expect(f.supervisor.authenticatedSnapshot("habit:sanctuary").manifest.map((entry) => entry.taskId)).toEqual(["a-first", "z-last"])

    expect(() => f.supervisor.authenticatedSnapshot("habit:../escape")).toThrow("invalid Supercronic namespace")
    expect(() => f.supervisor.authenticatedSnapshot("await:sanctuary")).toThrow("has no manifest")

    f.files.set("/scheduler/sanctuary.crontab", "drifted\n")
    expect(() => f.supervisor.authenticatedSnapshot("habit:sanctuary")).toThrow("crontab is not verified")
  })

  it("rejects invalid child PIDs and safely handles dead prior owners", () => {
    const dead = fixture(() => false)
    dead.files.set("/scheduler/sanctuary.pid", "not-a-pid\n")
    expect(() => dead.supervisor.start()).not.toThrow()

    const zero = fixture()
    Object.defineProperty(zero.child, "pid", { value: 0 })
    expect(() => zero.supervisor.start()).toThrow("did not return a child PID")
  })

  it("restarts with bounded backoff, ignores stale exits, and becomes fatal after exhaustion", () => {
    const files = new Map<string, string>()
    const children: Array<EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> }> = []
    const timers: Array<{ callback: () => void; delay: number; token: ReturnType<typeof setTimeout> }> = []
    const fatal = vi.fn()
    const supervisor = new SupercronicSupervisor({
      binaryPath: "/usr/local/bin/supercronic",
      crontabPath: "/scheduler/sanctuary.crontab",
      deps: {
        mkdir: vi.fn(),
        readFile: (target) => files.get(target) ?? (() => { throw new Error("missing") })(),
        durableWrite: (target, content) => { files.set(target, content) },
        removeFile: (target) => { files.delete(target) },
        processAlive: () => true,
        processCommand: () => "/usr/local/bin/supercronic -split-logs -inotify /scheduler/sanctuary.crontab",
        spawn: vi.fn(() => {
          const child = Object.assign(new EventEmitter(), { pid: 100 + children.length, kill: vi.fn(() => true) })
          children.push(child)
          return child
        }),
        setTimer: vi.fn((callback, delay) => {
          const token = { id: timers.length } as unknown as ReturnType<typeof setTimeout>
          timers.push({ callback, delay, token })
          return token
        }),
        clearTimer: vi.fn(),
      },
      onFatal: fatal,
    })
    supervisor.start()
    const staleExit = children[0]!.listeners("exit")[0] as (code: number, signal: string | null) => void
    children[0]!.emit("exit", 1, null)
    expect(timers.map((timer) => timer.delay)).toEqual([1_000])
    timers[0]!.callback()
    staleExit(1, null)
    children[1]!.emit("exit", 2, "SIGABRT")
    expect(timers[1]!.delay).toBe(5_000)
    timers[1]!.callback()
    children[2]!.emit("exit", 3, null)
    expect(timers[2]!.delay).toBe(15_000)
    timers[2]!.callback()
    children[3]!.emit("exit", 4, "SIGKILL")
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ message: "Supercronic exited repeatedly (code=4, signal=SIGKILL)" }))
  })

  it("does not spawn beside a pending supervised restart", () => {
    const files = new Map<string, string>()
    const children: Array<EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> }> = []
    let restart: (() => void) | null = null
    const supervisor = new SupercronicSupervisor({
      binaryPath: "/usr/local/bin/supercronic",
      crontabPath: "/scheduler/sanctuary.crontab",
      deps: {
        mkdir: vi.fn(),
        readFile: (target) => files.get(target) ?? (() => { throw new Error("missing") })(),
        durableWrite: (target, content) => { files.set(target, content) },
        removeFile: (target) => { files.delete(target) },
        processAlive: () => true,
        processCommand: () => "/usr/local/bin/supercronic -split-logs -inotify /scheduler/sanctuary.crontab",
        spawn: vi.fn(() => {
          const child = Object.assign(new EventEmitter(), { pid: 200 + children.length, kill: vi.fn(() => true) })
          children.push(child)
          return child
        }),
        setTimer: (callback) => {
          restart = callback
          return { restart: true } as unknown as ReturnType<typeof setTimeout>
        },
        clearTimer: vi.fn(),
      },
    })

    supervisor.start()
    children[0]!.emit("exit", 1, null)
    supervisor.start()
    expect(children).toHaveLength(1)
    expect(restart).not.toBeNull()
    ;(restart as unknown as () => void)()
    expect(children).toHaveLength(2)
  })

  it("clears pending restart state and handles empty or timed-out stops", async () => {
    const empty = fixture()
    await empty.supervisor.stop()
    expect(empty.files.has("/scheduler/sanctuary.pid")).toBe(false)

    const files = new Map<string, string>()
    const child = Object.assign(new EventEmitter(), { pid: 42, kill: vi.fn(() => true) })
    const timers: Array<{ callback: () => void; delay: number; token: ReturnType<typeof setTimeout> }> = []
    const clearTimer = vi.fn()
    const supervisor = new SupercronicSupervisor({
      binaryPath: "/usr/local/bin/supercronic",
      crontabPath: "/scheduler/sanctuary.crontab",
      deps: {
        mkdir: vi.fn(),
        readFile: (target) => files.get(target) ?? (() => { throw new Error("missing") })(),
        durableWrite: (target, content) => { files.set(target, content) },
        removeFile: (target) => { files.delete(target) },
        processAlive: () => true,
        processCommand: () => "/usr/local/bin/supercronic -split-logs -inotify /scheduler/sanctuary.crontab",
        spawn: () => child,
        setTimer: (callback, delay) => {
          const token = { id: timers.length } as unknown as ReturnType<typeof setTimeout>
          timers.push({ callback, delay, token })
          return token
        },
        clearTimer,
      },
    })
    supervisor.start()
    const stopping = supervisor.stop()
    expect(timers[0]!.delay).toBe(10_000)
    timers[0]!.callback()
    child.emit("exit", 0, "SIGTERM")
    await stopping
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM")
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL")
    expect(clearTimer).toHaveBeenCalledWith(timers[0]!.token)

    const restart = fixture()
    restart.supervisor.start()
    restart.child.emit("exit", 1, null)
    await restart.supervisor.stop()
    expect(restart.supervisor.deps.clearTimer).toHaveBeenCalled()
  })

  it("throws by default when restart exhaustion becomes fatal", () => {
    const f = fixture()
    expect(() => (f.supervisor as unknown as { onFatal(error: Error): void }).onFatal(new Error("fatal"))).toThrow("fatal")
  })
})
