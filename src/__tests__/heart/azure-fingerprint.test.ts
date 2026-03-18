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
    provider: "azure",
  })),
  DEFAULT_AGENT_CONTEXT: {
    maxTokens: 80000,
    contextMargin: 20,
  },
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

const mockAzureOpenAICtor = vi.fn()

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } }
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

vi.mock("../../mind/associative-recall", () => ({
  injectAssociativeRecall: vi.fn().mockResolvedValue(undefined),
}))

describe("azure provider fingerprint includes managedIdentityClientId", () => {
  beforeEach(() => {
    vi.resetModules()
    mockAzureOpenAICtor.mockReset()
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
    const { getModel, resetProviderRuntime } = await import("../../heart/core")
    resetProviderRuntime()
    getModel() // triggers provider creation
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
    getModel()
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

    const { getModel, resetProviderRuntime } = await import("../../heart/core")
    resetProviderRuntime()
    getModel()
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

    getModel()
    expect(mockAzureOpenAICtor).toHaveBeenCalledTimes(2)
  })
})
