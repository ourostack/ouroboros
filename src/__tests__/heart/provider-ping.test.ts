import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

const mockAnthropicCreate = vi.fn()
const mockOpenAICreate = vi.fn()
const mockResponsesCreate = vi.fn()
const mockClassifyError = vi.fn()


// Anthropic client mock: client.messages.create(...)
const anthropicClient = { messages: { create: (...args: any[]) => mockAnthropicCreate(...args) } }
// OpenAI-compatible client mock: client.chat.completions.create(...)
const openaiClient = { chat: { completions: { create: (...args: any[]) => mockOpenAICreate(...args) } } }
// Codex client mock: uses responses.create instead of chat.completions.create
const codexClient = { chat: { completions: { create: (...args: any[]) => mockOpenAICreate(...args) } }, responses: { create: (...args: any[]) => mockResponsesCreate(...args) } }

vi.mock("../../heart/providers/anthropic", () => ({
  createAnthropicProviderRuntime: vi.fn(() => ({
    id: "anthropic",
    model: "claude-opus-4-6",
    client: anthropicClient,
    classifyError: mockClassifyError,
  })),
  classifyAnthropicError: vi.fn(() => "unknown"),
}))

vi.mock("../../heart/providers/azure", () => ({
  createAzureProviderRuntime: vi.fn((model: string) => ({
    id: "azure",
    model,
    client: openaiClient,
    classifyError: mockClassifyError,
  })),
  classifyAzureError: vi.fn(() => "unknown"),
}))

vi.mock("../../heart/providers/minimax", () => ({
  createMinimaxProviderRuntime: vi.fn((model: string) => ({
    id: "minimax",
    model,
    client: openaiClient,
    classifyError: mockClassifyError,
  })),
  classifyMinimaxError: vi.fn(() => "unknown"),
}))

vi.mock("../../heart/providers/openai-codex", () => ({
  createOpenAICodexProviderRuntime: vi.fn(() => ({
    id: "openai-codex",
    model: "gpt-5.4",
    client: codexClient,
    classifyError: mockClassifyError,
    streamTurn: vi.fn(async (request: any) => {
      request.callbacks.onModelStart()
      request.callbacks.onModelStreamStart()
      request.callbacks.onTextChunk("pong")
      request.callbacks.onReasoningChunk("checking")
      request.callbacks.onToolStart("noop", {})
      request.callbacks.onToolEnd("noop", "ok", true)
      request.callbacks.onError(new Error("ignored"), "transient")
      await codexClient.responses.create({
        model: "gpt-5.4",
        input: [{ role: "user", content: "ping" }],
        instructions: "",
        tools: [],
        reasoning: { effort: "medium", summary: "detailed" },
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      }, request.signal ? { signal: request.signal } : {})
      return { content: "pong", toolCalls: [], outputItems: [] }
    }),
  })),
  classifyOpenAICodexError: vi.fn(() => "unknown"),
}))

vi.mock("../../heart/providers/github-copilot", () => ({
  createGithubCopilotProviderRuntime: vi.fn(() => ({
    id: "github-copilot",
    model: "gpt-5.4",
    client: openaiClient,
    classifyError: mockClassifyError,
  })),
  classifyGithubCopilotError: vi.fn(() => "unknown"),
}))

import { createProviderRuntimeForConfig, pingProvider, sanitizeErrorMessage, type PingResult } from "../../heart/provider-ping"
import type { ProviderErrorClassification } from "../../heart/core"
import { createOpenAICodexProviderRuntime } from "../../heart/providers/openai-codex"
import { createAzureProviderRuntime } from "../../heart/providers/azure"
import { createMinimaxProviderRuntime } from "../../heart/providers/minimax"

describe("sanitizeErrorMessage", () => {
  it("strips raw JSON from Anthropic SDK errors", () => {
    const raw = '400 {"type":"error","error":{"type":"invalid_request_error","message":"thinking.adaptive.effort: Extra inputs are not permitted"},"request_id":"req_123"}'
    expect(sanitizeErrorMessage(raw)).toBe("400 thinking.adaptive.effort: Extra inputs are not permitted")
  })

  it("extracts inner message from JSON error body", () => {
    const raw = '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth authentication is currently not supported."}}'
    expect(sanitizeErrorMessage(raw)).toBe("401 OAuth authentication is currently not supported.")
  })

  it("falls back to HTTP status when inner message is generic 'Error'", () => {
    const raw = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Error"}}'
    expect(sanitizeErrorMessage(raw)).toBe("HTTP 400")
  })

  it("falls back to HTTP status when JSON is malformed", () => {
    expect(sanitizeErrorMessage("400 {not valid json")).toBe("HTTP 400")
  })

  it("passes through clean error messages unchanged", () => {
    expect(sanitizeErrorMessage("401 Provided authentication token is expired.")).toBe("401 Provided authentication token is expired.")
  })

  it("passes through simple messages unchanged", () => {
    expect(sanitizeErrorMessage("network error")).toBe("network error")
  })

  it("strips HTML responses (Cloudflare challenge pages)", () => {
    const raw = '403 <html>\n  <head>\n    <meta name="viewport"...'
    expect(sanitizeErrorMessage(raw)).toBe("HTTP 403")
  })

  it("strips full HTML doctype responses", () => {
    const raw = '503 <!DOCTYPE html><html><body>Service Unavailable</body></html>'
    expect(sanitizeErrorMessage(raw)).toBe("HTTP 503")
  })
})

describe("pingProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("creates provider runtimes from explicit config for shared health and repair flows", () => {
    const runtime = createProviderRuntimeForConfig("minimax", {
      apiKey: "valid-key",
    }, {
      model: "MiniMax-M2.5",
    })

    expect(runtime.id).toBe("minimax")
    expect(createMinimaxProviderRuntime).toHaveBeenCalledWith("MiniMax-M2.5", {
      apiKey: "valid-key",
    })
  })

  it("returns ok: true when ping succeeds for anthropic", async () => {
    mockAnthropicCreate.mockResolvedValue({ content: [{ text: "hi" }] })
    const result = await pingProvider("anthropic", {
      model: "claude-opus-4-6",
      setupToken: "sk-ant-oat01-valid-token-that-is-long-enough-to-pass-format-check-1234567890abcdef",
    })
    expect(result.ok).toBe(true)
    // Should call messages.create with minimal params (no thinking)
    // Ping uses haiku regardless of configured model (cheapest, widest token access)
    expect(mockAnthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001", max_tokens: 1 }),
      expect.anything(),
    )
  })

  it("returns ok: true when ping succeeds for openai-codex", async () => {
    mockResponsesCreate.mockResolvedValue({ output: [{ text: "hi" }] })
    const result = await pingProvider("openai-codex", {
      model: "gpt-5.4",
      oauthAccessToken: "valid-token",
    })
    expect(result.ok).toBe(true)
    expect(createOpenAICodexProviderRuntime).toHaveBeenCalledWith("gpt-5.4", {
      model: "gpt-5.4",
      oauthAccessToken: "valid-token",
    })
    expect(mockResponsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        input: [{ role: "user", content: "ping" }],
        stream: true,
        store: false,
        reasoning: { effort: "medium", summary: "detailed" },
        include: ["reasoning.encrypted_content"],
      }),
      expect.anything(),
    )
  })

  it("returns ok: true when ping succeeds for azure", async () => {
    mockOpenAICreate.mockResolvedValue({ choices: [{ message: { content: "hi" } }] })
    const result = await pingProvider("azure", {
      modelName: "gpt-4o-mini",
      apiKey: "valid-key",
      endpoint: "https://example.openai.azure.com",
      deployment: "gpt-4o-mini",
      apiVersion: "2025-04-01-preview",
    })
    expect(result.ok).toBe(true)
  })

  it("adds the default azure API version when ping config omits it", async () => {
    mockOpenAICreate.mockResolvedValue({ choices: [{ message: { content: "hi" } }] })
    const result = await pingProvider("azure", {
      modelName: "gpt-4o-mini",
      apiKey: "valid-key",
      endpoint: "https://example.openai.azure.com",
      deployment: "gpt-4o-mini",
    })
    expect(result.ok).toBe(true)
    expect(createAzureProviderRuntime).toHaveBeenCalledWith("gpt-4o-mini", expect.objectContaining({
      apiVersion: "2025-04-01-preview",
    }))
  })

  it("allows azure managed identity credentials without an apiKey", async () => {
    mockOpenAICreate.mockResolvedValue({ choices: [{ message: { content: "hi" } }] })
    const result = await pingProvider("azure", {
      endpoint: "https://example.openai.azure.com",
      deployment: "gpt-4o-mini",
      apiVersion: "2025-04-01-preview",
      managedIdentityClientId: "client-id",
    })
    expect(result.ok).toBe(true)
  })

  it("returns ok: true when ping succeeds for minimax", async () => {
    mockOpenAICreate.mockResolvedValue({ choices: [{ message: { content: "hi" } }] })
    const result = await pingProvider("minimax", {
      model: "minimax-text-01",
      apiKey: "valid-key",
    })
    expect(result.ok).toBe(true)
  })

  it("pings the selected lane model instead of the provider default when supplied", async () => {
    mockOpenAICreate.mockResolvedValue({ choices: [{ message: { content: "hi" } }] })
    const result = await pingProvider("minimax", {
      apiKey: "valid-key",
    }, {
      model: "MiniMax-M2.5",
    })

    expect(result.ok).toBe(true)
    expect(createMinimaxProviderRuntime).toHaveBeenCalledWith("MiniMax-M2.5", {
      apiKey: "valid-key",
    })
    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "MiniMax-M2.5" }),
      expect.anything(),
    )
  })

  it("returns ok: true when ping succeeds for github-copilot", async () => {
    mockOpenAICreate.mockResolvedValue({ choices: [{ message: { content: "hi" } }] })
    const result = await pingProvider("github-copilot", {
      model: "gpt-5.4",
      githubToken: "ghp_test123",
      baseUrl: "https://api.copilot.example.com",
    })
    expect(result.ok).toBe(true)
  })

  it("returns auth-failure for empty credentials (anthropic)", async () => {
    const result = await pingProvider("anthropic", {
      model: "claude-opus-4-6",
      setupToken: "",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("auth-failure")
    }
  })

  it("returns auth-failure for empty credentials (openai-codex)", async () => {
    const result = await pingProvider("openai-codex", {
      model: "gpt-5.4",
      oauthAccessToken: "",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("auth-failure")
    }
  })

  it("returns auth-failure for empty credentials (minimax)", async () => {
    const result = await pingProvider("minimax", {
      model: "minimax-text-01",
      apiKey: "",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("auth-failure")
    }
  })

  it("returns auth-failure for empty credentials (azure)", async () => {
    const result = await pingProvider("azure", {
      modelName: "gpt-4o-mini",
      apiKey: "",
      endpoint: "",
      deployment: "",
      apiVersion: "2025-04-01-preview",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("auth-failure")
    }
  })

  it("returns auth-failure for empty credentials (github-copilot)", async () => {
    const result = await pingProvider("github-copilot", {
      model: "",
      githubToken: "",
      baseUrl: "",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("auth-failure")
    }
  })

  it("classifies error from API call failure", async () => {
    const err = Object.assign(new Error("auth failed"), { status: 401 })
    mockAnthropicCreate
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ content: [{ text: "recovered" }] })
    mockClassifyError.mockReturnValue("auth-failure" as ProviderErrorClassification)

    const result = await pingProvider("anthropic", {
      model: "claude-opus-4-6",
      setupToken: "sk-ant-oat01-valid-token-that-is-long-enough-to-pass-format-check-1234567890abcdef",
    })
    expect(result.ok).toBe(true)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(3)
  })

  it("classifies usage-limit error", async () => {
    const err = Object.assign(new Error("exceeded your usage limit"), { status: 429 })
    mockResponsesCreate.mockRejectedValue(err)
    mockClassifyError.mockReturnValue("usage-limit" as ProviderErrorClassification)

    const result = await pingProvider("openai-codex", {
      model: "gpt-5.4",
      oauthAccessToken: "valid-token",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("usage-limit")
    }
  })

  it("classifies network error on timeout", async () => {
    mockAnthropicCreate.mockImplementation(() => new Promise((_, reject) => {
      setTimeout(() => reject(new Error("aborted")), 100)
    }))
    mockClassifyError.mockReturnValue("network-error" as ProviderErrorClassification)

    const result = await pingProvider("anthropic", {
      model: "claude-opus-4-6",
      setupToken: "sk-ant-oat01-valid-token-that-is-long-enough-to-pass-format-check-1234567890abcdef",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("network-error")
    }
  })

  it("falls back to unknown when classifyError throws", async () => {
    mockAnthropicCreate.mockRejectedValue(new Error("weird error"))
    mockClassifyError.mockImplementation(() => { throw new Error("classify itself broke") })

    const result = await pingProvider("anthropic", {
      model: "claude-opus-4-6",
      setupToken: "sk-ant-oat01-valid-token-that-is-long-enough-to-pass-format-check-1234567890abcdef",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("unknown")
    }
  })
})
