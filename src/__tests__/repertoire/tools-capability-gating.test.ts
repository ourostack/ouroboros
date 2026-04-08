import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.test_run",
    message: testName,
    meta: { test: true },
  })
}

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

// Hard-mock the daemon socket client. The runtime guard in socket-client.ts
// already prevents real socket calls under vitest (by detecting process.argv),
// but the explicit mock lets tests that care assert on call counts and avoids
// the per-file allowlist in test-isolation.contract.test.ts.
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "minimax",
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

describe("tool capability gating", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("ToolDefinition accepts optional requiredCapability field", async () => {
    emitTestEvent("ToolDefinition requiredCapability field")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    type ToolDefinition = import("../../repertoire/tools-base").ToolDefinition
    const toolDef: ToolDefinition = {
      tool: {
        type: "function",
        function: {
          name: "test_tool",
          description: "test",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: () => "ok",
      requiredCapability: "reasoning-effort",
    }
    expect(toolDef.requiredCapability).toBe("reasoning-effort")
    // Existing tools without requiredCapability
    const readFile = baseToolDefinitions.find(d => d.tool.function.name === "read_file")
    expect(readFile).toBeDefined()
    expect(readFile!.requiredCapability).toBeUndefined()
  })

  it("getToolsForChannel accepts providerCapabilities parameter", async () => {
    emitTestEvent("getToolsForChannel accepts providerCapabilities")
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { getToolsForChannel } = await import("../../repertoire/tools")
    // Should accept the new parameter without error
    const tools = getToolsForChannel(undefined, undefined, undefined, new Set(["reasoning-effort"]))
    expect(tools.length).toBeGreaterThan(0)
  })

  it("getToolsForChannel filters out tools whose requiredCapability is not in providerCapabilities", async () => {
    emitTestEvent("getToolsForChannel filters gated tools")
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const toolsBase = await import("../../repertoire/tools-base")
    // Add a mock tool with requiredCapability to baseToolDefinitions
    const mockGatedTool = {
      tool: {
        type: "function" as const,
        function: {
          name: "_test_gated_tool",
          description: "test gated tool",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: () => "ok",
      requiredCapability: "reasoning-effort" as const,
    }
    toolsBase.baseToolDefinitions.push(mockGatedTool)
    try {
      const { getToolsForChannel } = await import("../../repertoire/tools")
      // Without the capability, the gated tool should be excluded
      const withoutCap = getToolsForChannel(undefined, undefined, undefined, new Set())
      expect(withoutCap.find(t => t.function.name === "_test_gated_tool")).toBeUndefined()
      // With the capability, the gated tool should be included
      const withCap = getToolsForChannel(undefined, undefined, undefined, new Set(["reasoning-effort"]))
      expect(withCap.find(t => t.function.name === "_test_gated_tool")).toBeDefined()
    } finally {
      // Clean up
      const idx = toolsBase.baseToolDefinitions.findIndex(d => d.tool.function.name === "_test_gated_tool")
      if (idx >= 0) toolsBase.baseToolDefinitions.splice(idx, 1)
    }
  })

  it("getToolsForChannel without providerCapabilities param excludes all capability-gated tools", async () => {
    emitTestEvent("getToolsForChannel no param excludes gated")
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const toolsBase = await import("../../repertoire/tools-base")
    const mockGatedTool = {
      tool: {
        type: "function" as const,
        function: {
          name: "_test_gated_tool_2",
          description: "test gated tool 2",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: () => "ok",
      requiredCapability: "phase-annotation" as const,
    }
    toolsBase.baseToolDefinitions.push(mockGatedTool)
    try {
      const { getToolsForChannel } = await import("../../repertoire/tools")
      // No providerCapabilities param = exclude all gated tools
      const tools = getToolsForChannel()
      expect(tools.find(t => t.function.name === "_test_gated_tool_2")).toBeUndefined()
    } finally {
      const idx = toolsBase.baseToolDefinitions.findIndex(d => d.tool.function.name === "_test_gated_tool_2")
      if (idx >= 0) toolsBase.baseToolDefinitions.splice(idx, 1)
    }
  })
})
