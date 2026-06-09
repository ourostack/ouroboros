import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

const contextLossSentinelMock = vi.hoisted(() => ({
  refreshContextLossSentinel: vi.fn(async () => ({
    verdict: "ready",
    summary: "deterministic recovery is ready",
  })),
}))

const nervesRuntimeMock = vi.hoisted(() => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../../heart/context-loss-sentinel", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/context-loss-sentinel")>(
    "../../../heart/context-loss-sentinel",
  )
  return {
    ...actual,
    refreshContextLossSentinel: contextLossSentinelMock.refreshContextLossSentinel,
  }
})

vi.mock("../../../nerves/runtime", () => nervesRuntimeMock)

import { runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"

describe("daemon CLI hook execution", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    contextLossSentinelMock.refreshContextLossSentinel.mockClear()
    nervesRuntimeMock.emitNervesEvent.mockClear()
  })

  it("refreshes Sentinel locally for session-start hooks when the daemon socket is absent", async () => {
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-cli-hook-"))
    const bundlesRoot = path.join(homeRoot, "AgentBundles")
    const agentRoot = path.join(bundlesRoot, "slugger.ouro")
    fs.mkdirSync(agentRoot, { recursive: true })

    try {
      const deps: OuroCliDeps = {
        socketPath: path.join(homeRoot, "missing.sock"),
        sendCommand: vi.fn(async () => ({ ok: true, summary: "sent" })),
        startDaemonProcess: vi.fn(async () => ({ pid: 12345 })),
        writeStdout: vi.fn(),
        checkSocketAlive: vi.fn(async () => false),
        cleanupStaleSocket: vi.fn(),
        fallbackPendingMessage: vi.fn(() => path.join(homeRoot, "pending.jsonl")),
        bundlesRoot,
      }

      await expect(runOuroCli(["hook", "session-start", "--agent", "slugger"], deps)).resolves.toBe(
        JSON.stringify({ continue: true }),
      )

      expect(contextLossSentinelMock.refreshContextLossSentinel).toHaveBeenCalledWith(
        "slugger",
        agentRoot,
        { trigger: "session_start" },
      )
      expect(deps.sendCommand).not.toHaveBeenCalled()
      expect(nervesRuntimeMock.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        component: "daemon",
        event: "daemon.hook_skipped_no_socket",
        meta: expect.objectContaining({
          agent: "slugger",
          eventType: "session-start",
          socketPath: path.join(homeRoot, "missing.sock"),
        }),
      }))
      expect(deps.writeStdout).toHaveBeenCalledWith(JSON.stringify({ continue: true }))
    } finally {
      fs.rmSync(homeRoot, { recursive: true, force: true })
    }
  })
})
