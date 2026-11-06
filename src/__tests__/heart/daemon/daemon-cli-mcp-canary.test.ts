import { describe, expect, it, vi, beforeEach } from "vitest"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"

const mockRunMcpStatusCanary = vi.fn()
const mockFormatMcpStatusCanaryResult = vi.fn((result: { summary: string }) => `formatted: ${result.summary}`)

vi.mock("../../../heart/daemon/mcp-canary", () => ({
  runMcpStatusCanary: (...args: unknown[]) => mockRunMcpStatusCanary(...args),
  formatMcpStatusCanaryResult: (...args: unknown[]) => mockFormatMcpStatusCanaryResult(...args),
}))

import { parseOuroCommand } from "../../../heart/daemon/cli-parse"
import { runOuroCli } from "../../../heart/daemon/cli-exec"

function deps(): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn(),
    startDaemonProcess: vi.fn(),
    writeStdout: vi.fn(),
    setExitCode: vi.fn(),
    checkSocketAlive: vi.fn(),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn(),
  } as unknown as OuroCliDeps
}

describe("ouro mcp canary", () => {
  beforeEach(() => {
    mockRunMcpStatusCanary.mockReset()
    mockFormatMcpStatusCanaryResult.mockClear()
  })

  it("parses agent, socket, json, and required sense flags", () => {
    expect(parseOuroCommand([
      "mcp",
      "canary",
      "--agent",
      "slugger",
      "--socket",
      "/tmp/custom.sock",
      "--require-sense",
      "bluebubbles",
      "--json",
    ])).toEqual({
      kind: "mcp.canary",
      agent: "slugger",
      socketOverride: "/tmp/custom.sock",
      requiredSenses: ["bluebubbles"],
      json: true,
    })
  })

  it("parses json-only canary flags", () => {
    expect(parseOuroCommand([
      "mcp",
      "canary",
      "--agent",
      "slugger",
      "--json",
    ])).toEqual({
      kind: "mcp.canary",
      agent: "slugger",
      json: true,
    })
  })

  it("ignores unknown canary flags while preserving the required agent", () => {
    expect(parseOuroCommand([
      "mcp",
      "canary",
      "--agent",
      "slugger",
      "--unknown",
    ])).toEqual({
      kind: "mcp.canary",
      agent: "slugger",
    })
  })

  it("requires an agent", () => {
    expect(() => parseOuroCommand(["mcp", "canary"])).toThrow("mcp canary requires --agent")
  })

  it("runs the canary without the daemon command plane", async () => {
    mockRunMcpStatusCanary.mockResolvedValue({
      ok: true,
      summary: "mcp canary ok",
      details: [],
    })
    const cliDeps = deps()

    const result = await runOuroCli(["mcp", "canary", "--agent", "slugger", "--require-sense", "bluebubbles"], cliDeps)

    expect(result).toBe("formatted: mcp canary ok")
    expect(mockRunMcpStatusCanary).toHaveBeenCalledWith(expect.objectContaining({
      agent: "slugger",
      socketPath: "/tmp/ouro-test.sock",
      requiredSenses: ["bluebubbles"],
    }))
    expect(cliDeps.sendCommand).not.toHaveBeenCalled()
  })

  it("sets exit code when the canary fails", async () => {
    mockRunMcpStatusCanary.mockResolvedValue({
      ok: false,
      summary: "mcp canary failed",
      details: ["health=warn"],
    })
    const cliDeps = deps()

    await runOuroCli(["mcp", "canary", "--agent", "slugger"], cliDeps)

    expect(cliDeps.setExitCode).toHaveBeenCalledWith(1)
  })
})
