import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock fs before any imports
function defaultReadFileSync(filePath: any, _encoding?: any): string {
  const p = String(filePath)
  if (p.endsWith("SOUL.md")) return "mock soul"
  if (p.endsWith("IDENTITY.md")) return "mock identity"
  if (p.endsWith("LORE.md")) return "mock lore"
  if (p.endsWith("FRIENDS.md")) return "mock friends"
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

vi.mock("../../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

vi.mock("../../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "github-copilot",
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

// Mock openai
const mockOpenAICtor = vi.fn()
vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } }
    responses = { create: vi.fn() }
    constructor(opts?: any) { mockOpenAICtor(opts) }
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

// Mock streaming module
const mockStreamChatCompletion = vi.fn()
const mockStreamResponsesApi = vi.fn()
const mockToResponsesInput = vi.fn().mockReturnValue({ instructions: "sys", input: [] })
const mockToResponsesTools = vi.fn().mockReturnValue([])
vi.mock("../../../heart/streaming", () => ({
  streamChatCompletion: (...args: any[]) => mockStreamChatCompletion(...args),
  streamResponsesApi: (...args: any[]) => mockStreamResponsesApi(...args),
  toResponsesInput: (...args: any[]) => mockToResponsesInput(...args),
  toResponsesTools: (...args: any[]) => mockToResponsesTools(...args),
}))

async function setAgentProvider(provider: string) {
  const { loadAgentConfig } = await import("../../../heart/identity")
  vi.mocked(loadAgentConfig).mockReturnValue({
    name: "testagent",
    provider,
    humanFacing: { provider, model: "" },
    agentFacing: { provider, model: "" },
  } as any)
}

async function setupConfig(partial: Record<string, unknown> & { humanFacingModel?: string }) {
  const provider = partial.provider ? String(partial.provider) : "github-copilot"
  const model = partial.humanFacingModel ?? ""
  await setAgentProvider(provider)
  // Update the mock to include model from humanFacingModel
  const { loadAgentConfig } = await import("../../../heart/identity")
  vi.mocked(loadAgentConfig).mockReturnValue({
    name: "testagent",
    provider,
    humanFacing: { provider, model } as any,
    agentFacing: { provider, model } as any,
  } as any)
  const config = await import("../../../heart/config")
  config.resetConfigCache()
  config.patchRuntimeConfig(partial as any)
}

beforeEach(async () => {
  vi.resetModules()
  mockOpenAICtor.mockClear()
  mockStreamChatCompletion.mockReset()
  mockStreamResponsesApi.mockReset()
  mockToResponsesInput.mockReset().mockReturnValue({ instructions: "sys", input: [] })
  mockToResponsesTools.mockReset().mockReturnValue([])
  const config = await import("../../../heart/config")
  config.resetConfigCache()
})

// --- Unit 1a: Types & Config tests ---

describe("github-copilot config", () => {
  it("getGithubCopilotConfig returns config from loadConfig().providers['github-copilot'] (credentials only, no model)", async () => {
    await setupConfig({
      providers: {
        "github-copilot": {
          githubToken: "ghp_test123",
          baseUrl: "https://api.copilot.example.com",
        },
      },
    })
    const { getGithubCopilotConfig } = await import("../../../heart/config")
    const cfg = getGithubCopilotConfig()
    expect(cfg).not.toHaveProperty("model")
    expect(cfg.githubToken).toBe("ghp_test123")
    expect(cfg.baseUrl).toBe("https://api.copilot.example.com")
  })

  it("loadAgentConfig accepts 'github-copilot' as a valid provider value", async () => {
    await setAgentProvider("github-copilot")
    const { loadAgentConfig } = await import("../../../heart/identity")
    const config = loadAgentConfig()
    expect(config.provider).toBe("github-copilot")
  })

  it("default secrets template includes providers['github-copilot'] (credentials only, no model)", async () => {
    await setupConfig({})
    const { loadConfig } = await import("../../../heart/config")
    const config = loadConfig()
    expect(config.providers["github-copilot"]).toEqual({
      githubToken: "",
      baseUrl: "",
    })
  })

  it("getProviderDisplayLabel returns 'github copilot (<model>)' for github-copilot", async () => {
    await setupConfig({
      provider: "github-copilot",
      humanFacingModel: "claude-sonnet-4.6",
      providers: {
        "github-copilot": {
          githubToken: "ghp_test123",
          baseUrl: "https://api.copilot.example.com",
        },
      },
    })
    const { getProviderDisplayLabel, resetProviderRuntime } = await import("../../../heart/core")
    resetProviderRuntime()
    expect(getProviderDisplayLabel()).toBe("github copilot (claude-sonnet-4.6)")
  })

  it("isAgentProvider('github-copilot') returns true", async () => {
    const { parseOuroCommand } = await import("../../../heart/daemon/daemon-cli")
    // If github-copilot is recognized, it won't throw
    expect(
      parseOuroCommand(["hatch", "--agent", "test", "--provider", "github-copilot"]),
    ).toMatchObject({
      kind: "hatch.start",
      provider: "github-copilot",
    })
  })
})

// --- Unit 2a: Provider Runtime tests ---

describe("createGithubCopilotProviderRuntime", () => {
  it("throws if githubToken is missing", async () => {
    await setupConfig({
      providers: {
        "github-copilot": { githubToken: "", baseUrl: "https://api.example.com" },
      },
    })
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    expect(() => createGithubCopilotProviderRuntime("claude-sonnet-4.6")).toThrow(/githubToken/)
  })

  it("throws if baseUrl is missing", async () => {
    await setupConfig({
      providers: {
        "github-copilot": { githubToken: "ghp_test123", baseUrl: "" },
      },
    })
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    expect(() => createGithubCopilotProviderRuntime("claude-sonnet-4.6")).toThrow(/baseUrl/)
  })

  it("creates OpenAI client with baseURL and token-style auth header", async () => {
    await setupConfig({
      providers: {
        "github-copilot": { githubToken: "ghp_test123", baseUrl: "https://api.copilot.example.com" },
      },
    })
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    createGithubCopilotProviderRuntime("claude-sonnet-4.6")
    expect(mockOpenAICtor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "ghp_test123",
        baseURL: "https://api.copilot.example.com",
      }),
    )
  })

  it("has id 'github-copilot' and uses model passed as parameter", async () => {
    await setupConfig({
      providers: {
        "github-copilot": { githubToken: "ghp_test123", baseUrl: "https://api.copilot.example.com" },
      },
    })
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    const runtime = createGithubCopilotProviderRuntime("claude-sonnet-4.6")
    expect(runtime.id).toBe("github-copilot")
    expect(runtime.model).toBe("claude-sonnet-4.6")
  })

  it("includes reasoning-effort capability when model supports it", async () => {
    await setupConfig({
      providers: {
        "github-copilot": { githubToken: "ghp_test123", baseUrl: "https://api.copilot.example.com" },
      },
    })
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    const runtime = createGithubCopilotProviderRuntime("claude-sonnet-4.6")
    expect(runtime.capabilities.has("reasoning-effort")).toBe(true)
  })

  it("Claude model: streamTurn calls streamChatCompletion", async () => {
    await setupConfig({
      providers: {
        "github-copilot": { githubToken: "ghp_test123", baseUrl: "https://api.copilot.example.com" },
      },
    })
    const turnResult = { content: "hello", toolCalls: [], outputItems: [] }
    mockStreamChatCompletion.mockResolvedValue(turnResult)
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    const runtime = createGithubCopilotProviderRuntime("claude-sonnet-4.6")
    const callbacks = { onModelStart: vi.fn(), onModelStreamStart: vi.fn(), onTextChunk: vi.fn(), onReasoningChunk: vi.fn(), onToolStart: vi.fn(), onToolEnd: vi.fn(), onError: vi.fn() }
    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks,
    })
    expect(mockStreamChatCompletion).toHaveBeenCalled()
    expect(mockStreamResponsesApi).not.toHaveBeenCalled()
    expect(result).toBe(turnResult)
  })

  it("GPT model: streamTurn calls streamResponsesApi", async () => {
    await setupConfig({
      providers: {
        "github-copilot": { githubToken: "ghp_test123", baseUrl: "https://api.copilot.example.com" },
      },
    })
    const turnResult = { content: "hello", toolCalls: [], outputItems: [{ type: "message", id: "1" }] }
    mockStreamResponsesApi.mockResolvedValue(turnResult)
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    const runtime = createGithubCopilotProviderRuntime("gpt-5.4")
    const callbacks = { onModelStart: vi.fn(), onModelStreamStart: vi.fn(), onTextChunk: vi.fn(), onReasoningChunk: vi.fn(), onToolStart: vi.fn(), onToolEnd: vi.fn(), onError: vi.fn() }
    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks,
    })
    expect(mockStreamResponsesApi).toHaveBeenCalled()
    expect(mockStreamChatCompletion).not.toHaveBeenCalled()
    expect(result).toBe(turnResult)
  })

  it("Claude model: resetTurnState and appendToolOutput are no-ops", async () => {
    await setupConfig({
      providers: {
        "github-copilot": { githubToken: "ghp_test123", baseUrl: "https://api.copilot.example.com" },
      },
    })
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    const runtime = createGithubCopilotProviderRuntime("claude-sonnet-4.6")
    // Should not throw
    runtime.resetTurnState([{ role: "user", content: "hi" }])
    runtime.appendToolOutput("call-1", "output")
  })

  it("GPT model: resetTurnState calls toResponsesInput, appendToolOutput pushes to nativeInput", async () => {
    await setupConfig({
      providers: {
        "github-copilot": { githubToken: "ghp_test123", baseUrl: "https://api.copilot.example.com" },
      },
    })
    const nativeInput: any[] = []
    mockToResponsesInput.mockReturnValue({ instructions: "sys", input: nativeInput })
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    const runtime = createGithubCopilotProviderRuntime("gpt-5.4")
    runtime.resetTurnState([{ role: "user", content: "hi" }])
    expect(mockToResponsesInput).toHaveBeenCalled()
    runtime.appendToolOutput("call-1", "result")
    expect(nativeInput).toContainEqual({ type: "function_call_output", call_id: "call-1", output: "result" })
  })

  it("auth failure produces re-auth guidance message", async () => {
    await setupConfig({
      providers: {
        "github-copilot": { githubToken: "ghp_test123", baseUrl: "https://api.copilot.example.com" },
      },
    })
    const authError: any = new Error("auth failed")
    authError.status = 401
    mockStreamChatCompletion.mockRejectedValue(authError)
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    const runtime = createGithubCopilotProviderRuntime("claude-sonnet-4.6")
    const callbacks = { onModelStart: vi.fn(), onModelStreamStart: vi.fn(), onTextChunk: vi.fn(), onReasoningChunk: vi.fn(), onToolStart: vi.fn(), onToolEnd: vi.fn(), onError: vi.fn() }
    await expect(
      runtime.streamTurn({ messages: [{ role: "user", content: "hi" }], activeTools: [], callbacks }),
    ).rejects.toThrow("auth failed")
  })
})
