import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "mind",
    event: "mind.test_run",
    message: testName,
    meta: { test: true },
  })
}

function defaultReadFileSync(filePath: any, _encoding?: any): string {
  const p = String(filePath)
  if (p.endsWith("SOUL.md")) return "mock soul"
  if (p.endsWith("IDENTITY.md")) return "mock identity"
  if (p.endsWith("LORE.md")) return ""
  if (p.endsWith("TACIT.md")) return ""
  if (p.endsWith("ASPIRATIONS.md")) return ""
  if (p.endsWith("package.json")) return JSON.stringify({ name: "other", version: "0.1.0" })
  if (p.endsWith("bundle-meta.json")) return JSON.stringify({})
  if (p.endsWith("CHANGELOG.json")) return "[]"
  if (p.endsWith("agent.json")) return JSON.stringify({ name: "testagent", provider: "minimax" })
  if (p.endsWith("secrets.json")) return JSON.stringify({})
  return ""
}

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(defaultReadFileSync),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: 0 })),
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

vi.mock("child_process", () => ({ execSync: vi.fn(), spawnSync: vi.fn() }))
vi.mock("../../repertoire/skills", () => ({ listSkills: vi.fn(() => []), loadSkill: vi.fn() }))
vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({ getBoard: () => ({ compact: "" }) }),
}))

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "minimax",
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
    senses: { cli: { enabled: true }, teams: { enabled: false }, bluebubbles: { enabled: false } },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

vi.mock("openai", () => {
  class MockOpenAI { chat = { completions: { create: vi.fn() } }; constructor() {} }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

describe("system prompt reasoning effort section", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("includes reasoning effort section when provider has reasoning-effort capability", async () => {
    emitTestEvent("prompt includes reasoning effort")
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { resetPsycheCache, buildSystem, flattenSystemPrompt } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = flattenSystemPrompt(await buildSystem("cli", {
      providerCapabilities: new Set(["reasoning-effort"]),
      supportedReasoningEfforts: ["low", "medium", "high"],
    }))
    expect(system).toContain("reasoning effort")
    expect(system).toContain("set_reasoning_effort")
  })

  it("does not include reasoning effort section when provider lacks capability", async () => {
    emitTestEvent("prompt excludes reasoning effort")
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { resetPsycheCache, buildSystem, flattenSystemPrompt } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = flattenSystemPrompt(await buildSystem("cli", {
      providerCapabilities: new Set(),
    }))
    expect(system).not.toContain("set_reasoning_effort")
  })

  it("does not include reasoning effort section when no options provided", async () => {
    emitTestEvent("prompt no options no reasoning effort")
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { resetPsycheCache, buildSystem, flattenSystemPrompt } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = flattenSystemPrompt(await buildSystem("cli"))
    expect(system).not.toContain("set_reasoning_effort")
  })

  it("shows 'varies by model' when supportedReasoningEfforts is undefined", async () => {
    emitTestEvent("prompt reasoning effort varies by model")
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { resetPsycheCache, buildSystem, flattenSystemPrompt } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = flattenSystemPrompt(await buildSystem("cli", {
      providerCapabilities: new Set(["reasoning-effort"]),
      // No supportedReasoningEfforts provided
    }))
    expect(system).toContain("varies by model")
  })

  it("shows 'varies by model' when supportedReasoningEfforts is empty", async () => {
    emitTestEvent("prompt reasoning effort empty levels")
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { resetPsycheCache, buildSystem, flattenSystemPrompt } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = flattenSystemPrompt(await buildSystem("cli", {
      providerCapabilities: new Set(["reasoning-effort"]),
      supportedReasoningEfforts: [],
    }))
    expect(system).toContain("varies by model")
  })
})
