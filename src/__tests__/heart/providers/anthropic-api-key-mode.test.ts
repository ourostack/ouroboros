import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

function emitTestEvent(testName: string): void {
  emitNervesEvent({ component: "engine", event: "engine.test_run", message: testName, meta: { test: true } })
}

vi.mock("../../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

vi.mock("../../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({ name: "testagent", provider: "anthropic" })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

let capturedParams: any = null
let capturedClientOptions: Record<string, any> | null = null
const mockCreate = vi.fn().mockImplementation((params: any) => {
  capturedParams = params
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }
      yield { type: "message_delta", usage: { input_tokens: 10, output_tokens: 5 } }
    },
  }
})

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockCreate }
    constructor(options?: Record<string, any>) { capturedClientOptions = options ?? null }
  }
  return { default: MockAnthropic }
})

const callbacks = {
  onModelStart: () => {},
  onModelStreamStart: () => {},
  onTextChunk: () => {},
  onReasoningChunk: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
  onError: () => {},
}

const setupToken = `sk-ant-oat01-${"a".repeat(80)}`

function httpError(status: number | undefined, message: string): Error {
  const error = new Error(message) as Error & { status?: number }
  if (status !== undefined) error.status = status
  return error
}

describe("Anthropic API-key mode", () => {
  beforeEach(() => {
    capturedParams = null
    capturedClientOptions = null
    mockCreate.mockClear()
  })

  it("builds the client with apiKey and baseURL, no auth token and no Claude Code headers", async () => {
    emitTestEvent("anthropic api-key client options")
    const { createAnthropicProviderRuntime } = await import("../../../heart/providers/anthropic")
    const runtime = createAnthropicProviderRuntime("claude-opus-5-5", { setupToken: "", apiKey: " ouro-gw-test ", baseUrl: " http://127.0.0.1:8787 " })
    expect(runtime.id).toBe("anthropic")
    expect(runtime.capabilities.has("reasoning-effort")).toBe(true)
    expect(capturedClientOptions).toEqual({ apiKey: "ouro-gw-test", authToken: null, baseURL: "http://127.0.0.1:8787", maxRetries: 0 })
    expect(capturedClientOptions).not.toHaveProperty("defaultHeaders")
    expect(JSON.stringify(capturedClientOptions)).not.toContain("claude-cli")
  })

  it("leaves baseURL to the SDK default when no base URL is configured, and wins over a setup-token", async () => {
    emitTestEvent("anthropic api-key default base url")
    const { createAnthropicProviderRuntime } = await import("../../../heart/providers/anthropic")
    const runtime = createAnthropicProviderRuntime("unknown-model-without-caps", { setupToken, apiKey: "sk-ant-usr-test" })
    expect(capturedClientOptions).toEqual({ apiKey: "sk-ant-usr-test", authToken: null, baseURL: undefined, maxRetries: 0 })
    expect(runtime.capabilities.has("reasoning-effort")).toBe(false)
    runtime.resetTurnState([])
    runtime.appendToolOutput("call", "output")
  })

  it("sends no Claude Code preamble in API-key mode for structured, legacy and empty system prompts", async () => {
    emitTestEvent("anthropic api-key no preamble")
    const { createAnthropicProviderRuntime } = await import("../../../heart/providers/anthropic")
    const runtime = createAnthropicProviderRuntime("claude-opus-4-6", { setupToken: "", apiKey: "ouro-gw-test" })

    const result = await runtime.streamTurn({
      messages: [{ role: "system", content: "stable\n\nvolatile" }, { role: "user", content: "hi" }],
      activeTools: [],
      callbacks,
      systemPrompt: { stable: "stable", volatile: "volatile" },
    })
    expect(result.content).toBe("hello")
    expect(capturedParams.system).toEqual([
      { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
      { type: "text", text: "volatile" },
    ])
    expect(capturedParams.thinking).toEqual({ type: "adaptive" })

    await runtime.streamTurn({
      messages: [{ role: "system", content: "legacy system" }, { role: "user", content: "hi" }],
      activeTools: [],
      callbacks,
    })
    expect(capturedParams.system).toEqual([{ type: "text", text: "legacy system" }])

    await runtime.streamTurn({ messages: [{ role: "user", content: "hi" }], activeTools: [], callbacks })
    expect(capturedParams).not.toHaveProperty("system")
    expect(JSON.stringify(mockCreate.mock.calls)).not.toContain("You are Claude Code")
  })

  it("keeps the Claude Code preamble and OAuth client in setup-token mode", async () => {
    emitTestEvent("anthropic oauth preamble kept")
    const { createAnthropicProviderRuntime } = await import("../../../heart/providers/anthropic")
    const runtime = createAnthropicProviderRuntime("claude-opus-4-6", { setupToken })
    expect(capturedClientOptions?.authToken).toBe(setupToken)
    expect(capturedClientOptions).not.toHaveProperty("apiKey")
    expect(capturedClientOptions?.defaultHeaders["user-agent"]).toContain("claude-cli")

    await runtime.streamTurn({
      messages: [{ role: "system", content: "legacy system" }, { role: "user", content: "hi" }],
      activeTools: [],
      callbacks,
    })
    expect(capturedParams.system).toEqual([
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "legacy system" },
    ])
  })

  it("pings with the plain API key and no OAuth beta header", async () => {
    emitTestEvent("anthropic api-key ping")
    const { createAnthropicProviderRuntime } = await import("../../../heart/providers/anthropic")
    const runtime = createAnthropicProviderRuntime("claude-opus-4-6", { setupToken: "", apiKey: "ouro-gw-test" })
    const controller = new AbortController()
    mockCreate.mockResolvedValueOnce({ content: [] })
    await runtime.ping!(controller.signal)
    expect(mockCreate).toHaveBeenLastCalledWith(
      { model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
      { signal: controller.signal },
    )
  })

  it("classifies a credit-low 400/402 as usage-limit and invalid x-api-key as auth-failure", async () => {
    emitTestEvent("anthropic credit-low classification")
    const { classifyAnthropicError, createAnthropicProviderRuntime } = await import("../../../heart/providers/anthropic")
    const creditLow = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'
    expect(classifyAnthropicError(httpError(400, creditLow))).toBe("usage-limit")
    expect(classifyAnthropicError(httpError(402, "YOUR CREDIT BALANCE IS TOO LOW"))).toBe("usage-limit")
    expect(classifyAnthropicError(httpError(400, "messages: field required"))).toBe("unknown")
    expect(classifyAnthropicError(httpError(500, creditLow))).toBe("server-error")
    expect(classifyAnthropicError(httpError(undefined, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'))).toBe("auth-failure")

    const runtime = createAnthropicProviderRuntime("claude-opus-4-6", { setupToken: "", apiKey: "ouro-gw-test" })
    expect(runtime.classifyError(httpError(400, creditLow))).toBe("usage-limit")
  })
})
