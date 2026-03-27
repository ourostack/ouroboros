import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  mkdirSync: vi.fn(),
}))

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn().mockReturnValue([]),
  loadSkill: vi.fn(),
}))

vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({
    getBoard: vi.fn().mockReturnValue({ compact: "", full: "", byStatus: {}, actionRequired: [], unresolvedDependencies: [], activeSessions: [], activeBridges: [] }),
  }),
}))

vi.mock("../../heart/identity", () => {
  const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
  return {
    DEFAULT_AGENT_CONTEXT,
    loadAgentConfig: vi.fn(() => ({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "minimax",
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

import * as fs from "fs"

const MOCK_PACKAGE_JSON = JSON.stringify({ version: "0.1.0-alpha.20" })
const MOCK_SOUL = "i am a witty agent."
const MOCK_IDENTITY = "i am Ouroboros."
const MOCK_LORE = "i am named after the ouroboros."
const MOCK_FRIENDS = "my creator talks to me."
const MOCK_TACIT_KNOWLEDGE = "structured logging is good."
const MOCK_ASPIRATIONS = "keep improving."

function setupReadFileSync() {
  vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
    const p = String(filePath)
    if (p.endsWith("SOUL.md")) return MOCK_SOUL
    if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
    if (p.endsWith("LORE.md")) return MOCK_LORE
    if (p.endsWith("FRIENDS.md")) return MOCK_FRIENDS
    if (p.endsWith("TACIT.md")) return MOCK_TACIT_KNOWLEDGE
    if (p.endsWith("ASPIRATIONS.md")) return MOCK_ASPIRATIONS
    if (p.endsWith("secrets.json")) return JSON.stringify({})
    if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
    return ""
  })
}

describe("runtimeInfoSection mcp channel", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
  })

  it("mcp channel includes dev tool guidance", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("mcp")
    expect(result).toContain("dev tool")
  })

  it("mcp channel mentions settle and ponder", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("mcp")
    expect(result).toContain("settle")
    expect(result).toContain("ponder")
  })

  it("mcp channel includes process type label 'mcp bridge'", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("mcp")
    expect(result).toContain("mcp bridge")
  })

  it("mcp channel does NOT include CLI boot greeting", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("mcp")
    expect(result).not.toContain("i introduce myself on boot")
  })

  it("mcp channel does NOT include Teams or iMessage behavior", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("mcp")
    expect(result).not.toContain("Microsoft Teams")
    expect(result).not.toContain("iMessage")
  })
})
