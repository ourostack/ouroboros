import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "engine",
    event: "engine.test_run",
    message: testName,
    meta: { test: true },
  })
}

// Default readFileSync: return psyche file stubs so prompt.ts module-level loads work
function defaultReadFileSync(filePath: any, _encoding?: any): string {
  const p = String(filePath)
  if (p.endsWith("SOUL.md")) return "mock soul"
  if (p.endsWith("IDENTITY.md")) return "mock identity"
  if (p.endsWith("package.json")) return JSON.stringify({ name: "other" })
  return ""
}

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(defaultReadFileSync),
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
    provider: "azure",
    humanFacing: { provider: "azure", model: "gpt-4o" },
    agentFacing: { provider: "azure", model: "gpt-4o" },
  })),
  DEFAULT_AGENT_CONTEXT: {
    maxTokens: 80000,
    contextMargin: 20,
  },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

const mockAzureOpenAICtor = vi.fn()
const mockChatCreate = vi.fn().mockResolvedValue({ choices: [{ message: { content: "summary" } }] })

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: mockChatCreate } }
    responses = { create: vi.fn() }
    constructor(opts?: any) { mockAzureOpenAICtor(opts) }
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class MockDefaultAzureCredential {
    getToken = vi.fn().mockResolvedValue({ token: "mock-token" })
    constructor() {}
  },
}))

vi.mock("../../mind/note-search", () => ({
  injectNoteSearchContext: vi.fn().mockResolvedValue(undefined),
}))

describe("azure provider fingerprint includes managedIdentityClientId", () => {
  beforeEach(() => {
    vi.resetModules()
    mockAzureOpenAICtor.mockReset()
    mockChatCreate.mockClear()
  })

  it("fingerprint with managedIdentityClientId undefined differs from one with a value", async () => {
    emitTestEvent("fingerprint managedIdentityClientId undefined vs value")

    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "key-1",
          endpoint: "https://test.openai.azure.com",
          deployment: "gpt-4",
          modelName: "gpt-4",
        },
      },
    })

    // First call: create provider with no managedIdentityClientId
    const { createSummarize, resetProviderRuntime } = await import("../../heart/core")
    resetProviderRuntime()
    await createSummarize()("hello", "summarize")
    expect(mockAzureOpenAICtor).toHaveBeenCalledTimes(1)

    // Change managedIdentityClientId
    config.patchRuntimeConfig({
      providers: {
        azure: {
          managedIdentityClientId: "c404d5a9-1234-5678-abcd-ef0123456789",
        },
      },
    })

    // Second call: should detect fingerprint change and re-create provider
    await createSummarize()("hello", "summarize")
    expect(mockAzureOpenAICtor).toHaveBeenCalledTimes(2)
  })

  it("fingerprint with apiKey and empty managedIdentityClientId differs from empty apiKey with managedIdentityClientId", async () => {
    emitTestEvent("fingerprint key-auth vs managedIdentityClientId")

    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "key123",
          endpoint: "https://test.openai.azure.com",
          deployment: "gpt-4",
          modelName: "gpt-4",
          managedIdentityClientId: "",
        },
      },
    })

    const { createSummarize, resetProviderRuntime } = await import("../../heart/core")
    resetProviderRuntime()
    await createSummarize()("hello", "summarize")
    expect(mockAzureOpenAICtor).toHaveBeenCalledTimes(1)

    // Switch to managed identity
    config.patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "",
          managedIdentityClientId: "c404d5a9-1234-5678-abcd-ef0123456789",
        },
      },
    })

    await createSummarize()("hello", "summarize")
    expect(mockAzureOpenAICtor).toHaveBeenCalledTimes(2)
  })
})
