import { describe, it, expect, vi, beforeEach } from "vitest"

// Test that buildSystem returns a SystemPrompt with stable/volatile
// and that the ProviderTurnRequest type includes systemPrompt.

function defaultReadFileSync(filePath: any, _encoding?: any): string {
  const p = String(filePath)
  if (p.endsWith("SOUL.md")) return "mock soul"
  if (p.endsWith("IDENTITY.md")) return "mock identity"
  if (p.endsWith("LORE.md")) return "mock lore"
  if (p.endsWith("FRIENDS.md")) return "mock friends"
  if (p.endsWith("package.json")) return JSON.stringify({ name: "ouro" })
  return ""
}

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(defaultReadFileSync),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  }
})

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/mock/agent-root"),
  getAgentName: vi.fn(() => "testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  getAgentRepoWorkspacesRoot: vi.fn(() => "/mock/repo/testagent/state/workspaces"),
  getAgentSecretsPath: vi.fn(() => "/mock/secrets.json"),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "minimax",
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
    context: { maxTokens: 80000, contextMargin: 20 },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  HARNESS_CANONICAL_REPO_URL: "https://github.com/ouroborosbot/ouroboros.git",
  resetIdentity: vi.fn(),
}))

vi.mock("../../heart/daemon/runtime-mode", () => ({
  detectRuntimeMode: vi.fn(() => "dev"),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(() => []),
}))

vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({
    getBoard: vi.fn(() => ({ compact: "" })),
  }),
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

vi.mock("../../heart/core", () => ({
  getProviderDisplayLabel: vi.fn(() => "mock-provider"),
}))

vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

describe("ProviderTurnRequest systemPrompt passthrough", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("buildSystem returns SystemPrompt with volatile date and stable identity", async () => {
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem("cli")

    // SystemPrompt structure
    expect(result).toHaveProperty("stable")
    expect(result).toHaveProperty("volatile")
    expect(typeof result.stable).toBe("string")
    expect(typeof result.volatile).toBe("string")

    // date/rhythm in volatile, not stable
    expect(result.volatile).toContain("current date and time:")
    expect(result.stable).not.toContain("current date and time:")

    // identity in stable
    expect(result.stable).toContain("mock identity")

    // flattenSystemPrompt produces the full combined text
    const flat = flattenSystemPrompt(result)
    expect(flat).toContain("mock identity")
    expect(flat).toContain("current date and time:")
  })
})
