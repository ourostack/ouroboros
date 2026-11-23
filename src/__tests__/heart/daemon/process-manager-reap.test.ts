import { spawn as nodeSpawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { DaemonProcessManager } from "../../../heart/daemon/process-manager"
import { listProcesses } from "../../../heart/daemon/process-tree"

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A real worker that ignores SIGTERM and has started what sync starts: a detached git-like child with its own
// child in the same group, and a plain child. After the stop, none of them may still run.
const WORKER = `
const { spawn } = require("node:child_process")
const fs = require("node:fs")
process.on("SIGTERM", () => {})
const detached = spawn("sh", ["-c", "sleep 60 & wait"], { detached: true, stdio: "ignore" })
const plain = spawn("sleep", ["60"], { stdio: "ignore" })
fs.writeFileSync(process.argv[1], JSON.stringify({ detached: detached.pid, plain: plain.pid }))
setInterval(() => {}, 1000)
`

describe("stopping a worker that ignores SIGTERM", () => {
  it("leaves nothing the worker started running", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "process-manager-reap-"))
    const pidsFile = path.join(dir, "pids.json")
    let workerPid = 0
    const spawned: number[] = []
    const manager = new DaemonProcessManager({
      agents: [{ name: "stuck", entry: "heart/agent-entry.js", channel: "cli", autoStart: false }],
      spawn: (_command, _args, options) => {
        const child = nodeSpawn(process.execPath, ["-e", WORKER, pidsFile], { stdio: options.stdio as never })
        workerPid = child.pid!
        return child
      },
      listProcesses,
      stopTimeoutMs: 300,
      killTimeoutMs: 5_000,
    })
    try {
      await manager.startAgent("stuck")
      const started = await vi.waitFor(() => JSON.parse(fs.readFileSync(pidsFile, "utf-8")) as { detached: number; plain: number }, { timeout: 10_000, interval: 50 })
      spawned.push(workerPid, started.detached, -started.detached, started.plain)
      const grandchild = await vi.waitFor(() => {
        const row = listProcesses().find((candidate) => candidate.ppid === started.detached)
        expect(row).toBeDefined()
        return row!.pid
      }, { timeout: 10_000, interval: 50 })

      await manager.stopAgent("stuck")

      await vi.waitFor(() => {
        for (const pid of [workerPid, started.detached, grandchild, started.plain]) expect(alive(pid), `pid ${pid}`).toBe(false)
      }, { timeout: 5_000, interval: 50 })
    } finally {
      // A failed run must not leave its sleeps behind on a shared machine.
      for (const pid of spawned) {
        try { process.kill(pid, "SIGKILL") } catch { /* already gone */ }
      }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
