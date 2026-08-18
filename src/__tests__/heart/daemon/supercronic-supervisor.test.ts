import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"

import { SupercronicSupervisor } from "../../../heart/daemon/supercronic-supervisor"
import type { ScheduledTaskJob } from "../../../heart/daemon/task-scheduler"

function job(agent: string, taskId: string, command = `/usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke ${agent} --habit ${taskId} --trigger cron`): ScheduledTaskJob {
  return { id: `${agent}:${taskId}`, agent, taskId, schedule: "*/15 * * * *", lastRun: null, command, taskPath: `/tmp/${taskId}.md` }
}

function fixture(processAlive: (pid: number) => boolean = (pid) => pid === 42) {
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
      spawn,
      setTimer: vi.fn(),
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

    habits.removeAll()
    expect(f.files.get("/scheduler/sanctuary.crontab")).toContain("--await disk")
    expect(f.files.get("/scheduler/sanctuary.crontab")).not.toContain("sanctuary-health")
  })

  it("refuses invalid namespaces, newline injection, and a second live owner", () => {
    const f = fixture()
    expect(() => f.supervisor.namespace("habit:../escape")).toThrow("invalid Supercronic namespace")
    expect(() => f.supervisor.namespace("habit:sanctuary").sync([job("sanctuary", "bad\njob")])).toThrow("invalid Supercronic job")

    const live = fixture(() => true)
    live.files.set("/scheduler/sanctuary.pid", "123\n")
    expect(() => live.supervisor.start()).toThrow("already running")
  })

  it("marks child health and stops only the owned child", async () => {
    const f = fixture()
    f.supervisor.start()
    expect(f.supervisor.isHealthy()).toBe(true)
    await f.supervisor.stop()
    expect(f.child.kill).toHaveBeenCalledWith("SIGTERM")
    expect(f.files.has("/scheduler/sanctuary.pid")).toBe(false)
  })
})
