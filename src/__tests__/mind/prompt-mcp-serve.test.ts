import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "fs"
import { emitNervesEvent } from "../../nerves/runtime"

vi.mock("fs", async () => {
  const actual = await vi.importActual("fs")
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    readdirSync: vi.fn(() => []),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  }
})

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getAgentName: vi.fn(() => "testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  loadAgentConfig: vi.fn(() => ({
    version: 1,
    enabled: true,
    provider: "minimax",
    senses: {
      cli: { enabled: true },
      teams: { enabled: false },
      bluebubbles: { enabled: false },
    },
    phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
  })),
}))

vi.mock("../../heart/config", () => ({
  getProviderModelId: vi.fn(() => "test-model"),
  loadConfig: vi.fn(() => ({ teams: {}, bluebubbles: {} })),
  patchRuntimeConfig: vi.fn(),
  resetConfigCache: vi.fn(),
}))

function setupReadFileSync() {
  vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
    if (typeof p === "string" && p.includes("package.json")) {
      return JSON.stringify({ version: "0.1.0-alpha.1" })
    }
    return ""
  })
}

describe("prompt MCP serve awareness", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readFileSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()

    emitNervesEvent({
      component: "mind",
      event: "mind.prompt_mcp_test_start",
      message: "prompt MCP serve awareness test starting",
      meta: {},
    })
  })

  it("bodyMapSection includes ouro mcp-serve command", async () => {
    const { bodyMapSection } = await import("../../mind/prompt")
    const result = bodyMapSection("testagent")
    expect(result).toContain("ouro mcp-serve --agent testagent")

    emitNervesEvent({
      component: "mind",
      event: "mind.prompt_mcp_test_end",
      message: "bodyMapSection mcp-serve test complete",
      meta: {},
    })
  })

  it("runtimeInfoSection mentions MCP serve capability", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).toContain("mcp")

    emitNervesEvent({
      component: "mind",
      event: "mind.prompt_mcp_test_end",
      message: "runtimeInfoSection MCP awareness test complete",
      meta: {},
    })
  })
})
