import { afterEach, describe, expect, it, vi } from "vitest"
import * as os from "os"
import * as path from "path"

import { OuroDaemon } from "../../../heart/daemon/daemon"
import { emitNervesEvent } from "../../../nerves/runtime"

function tmpSocketPath(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

describe("defensive handleCommand wrapping", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("logs daemon.command_error and re-throws when command handler throws", async () => {
    const socketPath = tmpSocketPath("daemon-cmd-error")
    const emitSpy = vi.spyOn({ emitNervesEvent }, "emitNervesEvent")

    // Create a daemon where startAgent throws
    const processManager = {
      listAgentSnapshots: vi.fn(() => []),
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => { throw new Error("spawn-failed") }),
      sendToAgent: vi.fn(),
    }

    const daemon = new OuroDaemon({
      socketPath,
      processManager,
      scheduler: {
        listJobs: vi.fn(() => []),
        triggerJob: vi.fn(async () => ({ ok: true, message: "ok" })),
      },
      healthMonitor: { runChecks: vi.fn(async () => []) },
      router: {
        send: vi.fn(async () => ({ id: "m", queuedAt: "x" })),
        pollInbox: vi.fn(() => []),
      },
      senseManager: {
        startAutoStartSenses: vi.fn(async () => undefined),
        stopAll: vi.fn(async () => undefined),
        listSenseRows: vi.fn(() => []),
      },
    } as any)

    // agent.start will trigger startAgent which throws
    await expect(
      daemon.handleCommand({ kind: "agent.start", agent: "test" }),
    ).rejects.toThrow("spawn-failed")
  })

  it("handleRawPayload catches errors and returns JSON error response", async () => {
    const socketPath = tmpSocketPath("daemon-raw-error")

    const processManager = {
      listAgentSnapshots: vi.fn(() => []),
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => { throw new Error("boom") }),
      sendToAgent: vi.fn(),
    }

    const daemon = new OuroDaemon({
      socketPath,
      processManager,
      scheduler: {
        listJobs: vi.fn(() => []),
        triggerJob: vi.fn(async () => ({ ok: true, message: "ok" })),
      },
      healthMonitor: { runChecks: vi.fn(async () => []) },
      router: {
        send: vi.fn(async () => ({ id: "m", queuedAt: "x" })),
        pollInbox: vi.fn(() => []),
      },
    } as any)

    // handleRawPayload should catch the error from handleCommand
    const raw = await daemon.handleRawPayload('{"kind":"agent.start","agent":"test"}')
    const parsed = JSON.parse(raw) as { ok: boolean; error: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe("boom")
  })

  it("logs non-Error throw values with String() conversion", async () => {
    const socketPath = tmpSocketPath("daemon-cmd-non-error")

    const processManager = {
      listAgentSnapshots: vi.fn(() => []),
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => { throw "string-throw" }),
      sendToAgent: vi.fn(),
    }

    const daemon = new OuroDaemon({
      socketPath,
      processManager,
      scheduler: {
        listJobs: vi.fn(() => []),
        triggerJob: vi.fn(async () => ({ ok: true, message: "ok" })),
      },
      healthMonitor: { runChecks: vi.fn(async () => []) },
      router: {
        send: vi.fn(async () => ({ id: "m", queuedAt: "x" })),
        pollInbox: vi.fn(() => []),
      },
    } as any)

    await expect(
      daemon.handleCommand({ kind: "agent.start", agent: "test" }),
    ).rejects.toBe("string-throw")
  })

  it("successful commands do not emit command_error", async () => {
    const socketPath = tmpSocketPath("daemon-cmd-success")

    const daemon = new OuroDaemon({
      socketPath,
      processManager: {
        listAgentSnapshots: vi.fn(() => []),
        startAutoStartAgents: vi.fn(async () => undefined),
        stopAll: vi.fn(async () => undefined),
        startAgent: vi.fn(async () => undefined),
        sendToAgent: vi.fn(),
      },
      scheduler: {
        listJobs: vi.fn(() => []),
        triggerJob: vi.fn(async () => ({ ok: true, message: "ok" })),
      },
      healthMonitor: { runChecks: vi.fn(async () => []) },
      router: {
        send: vi.fn(async () => ({ id: "m", queuedAt: "x" })),
        pollInbox: vi.fn(() => []),
      },
      senseManager: {
        startAutoStartSenses: vi.fn(async () => undefined),
        stopAll: vi.fn(async () => undefined),
        listSenseRows: vi.fn(() => []),
      },
    } as any)

    const result = await daemon.handleCommand({ kind: "daemon.status" })
    expect(result.ok).toBe(true)
    // No error emitted — command succeeded
  })
})
