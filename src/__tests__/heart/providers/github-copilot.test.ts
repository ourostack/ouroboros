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
const mockTruncateResponsesFunctionCallOutput = vi.fn((output: string) => output)
vi.mock("../../../heart/streaming", () => ({
  streamChatCompletion: (...args: any[]) => mockStreamChatCompletion(...args),
  streamResponsesApi: (...args: any[]) => mockStreamResponsesApi(...args),
  toResponsesInput: (...args: any[]) => mockToResponsesInput(...args),
  toResponsesTools: (...args: any[]) => mockToResponsesTools(...args),
  truncateResponsesFunctionCallOutput: (...args: any[]) => mockTruncateResponsesFunctionCallOutput(...args),
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
  mockTruncateResponsesFunctionCallOutput.mockReset().mockImplementation((output: string) => output)
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

  it("getGithubCopilotConfig defaults credentials locally without a secrets providers block", async () => {
    await setupConfig({})
    const { getGithubCopilotConfig, loadConfig } = await import("../../../heart/config")
    expect(loadConfig()).not.toHaveProperty("providers")
    expect(getGithubCopilotConfig()).toEqual({
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

  it("parses --github-token and --base-url into hatch credentials", async () => {
    const { parseOuroCommand } = await import("../../../heart/daemon/daemon-cli")
    expect(
      parseOuroCommand([
        "hatch",
        "--agent", "test",
        "--provider", "github-copilot",
        "--github-token", "ghp_example_token",
        "--base-url", "https://api.githubcopilot.com",
      ]),
    ).toMatchObject({
      kind: "hatch.start",
      provider: "github-copilot",
      credentials: { githubToken: "ghp_example_token", baseUrl: "https://api.githubcopilot.com" },
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
    const runtime = createGithubCopilotProviderRuntime("claude-sonnet-5.5")
    expect(runtime.capabilities.has("reasoning-effort")).toBe(true)
  })

  it("Claude model: a required tool choice is sent as auto because thinking rejects required", async () => {
    await setupConfig({
      providers: {
        "github-copilot": { githubToken: "ghp_test123", baseUrl: "https://api.copilot.example.com" },
      },
    })
    mockStreamChatCompletion.mockResolvedValue({ content: "", toolCalls: [], outputItems: [] })
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    const runtime = createGithubCopilotProviderRuntime("claude-opus-5.5")
    const callbacks = { onModelStart: vi.fn(), onModelStreamStart: vi.fn(), onTextChunk: vi.fn(), onReasoningChunk: vi.fn(), onToolStart: vi.fn(), onToolEnd: vi.fn(), onError: vi.fn() }
    await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks,
      toolChoiceRequired: true,
    })
    const params = mockStreamChatCompletion.mock.calls[0][1] as Record<string, unknown>
    expect(params.tool_choice).toBe("auto")
  })

  it("GPT model: a required tool choice is still sent as required", async () => {
    await setupConfig({
      providers: {
        "github-copilot": { githubToken: "ghp_test123", baseUrl: "https://api.copilot.example.com" },
      },
    })
    mockStreamResponsesApi.mockResolvedValue({ content: "", toolCalls: [], outputItems: [] })
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    const runtime = createGithubCopilotProviderRuntime("gpt-5.5")
    const callbacks = { onModelStart: vi.fn(), onModelStreamStart: vi.fn(), onTextChunk: vi.fn(), onReasoningChunk: vi.fn(), onToolStart: vi.fn(), onToolEnd: vi.fn(), onError: vi.fn() }
    await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks,
      toolChoiceRequired: true,
    })
    const params = mockStreamResponsesApi.mock.calls[0][1] as Record<string, unknown>
    expect(params.tool_choice).toBe("required")
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

  it("GPT model: sends current and verified predecessor evidence once through the actual Responses conversion", async () => {
    await setupConfig({
      providers: {
        "github-copilot": { githubToken: "ghp_test123", baseUrl: "https://api.copilot.example.com" },
      },
    })
    const actualStreaming = await vi.importActual<typeof import("../../../heart/streaming")>("../../../heart/streaming")
    mockToResponsesInput.mockImplementation(actualStreaming.toResponsesInput)
    mockStreamResponsesApi.mockResolvedValue({ content: "", toolCalls: [], outputItems: [] })
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    const runtime = createGithubCopilotProviderRuntime("gpt-5.4")
    const messages = [
      { role: "system" as const, content: "core system" },
      { role: "system" as const, content: "verified predecessor evidence" },
      { role: "user" as const, content: "current request" },
    ]
    runtime.resetTurnState(messages)
    await runtime.streamTurn({
      messages,
      activeTools: [],
      callbacks: { onModelStart: vi.fn(), onModelStreamStart: vi.fn(), onTextChunk: vi.fn(), onReasoningChunk: vi.fn(), onToolStart: vi.fn(), onToolEnd: vi.fn(), onError: vi.fn() },
    })

    const payload = mockStreamResponsesApi.mock.calls[0]?.[1]
    expect(payload.instructions).toBe("core system\n\nverified predecessor evidence")
    expect(payload.instructions.match(/verified predecessor evidence/g)).toHaveLength(1)
    expect(payload.input).toEqual([{ role: "user", content: "current request" }])
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
    expect(mockTruncateResponsesFunctionCallOutput).toHaveBeenCalledWith("result")
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

describe("github-copilot account pool", () => {
  const pool = JSON.stringify([
    { login: "ari", host: "msft.ghe.com", baseUrl: "https://copilot-api.msft.ghe.com", githubToken: "t-msft" },
    { login: "ari", host: "microsoft.ghe.com", baseUrl: "https://copilot-api.microsoft.ghe.com", githubToken: "t-mscom" },
  ])
  const config = { githubToken: "t-msft", baseUrl: "https://copilot-api.msft.ghe.com", accountPool: pool }
  const owner = { agentName: "testagent", agentRoot: "/mock/repo/testagent" }
  const quota = () => Object.assign(new Error("429 quota exceeded"), { status: 429 })

  it("has no pool for a single-account credential", async () => {
    const { createGithubCopilotPooledCaller } = await import("../../../heart/providers/github-copilot")
    expect(createGithubCopilotPooledCaller({ githubToken: "t", baseUrl: "https://x" })).toBeNull()
  })

  it("builds the turn's client from the pool's account", async () => {
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    createGithubCopilotProviderRuntime("claude-opus-5.5", { ...config, fleetGistId: "g", fleetGistToken: "gt", fleetMachine: "laptop" }, owner)
    expect(mockOpenAICtor).toHaveBeenCalledTimes(1)
    expect(mockOpenAICtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "t-msft", baseURL: "https://copilot-api.msft.ghe.com" }))
  })

  it("on a 429 switches account and retries the chat turn once", async () => {
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    const runtime = createGithubCopilotProviderRuntime("claude-opus-5.5", config)
    mockStreamChatCompletion.mockRejectedValueOnce(quota()).mockResolvedValueOnce({ content: "ok" })
    await expect(runtime.streamTurn({ messages: [], activeTools: [], callbacks: {} as any })).resolves.toEqual({ content: "ok" })
    expect(mockStreamChatCompletion).toHaveBeenCalledTimes(2)
    expect(mockStreamChatCompletion.mock.calls[0][0]).not.toBe(mockStreamChatCompletion.mock.calls[1][0])
    expect(mockOpenAICtor).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: "t-mscom", baseURL: "https://copilot-api.microsoft.ghe.com" }))
  })

  it("keeps the owning agent's next turn on the account it switched to", async () => {
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    const first = createGithubCopilotProviderRuntime("claude-opus-5.5", config, owner)
    mockStreamChatCompletion.mockRejectedValueOnce(quota()).mockResolvedValueOnce({ content: "ok" })
    await first.streamTurn({ messages: [], activeTools: [], callbacks: {} as any })
    mockOpenAICtor.mockClear()
    createGithubCopilotProviderRuntime("claude-opus-5.5", config, owner)
    expect(mockOpenAICtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "t-mscom" }))
  })

  it("without an owning agent still switches, but keeps no state between runtimes", async () => {
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    const first = createGithubCopilotProviderRuntime("claude-opus-5.5", config)
    mockStreamChatCompletion.mockRejectedValueOnce(quota()).mockResolvedValueOnce({ content: "ok" })
    await expect(first.streamTurn({ messages: [], activeTools: [], callbacks: {} as any })).resolves.toEqual({ content: "ok" })
    mockOpenAICtor.mockClear()
    createGithubCopilotProviderRuntime("claude-opus-5.5", config)
    expect(mockOpenAICtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "t-msft" }))
  })

  it("switches on a 429 for the Responses API and for pings", async () => {
    const { createGithubCopilotProviderRuntime } = await import("../../../heart/providers/github-copilot")
    const responses = createGithubCopilotProviderRuntime("gpt-5.4", config)
    mockStreamResponsesApi.mockRejectedValueOnce(quota()).mockResolvedValueOnce({ outputItems: [] })
    await expect(responses.streamTurn({ messages: [], activeTools: [], callbacks: {} as any })).resolves.toEqual({ outputItems: [] })
    expect(mockStreamResponsesApi).toHaveBeenCalledTimes(2)
    await expect(responses.ping!()).resolves.toBeUndefined()
    const chat = createGithubCopilotProviderRuntime("claude-opus-5.5", config)
    await expect(chat.ping!()).resolves.toBeUndefined()
  })
})
