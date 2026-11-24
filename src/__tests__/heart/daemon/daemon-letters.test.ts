import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function daemonOptions(bundlesRoot: string) {
  return {
    socketPath: path.join(bundlesRoot, "daemon.sock"),
    bundlesRoot,
    processManager: { listAgentSnapshots: vi.fn(() => []), startAutoStartAgents: vi.fn(async () => undefined), stopAll: vi.fn(async () => undefined), startAgent: vi.fn(async () => undefined), sendToAgent: vi.fn() },
    scheduler: { listJobs: vi.fn(() => []), triggerJob: vi.fn(async () => ({ ok: true, message: "" })), reconcile: vi.fn(async () => undefined) },
    healthMonitor: { runChecks: vi.fn(async () => []) },
    router: { send: vi.fn(async () => ({ id: "m", queuedAt: "" })), pollInbox: vi.fn(() => []) },
    senseManager: { startAutoStartSenses: vi.fn(async () => undefined), stopAll: vi.fn(async () => undefined), listSenseRows: vi.fn(() => []) },
  }
}

describe("the daemon's letters.action command", () => {
  it("hands each mailbox call to one letters writer over the daemon's bundles, and answers its refusals with their code", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c21-daemon-letters-"))
    made.push(bundlesRoot)
    fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro"))
    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const daemon = new OuroDaemon(daemonOptions(bundlesRoot) as ConstructorParameters<typeof OuroDaemon>[0])
    await expect(daemon.handleCommand({ kind: "letters.action", agent: "slugger", action: "mailbox_list", input: {} }))
      .resolves.toEqual({ ok: true, data: { outcome: "done", count: 0, listing: "" } })
    await expect(daemon.handleCommand({ kind: "letters.action", agent: "nobody", action: "mailbox_list", input: {} }))
      .resolves.toEqual(expect.objectContaining({ ok: false, data: expect.objectContaining({ code: "no-agent" }) }))
  })
})
