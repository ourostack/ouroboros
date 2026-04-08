import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "engine",
    event: "engine.test_run",
    message: testName,
    meta: { test: true },
  })
}

// Mock @azure/identity before any imports that use it
const mockGetToken = vi.fn()
const mockDefaultAzureCredentialCtor = vi.fn()

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class MockDefaultAzureCredential {
    getToken: typeof mockGetToken
    constructor(opts?: any) {
      mockDefaultAzureCredentialCtor(opts)
      this.getToken = mockGetToken
    }
  },
}))

// Hard-mock the daemon socket client. The runtime guard in socket-client.ts
// already prevents real socket calls under vitest (by detecting process.argv),
// but the explicit mock lets tests that care assert on call counts and avoids
// the per-file allowlist in test-isolation.contract.test.ts.
vi.mock("../../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

// Mock openai
const mockAzureOpenAICtor = vi.fn()
vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } }
    responses = { create: vi.fn() }
    constructor(opts?: any) { mockAzureOpenAICtor(opts) }
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

// Mock fs
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

vi.mock("../../../heart/identity", () => ({
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

vi.mock("../../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

describe("createAzureTokenProvider", () => {
  beforeEach(() => {
    mockGetToken.mockReset()
    mockDefaultAzureCredentialCtor.mockReset()
  })

  it("creates DefaultAzureCredential with managedIdentityClientId when provided", async () => {
    emitTestEvent("creates DefaultAzureCredential with managedIdentityClientId when provided")
    mockGetToken.mockResolvedValue({ token: "test-token-123" })

    const { createAzureTokenProvider } = await import("../../../heart/providers/azure")
    const tokenProvider = createAzureTokenProvider("c404d5a9-1234-5678-abcd-ef0123456789")

    // Credential is created lazily on first call (dynamic import)
    expect(mockDefaultAzureCredentialCtor).not.toHaveBeenCalled()

    const token = await tokenProvider()
    expect(token).toBe("test-token-123")
    expect(mockDefaultAzureCredentialCtor).toHaveBeenCalledWith({
      managedIdentityClientId: "c404d5a9-1234-5678-abcd-ef0123456789",
    })
    expect(mockGetToken).toHaveBeenCalledWith("https://cognitiveservices.azure.com/.default")
  })

  it("creates DefaultAzureCredential without options when no client ID provided", async () => {
    emitTestEvent("creates DefaultAzureCredential without options when no client ID provided")
    mockGetToken.mockResolvedValue({ token: "local-dev-token" })

    const { createAzureTokenProvider } = await import("../../../heart/providers/azure")
    const tokenProvider = createAzureTokenProvider()

    const token = await tokenProvider()
    expect(token).toBe("local-dev-token")
    expect(mockDefaultAzureCredentialCtor).toHaveBeenCalledWith(undefined)
  })

  it("creates DefaultAzureCredential without options when client ID is empty string", async () => {
    emitTestEvent("creates DefaultAzureCredential without options when client ID is empty string")
    mockGetToken.mockResolvedValue({ token: "local-dev-token-2" })

    const { createAzureTokenProvider } = await import("../../../heart/providers/azure")
    const tokenProvider = createAzureTokenProvider("")

    const token = await tokenProvider()
    expect(token).toBe("local-dev-token-2")
    expect(mockDefaultAzureCredentialCtor).toHaveBeenCalledWith(undefined)
  })

  it("throws with clear error message including original error when getToken fails", async () => {
    emitTestEvent("throws with clear error message including original error when getToken fails")
    mockGetToken.mockRejectedValue(new Error("CredentialUnavailableError"))

    const { createAzureTokenProvider } = await import("../../../heart/providers/azure")
    const tokenProvider = createAzureTokenProvider()

    await expect(tokenProvider()).rejects.toThrow(
      /Azure OpenAI authentication failed: CredentialUnavailableError/,
    )
    await expect(tokenProvider()).rejects.toThrow(
      /az login/,
    )
    await expect(tokenProvider()).rejects.toThrow(
      /managedIdentityClientId/,
    )
  })

  it("includes non-Error thrown values in the error message", async () => {
    emitTestEvent("includes non-Error thrown values in the error message")
    mockGetToken.mockRejectedValue("raw string failure")

    const { createAzureTokenProvider } = await import("../../../heart/providers/azure")
    const tokenProvider = createAzureTokenProvider()

    await expect(tokenProvider()).rejects.toThrow(
      /Azure OpenAI authentication failed: raw string failure/,
    )
  })
})

describe("createAzureProviderRuntime", () => {
  beforeEach(() => {
    vi.resetModules()
    mockAzureOpenAICtor.mockReset()
    mockGetToken.mockReset()
    mockDefaultAzureCredentialCtor.mockReset()
  })

  it("uses apiKey when present and non-empty (existing behavior)", async () => {
    emitTestEvent("uses key auth when present and non-empty")

    const config = await import("../../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "test-api-key",
          endpoint: "https://test.openai.azure.com",
          deployment: "gpt-4",
        },
      },
    })

    const { createAzureProviderRuntime } = await import("../../../heart/providers/azure")
    const runtime = createAzureProviderRuntime("gpt-4")

    expect(runtime.id).toBe("azure")
    expect(runtime.model).toBe("gpt-4")
    expect(mockAzureOpenAICtor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-api-key",
      }),
    )
    // Should NOT have azureADTokenProvider
    const ctorArgs = mockAzureOpenAICtor.mock.calls[0][0]
    expect(ctorArgs.azureADTokenProvider).toBeUndefined()
  })

  it("uses azureADTokenProvider when apiKey is empty and managedIdentityClientId is set", async () => {
    emitTestEvent("uses azureADTokenProvider with managedIdentityClientId")

    const config = await import("../../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "",
          endpoint: "https://test.openai.azure.com",
          deployment: "gpt-4",
          managedIdentityClientId: "c404d5a9-test",
        },
      },
    })

    const { createAzureProviderRuntime } = await import("../../../heart/providers/azure")
    const runtime = createAzureProviderRuntime("gpt-4")

    expect(runtime.id).toBe("azure")
    const ctorArgs = mockAzureOpenAICtor.mock.calls[0][0]
    expect(ctorArgs.apiKey).toBeUndefined()
    expect(typeof ctorArgs.azureADTokenProvider).toBe("function")
    // Credential is created lazily on first token call, not at provider init
    expect(mockDefaultAzureCredentialCtor).not.toHaveBeenCalled()
    // Trigger lazy init and verify
    mockGetToken.mockResolvedValue({ token: "lazy-token" })
    await ctorArgs.azureADTokenProvider()
    expect(mockDefaultAzureCredentialCtor).toHaveBeenCalledWith({
      managedIdentityClientId: "c404d5a9-test",
    })
  })

  it("uses azureADTokenProvider with default credential chain when apiKey empty and no managedIdentityClientId", async () => {
    emitTestEvent("uses azureADTokenProvider with default credential chain")

    const config = await import("../../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "",
          endpoint: "https://test.openai.azure.com",
          deployment: "gpt-4",
        },
      },
    })

    const { createAzureProviderRuntime } = await import("../../../heart/providers/azure")
    const runtime = createAzureProviderRuntime("gpt-4")

    expect(runtime.id).toBe("azure")
    const ctorArgs = mockAzureOpenAICtor.mock.calls[0][0]
    expect(ctorArgs.apiKey).toBeUndefined()
    expect(typeof ctorArgs.azureADTokenProvider).toBe("function")
    // Credential is created lazily — trigger it and verify default chain (no managedIdentityClientId)
    mockGetToken.mockResolvedValue({ token: "lazy-token-2" })
    await ctorArgs.azureADTokenProvider()
    expect(mockDefaultAzureCredentialCtor).toHaveBeenCalledWith(undefined)
  })

  it("still requires endpoint and deployment in all paths", async () => {
    emitTestEvent("requires endpoint deployment")

    const config = await import("../../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "test-key",
          endpoint: "",
          deployment: "",
        },
      },
    })

    const { createAzureProviderRuntime } = await import("../../../heart/providers/azure")
    expect(() => createAzureProviderRuntime("gpt-4")).toThrow(/incomplete/)
  })

  it("still requires endpoint and deployment when using managed identity", async () => {
    emitTestEvent("requires endpoint deployment with managed identity")

    const config = await import("../../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "",
          endpoint: "",
          deployment: "",
          managedIdentityClientId: "c404d5a9-test",
        },
      },
    })

    const { createAzureProviderRuntime } = await import("../../../heart/providers/azure")
    expect(() => createAzureProviderRuntime("gpt-4")).toThrow(/incomplete/)
  })

  it("includes authMethod in provider_init nerves event", async () => {
    emitTestEvent("includes authMethod in provider_init nerves event")
    const emitSpy = vi.fn()
    vi.doMock("../../../nerves/runtime", () => ({
      emitNervesEvent: emitSpy,
    }))

    const config = await import("../../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "test-key",
          endpoint: "https://test.openai.azure.com",
          deployment: "gpt-4",
        },
      },
    })

    const { createAzureProviderRuntime } = await import("../../../heart/providers/azure")
    createAzureProviderRuntime("gpt-4")

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "engine.provider_init",
        meta: expect.objectContaining({ authMethod: "key" }),
      }),
    )
  })

  it("reports managed-identity authMethod in nerves event when using token provider", async () => {
    emitTestEvent("reports managed-identity authMethod in nerves event")
    const emitSpy = vi.fn()
    vi.doMock("../../../nerves/runtime", () => ({
      emitNervesEvent: emitSpy,
    }))

    const config = await import("../../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "",
          endpoint: "https://test.openai.azure.com",
          deployment: "gpt-4",
        },
      },
    })

    const { createAzureProviderRuntime } = await import("../../../heart/providers/azure")
    createAzureProviderRuntime("gpt-4")

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "engine.provider_init",
        meta: expect.objectContaining({ authMethod: "managed-identity" }),
      }),
    )
  })
})
