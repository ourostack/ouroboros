import { beforeEach, describe, expect, it, vi } from "vitest"

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
    provider: "openai-codex",
    humanFacing: { provider: "openai-codex", model: "gpt-5.4" },
    agentFacing: { provider: "openai-codex", model: "gpt-5.4" },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

const mockOpenAICtor = vi.fn()
const mockResponsesCreate = vi.fn()

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } }
    responses = { create: (...args: any[]) => mockResponsesCreate(...args) }
    constructor(opts?: any) { mockOpenAICtor(opts) }
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

const mockStreamResponsesApi = vi.fn()
const mockToResponsesInput = vi.fn().mockReturnValue({ instructions: "sys", input: [] })
const mockToResponsesTools = vi.fn().mockReturnValue([])
const mockTruncateResponsesFunctionCallOutput = vi.fn((output: string) => output)

vi.mock("../../../heart/streaming", () => ({
  streamResponsesApi: (...args: any[]) => mockStreamResponsesApi(...args),
  toResponsesInput: (...args: any[]) => mockToResponsesInput(...args),
  toResponsesTools: (...args: any[]) => mockToResponsesTools(...args),
  truncateResponsesFunctionCallOutput: (...args: any[]) => mockTruncateResponsesFunctionCallOutput(...args),
}))

function buildToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.signature`
}

function createCallbacks() {
  return {
    onModelStart: vi.fn(),
    onModelStreamStart: vi.fn(),
    onTextChunk: vi.fn(),
    onReasoningChunk: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onError: vi.fn(),
  }
}

async function setupConfig(token = buildToken("acct-test-123")) {
  const config = await import("../../../heart/config")
  config.resetConfigCache()
  config.patchRuntimeConfig({
    providers: {
      "openai-codex": {
        oauthAccessToken: token,
      },
    },
  })
}

describe("createOpenAICodexProviderRuntime", () => {
  beforeEach(async () => {
    vi.resetModules()
    mockOpenAICtor.mockReset()
    mockResponsesCreate.mockReset()
    mockStreamResponsesApi.mockReset()
    mockToResponsesInput.mockReset().mockReturnValue({ instructions: "sys", input: [] })
    mockToResponsesTools.mockReset().mockReturnValue([])
    mockTruncateResponsesFunctionCallOutput.mockReset().mockImplementation((output: string) => output)
    const config = await import("../../../heart/config")
    config.resetConfigCache()
  })

  it("ping uses the Codex streaming Responses payload instead of a bare responses.create request", async () => {
    await setupConfig()
    mockStreamResponsesApi.mockResolvedValue({ content: "pong", toolCalls: [], outputItems: [] })

    const { createOpenAICodexProviderRuntime } = await import("../../../heart/providers/openai-codex")
    const runtime = createOpenAICodexProviderRuntime("gpt-5.4")

    await runtime.ping()

    expect(mockOpenAICtor).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: "https://chatgpt.com/backend-api/codex",
      defaultHeaders: expect.objectContaining({
        "OpenAI-Beta": "responses=experimental",
        originator: "ouroboros",
      }),
    }))
    expect(mockStreamResponsesApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: "gpt-5.4",
        input: [{ role: "user", content: "ping" }],
        instructions: "",
        tools: [],
        reasoning: { effort: "medium", summary: "detailed" },
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      }),
      expect.objectContaining({
        onModelStart: expect.any(Function),
        onModelStreamStart: expect.any(Function),
        onTextChunk: expect.any(Function),
        onReasoningChunk: expect.any(Function),
        onToolStart: expect.any(Function),
        onToolEnd: expect.any(Function),
        onError: expect.any(Function),
      }),
      undefined,
    )
    expect(mockResponsesCreate).not.toHaveBeenCalled()

    const pingCallbacks = mockStreamResponsesApi.mock.calls[0]?.[2]
    pingCallbacks.onModelStart()
    pingCallbacks.onModelStreamStart()
    pingCallbacks.onTextChunk("pong")
    pingCallbacks.onReasoningChunk("thinking")
    pingCallbacks.onToolStart({ type: "function", name: "settle" })
    pingCallbacks.onToolEnd({ type: "function", name: "settle" })
    pingCallbacks.onError(new Error("noop"))
  })

  it("streamTurn reuses the shared Responses payload shape, forwards tool choices, and preserves turn state", async () => {
    await setupConfig()
    const assistantOutput = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    }
    mockToResponsesInput.mockReturnValue({
      instructions: "sys-turn",
      input: [{ role: "user", content: "hello" }],
    })
    mockToResponsesTools
      .mockReturnValueOnce([{ type: "function", name: "settle" }])
      .mockReturnValueOnce([])
    mockStreamResponsesApi
      .mockResolvedValueOnce({ content: "done", toolCalls: [], outputItems: [assistantOutput] })
      .mockResolvedValueOnce({ content: "again", toolCalls: [], outputItems: [] })

    const { createOpenAICodexProviderRuntime } = await import("../../../heart/providers/openai-codex")
    const runtime = createOpenAICodexProviderRuntime("gpt-5.4")
    const callbacks = createCallbacks()

    runtime.resetTurnState([
      { role: "system", content: "sys-turn" } as any,
      { role: "user", content: "hello" } as any,
    ])
    runtime.appendToolOutput("call-1", "tool ok")
    const firstResult = await runtime.streamTurn({
      messages: [{ role: "user", content: "hello" } as any],
      callbacks,
      signal: undefined,
      eagerSettleStreaming: false,
      activeTools: [{ name: "settle" } as any],
      toolChoiceRequired: true,
      reasoningEffort: "high",
    })

    expect(firstResult).toEqual({ content: "done", toolCalls: [], outputItems: [assistantOutput] })
    expect(mockToResponsesTools).toHaveBeenCalledWith([{ name: "settle" }])
    expect(mockStreamResponsesApi).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        model: "gpt-5.4",
        input: [
          { role: "user", content: "hello" },
          { type: "function_call_output", call_id: "call-1", output: "tool ok" },
          assistantOutput,
        ],
        instructions: "sys-turn",
        tools: [{ type: "function", name: "settle" }],
        tool_choice: "required",
        reasoning: { effort: "high", summary: "detailed" },
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      }),
      callbacks,
      undefined,
      false,
    )

    await runtime.streamTurn({
      messages: [{ role: "user", content: "hello" } as any],
      callbacks,
      signal: undefined,
      eagerSettleStreaming: false,
      activeTools: [],
      toolChoiceRequired: false,
      reasoningEffort: undefined,
    })

    expect(mockStreamResponsesApi).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        model: "gpt-5.4",
        input: [
          { role: "user", content: "hello" },
          { type: "function_call_output", call_id: "call-1", output: "tool ok" },
          assistantOutput,
        ],
        instructions: "sys-turn",
        tools: [],
        reasoning: { effort: "medium", summary: "detailed" },
      }),
      callbacks,
      undefined,
      false,
    )
  })

  it("appendToolOutput truncates oversized function_call_output before storing turn state", async () => {
    await setupConfig()
    mockToResponsesInput.mockReturnValue({
      instructions: "sys-turn",
      input: [{ role: "user", content: "hello" }],
    })
    mockTruncateResponsesFunctionCallOutput.mockReturnValue("[truncated output]")
    mockStreamResponsesApi.mockResolvedValue({ content: "done", toolCalls: [], outputItems: [] })

    const { createOpenAICodexProviderRuntime } = await import("../../../heart/providers/openai-codex")
    const runtime = createOpenAICodexProviderRuntime("gpt-5.4")
    runtime.resetTurnState([{ role: "user", content: "hello" } as any])
    runtime.appendToolOutput("call-1", "x".repeat(250000))

    expect(mockTruncateResponsesFunctionCallOutput).toHaveBeenCalledWith("x".repeat(250000))
    await runtime.streamTurn({
      messages: [{ role: "user", content: "hello" } as any],
      callbacks: createCallbacks(),
      signal: undefined,
      eagerSettleStreaming: false,
      activeTools: [],
      toolChoiceRequired: false,
      reasoningEffort: undefined,
    })

    expect(mockStreamResponsesApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        input: [
          { role: "user", content: "hello" },
          { type: "function_call_output", call_id: "call-1", output: "[truncated output]" },
        ],
      }),
      expect.anything(),
      undefined,
      false,
    )
  })

  it("runtime classifyError delegates to the shared Codex error classifier", async () => {
    await setupConfig()
    const { createOpenAICodexProviderRuntime } = await import("../../../heart/providers/openai-codex")
    const runtime = createOpenAICodexProviderRuntime("gpt-5.4")

    expect(runtime.classifyError(Object.assign(new Error("Unauthorized"), { status: 401 }))).toBe("auth-failure")
  })
})
