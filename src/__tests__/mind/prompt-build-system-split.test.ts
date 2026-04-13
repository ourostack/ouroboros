import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

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

const mockGetBoard = vi.fn()
vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({
    getBoard: mockGetBoard,
  }),
}))

vi.mock("../../heart/identity", () => {
  const DEFAULT_AGENT_CONTEXT = {
    maxTokens: 80000,
    contextMargin: 20,
  }
  return {
    DEFAULT_AGENT_CONTEXT,
    loadAgentConfig: vi.fn(() => ({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })),
    getAgentName: vi.fn(() => "testagent"),
    getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
    getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
    getRepoRoot: vi.fn(() => "/mock/repo"),
    getAgentRepoWorkspacesRoot: vi.fn(() => "/mock/repo/testagent/state/workspaces"),
    HARNESS_CANONICAL_REPO_URL: "https://github.com/ouroborosbot/ouroboros.git",
    resetIdentity: vi.fn(),
  }
})

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } }
    responses = { create: vi.fn() }
    constructor(_opts?: any) {}
  }
  return {
    default: MockOpenAI,
    AzureOpenAI: MockOpenAI,
  }
})

vi.mock("../../heart/core", () => ({
  getProviderDisplayLabel: vi.fn(() => "mock-provider"),
}))

vi.mock("../../heart/daemon/runtime-mode", () => ({
  detectRuntimeMode: vi.fn(() => "dev"),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../mind/friends/channel", () => ({
  getChannelCapabilities: vi.fn(() => ({
    channel: "cli",
    availableIntegrations: [],
    supportsMarkdown: true,
    supportsStreaming: true,
    supportsRichCards: false,
  })),
  isRemoteChannel: vi.fn(() => false),
  channelToFacing: vi.fn(() => "human"),
}))

vi.mock("../../mind/first-impressions", () => ({
  getFirstImpressions: vi.fn(() => null),
}))

import * as fs from "fs"

const MOCK_PACKAGE_JSON = JSON.stringify({ version: "0.1.0-alpha.20" })
const MOCK_SOUL = "i am a witty, funny, competent chaos monkey coding assistant."
const MOCK_IDENTITY = "i am Ouroboros."
const MOCK_LORE = "i am named after the ouroboros."
const MOCK_TACIT_KNOWLEDGE = "structured logging is better."
const MOCK_ASPIRATIONS = "keep improving."

function setupReadFileSync() {
  vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
    const p = String(filePath)
    if (p.endsWith("SOUL.md")) return MOCK_SOUL
    if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
    if (p.endsWith("LORE.md")) return MOCK_LORE
    if (p.endsWith("TACIT.md")) return MOCK_TACIT_KNOWLEDGE
    if (p.endsWith("ASPIRATIONS.md")) return MOCK_ASPIRATIONS
    if (p.endsWith("secrets.json")) return JSON.stringify({})
    if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
    return ""
  })
}

describe("buildSystem returns SystemPrompt", () => {
  beforeEach(() => {
    vi.resetModules()
    mockGetBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [],
        processing: [],
        validating: [],
        collaborating: [],
        paused: [],
        blocked: [],
        done: [],
        cancelled: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
  })

  it("returns an object with stable and volatile string fields", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem()

    expect(result).toHaveProperty("stable")
    expect(result).toHaveProperty("volatile")
    expect(typeof result.stable).toBe("string")
    expect(typeof result.volatile).toBe("string")
  })

  it("places dateSection output in volatile, not stable", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem()

    expect(result.volatile).toContain("current date and time:")
    expect(result.stable).not.toContain("current date and time:")
  })

  it("places rhythmStatusSection output in volatile, not stable", async () => {
    setupReadFileSync()
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
      const p = String(filePath)
      if (p.endsWith("SOUL.md")) return MOCK_SOUL
      if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
      if (p.endsWith("LORE.md")) return MOCK_LORE
      if (p.endsWith("TACIT.md")) return MOCK_TACIT_KNOWLEDGE
      if (p.endsWith("ASPIRATIONS.md")) return MOCK_ASPIRATIONS
      if (p.endsWith("secrets.json")) return JSON.stringify({})
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      if (p.endsWith("daemon-health.json")) return JSON.stringify({
        habits: { ponder: { lastFired: new Date().toISOString() } },
        degraded: [],
      })
      return ""
    })
    vi.mocked(fs.existsSync).mockImplementation((filePath: any) => {
      const p = String(filePath)
      if (p.includes("daemon-health.json")) return true
      return false
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem("cli", {
      daemonHealth: {
        habits: { ponder: { lastFired: new Date().toISOString() } },
        degraded: [],
      },
    })

    // rhythmStatusSection produces "my rhythms: ..." when health data exists
    expect(result.volatile).toContain("my rhythms:")
    expect(result.stable).not.toContain("my rhythms:")
  })

  it("places Groups 1-6 content in stable", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem()

    // Group 1: soul, identity
    expect(result.stable).toContain("# who i am")
    expect(result.stable).toContain("chaos monkey coding assistant")
    expect(result.stable).toContain("i am Ouroboros")

    // Group 2: body & environment (minus date/rhythm)
    expect(result.stable).toContain("# my body & environment")

    // Group 3: tools & capabilities
    expect(result.stable).toContain("# my tools & capabilities")

    // Group 4: how i work
    expect(result.stable).toContain("# how i work")
  })

  it("places Groups 7-9 content in volatile", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem()

    // Group 7: dynamic state
    expect(result.volatile).toContain("# dynamic state for this turn")

    // Group 8: friend context
    expect(result.volatile).toContain("# friend context")

    // Group 9: task context
    expect(result.volatile).toContain("# task context")
  })
})
