import { describe, expect, it, vi, beforeEach } from "vitest"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"

const mockRunMcpStatusCanary = vi.fn()
const mockFormatMcpStatusCanaryResult = vi.fn((result: { summary: string }) => `formatted: ${result.summary}`)
const mockFormatMcpStatusDoctorResult = vi.fn((result: { summary: string }, agent: string) => `doctor: ${agent}: ${result.summary}`)
const mockBuildMcpBridgeRepairGuidance = vi.fn((agent: string) => ({
  actor: "agent-runnable",
  commands: [
    `ouro setup --tool codex --agent ${agent}`,
    `ouro setup --tool claude-code --agent ${agent}`,
  ],
  reload: "reload",
  verify: `ouro mcp doctor --agent ${agent}`,
}))
const mockBuildMcpDoctorNextSteps = vi.fn((result: { summary: string }, agent: string) => ({
  actor: "agent-runnable",
  commands: ["ouro doctor", `ouro mcp doctor --agent ${agent}`],
  note: `next for ${result.summary}`,
}))

vi.mock("../../../heart/daemon/mcp-canary", () => ({
  runMcpStatusCanary: (...args: unknown[]) => mockRunMcpStatusCanary(...args),
  formatMcpStatusCanaryResult: (...args: unknown[]) => mockFormatMcpStatusCanaryResult(...args),
  formatMcpStatusDoctorResult: (...args: unknown[]) => mockFormatMcpStatusDoctorResult(...args),
  buildMcpBridgeRepairGuidance: (...args: unknown[]) => mockBuildMcpBridgeRepairGuidance(...args),
  buildMcpDoctorNextSteps: (...args: unknown[]) => mockBuildMcpDoctorNextSteps(...args),
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
    mockFormatMcpStatusDoctorResult.mockClear()
    mockBuildMcpBridgeRepairGuidance.mockClear()
    mockBuildMcpDoctorNextSteps.mockClear()
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

  it("parses mcp doctor for an agent", () => {
    expect(parseOuroCommand([
      "mcp",
      "doctor",
      "--agent",
      "slugger",
      "--socket",
      "/tmp/custom.sock",
      "--json",
    ])).toEqual({
      kind: "mcp.doctor",
      agent: "slugger",
      socketOverride: "/tmp/custom.sock",
      json: true,
    })
  })

  it("parses mcp doctor with json only", () => {
    expect(parseOuroCommand([
      "mcp",
      "doctor",
      "--agent",
      "slugger",
      "--json",
    ])).toEqual({
      kind: "mcp.doctor",
      agent: "slugger",
      json: true,
    })
  })

  it("parses mcp doctor with only the required agent", () => {
    expect(parseOuroCommand([
      "mcp",
      "doctor",
      "--agent",
      "slugger",
    ])).toEqual({
      kind: "mcp.doctor",
      agent: "slugger",
    })
  })

  it("requires an agent for mcp doctor", () => {
    expect(() => parseOuroCommand(["mcp", "doctor"])).toThrow("mcp doctor requires --agent")
  })

  it("rejects unknown mcp doctor flags", () => {
    expect(() => parseOuroCommand([
      "mcp",
      "doctor",
      "--agent",
      "slugger",
      "--unknown",
    ])).toThrow("Unknown mcp doctor flag: --unknown")
  })

  it("rejects mcp doctor socket without a value", () => {
    expect(() => parseOuroCommand([
      "mcp",
      "doctor",
      "--agent",
      "slugger",
      "--socket",
    ])).toThrow("mcp doctor requires a value after --socket")
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

  it("runs mcp doctor through the direct bridge canary", async () => {
    mockRunMcpStatusCanary.mockResolvedValue({
      ok: true,
      summary: "mcp canary ok",
      details: [],
    })
    const cliDeps = deps()

    const result = await runOuroCli(["mcp", "doctor", "--agent", "slugger"], cliDeps)

    expect(result).toBe("doctor: slugger: mcp canary ok")
    expect(mockRunMcpStatusCanary).toHaveBeenCalledWith(expect.objectContaining({
      agent: "slugger",
      socketPath: "/tmp/ouro-test.sock",
      ignoreOverviewHealth: true,
      ignoreSenseHealth: true,
    }))
    expect(mockFormatMcpStatusDoctorResult).toHaveBeenCalledWith(expect.objectContaining({
      summary: "mcp canary ok",
    }), "slugger")
  })

  it("returns JSON bridge repair guidance for a healthy direct doctor", async () => {
    mockRunMcpStatusCanary.mockResolvedValue({
      ok: true,
      summary: "mcp canary ok",
      details: [],
    })
    const cliDeps = deps()

    const result = await runOuroCli(["mcp", "doctor", "--agent", "slugger", "--json"], cliDeps)
    const parsed = JSON.parse(result)

    expect(parsed.repair).toMatchObject({
      actor: "agent-runnable",
      commands: [
        "ouro setup --tool codex --agent slugger",
        "ouro setup --tool claude-code --agent slugger",
      ],
    })
    expect(parsed.nextSteps).toBeUndefined()
    expect(mockFormatMcpStatusDoctorResult).not.toHaveBeenCalled()
  })

  it("returns JSON next steps instead of setup repair for non-bridge failures", async () => {
    mockRunMcpStatusCanary.mockResolvedValue({
      ok: false,
      summary: "mcp canary failed: health=warn",
      details: ["health=warn"],
    })
    const cliDeps = deps()

    const result = await runOuroCli(["mcp", "doctor", "--agent", "slugger", "--json"], cliDeps)
    const parsed = JSON.parse(result)

    expect(parsed.repair).toBeUndefined()
    expect(parsed.nextSteps).toMatchObject({
      actor: "agent-runnable",
      commands: ["ouro doctor", "ouro mcp doctor --agent slugger"],
    })
  })
})
