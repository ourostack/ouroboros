import { spawn } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import * as nerves from "../../../nerves/runtime"
import { killProcessTree, listProcesses, processTreeTargets, sendSignal, targetsStillInTree, type ProcessRow } from "../../../heart/daemon/process-tree"

// The daemon (100) runs a worker (111) in its own group. The worker started sync's git detached (200), which ran
// ssh (201) in git's group, and a helper (300) in the daemon's group. 400 is unrelated.
const table: ProcessRow[] = [
  { pid: 100, ppid: 1, pgid: 100 },
  { pid: 111, ppid: 100, pgid: 100 },
  { pid: 200, ppid: 111, pgid: 200 },
  { pid: 201, ppid: 200, pgid: 200 },
  { pid: 300, ppid: 111, pgid: 100 },
  { pid: 400, ppid: 1, pgid: 400 },
]

describe("processTreeTargets", () => {
  it("kills the groups the worker's tree leads whole, and the rest of the tree one by one, never the daemon's group", () => {
    expect(processTreeTargets(111, table)).toMatchObject({ groups: [200], pids: [111, 300] })
  })

  it("still names the worker when the process table could not be read", () => {
    expect(processTreeTargets(111, [])).toMatchObject({ groups: [], pids: [111] })
  })

  it("lists several groups and processes in pid order", () => {
    const wider = [...table, { pid: 150, ppid: 111, pgid: 150 }, { pid: 120, ppid: 111, pgid: 100 }]
    expect(processTreeTargets(111, wider)).toMatchObject({ groups: [150, 200], pids: [111, 120, 300] })
  })

  it("never names init, every process (-1) or the caller's group (0)", () => {
    expect(processTreeTargets(1, table)).toEqual({ groups: [], pids: [], members: [] })
    expect(processTreeTargets(0, table)).toEqual({ groups: [], pids: [], members: [] })
    // A table that claims a tree member leads group 1 or 0 still never yields a group kill of it.
    expect(processTreeTargets(111, [{ pid: 111, ppid: 100, pgid: 100 }, { pid: 1, ppid: 111, pgid: 1 }, { pid: 0, ppid: 111, pgid: 0 }])).toMatchObject({ groups: [], pids: [111] })
  })
})

describe("targetsStillInTree", () => {
  const targets = processTreeTargets(111, table)

  it("records the tree's members with their groups", () => {
    expect(targets.members.map((row) => row.pid).sort((a, b) => a - b)).toEqual([111, 200, 201, 300])
  })

  it("keeps what is still the worker's: a group with a member or a member's child in it, a process with its group whose parent is a member or launchd", () => {
    const now: ProcessRow[] = [
      { pid: 202, ppid: 201, pgid: 200 },
      { pid: 300, ppid: 1, pgid: 100 },
    ]
    expect(targetsStillInTree(targets, now)).toMatchObject({ groups: [200], pids: [300] })
    // The group's leader itself, taken over by launchd once the worker died.
    expect(targetsStillInTree(targets, [{ pid: 200, ppid: 1, pgid: 200 }])).toMatchObject({ groups: [200] })
  })

  it("drops a pid or group the system has since handed to something else", () => {
    const now: ProcessRow[] = [
      { pid: 200, ppid: 50, pgid: 200 },
      { pid: 300, ppid: 1, pgid: 300 },
      { pid: 111, ppid: 50, pgid: 100 },
    ]
    // 200 leads a group of that number again, but as a new process started by something outside the tree; 300 is in
    // another group now.
    expect(targetsStillInTree(targets, now)).toMatchObject({ groups: [], pids: [] })
  })

  it("keeps nothing when the table could not be read again", () => {
    expect(targetsStillInTree(targets, [])).toMatchObject({ groups: [], pids: [] })
  })
})

describe("killProcessTree", () => {
  it("sends SIGKILL to each group and process except the one already signalled, and counts what it reached", () => {
    const kill = vi.fn((pid: number) => {
      if (pid === 300) throw Object.assign(new Error("no such process"), { code: "ESRCH" })
    })
    expect(killProcessTree({ groups: [200, 500], pids: [111, 300], members: [] }, 111, kill, "SIGKILL")).toEqual({ groups: 2, processes: 0 })
    expect(kill.mock.calls).toEqual([[-200, "SIGKILL"], [-500, "SIGKILL"], [300, "SIGKILL"]])
  })

  it("sends the signal it is given, and does not count a group it could not reach", () => {
    const kill = vi.fn((pid: number) => {
      if (pid === -500) throw Object.assign(new Error("no such process"), { code: "ESRCH" })
    })
    expect(killProcessTree({ groups: [200, 500], pids: [111, 300], members: [] }, 111, kill, "SIGTERM")).toEqual({ groups: 1, processes: 1 })
    expect(kill.mock.calls).toEqual([[-200, "SIGTERM"], [-500, "SIGTERM"], [300, "SIGTERM"]])
  })
})

describe("sendSignal", () => {
  it("signals a real process, and throws for one that is gone", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" })
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)))
    sendSignal(child.pid!, "SIGKILL")
    expect(await exited).toBe("SIGKILL")
    expect(() => sendSignal(child.pid!, "SIGKILL")).toThrow()
  })
})

describe("listProcesses", () => {
  it("reads the real process table, this process included", () => {
    const rows = listProcesses()
    expect(rows).toContainEqual({ pid: process.pid, ppid: process.ppid, pgid: expect.any(Number) })
  })

  it("reads nothing when ps cannot run, and says so", () => {
    const path = process.env.PATH
    const emit = vi.spyOn(nerves, "emitNervesEvent")
    process.env.PATH = ""
    try {
      expect(listProcesses()).toEqual([])
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        level: "warn",
        component: "daemon",
        event: "daemon.process_table_unreadable",
        meta: expect.objectContaining({ error: expect.any(String) }),
      }))
    } finally {
      emit.mockRestore()
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  })

  it("finds a detached child in its own group under the process that started it", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
    try {
      await vi.waitFor(() => expect(listProcesses()).toContainEqual({ pid: child.pid, ppid: process.pid, pgid: child.pid }))
    } finally {
      child.kill("SIGKILL")
    }
  })
})
