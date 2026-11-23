import { spawn } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import { killProcessTree, listProcesses, processTreeTargets, type ProcessRow } from "../../../heart/daemon/process-tree"

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
    expect(processTreeTargets(111, table)).toEqual({ groups: [200], pids: [111, 300] })
  })

  it("still names the worker when the process table could not be read", () => {
    expect(processTreeTargets(111, [])).toEqual({ groups: [], pids: [111] })
  })
})

describe("killProcessTree", () => {
  it("sends SIGKILL to each group and process except the one already signalled, and counts what it reached", () => {
    const kill = vi.fn((pid: number) => {
      if (pid === 300) throw Object.assign(new Error("no such process"), { code: "ESRCH" })
    })
    expect(killProcessTree({ groups: [200, 500], pids: [111, 300] }, 111, kill)).toEqual({ groups: 2, processes: 0 })
    expect(kill.mock.calls).toEqual([[-200, "SIGKILL"], [-500, "SIGKILL"], [300, "SIGKILL"]])
  })
})

describe("listProcesses", () => {
  it("reads the real process table, this process included", () => {
    const rows = listProcesses()
    expect(rows).toContainEqual({ pid: process.pid, ppid: process.ppid, pgid: expect.any(Number) })
  })

  it("reads nothing when ps cannot run", () => {
    const path = process.env.PATH
    process.env.PATH = ""
    try {
      expect(listProcesses()).toEqual([])
    } finally {
      process.env.PATH = path
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
