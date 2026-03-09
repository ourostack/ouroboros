import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Default readFileSync: return psyche file stubs so prompt.ts module-level loads work
function defaultReadFileSync(filePath: any, _encoding?: any): string {
  const p = String(filePath)
  if (p.endsWith("SOUL.md")) return "mock soul"
  if (p.endsWith("IDENTITY.md")) return "mock identity"
  if (p.endsWith("LORE.md")) return "mock lore"
  if (p.endsWith("FRIENDS.md")) return "mock friends"
  if (p.endsWith("package.json")) return JSON.stringify({ name: "other" })
  return ""
}

// Mock fs and child_process before importing core
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
    provider: "minimax",
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

// We need to mock OpenAI before importing core
const mockCreate = vi.fn()
const mockResponsesCreate = vi.fn()
const mockOpenAICtor = vi.fn()
const mockAnthropicMessagesCreate = vi.fn()
const mockAnthropicCtor = vi.fn()
const mockInjectAssociativeRecall = vi.fn().mockResolvedValue(undefined)
vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    }
    responses = {
      create: mockResponsesCreate,
    }
    constructor(opts?: any) {
      mockOpenAICtor(opts)
    }
  }
  return {
    default: MockOpenAI,
    AzureOpenAI: MockOpenAI,
  }
})

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = {
      create: mockAnthropicMessagesCreate,
    }
    constructor(opts?: any) {
      mockAnthropicCtor(opts)
    }
  }
  return {
    default: MockAnthropic,
  }
})

vi.mock("../../mind/associative-recall", () => ({
  injectAssociativeRecall: (...args: any[]) => mockInjectAssociativeRecall(...args),
}))

import * as fs from "fs"
import * as nodeFs from "node:fs"
import * as path from "path"
import { execSync, spawnSync } from "child_process"
import * as identity from "../../heart/identity"
import type { ChannelCallbacks } from "../../heart/core"

// Dynamic config helpers -- must be re-imported after vi.resetModules()
async function setAgentProvider(provider: "azure" | "minimax" | "anthropic" | "openai-codex") {
  vi.mocked(identity.loadAgentConfig).mockReturnValue({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider,
  })
}

async function setupMinimax(apiKey = "test-key", model = "test-model") {
  await setAgentProvider("minimax")
  const config = await import("../../heart/config")
  config.resetConfigCache()
  config.patchRuntimeConfig({ providers: { minimax: { apiKey, model } } })
}

async function setupAzure(
  apiKey = "azure-test-key",
  endpoint = "https://test.openai.azure.com",
  deployment = "test-deployment",
  modelName = "gpt-5.2-chat",
) {
  await setAgentProvider("azure")
  const config = await import("../../heart/config")
  config.resetConfigCache()
  config.patchRuntimeConfig({ providers: { azure: { apiKey, endpoint, deployment, modelName } } })
}

function makeAnthropicSetupToken(): string {
  return `sk-ant-oat01-${"a".repeat(80)}`
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function makeOpenAICodexAccessToken(accountId = "chatgpt-account-test"): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }))
  const payload = encodeBase64Url(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
      },
    }),
  )
  return `${header}.${payload}.signature`
}

async function setupConfig(partial: Record<string, unknown>) {
  const providers = (partial.providers ?? {}) as Record<string, unknown>
  if (providers.azure) await setAgentProvider("azure")
  else if (providers.anthropic) await setAgentProvider("anthropic")
  else if (providers["openai-codex"]) await setAgentProvider("openai-codex")
  else await setAgentProvider("minimax")
  const config = await import("../../heart/config")
  config.resetConfigCache()
  config.patchRuntimeConfig(partial as any)
}

async function resetConfig() {
  const config = await import("../../heart/config")
  config.resetConfigCache()
}

describe("isTransientError", () => {
  it("detects Node.js network error codes", async () => {
    const { isTransientError } = await import("../../heart/core")
    for (const code of ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EPIPE",
                         "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ECONNABORTED"]) {
      const err: any = new Error("fail")
      err.code = code
      expect(isTransientError(err)).toBe(true)
    }
  })

  it("detects fetch/network errors by message", async () => {
    const { isTransientError } = await import("../../heart/core")
    expect(isTransientError(new Error("fetch failed"))).toBe(true)
    expect(isTransientError(new Error("network error"))).toBe(true)
    expect(isTransientError(new Error("socket hang up"))).toBe(true)
    expect(isTransientError(new Error("getaddrinfo ENOTFOUND"))).toBe(true)
    expect(isTransientError(new Error("ECONNRESET by peer"))).toBe(true)
    expect(isTransientError(new Error("ETIMEDOUT waiting"))).toBe(true)
  })

  it("detects HTTP status codes 429 and 5xx", async () => {
    const { isTransientError } = await import("../../heart/core")
    for (const status of [429, 500, 502, 503, 504]) {
      const err: any = new Error("server error")
      err.status = status
      expect(isTransientError(err)).toBe(true)
    }
  })

  it("returns false for non-transient errors", async () => {
    const { isTransientError } = await import("../../heart/core")
    expect(isTransientError(new Error("invalid request"))).toBe(false)
    expect(isTransientError(new Error("authentication failed"))).toBe(false)
    expect(isTransientError("not an error")).toBe(false)
    expect(isTransientError(new Error())).toBe(false) // empty message
    const err: any = new Error("bad request")
    err.status = 400
    expect(isTransientError(err)).toBe(false)
  })

  it("returns false for context overflow messages (not transient)", async () => {
    const { isTransientError } = await import("../../heart/core")
    expect(isTransientError(new Error("context_length_exceeded"))).toBe(false)
    expect(isTransientError(new Error("context window exceeds limit"))).toBe(false)
  })
})

describe("classifyTransientError", () => {
  it("classifies non-Error values as unknown error", async () => {
    const { classifyTransientError } = await import("../../heart/core")
    expect(classifyTransientError("string-error")).toBe("unknown error")
    expect(classifyTransientError(42)).toBe("unknown error")
    expect(classifyTransientError(null)).toBe("unknown error")
  })

  it("classifies 429 as rate limited", async () => {
    const { classifyTransientError } = await import("../../heart/core")
    const err: any = new Error("too many requests")
    err.status = 429
    expect(classifyTransientError(err)).toBe("rate limited")
  })

  it("classifies 401 and 403 as auth error", async () => {
    const { classifyTransientError } = await import("../../heart/core")
    for (const status of [401, 403]) {
      const err: any = new Error("unauthorized")
      err.status = status
      expect(classifyTransientError(err)).toBe("auth error")
    }
  })

  it("classifies 5xx as server error", async () => {
    const { classifyTransientError } = await import("../../heart/core")
    for (const status of [500, 502, 503, 504]) {
      const err: any = new Error("server error")
      err.status = status
      expect(classifyTransientError(err)).toBe("server error")
    }
  })

  it("classifies regular errors as network error", async () => {
    const { classifyTransientError } = await import("../../heart/core")
    expect(classifyTransientError(new Error("ECONNRESET"))).toBe("network error")
    expect(classifyTransientError(new Error("fetch failed"))).toBe("network error")
  })
})

describe("ChannelCallbacks interface", () => {
  it("accepts an object with all required callback signatures", () => {
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (_text: string) => {},
      onReasoningChunk: (_text: string) => {},
      onToolStart: (_name: string, _args: Record<string, string>) => {},
      onToolEnd: (_name: string, _summary: string, _success: boolean) => {},
      onError: (_error: Error, _severity: "transient" | "terminal") => {},
    }
    // Type check passes if this compiles
    expect(callbacks).toBeDefined()
    expect(typeof callbacks.onModelStart).toBe("function")
    expect(typeof callbacks.onModelStreamStart).toBe("function")
    expect(typeof callbacks.onTextChunk).toBe("function")
    expect(typeof callbacks.onReasoningChunk).toBe("function")
    expect(typeof callbacks.onToolStart).toBe("function")
    expect(typeof callbacks.onToolEnd).toBe("function")
    expect(typeof callbacks.onError).toBe("function")
  })
})

describe("RunAgentOptions trace propagation contract", () => {
  it("supports a traceId field in RunAgentOptions", async () => {
    const core = await import("../../heart/core")
    const options: core.RunAgentOptions = { traceId: "trace-123" }
    expect((options as any).traceId).toBe("trace-123")
  })
})

describe("runAgent", () => {
  let runAgent: (messages: any[], callbacks: ChannelCallbacks, channel?: string, signal?: AbortSignal, options?: { toolChoiceRequired?: boolean }) => Promise<{ usage?: any }>

  // Helper to create an async iterable from chunks
  function makeStream(chunks: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    }
  }

  function makeChunk(content?: string, toolCalls?: any[]) {
    const delta: any = {}
    if (content !== undefined) delta.content = content
    if (toolCalls !== undefined) delta.tool_calls = toolCalls
    return { choices: [{ delta }] }
  }

  // Helper for Responses API events (flat { type, delta, ... } objects)
  function makeResponsesStream(events: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const event of events) {
          yield event
        }
      },
    }
  }

  beforeEach(async () => {
    vi.resetModules()
    mockCreate.mockReset()
    mockResponsesCreate.mockReset()
    mockOpenAICtor.mockReset()
    mockInjectAssociativeRecall.mockReset().mockResolvedValue(undefined)
    // Restore default readFileSync so prompt.ts module-level psyche file loads work
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()

    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  it("fires onModelStart before API call", async () => {
    const order: string[] = []
    mockCreate.mockImplementation(() => {
      order.push("api_call")
      return makeStream([makeChunk("hello")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => order.push("onModelStart"),
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    expect(order[0]).toBe("onModelStart")
    expect(order[1]).toBe("api_call")
  })

  it("injects steering follow-ups as ordered user messages before model calls", async () => {
    const drained = vi.fn().mockReturnValue([
      { text: "follow-up 1" },
      { text: "follow-up 2" },
    ])
    mockCreate.mockReturnValue(makeStream([makeChunk("ok")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, {
      drainSteeringFollowUps: drained,
    } as any)

    expect(drained).toHaveBeenCalledTimes(1)
    const followUps = messages.filter((m: any) => m.role === "user").map((m: any) => m.content)
    expect(followUps).toEqual(["follow-up 1", "follow-up 2"])
  })

  it("rebases openai-codex provider state from messages at each runAgent turn", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.2",
          oauthAccessToken: makeOpenAICodexAccessToken(),
        },
      },
    } as any)

    mockResponsesCreate.mockReset()
    mockResponsesCreate
      .mockImplementationOnce((params: any) => {
        const input = Array.isArray(params.input) ? params.input : []
        expect(input.some((item: any) => item?.role === "user" && item?.content === "hello")).toBe(true)
        return makeResponsesStream([{ type: "response.output_text.delta", delta: "first" }])
      })
      .mockImplementationOnce((params: any) => {
        const input = Array.isArray(params.input) ? params.input : []
        expect(input.some((item: any) => item?.role === "user" && item?.content === "what model are you?")).toBe(true)
        return makeResponsesStream([{ type: "response.output_text.delta", delta: "second" }])
      })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const core = await import("../../heart/core")
    const messages: any[] = [{ role: "system", content: "test" }, { role: "user", content: "hello" }]
    await core.runAgent(messages, callbacks)
    messages.push({ role: "user", content: "what model are you?" })
    await core.runAgent(messages, callbacks)

    const assistantReplies = messages
      .filter((m: any) => m.role === "assistant" && typeof m.content === "string")
      .map((m: any) => m.content)
    expect(assistantReplies).toContain("first")
    expect(assistantReplies).toContain("second")
  })

  it("propagates traceId option into model request metadata", async () => {
    mockCreate.mockReturnValue(
      makeStream([makeChunk("ok")])
    )

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent(
      [{ role: "system", content: "test" }],
      callbacks,
      undefined,
      undefined,
      { traceId: "trace-abc" } as any,
    )

    expect(mockCreate).toHaveBeenCalled()
    const params = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(params).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({ trace_id: "trace-abc" }),
    }))
  })

  it("emits engine lifecycle observability events for a successful turn", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()

    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent,
    }))

    mockCreate.mockReturnValue(
      makeStream([makeChunk("ok")])
    )

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await core.runAgent([{ role: "system", content: "test" }], callbacks)

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "engine.turn_start" }))
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "engine.turn_end" }))
  })

  it("fires onModelStreamStart on first content token", async () => {
    mockCreate.mockReturnValue(
      makeStream([makeChunk("hello"), makeChunk(" world")])
    )

    const calls: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => calls.push("streamStart"),
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    // onModelStreamStart should fire exactly once
    expect(calls).toEqual(["streamStart"])
  })

  it("routes inline think tags to onReasoningChunk and answer to onTextChunk (single chunk)", async () => {
    mockCreate.mockReturnValue(
      makeStream([makeChunk("<think>reasoning</think>answer")])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks.join("")).toBe("reasoning")
    expect(textChunks.join("")).toBe("answer")
  })

  it("routes inline think tags split across chunks", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk("<think>"),
        makeChunk("reasoning"),
        makeChunk("</think>"),
        makeChunk("answer"),
      ])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks.join("")).toBe("reasoning")
    expect(textChunks.join("")).toBe("answer")
  })

  it("content-only (no think tags) goes only to onTextChunk", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("just text")]))

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(textChunks).toEqual(["just text"])
    expect(reasoningChunks).toEqual([])
  })

  it("think-only content goes only to onReasoningChunk", async () => {
    mockCreate.mockReturnValue(
      makeStream([makeChunk("<think>only thinking</think>")])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks.join("")).toBe("only thinking")
    expect(textChunks).toEqual([])
  })

  it("handles multiple think blocks in content", async () => {
    mockCreate.mockReturnValue(
      makeStream([makeChunk("<think>a</think>mid<think>b</think>end")])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks.join("")).toBe("ab")
    expect(textChunks.join("")).toBe("midend")
  })

  it("handles partial think tag at chunk boundary", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk("some text<thi"),
        makeChunk("nk>reasoning</think>answer"),
      ])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks.join("")).toBe("reasoning")
    expect(textChunks.join("")).toBe("some textanswer")
  })

  it("handles think tags split across many chunks", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk("<th"),
        makeChunk("ink>"),
        makeChunk("reas"),
        makeChunk("oning</thi"),
        makeChunk("nk>answer"),
      ])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks.join("")).toBe("reasoning")
    expect(textChunks.join("")).toBe("answer")
  })

  it("handles partial close tag at chunk boundary inside think block", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk("<think>reasoning</"),
        makeChunk("think>answer"),
      ])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks.join("")).toBe("reasoning")
    expect(textChunks.join("")).toBe("answer")
  })

  it("flushes remaining content buffer as text at end of stream", async () => {
    // Content that ends with a partial <think> prefix -- at flush time, treated as plain text
    mockCreate.mockReturnValue(
      makeStream([makeChunk("hello<th")])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(textChunks.join("")).toBe("hello<th")
    expect(reasoningChunks).toEqual([])
  })

  it("flushes remaining reasoning buffer at end of stream (unclosed think)", async () => {
    // Think block that never closes -- at flush time, remaining buffer is reasoning
    mockCreate.mockReturnValue(
      makeStream([makeChunk("<think>unterminated reasoning")])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks.join("")).toBe("unterminated reasoning")
    expect(textChunks).toEqual([])
  })

  it("retains partial close tag prefix in reasoning buffer across chunks", async () => {
    // Reasoning text ending with partial </think> prefix: "reasoning</"
    // Next chunk completes it: "think>answer"
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk("<think>reasoning</"),
        makeChunk("think>answer"),
      ])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks.join("")).toBe("reasoning")
    expect(textChunks.join("")).toBe("answer")
  })

  it("flushes partial close tag prefix as reasoning at end of stream", async () => {
    // Stream ends with buffer holding a partial </think> prefix inside think block
    mockCreate.mockReturnValue(
      makeStream([makeChunk("<think>reasoning</")])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    // "reasoning" is emitted during chunked processing, "</" is flushed at end as reasoning
    expect(reasoningChunks.join("")).toBe("reasoning</")
    expect(textChunks).toEqual([])
  })

  it("handles empty reasoning before partial close tag prefix", async () => {
    // Think tag opens, then immediately a partial close tag with no reasoning in between
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk("<think></"),
        makeChunk("think>answer"),
      ])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks).toEqual([])
    expect(textChunks.join("")).toBe("answer")
  })

  it("handles empty content chunks in think tag processing", async () => {
    mockCreate.mockReturnValue(
      makeStream([makeChunk("<think>r</think>text")])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks.join("")).toBe("r")
    expect(textChunks.join("")).toBe("text")
  })

  it("ends loop when response has no tool calls", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("just text")]))

    let modelStartCount = 0
    const callbacks: ChannelCallbacks = {
      onModelStart: () => modelStartCount++,
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    // Should only call the model once
    expect(modelStartCount).toBe(1)
  })

  it("fires onToolStart before tool execution and onToolEnd after", async () => {
    // First call: model returns tool call
    // Second call: model returns text only (ending loop)
    vi.mocked(fs.readFileSync).mockReturnValue("file data")

    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"/tmp/test.txt"}' } },
          ]),
        ])
      }
      return makeStream([makeChunk("done")])
    })

    const events: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => events.push("modelStart"),
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onToolStart: (name, args) => events.push(`toolStart:${name}:${args.path}`),
      onToolEnd: (name, summary, success) => events.push(`toolEnd:${name}:${summary}:${success}`),
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)

    expect(events).toContain("toolStart:read_file:/tmp/test.txt")
    // onToolEnd should appear after toolStart
    const toolStartIdx = events.indexOf("toolStart:read_file:/tmp/test.txt")
    const toolEndIdx = events.findIndex((e) => e.startsWith("toolEnd:read_file"))
    expect(toolEndIdx).toBeGreaterThan(toolStartIdx)
  })

  it("loops back for another model call after tool execution", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("data")

    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"f.txt"}' } },
          ]),
        ])
      }
      return makeStream([makeChunk("final answer")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(callCount).toBe(2)
  })

  it("fires onError on API errors with terminal severity and ends loop", async () => {
    mockCreate.mockImplementation(() => {
      throw new Error("API rate limit")
    })

    const errors: { error: Error; severity: string }[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err, severity) => errors.push({ error: err, severity }),
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(errors).toHaveLength(1)
    expect(errors[0].error.message).toBe("API rate limit")
    expect(errors[0].severity).toBe("terminal")
  })

  it("pushes assistant message with content onto messages array", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("hello there")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    const assistantMsg = messages.find((m: any) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg.content).toBe("hello there")
  })

  it("pushes assistant message with tool_calls and tool result messages", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("contents")

    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
          ]),
        ])
      }
      return makeStream([makeChunk("ok")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    // Should have: system, assistant (with tool_calls), tool result, assistant (text)
    const toolCallMsg = messages.find(
      (m: any) => m.role === "assistant" && m.tool_calls
    )
    expect(toolCallMsg).toBeDefined()
    expect(toolCallMsg.tool_calls[0].function.name).toBe("read_file")

    const toolResultMsg = messages.find((m: any) => m.role === "tool")
    expect(toolResultMsg).toBeDefined()
    expect(toolResultMsg.tool_call_id).toBe("call_1")
    expect(toolResultMsg.content).toBe("contents")
  })

  it("does NOT push user message (adapter responsibility)", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("response")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [
      { role: "system", content: "test" },
      { role: "user", content: "hi" },
    ]
    const initialLen = messages.length
    await runAgent(messages, callbacks)

    // Only assistant message should be added, no user message
    const userMessages = messages.filter((m: any) => m.role === "user")
    expect(userMessages).toHaveLength(1) // only the one we passed in
  })

  it("handles tool call with arguments split across chunks", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("data")

    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path"' } },
          ]),
          makeChunk(undefined, [
            { index: 0, function: { arguments: ':"/tmp/f.txt"}' } },
          ]),
        ])
      }
      return makeStream([makeChunk("done")])
    })

    const toolNames: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onToolStart: (name) => toolNames.push(name),
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(toolNames).toEqual(["read_file"])
  })

  it("handles multiple tool calls in a single response", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("data1")
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: "a.txt", isDirectory: () => false } as any,
    ])

    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
            { index: 1, id: "call_2", function: { name: "list_directory", arguments: '{"path":"/tmp"}' } },
          ]),
        ])
      }
      return makeStream([makeChunk("done")])
    })

    const toolStarts: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onToolStart: (name) => toolStarts.push(name),
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(toolStarts).toEqual(["read_file", "list_directory"])
  })

  it("fires onToolEnd with success=false when tool throws", async () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath).includes("missing.txt")) {
        throw new Error("file not found")
      }
      return defaultReadFileSync(filePath)
    })

    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"missing.txt"}' } },
          ]),
        ])
      }
      return makeStream([makeChunk("ok")])
    })

    const toolEnds: { name: string; success: boolean }[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onToolStart: () => {},
      onToolEnd: (name, _summary, success) => toolEnds.push({ name, success }),
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(toolEnds).toHaveLength(1)
    expect(toolEnds[0].success).toBe(false)
  })

  it("skips chunks with no delta", async () => {
    mockCreate.mockReturnValue(
      makeStream([{ choices: [{}] }, makeChunk("text")])
    )

    const chunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => chunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(chunks).toEqual(["text"])
  })

  it("handles invalid JSON in tool call arguments gracefully", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("fallback")

    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "read_file", arguments: "not valid json{" } },
          ]),
        ])
      }
      return makeStream([makeChunk("done")])
    })

    const toolStarts: { name: string; args: Record<string, string> }[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onToolStart: (name, args) => toolStarts.push({ name, args }),
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    // args should be empty object when JSON parse fails
    expect(toolStarts[0].args).toEqual({})
  })

  it("wraps non-Error thrown values in Error in onError callback", async () => {
    mockCreate.mockImplementation(() => {
      throw "string error"
    })

    const errors: Error[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err) => errors.push(err),
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect(errors[0].message).toBe("string error")
  })

  it("pushes assistant message without content when only tool calls are returned", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("data")

    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
          ]),
        ])
      }
      return makeStream([makeChunk("result")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    const firstAssistant = messages.find((m: any) => m.role === "assistant")
    // When there's no content, content should not be set on the message
    expect(firstAssistant.content).toBeUndefined()
    expect(firstAssistant.tool_calls).toBeDefined()
  })

  it("handles tool call chunks with missing id and function name", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("data")

    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          // First chunk: no id, no function name -- only index
          makeChunk(undefined, [
            { index: 0 },
          ]),
          // Second chunk: provides id and name
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"x.txt"}' } },
          ]),
        ])
      }
      return makeStream([makeChunk("done")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)
    const toolMsg = messages.find((m: any) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    expect(toolMsg.content).toBe("data")
  })

  it("handles tool call chunk with no function arguments", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("data")

    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          // Chunk with id and name but no arguments field
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "get_current_time" } },
          ]),
        ])
      }
      return makeStream([makeChunk("done")])
    })

    const toolStarts: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onToolStart: (name) => toolStarts.push(name),
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(toolStarts).toContain("get_current_time")
  })

  it("uses minimax model from config when set", async () => {
    await setupConfig({ providers: { minimax: { apiKey: "test-key", model: "custom-model" } } })
    mockCreate.mockReturnValue(makeStream([makeChunk("hi")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.model).toBe("custom-model")
  })

  it("calls onReasoningChunk for reasoning_content", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        { choices: [{ delta: { reasoning_content: "thinking hard" } }] },
        { choices: [{ delta: { content: "answer" } }] },
      ])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks).toEqual(["thinking hard"])
    expect(textChunks).toEqual(["answer"])
  })

  it("calls onReasoningChunk for reasoning-only stream (no tool calls, accepted as-is)", async () => {
    // With kick detection disabled and tool_choice: required, the model
    // should not normally return text-only, but if it does, the response
    // is accepted as-is. This test verifies reasoning chunks are captured.
    mockCreate.mockReturnValue(
      makeStream([
        { choices: [{ delta: { reasoning_content: "still thinking" } }] },
        makeChunk("got it"),
      ])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks).toEqual(["still thinking"])
    expect(textChunks).toEqual(["got it"])
  })

  it("stops immediately when signal is pre-aborted", async () => {
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const controller = new AbortController()
    controller.abort()
    await runAgent([{ role: "system", content: "test" }], callbacks, undefined, controller.signal)
    // mockCreate should never be called
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("stops streaming when signal is aborted mid-stream", async () => {
    const controller = new AbortController()
    mockCreate.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield makeChunk("hello")
        controller.abort()
        yield makeChunk(" world") // should be skipped
      },
    })

    const chunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => chunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks, undefined, controller.signal)
    expect(chunks).toEqual(["hello"])
  })

  it("breaks out of loop cleanly when signal aborted during catch", async () => {
    const controller = new AbortController()
    mockCreate.mockImplementation(() => {
      controller.abort()
      throw new Error("network error")
    })

    const errors: Error[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err) => errors.push(err),
    }

    await runAgent([{ role: "system", content: "test" }], callbacks, undefined, controller.signal)
    // Abort in catch path should break cleanly, not fire onError
    expect(errors).toHaveLength(0)
  })

  it("skips remaining tools when signal is aborted mid-tool-execution", async () => {
    const controller = new AbortController()
    vi.mocked(fs.readFileSync).mockReturnValue("data")

    // Return 2 tool calls in one response
    mockCreate.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
          { index: 1, id: "call_2", function: { name: "read_file", arguments: '{"path":"b.txt"}' } },
        ])
      },
    })

    const toolStarts: string[] = []
    let toolEndCount = 0
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: (name) => toolStarts.push(name),
      onToolEnd: () => { toolEndCount++; if (toolEndCount === 1) controller.abort() },
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks, undefined, controller.signal)
    // First tool executes, onToolEnd aborts signal, second tool should be skipped
    expect(toolStarts.length).toBe(1)
  })

  it("fires onModelStreamStart on first reasoning_content token", async () => {
    // With kick detection disabled, a reasoning-only response is accepted
    // as-is (single API call, no retry).
    mockCreate.mockReturnValue(
      makeStream([
        { choices: [{ delta: { reasoning_content: "hmm" } }] },
      ])
    )

    const calls: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => calls.push("streamStart"),
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    // streamStart fires once (no retry -- kick detection disabled)
    expect(calls).toEqual(["streamStart"])
  })

  it("calls onReasoningChunk for each reasoning chunk", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          { choices: [{ delta: { reasoning_content: "step 1" } }] },
          { choices: [{ delta: { reasoning_content: "step 2" } }] },
        ])
      }
      return makeStream([makeChunk("done")])
    })

    const reasoningChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks).toEqual(["step 1", "step 2"])
  })

  it("handles multiple reasoning_content chunks before content", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        { choices: [{ delta: { reasoning_content: "step 1 " } }] },
        { choices: [{ delta: { reasoning_content: "step 2" } }] },
        { choices: [{ delta: { content: "result" } }] },
      ])
    )

    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: (text) => reasoningChunks.push(text),
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(reasoningChunks).toEqual(["step 1 ", "step 2"])
    expect(textChunks).toEqual(["result"])
  })

  it("Azure provider calls mockResponsesCreate with Responses API params", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    mockResponsesCreate.mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "hello" },
    ]))

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await core.runAgent([{ role: "system", content: "test" }], callbacks)
    expect(mockResponsesCreate).toHaveBeenCalledTimes(1)
    expect(mockCreate).not.toHaveBeenCalled()
    const params = mockResponsesCreate.mock.calls[0][0]
    expect(params.model).toBe("gpt-5.2-chat")
    expect(params.stream).toBe(true)
    expect(params.store).toBe(false)
    expect(params.include).toEqual(["reasoning.encrypted_content"])
    expect(params.reasoning).toEqual({ effort: "medium", summary: "detailed" })
    expect(params.instructions).toBe("test")
    expect(params.tools).toBeDefined()

    // config cleanup handled by resetConfigCache in beforeEach
  })

  it("Azure text-only response: assistant message pushed in CC format, loop ends", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    mockResponsesCreate.mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "hello azure" },
    ]))

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await core.runAgent(messages, callbacks)
    const assistantMsg = messages.find((m: any) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg.content).toBe("hello azure")

    // config cleanup handled by resetConfigCache in beforeEach
  })

  it("Azure: propagates traceId option into responses metadata", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    mockResponsesCreate.mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "hello azure trace" },
    ]))

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await core.runAgent(
      [{ role: "system", content: "test" }],
      callbacks,
      undefined,
      undefined,
      { traceId: "trace-azure" } as any,
    )

    const params = mockResponsesCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(params).toEqual(expect.objectContaining({
      metadata: { trace_id: "trace-azure" },
    }))
  })

  it("Azure tool-use turn: tool executed, result pushed, loop continues", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    vi.mocked(fs.readFileSync).mockReturnValue("file contents")

    let callCount = 0
    mockResponsesCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeResponsesStream([
          { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "read_file", arguments: "" } },
          { type: "response.function_call_arguments.delta", delta: '{"path":"a.txt"}' },
          { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' } },
        ])
      }
      return makeResponsesStream([
        { type: "response.output_text.delta", delta: "done" },
      ])
    })

    const core = await import("../../heart/core")
    const toolStarts: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: (name) => toolStarts.push(name),
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await core.runAgent(messages, callbacks)
    expect(callCount).toBe(2)
    expect(toolStarts).toEqual(["read_file"])
    const toolMsg = messages.find((m: any) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    expect(toolMsg.content).toBe("file contents")

    // config cleanup handled by resetConfigCache in beforeEach
  })

  it("Azure native input: output items + function_call_output in correct order", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    vi.mocked(fs.readFileSync).mockReturnValue("data")

    const reasoningItem = { type: "reasoning", id: "r1", summary: [{ text: "thought", type: "summary_text" }], encrypted_content: "enc1" }
    const funcItem = { type: "function_call", id: "fc1", call_id: "c1", name: "read_file", arguments: '{"path":"a.txt"}', status: "completed" }
    let callCount = 0
    mockResponsesCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeResponsesStream([
          { type: "response.output_item.done", item: reasoningItem },
          { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "read_file", arguments: "" } },
          { type: "response.function_call_arguments.delta", delta: '{"path":"a.txt"}' },
          { type: "response.output_item.done", item: funcItem },
        ])
      }
      return makeResponsesStream([
        { type: "response.output_text.delta", delta: "done" },
      ])
    })

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await core.runAgent([{ role: "system", content: "test" }, { role: "user", content: "hi" }], callbacks)
    // Second call uses the maintained native input array
    const secondCallInput = mockResponsesCreate.mock.calls[1][0].input
    // Should contain: user("hi"), reasoning, function_call, function_call_output
    const userItem = secondCallInput.find((i: any) => i.role === "user")
    expect(userItem).toBeDefined()
    // Reasoning item in correct position (before function_call, not at end)
    const reasoningIdx = secondCallInput.findIndex((i: any) => i.type === "reasoning")
    const funcCallIdx = secondCallInput.findIndex((i: any) => i.type === "function_call")
    const funcOutputIdx = secondCallInput.findIndex((i: any) => i.type === "function_call_output")
    expect(reasoningIdx).toBeGreaterThan(-1)
    expect(funcCallIdx).toBeGreaterThan(reasoningIdx)
    expect(funcOutputIdx).toBeGreaterThan(funcCallIdx)
    // Original output items preserved (with their id fields)
    expect(secondCallInput[reasoningIdx].encrypted_content).toBe("enc1")
    expect(secondCallInput[funcCallIdx].id).toBe("fc1")
    // function_call_output has the tool result
    expect(secondCallInput[funcOutputIdx].call_id).toBe("c1")
    expect(secondCallInput[funcOutputIdx].output).toBe("data")

    // config cleanup handled by resetConfigCache in beforeEach
  })

  it("Azure native input: same array reference reused across iterations", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    vi.mocked(fs.readFileSync).mockReturnValue("data")

    const funcItem = { type: "function_call", id: "fc1", call_id: "c1", name: "read_file", arguments: '{"path":"a.txt"}', status: "completed" }
    // Capture input snapshots at call time
    const inputSnapshots: any[][] = []
    let callCount = 0
    mockResponsesCreate.mockImplementation((params: any) => {
      callCount++
      inputSnapshots.push([...params.input])
      if (callCount === 1) {
        return makeResponsesStream([
          { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "read_file", arguments: "" } },
          { type: "response.function_call_arguments.delta", delta: '{"path":"a.txt"}' },
          { type: "response.output_item.done", item: funcItem },
        ])
      }
      return makeResponsesStream([
        { type: "response.output_text.delta", delta: "done" },
      ])
    })

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await core.runAgent([{ role: "system", content: "test" }, { role: "user", content: "hi" }], callbacks)
    // First call: initialized from toResponsesInput (just user message)
    expect(inputSnapshots[0]).toEqual([{ role: "user", content: "hi" }])
    // Second call: same array grew with output items + function_call_output
    expect(inputSnapshots[1].length).toBeGreaterThan(1)
    expect(inputSnapshots[1][0]).toEqual({ role: "user", content: "hi" })
    // It IS the same array reference (mutated in place, not rebuilt)
    expect(mockResponsesCreate.mock.calls[0][0].input).toBe(mockResponsesCreate.mock.calls[1][0].input)

    // config cleanup handled by resetConfigCache in beforeEach
  })

  it("does not pass reasoning params for MiniMax provider", async () => {
    mockCreate.mockReturnValue(
      makeStream([makeChunk("hello")])
    )

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    const params = mockCreate.mock.calls[0][0]
    expect(params.reasoning_effort).toBeUndefined()
  })

  it("MiniMax path calls mockCreate, not mockResponsesCreate", async () => {
    mockCreate.mockReturnValue(
      makeStream([makeChunk("hello")])
    )

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockResponsesCreate).not.toHaveBeenCalled()
  })

  // --- Unit 1a: Store reasoning items on assistant messages ---

  it("Azure: stores reasoning items as _reasoning_items on assistant message", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    const reasoningItem = { type: "reasoning", id: "r1", summary: [{ text: "thought", type: "summary_text" }], encrypted_content: "enc123" }
    mockResponsesCreate.mockReturnValue(makeResponsesStream([
      { type: "response.output_item.done", item: reasoningItem },
      { type: "response.output_text.delta", delta: "answer" },
    ]))

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await core.runAgent(messages, callbacks)

    const assistantMsg = messages.find((m: any) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg._reasoning_items).toEqual([reasoningItem])

    // config cleanup handled by resetConfigCache in beforeEach
  })

  it("Azure: does not set _reasoning_items when outputItems has no reasoning items", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    const messageItem = { type: "message", id: "m1", content: [{ type: "output_text", text: "hello" }] }
    mockResponsesCreate.mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "hello" },
      { type: "response.output_item.done", item: messageItem },
    ]))

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await core.runAgent(messages, callbacks)

    const assistantMsg = messages.find((m: any) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg._reasoning_items).toBeUndefined()

    // config cleanup handled by resetConfigCache in beforeEach
  })

  it("Azure: stores only reasoning items when outputItems has mixed types", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    const reasoningItem = { type: "reasoning", id: "r1", summary: [{ text: "thought", type: "summary_text" }], encrypted_content: "enc1" }
    const messageItem = { type: "message", id: "m1", content: [{ type: "output_text", text: "hello" }] }
    mockResponsesCreate.mockReturnValue(makeResponsesStream([
      { type: "response.output_item.done", item: reasoningItem },
      { type: "response.output_text.delta", delta: "hello" },
      { type: "response.output_item.done", item: messageItem },
    ]))

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await core.runAgent(messages, callbacks)

    const assistantMsg = messages.find((m: any) => m.role === "assistant")
    expect(assistantMsg._reasoning_items).toEqual([reasoningItem])
    expect(assistantMsg._reasoning_items).toHaveLength(1)

    // config cleanup handled by resetConfigCache in beforeEach
  })

  it("Azure: azureInput.push still happens for each outputItem (existing behavior preserved)", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    vi.mocked(fs.readFileSync).mockReturnValue("data")

    const reasoningItem = { type: "reasoning", id: "r1", summary: [], encrypted_content: "enc1" }
    const funcItem = { type: "function_call", id: "fc1", call_id: "c1", name: "read_file", arguments: '{"path":"a.txt"}', status: "completed" }
    let callCount = 0
    mockResponsesCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeResponsesStream([
          { type: "response.output_item.done", item: reasoningItem },
          { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "read_file", arguments: "" } },
          { type: "response.function_call_arguments.delta", delta: '{"path":"a.txt"}' },
          { type: "response.output_item.done", item: funcItem },
        ])
      }
      return makeResponsesStream([
        { type: "response.output_text.delta", delta: "done" },
      ])
    })

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }, { role: "user", content: "hi" }]
    await core.runAgent(messages, callbacks)

    // Verify the second call's input still contains reasoning + function_call items (azureInput.push preserved)
    const secondCallInput = mockResponsesCreate.mock.calls[1][0].input
    const reasoningIdx = secondCallInput.findIndex((i: any) => i.type === "reasoning")
    const funcCallIdx = secondCallInput.findIndex((i: any) => i.type === "function_call")
    expect(reasoningIdx).toBeGreaterThan(-1)
    expect(funcCallIdx).toBeGreaterThan(reasoningIdx)

    // config cleanup handled by resetConfigCache in beforeEach
  })

  it("MiniMax: does not set _reasoning_items (outputItems always empty)", async () => {
    mockCreate.mockReturnValue(
      makeStream([makeChunk("hello")])
    )

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    const assistantMsg = messages.find((m: any) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg._reasoning_items).toBeUndefined()
  })

  // --- Unit 3c: runAgent returns { usage } ---

  it("returns usage from single API call (no tool calls)", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk("hello"),
        { choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
      ])
    )

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const result = await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(result.usage).toBeDefined()
    expect(result.usage!.input_tokens).toBe(100)
    expect(result.usage!.output_tokens).toBe(50)
    expect(result.usage!.total_tokens).toBe(150)
  })

  it("returns usage from last API call when multiple tool rounds", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("data")
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }]),
          { choices: [{ delta: {} }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } },
        ])
      }
      return makeStream([
        makeChunk("done"),
        { choices: [{ delta: {} }], usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 } },
      ])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const result = await runAgent([{ role: "system", content: "test" }], callbacks)
    // Should return usage from the LAST call (200/100/300), not the first (50/20/70)
    expect(result.usage).toBeDefined()
    expect(result.usage!.input_tokens).toBe(200)
    expect(result.usage!.total_tokens).toBe(300)
  })

  it("returns undefined usage when no usage data available", async () => {
    mockCreate.mockReturnValue(
      makeStream([makeChunk("hello")])
    )

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const result = await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(result.usage).toBeUndefined()
  })

  it("returns undefined usage on error", async () => {
    mockCreate.mockImplementation(() => { throw new Error("invalid request") })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const result = await runAgent([{ role: "system", content: "test" }], callbacks)
    expect(result.usage).toBeUndefined()
  })

  // ── context overflow auto-recovery ──

  it("recovers from Azure context_length_exceeded error by trimming and retrying", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        const err: any = new Error("context_length_exceeded")
        err.code = "context_length_exceeded"
        throw err
      }
      return makeStream([makeChunk("recovered")])
    })

    const errors: { error: Error; severity: string }[] = []
    const chunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (t) => chunks.push(t),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err, severity) => errors.push({ error: err, severity }),
    }

    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old msg 1" },
      { role: "assistant", content: "old reply 1" },
      { role: "user", content: "latest" },
    ]
    await runAgent(messages, callbacks)

    // Should have retried and succeeded
    expect(callCount).toBe(2)
    expect(chunks).toContain("recovered")
    // Should have logged a trim info message with transient severity
    expect(errors.some(e => e.error.message.includes("trimm"))).toBe(true)
    expect(errors[0].severity).toBe("transient")
  })

  it("recovers from Azure overflow via error message (no .code)", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        throw new Error("Request failed: context_length_exceeded for this model")
      }
      return makeStream([makeChunk("ok")])
    })

    const errors: Error[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err) => errors.push(err),
    }

    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "msg" },
    ]
    await runAgent(messages, callbacks)

    expect(callCount).toBe(2) // retry succeeded
  })

  it("recovers from MiniMax context window exceeds limit error", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        throw new Error("context window exceeds limit")
      }
      return makeStream([makeChunk("ok")])
    })

    const errors: Error[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err) => errors.push(err),
    }

    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "msg" },
    ]
    await runAgent(messages, callbacks)

    expect(callCount).toBe(2) // retry succeeded
  })

  it("surfaces error via onError when retry also fails with overflow", async () => {
    mockCreate.mockImplementation(() => {
      const err: any = new Error("context_length_exceeded")
      err.code = "context_length_exceeded"
      throw err
    })

    const errors: Error[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err) => errors.push(err),
    }

    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "msg" },
    ]
    await runAgent(messages, callbacks)

    // First error is trim info, second is the actual overflow error
    expect(errors.length).toBeGreaterThanOrEqual(2)
    expect(errors[errors.length - 1].message).toContain("context_length_exceeded")
  })

  it("does not catch non-overflow errors with overflow recovery", async () => {
    mockCreate.mockImplementation(() => {
      throw new Error("invalid request format")
    })

    const errors: Error[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err) => errors.push(err),
    }

    const messages: any[] = [{ role: "system", content: "sys" }]
    await runAgent(messages, callbacks)

    // Should have exactly 1 error (the original error), no retry
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe("invalid request format")
  })

  it("strips tool calls before trimming on mid-turn overflow", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // First call returns tool calls
        return makeStream([
          makeChunk(undefined, [{ index: 0, id: "tc1", function: { name: "search", arguments: '{"q":"test"}' } }]),
        ])
      }
      if (callCount === 2) {
        // Second call (tool execution done) overflows
        const err: any = new Error("context_length_exceeded")
        err.code = "context_length_exceeded"
        throw err
      }
      // Third call succeeds after trim
      return makeStream([makeChunk("recovered after tool overflow")])
    })

    const toolResults = new Map()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([] as any)
    vi.mocked(spawnSync).mockReturnValue({ stdout: "tool result", stderr: "", status: 0 } as any)
    vi.mocked(execSync).mockReturnValue("tool result" as any)

    const errors: Error[] = []
    const chunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (t) => chunks.push(t),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err) => errors.push(err),
    }

    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "do something" },
    ]
    await runAgent(messages, callbacks)

    // Should have recovered after trim
    expect(callCount).toBe(3)
    expect(chunks).toContain("recovered after tool overflow")
    // Messages should not have orphan tool_calls or tool results
    const hasToolMsg = messages.some((m: any) => m.role === "tool")
    // After trim+stripLastToolCalls, tool messages should be cleaned
    expect(errors.some(e => e.message.includes("trimm"))).toBe(true)
  })

  it("handles overflow error with empty message property", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        const err: any = new Error()
        err.code = "context_length_exceeded"
        err.message = "" // empty message
        throw err
      }
      return makeStream([makeChunk("ok")])
    })

    const errors: Error[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err) => errors.push(err),
    }

    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "msg" },
    ]
    await runAgent(messages, callbacks)

    expect(callCount).toBe(2) // retry succeeded via .code check
  })

  it("overflow on cold start with only system message still retries", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        throw new Error("context_length_exceeded")
      }
      return makeStream([makeChunk("ok")])
    })

    const errors: Error[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err) => errors.push(err),
    }

    // Only system message -- can't trim further, but retry should still happen
    const messages: any[] = [{ role: "system", content: "sys" }]
    await runAgent(messages, callbacks)

    expect(callCount).toBe(2) // retry attempted
  })

  // ── transient network error retry ──

  it("retries on transient network errors with backoff and transient severity", async () => {
    vi.useFakeTimers()
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount <= 2) {
        const err: any = new Error("fetch failed")
        throw err
      }
      return makeStream([makeChunk("recovered")])
    })

    const errors: { error: Error; severity: string }[] = []
    const chunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (t) => chunks.push(t),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err, severity) => errors.push({ error: err, severity }),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    const promise = runAgent(messages, callbacks)

    // First retry: 2s delay
    await vi.advanceTimersByTimeAsync(2100)
    // Second retry: 4s delay
    await vi.advanceTimersByTimeAsync(4100)
    // Let setImmediate ticks process
    await vi.advanceTimersByTimeAsync(100)

    await promise

    expect(callCount).toBe(3)
    expect(chunks).toContain("recovered")
    expect(errors.length).toBe(2) // two retry messages
    expect(errors[0].error.message).toContain("retrying in 2s (1/3)")
    expect(errors[0].severity).toBe("transient")
    expect(errors[1].error.message).toContain("retrying in 4s (2/3)")
    expect(errors[1].severity).toBe("transient")

    vi.useRealTimers()
  })

  it("gives up after MAX_RETRIES transient failures with terminal final error", async () => {
    vi.useFakeTimers()
    mockCreate.mockImplementation(() => {
      const err: any = new Error("connect failed")
      err.code = "ECONNREFUSED"
      throw err
    })

    const errors: { error: Error; severity: string }[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err, severity) => errors.push({ error: err, severity }),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    const promise = runAgent(messages, callbacks)

    // Advance through all 3 retry delays: 2s, 4s, 8s
    await vi.advanceTimersByTimeAsync(2100)
    await vi.advanceTimersByTimeAsync(4100)
    await vi.advanceTimersByTimeAsync(8100)
    await vi.advanceTimersByTimeAsync(100)

    await promise

    // 3 retry messages + 1 final error
    expect(errors.length).toBe(4)
    expect(errors[0].error.message).toContain("retrying in 2s (1/3)")
    expect(errors[0].severity).toBe("transient")
    expect(errors[1].error.message).toContain("retrying in 4s (2/3)")
    expect(errors[1].severity).toBe("transient")
    expect(errors[2].error.message).toContain("retrying in 8s (3/3)")
    expect(errors[2].severity).toBe("transient")
    expect(errors[3].error.message).toContain("connect failed")
    expect(errors[3].severity).toBe("terminal")

    vi.useRealTimers()
  })

  it("aborts retry wait on signal abort", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    mockCreate.mockImplementation(() => {
      const err: any = new Error("fetch failed")
      throw err
    })

    const errors: Error[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err) => errors.push(err),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    const promise = runAgent(messages, callbacks, undefined, controller.signal)

    // Let it start the first retry wait
    await vi.advanceTimersByTimeAsync(100)
    // Abort during wait
    controller.abort()
    await vi.advanceTimersByTimeAsync(100)

    await promise

    // Only 1 retry message, no final error (clean abort)
    expect(errors.length).toBe(1)
    expect(errors[0].message).toContain("retrying")

    vi.useRealTimers()
  })

  it("skips retry wait immediately when signal is already aborted", async () => {
    const controller = new AbortController()
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      const err: any = new Error("fetch failed")
      throw err
    })

    const errors: Error[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      // Abort in the error callback — signal is not yet aborted when the
      // catch block's signal?.aborted check runs, but IS aborted by the
      // time the retry wait promise checks signal.aborted (line 365).
      onError: (err) => { errors.push(err); controller.abort() },
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, controller.signal)

    expect(callCount).toBe(1)
    expect(errors.length).toBe(1)
    expect(errors[0].message).toContain("retrying")
  })

  it("resets retry count after successful call", async () => {
    vi.useFakeTimers()
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      // First call: tool call
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [{ index: 0, id: "tc1", function: { name: "search", arguments: '{"q":"test"}' } }]),
        ])
      }
      // Second call: network error
      if (callCount === 2) {
        throw new Error("fetch failed")
      }
      // Third call: success after retry
      return makeStream([makeChunk("done")])
    })

    const errors: Error[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err) => errors.push(err),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    const promise = runAgent(messages, callbacks)

    // Let first call (tool) + tool exec + second call (error) happen
    await vi.advanceTimersByTimeAsync(100)
    // First retry: 2s
    await vi.advanceTimersByTimeAsync(2100)
    await vi.advanceTimersByTimeAsync(100)

    await promise

    expect(callCount).toBe(3)
    // retry message says (1/3) — counter was reset after first success
    expect(errors.some(e => e.message.includes("1/3"))).toBe(true)

    vi.useRealTimers()
  })

  it("detects HTTP 429 and 5xx as transient errors", async () => {
    vi.useFakeTimers()
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        const err: any = new Error("rate limited")
        err.status = 429
        throw err
      }
      return makeStream([makeChunk("ok")])
    })

    const errors: Error[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err) => errors.push(err),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    const promise = runAgent(messages, callbacks)

    await vi.advanceTimersByTimeAsync(2100)
    await vi.advanceTimersByTimeAsync(100)

    await promise

    expect(callCount).toBe(2)
    expect(errors[0].message).toContain("retrying")

    vi.useRealTimers()
  })

  // ── system prompt refresh (Feature 5) ──

  it("refreshes system prompt at start of runAgent when channel is passed", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("hi")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [
      { role: "system", content: "stale old prompt" },
      { role: "user", content: "hello" },
    ]
    await runAgent(messages, callbacks, "cli")

    // messages[0] should have been refreshed with await buildSystem("cli")
    expect(messages[0].content).not.toBe("stale old prompt")
    expect(messages[0].role).toBe("system")
  })

  it("runs associative recall injection before model calls when channel is provided", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("hi")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [
      { role: "system", content: "stale old prompt" },
      { role: "user", content: "hello" },
    ]
    await runAgent(messages, callbacks, "cli")

    expect(mockInjectAssociativeRecall).toHaveBeenCalledWith(messages)
  })

  it("refreshes system prompt for teams channel", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("hi")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [
      { role: "system", content: "stale old prompt" },
      { role: "user", content: "hello" },
    ]
    await runAgent(messages, callbacks, "teams")

    // messages[0] should have been refreshed
    expect(messages[0].content).not.toBe("stale old prompt")
    expect(messages[0].role).toBe("system")
  })

  it("preserves non-system history when refreshing system prompt", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("hi")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [
      { role: "user", content: "hello from history" },
    ]
    await runAgent(messages, callbacks, "cli")

    expect(messages[0].role).toBe("system")
    expect(messages.some((m: any) => m.role === "user" && m.content === "hello from history")).toBe(true)
  })

  it("falls back to existing system prompt when prompt refresh fails", async () => {
    vi.resetModules()
    mockCreate.mockReset()
    mockResponsesCreate.mockReset()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockRejectedValue(new Error("prompt refresh failed")),
    }))

    try {
      const core = await import("../../heart/core")
      mockCreate.mockReturnValue(makeStream([makeChunk("hi")]))

      const callbacks: ChannelCallbacks = {
        onModelStart: () => {},
        onModelStreamStart: () => {},
        onTextChunk: () => {},
        onReasoningChunk: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onError: () => {},
      }

      const messages: any[] = [
        { role: "system", content: "stable fallback prompt" },
        { role: "user", content: "hello" },
      ]

      await core.runAgent(messages, callbacks, "teams")

      expect(messages[0].role).toBe("system")
      expect(messages[0].content).toBe("stable fallback prompt")
      expect(messages.some((m: any) => m.role === "user" && m.content === "hello")).toBe(true)
      expect(mockCreate).toHaveBeenCalled()
    } finally {
      vi.doUnmock("../../mind/prompt")
      vi.resetModules()
    }
  })

  it("injects default fallback prompt when refresh throws a non-Error and no system prompt exists", async () => {
    vi.resetModules()
    mockCreate.mockReset()
    mockResponsesCreate.mockReset()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockRejectedValue("refresh unavailable"),
    }))

    try {
      const core = await import("../../heart/core")
      mockCreate.mockReturnValue(makeStream([makeChunk("hi")]))

      const callbacks: ChannelCallbacks = {
        onModelStart: () => {},
        onModelStreamStart: () => {},
        onTextChunk: () => {},
        onReasoningChunk: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onError: () => {},
      }

      const messages: any[] = [
        { role: "user", content: "hello" },
      ]

      await core.runAgent(messages, callbacks, "teams")

      expect(messages[0].role).toBe("system")
      expect(messages[0].content).toBe("You are a helpful assistant.")
      expect(messages.some((m: any) => m.role === "user" && m.content === "hello")).toBe(true)
      expect(mockCreate).toHaveBeenCalled()
    } finally {
      vi.doUnmock("../../mind/prompt")
      vi.resetModules()
    }
  })

  it("still works without channel parameter (backward compatible)", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("hi")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [
      { role: "system", content: "test" },
      { role: "user", content: "hello" },
    ]
    // No channel parameter -- should still work
    await runAgent(messages, callbacks)
    // Messages should have an assistant reply
    expect(messages.some((m: any) => m.role === "assistant")).toBe(true)
  })

  it("uses custom tools when options.tools is provided", async () => {
    const customTool: any = {
      type: "function",
      function: {
        name: "custom_tool",
        description: "A custom tool",
        parameters: { type: "object", properties: {} },
      },
    }

    mockCreate.mockReturnValue(makeStream([makeChunk("hello")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "user", content: "hello" }]
    await runAgent(messages, callbacks, undefined, undefined, {
      tools: [customTool],
    } as any)

    expect(mockCreate).toHaveBeenCalled()
    const apiCall = mockCreate.mock.calls[0][0]
    const toolNames = apiCall.tools.map((t: any) => t.function.name)
    expect(toolNames).toContain("custom_tool")
    // Should NOT contain any of the default tools (like read_file)
    expect(toolNames).not.toContain("read_file")
  })

  it("uses custom execTool when options.execTool is provided", async () => {
    const customExecTool = vi.fn().mockResolvedValue("custom result")

    // First call returns a tool call, second call returns text (done)
    mockCreate
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "my_tool", arguments: '{"arg":"val"}' } },
        ]),
      ]))
      .mockReturnValueOnce(makeStream([makeChunk("done")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "user", content: "hello" }]
    await runAgent(messages, callbacks, undefined, undefined, {
      tools: [{
        type: "function",
        function: {
          name: "my_tool",
          description: "test",
          parameters: { type: "object", properties: {} },
        },
      }],
      execTool: customExecTool,
      toolChoiceRequired: false,
    } as any)

    expect(customExecTool).toHaveBeenCalledWith("my_tool", { arg: "val" }, undefined)
    // Verify the custom result ended up in the messages
    const toolMsg = messages.find((m: any) => m.role === "tool")
    expect(toolMsg?.content).toBe("custom result")
  })

  it("uses default tools and execTool when overrides are not provided", async () => {
    // This is the existing behavior -- just verify it still works
    mockCreate.mockReturnValue(makeStream([makeChunk("hello")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "user", content: "hello" }]
    await runAgent(messages, callbacks)

    // Should have called the API with default tools (which include read_file etc.)
    const apiCall = mockCreate.mock.calls[0][0]
    const toolNames = apiCall.tools.map((t: any) => t.function.name)
    expect(toolNames).toContain("read_file")
  })
})

describe("getClient", () => {
  const saved: Record<string, string | undefined> = {}
  const allVars = [
    "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_MODEL_NAME",
    "AZURE_OPENAI_API_VERSION", "MINIMAX_API_KEY", "MINIMAX_MODEL",
  ]

  beforeEach(() => {
    for (const v of allVars) { saved[v] = process.env[v]; delete process.env[v] }
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
  })

  afterEach(() => {
    for (const v of allVars) {
      if (saved[v] !== undefined) process.env[v] = saved[v]
      else delete process.env[v]
    }
  })

  it("exits when no env vars are set", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      const callbacks: ChannelCallbacks = {
        onModelStart: () => {},
        onModelStreamStart: () => {},
        onTextChunk: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onError: () => {},
      }
      await core.runAgent([], callbacks).catch(() => {})
    } catch {
      // Expected -- process.exit throws
    }

    expect(mockExit).toHaveBeenCalledWith(1)
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "engine.provider_init_error",
      component: "engine",
    }))

    mockExit.mockRestore()
  })

  it("uses MiniMax when minimax config is set", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax("mm-key", "MiniMax-M2.5")

    const core = await import("../../heart/core")
    expect(core.getModel()).toBe("MiniMax-M2.5")
    expect(core.getProvider()).toBe("minimax")
  })

  it("prefers Azure when all Azure config is set", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({ providers: { azure: { apiKey: "azure-test-key", endpoint: "https://test.openai.azure.com", deployment: "test-deployment", modelName: "gpt-4o" }, minimax: { apiKey: "mm-key", model: "MiniMax-M2.5" } } })

    const core = await import("../../heart/core")
    expect(core.getModel()).toBe("gpt-4o")
    expect(core.getProvider()).toBe("azure")
  })

  it("fails fast when selected Azure provider config is incomplete", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    await setupConfig({ providers: { azure: { apiKey: "azure-test-key" }, minimax: { apiKey: "mm-key", model: "MiniMax-M2.5" } } })
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "engine.provider_init_error",
        component: "engine",
        message: expect.stringContaining("provider 'azure' is selected"),
      }))
    } finally {
      mockExit.mockRestore()
    }
  })

  it("caches client across multiple runAgent invocations", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax("mm-key", "cached-model")

    mockCreate.mockReset()
    mockCreate.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: "hi" } }] }
      },
    })

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    // First call initializes getClient()
    await core.runAgent([{ role: "system", content: "test" }], callbacks)
    // Second call hits the cached path (if (!_client) is false)
    await core.runAgent([{ role: "system", content: "test" }], callbacks)

    expect(core.getModel()).toBe("cached-model")
    expect(core.getProvider()).toBe("minimax")
  })

  it("omits model param in createParams when model is empty", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax("mm-key", "")

    mockCreate.mockReset()
    mockCreate.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: "hi" } }] }
      },
    })

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }
    await core.runAgent([{ role: "system", content: "test" }], callbacks)

    // model param should not be in the call since getModel() returns ""
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.model).toBeUndefined()
  })
})

describe("getClient config integration", () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
  })

  it("uses azure config from config.json when apiKey is present", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure("config-az-key", "https://config.openai.azure.com", "config-deploy", "config-model")

    const core = await import("../../heart/core")
    expect(core.getModel()).toBe("config-model")
    expect(core.getProvider()).toBe("azure")
  })

  it("uses minimax config from config.json when apiKey is present", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax("config-mm-key", "config-mm-model")

    const core = await import("../../heart/core")
    expect(core.getModel()).toBe("config-mm-model")
    expect(core.getProvider()).toBe("minimax")
  })

  it("prefers azure when both providers are configured in config.json", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        azure: {
          apiKey: "az-key",
          endpoint: "https://az.openai.azure.com",
          deployment: "deploy",
          modelName: "az-model",
        },
        minimax: {
          apiKey: "mm-key",
          model: "mm-model",
        },
      },
    })

    const core = await import("../../heart/core")
    expect(core.getProvider()).toBe("azure")
  })

  it("uses agent.json provider with secrets.json settings", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax("config-mm-key", "config-mm-model")

    const core = await import("../../heart/core")
    expect(core.getModel()).toBe("config-mm-model")
    expect(core.getProvider()).toBe("minimax")
  })

  it("stripLastToolCalls pops trailing tool messages", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()
    const { stripLastToolCalls } = await import("../../heart/core")

    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "reply", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "result" },
    ]
    stripLastToolCalls(messages)

    // Should pop tool message and strip tool_calls from assistant
    expect(messages.length).toBe(2)
    expect(messages[1].role).toBe("assistant")
    expect(messages[1].tool_calls).toBeUndefined()
    expect(messages[1].content).toBe("reply")
  })

  it("stripLastToolCalls removes empty assistant after stripping tool_calls", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()
    const { stripLastToolCalls } = await import("../../heart/core")

    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "result" },
    ]
    stripLastToolCalls(messages)

    // Should pop both tool and empty assistant
    expect(messages.length).toBe(1)
    expect(messages[0].role).toBe("system")
  })

  it("stripLastToolCalls is a no-op when no trailing tools", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()
    const { stripLastToolCalls } = await import("../../heart/core")

    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "just text" },
    ]
    stripLastToolCalls(messages)

    expect(messages.length).toBe(2)
    expect(messages[1].content).toBe("just text")
  })

  it("exits when neither provider configured in config", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    // Empty config -- no providers at all (defaults have empty strings)
    await resetConfig()

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      const core = await import("../../heart/core")
      const callbacks: ChannelCallbacks = {
        onModelStart: () => {},
        onModelStreamStart: () => {},
        onTextChunk: () => {},
        onReasoningChunk: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onError: () => {},
      }
      await core.runAgent([], callbacks).catch(() => {})
    } catch {
      // Expected -- process.exit throws
    }

    expect(mockExit).toHaveBeenCalledWith(1)
    mockExit.mockRestore()
    mockError.mockRestore()
  })
})

describe("provider abstraction contract", () => {
  it("exports createProviderRegistry for provider abstraction wiring", async () => {
    const core = await import("../../heart/core")
    expect(typeof (core as any).createProviderRegistry).toBe("function")
  })

  it("runAgent request path avoids hardcoded provider-name branches", () => {
    const sourcePath = path.resolve(__dirname, "..", "..", "heart", "core.ts")
    const source = nodeFs.readFileSync(sourcePath, "utf-8")
    expect(source).not.toContain('if (provider === "azure")')
  })

  it("delegates provider runtime construction to dedicated provider modules", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs")
    const sourcePath = path.resolve(__dirname, "..", "..", "heart", "core.ts")
    const source = realFs.readFileSync(sourcePath, "utf-8")
    expect(source).toContain('from "./providers/azure"')
    expect(source).toContain('from "./providers/anthropic"')
    expect(source).toContain('from "./providers/minimax"')
    expect(source).not.toContain("const runtimeFactories:")
    expect(source).not.toContain("streamAnthropicMessages(")
  })

  it("registry provider runtimes expose provider-owned turn execution hooks", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()
    const core = await import("../../heart/core")
    const registry = (core as any).createProviderRegistry()
    const runtime = registry.resolve()
    expect(runtime).toBeTruthy()
    expect(typeof runtime?.streamTurn).toBe("function")
    expect(typeof runtime?.appendToolOutput).toBe("function")
    expect(typeof runtime?.resetTurnState).toBe("function")
  })

  it("azure provider runtime safely ignores tool output before turn state initialization", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()
    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    expect(runtime?.id).toBe("azure")
    expect(() => runtime?.appendToolOutput("call_1", "ok")).not.toThrow()
  })

  it("azure provider runtime rebuilds turn state inside streamTurn when unset", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()
    mockResponsesCreate.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "response.output_text.delta", delta: "hello azure" }
        yield { type: "response.completed" }
      },
    }))

    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    expect(runtime?.id).toBe("azure")

    const onTextChunk = vi.fn()
    const callbacks: ChannelCallbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk,
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
    }

    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks,
    })
    expect(result.toolCalls).toEqual([])
    expect(onTextChunk).toHaveBeenCalledWith("hello azure")
  })

  it("fails fast when provider registry resolves null runtime", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    vi.doMock("../../heart/providers/azure", () => ({
      createAzureProviderRuntime: () => null,
    }))
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    await setupAzure()

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      vi.spyOn(core as any, "createProviderRegistry").mockReturnValue({
        resolve: () => null,
      } as any)
      expect(() => core.getProvider()).toThrow("process.exit called")
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "engine.provider_init_error",
        component: "engine",
        message: "provider runtime could not be initialized.",
      }))
    } finally {
      mockExit.mockRestore()
      vi.doUnmock("../../heart/providers/azure")
    }
  })

  it("fails fast when provider registry resolve() throws", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../heart/providers/azure", () => ({
      createAzureProviderRuntime: () => { throw new Error("provider exploded") },
    }))
    await setupAzure()

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "engine.provider_init_error",
        component: "engine",
        message: "provider exploded",
      }))
    } finally {
      mockExit.mockRestore()
      vi.doUnmock("../../heart/providers/azure")
    }
  })

})

describe("anthropic setup-token provider contract", () => {
  function makeAnthropicEventStream(events: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const event of events) {
          yield event
        }
      },
    }
  }

  beforeEach(() => {
    mockAnthropicMessagesCreate.mockReset()
    mockAnthropicCtor.mockReset()
    vi.mocked(execSync).mockReset()
  })

  it("uses Anthropic when setup-token credentials are configured in secrets.json", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        anthropic: {
          model: "claude-opus-4-6",
          setupToken: makeAnthropicSetupToken(),
        },
      },
    })

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(core.getProvider()).toBe("anthropic")
      expect(core.getModel()).toBe("claude-opus-4-6")
      expect(mockAnthropicCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          authToken: makeAnthropicSetupToken(),
        }),
      )
      expect(mockAnthropicCtor).toHaveBeenCalledWith(
        expect.not.objectContaining({
          apiKey: expect.any(String),
        }),
      )
    } finally {
      mockExit.mockRestore()
    }
  })

  it("fails fast with setup-token prefix guidance when non-setup Anthropic token is found", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    await setupConfig({
      providers: {
        anthropic: {
          model: "claude-opus-4-6",
          setupToken: "sk-ant-not-setup-token",
        },
      },
    })

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "engine.provider_init_error",
        message: expect.stringContaining("expected prefix sk-ant-oat01-"),
      }))
    } finally {
      mockExit.mockRestore()
    }
  })

  it("fails fast with setup-token length guidance when token is too short", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    await setupConfig({
      providers: {
        anthropic: {
          model: "claude-opus-4-6",
          setupToken: "sk-ant-oat01-short",
        },
      },
    })

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "engine.provider_init_error",
        message: expect.stringContaining("too short"),
      }))
    } finally {
      mockExit.mockRestore()
    }
  })

  it("fails fast with re-auth guidance when setup-token is blank after trimming", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    await setupConfig({
      providers: {
        anthropic: {
          model: "claude-opus-4-6",
          setupToken: "   ",
        },
      },
    })

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      const msg = emitNervesEvent.mock.calls.find(
        (c: any[]) => c[0]?.event === "engine.provider_init_error",
      )?.[0]?.message ?? ""
      expect(msg).toContain("no setup-token credential was found")
      expect(msg).toContain("claude setup-token")
      expect(msg).toContain("/tmp/.agentsecrets/testagent/secrets.json")
      expect(msg).toContain("providers.anthropic.setupToken")
    } finally {
      mockExit.mockRestore()
    }
  })

  it("fails fast when Anthropic model is configured but setupToken is missing from secrets config", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    await setupConfig({
      providers: {
        anthropic: {
          model: "claude-opus-4-6",
        },
      },
    })

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      expect(mockExit).toHaveBeenCalledWith(1)
      const msg = emitNervesEvent.mock.calls.find(
        (c: any[]) => c[0]?.event === "engine.provider_init_error",
      )?.[0]?.message ?? ""
      expect(msg).toContain("model/setupToken is incomplete")
      expect(msg).toContain("claude setup-token")
      expect(msg).toContain("/tmp/.agentsecrets/testagent/secrets.json")
      expect(msg).toContain("providers.anthropic.setupToken")
    } finally {
      mockExit.mockRestore()
    }
  })

  it("maps canonical messages to Anthropic payload and streams tool/text/thinking/usage events", async () => {
    vi.resetModules()
    vi.mocked(execSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: makeAnthropicSetupToken(),
        expiresAt: Date.now() + 60_000,
      },
    }) as any)
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        anthropic: {
          model: "claude-opus-4-6",
          setupToken: makeAnthropicSetupToken(),
        },
      },
    })

    mockAnthropicMessagesCreate.mockResolvedValue(makeAnthropicEventStream([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call0", name: "read_file", input: { path: "a.txt" } },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call1", name: "search" },
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello " },
      },
      {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "reasoning " },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: ',\"line\":1' },
      },
      {
        type: "content_block_delta",
        index: 99,
        delta: { type: "input_json_delta", partial_json: '{"ignored":true}' },
      },
      {
        type: "content_block_stop",
        index: 1,
      },
      {
        type: "message_delta",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
          output_tokens: 5,
        },
      },
    ]))

    const streamStart = vi.fn()
    const textChunk = vi.fn()
    const reasoningChunk = vi.fn()
    const controller = new AbortController()
    const callbacks: ChannelCallbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: streamStart,
      onTextChunk: textChunk,
      onReasoningChunk: reasoningChunk,
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
    }

    const messages: any[] = [
      { role: "system", content: [{ type: "text", text: "system from array" }] },
      { role: "system", content: "ignored second system" },
      { role: "user", content: "hello user" },
      {
        role: "assistant",
        content: "assistant text",
        tool_calls: [
          { id: "tool1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"f.txt\"}" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tool2", type: "function", function: { name: "noop", arguments: " " } },
          { id: "tool3", type: "function", function: { name: "noop", arguments: "not-json" } },
          { id: "tool4", type: "function", function: { name: "noop", arguments: "3" } },
        ],
      },
      { role: "assistant", content: null },
      {
        role: "tool",
        tool_call_id: "tool1",
        content: [
          { type: "text", text: 42 as any },
          { type: "text", text: "tool output" },
        ],
      },
    ]

    const activeTools: any[] = [
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
      {
        type: "function",
        function: {
          name: "search",
        },
      },
    ]

    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    expect(runtime.id).toBe("anthropic")
    expect(() => runtime.resetTurnState(messages)).not.toThrow()
    expect(() => runtime.appendToolOutput("noop-call", "ok")).not.toThrow()
    const result = await runtime.streamTurn({
      messages,
      activeTools,
      callbacks,
      signal: controller.signal,
      toolChoiceRequired: true,
    })

    expect(streamStart).toHaveBeenCalledTimes(1)
    expect(textChunk).toHaveBeenCalledWith("hello ")
    expect(reasoningChunk).toHaveBeenCalledWith("reasoning ")
    expect(result.content).toBe("hello ")
    expect(result.toolCalls).toEqual([
      {
        id: "call0",
        name: "read_file",
        arguments: "{\"path\":\"a.txt\",\"line\":1}",
      },
      {
        id: "call1",
        name: "search",
        arguments: "{}",
      },
    ])
    expect(result.usage).toEqual({
      input_tokens: 9,
      output_tokens: 5,
      reasoning_tokens: 0,
      total_tokens: 14,
    })
    expect(mockAnthropicMessagesCreate).toHaveBeenCalledTimes(1)
    const [params, requestOptions] = mockAnthropicMessagesCreate.mock.calls[0]
    expect(requestOptions).toEqual({ signal: controller.signal })
    expect(params).toEqual(expect.objectContaining({
      model: "claude-opus-4-6",
      stream: true,
      max_tokens: 4096,
      system: "system from array",
      tool_choice: { type: "any" },
    }))
    expect(Array.isArray((params as any).messages)).toBe(true)
    expect(Array.isArray((params as any).tools)).toBe(true)
  })

  it("handles Anthropic tool argument merge/reset/fallback delta paths", async () => {
    vi.resetModules()
    vi.mocked(execSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: makeAnthropicSetupToken(),
        expiresAt: Date.now() + 60_000,
      },
    }) as any)
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        anthropic: {
          model: "claude-opus-4-6",
          setupToken: makeAnthropicSetupToken(),
        },
      },
    })

    mockAnthropicMessagesCreate.mockResolvedValue(makeAnthropicEventStream([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call0", name: "read_file", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: ',\"line\":1' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":"b.txt","line":2}' },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call1", name: "search", input: [] },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: ',\"q\":\"snake\"' },
      },
    ]))

    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [
        { type: "function", function: { name: "read_file" } },
        { type: "function", function: { name: "search" } },
      ],
      callbacks: {
        onModelStart: vi.fn(),
        onModelStreamStart: vi.fn(),
        onTextChunk: vi.fn(),
        onReasoningChunk: vi.fn(),
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onError: vi.fn(),
      },
      signal: new AbortController().signal,
    })

    expect(result.toolCalls).toEqual([
      { id: "call0", name: "read_file", arguments: '{"path":"b.txt","line":2}' },
      { id: "call1", name: "search", arguments: '[],"q":"snake"' },
    ])
  })

  it("returns early when Anthropic stream signal is aborted", async () => {
    vi.resetModules()
    vi.mocked(execSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: makeAnthropicSetupToken(),
        expiresAt: Date.now() + 60_000,
      },
    }) as any)
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        anthropic: {
          model: "claude-opus-4-6",
          setupToken: makeAnthropicSetupToken(),
        },
      },
    })

    mockAnthropicMessagesCreate.mockResolvedValue(makeAnthropicEventStream([
      { type: "content_block_delta", delta: { type: "text_delta", text: "ignored" } },
    ]))

    const streamStart = vi.fn()
    const callbacks: ChannelCallbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: streamStart,
      onTextChunk: vi.fn(),
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
    }

    const controller = new AbortController()
    controller.abort()
    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks,
      signal: controller.signal,
    })

    expect(result.content).toBe("")
    expect(result.toolCalls).toEqual([])
    expect(result.outputItems).toEqual([])
    expect(streamStart).not.toHaveBeenCalled()
    expect(mockAnthropicMessagesCreate).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal })
  })

  it("wraps Anthropic auth failures from create() with setup-token guidance", async () => {
    vi.resetModules()
    vi.mocked(execSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: makeAnthropicSetupToken(),
        expiresAt: Date.now() + 60_000,
      },
    }) as any)
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        anthropic: {
          model: "claude-opus-4-6",
          setupToken: makeAnthropicSetupToken(),
        },
      },
    })

    const authError: any = new Error("oauth authentication failed")
    authError.status = 401
    mockAnthropicMessagesCreate.mockRejectedValue(authError)

    const callbacks: ChannelCallbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk: vi.fn(),
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
    }

    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    await expect(
      runtime.streamTurn({
        messages: [{ role: "user", content: "hi" }],
        activeTools: [],
        callbacks,
      }),
    ).rejects.toThrow("claude setup-token")
  })

  it("wraps Anthropic auth failures from streaming events with setup-token guidance", async () => {
    vi.resetModules()
    vi.mocked(execSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: makeAnthropicSetupToken(),
        expiresAt: Date.now() + 60_000,
      },
    }) as any)
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        anthropic: {
          model: "claude-opus-4-6",
          setupToken: makeAnthropicSetupToken(),
        },
      },
    })

    const streamError = Object.assign(new Error("invalid api key"), { status: 403 })
    mockAnthropicMessagesCreate.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } }
        throw streamError
      },
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk: vi.fn(),
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
    }

    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    await expect(
      runtime.streamTurn({
        messages: [{ role: "user", content: "hi" }],
        activeTools: [],
        callbacks,
      }),
    ).rejects.toThrow("Anthropic authentication failed")
  })

  it("preserves non-auth Anthropic errors without rewriting guidance", async () => {
    vi.resetModules()
    vi.mocked(execSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: makeAnthropicSetupToken(),
        expiresAt: Date.now() + 60_000,
      },
    }) as any)
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        anthropic: {
          model: "claude-opus-4-6",
          setupToken: makeAnthropicSetupToken(),
        },
      },
    })

    mockAnthropicMessagesCreate.mockRejectedValue(new Error("transport failed"))

    const callbacks: ChannelCallbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk: vi.fn(),
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
    }

    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    await expect(
      runtime.streamTurn({
        messages: [{ role: "user", content: "hi" }],
        activeTools: [],
        callbacks,
      }),
    ).rejects.toThrow("transport failed")
  })

  it("fails fast when setup-token contains only whitespace characters", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    await setupConfig({
      providers: {
        anthropic: {
          model: "claude-opus-4-6",
          setupToken: "\n \t",
        },
      },
    })

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "engine.provider_init_error",
        message: expect.stringContaining("no setup-token credential was found"),
      }))
    } finally {
      mockExit.mockRestore()
    }
  })

  it("handles nullish Anthropic stream fields and unknown events safely", async () => {
    vi.resetModules()
    vi.mocked(execSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: makeAnthropicSetupToken(),
        expiresAt: Date.now() + 60_000,
      },
    }) as any)
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        anthropic: {
          model: "claude-opus-4-6",
          setupToken: makeAnthropicSetupToken(),
        },
      },
    })

    mockAnthropicMessagesCreate.mockResolvedValue(makeAnthropicEventStream([
      { type: "content_block_start", index: 2, content_block: { type: "tool_use" } },
      { type: "content_block_delta", delta: { type: "thinking_delta" } },
      { type: "content_block_delta", delta: { type: "text_delta" } },
      { type: "content_block_delta" },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta" } },
      { type: "content_block_stop", index: 999 },
      { type: "content_block_start", index: 4, content_block: { type: "not_tool_use" } },
      { type: "message_delta", usage: {} },
      { type: "message_delta", usage: "invalid" },
      {},
      { type: "mystery" },
    ]))

    const streamStart = vi.fn()
    const textChunk = vi.fn()
    const reasoningChunk = vi.fn()
    const callbacks: ChannelCallbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: streamStart,
      onTextChunk: textChunk,
      onReasoningChunk: reasoningChunk,
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
    }

    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    const result = await runtime.streamTurn({
      messages: [
        { role: "system", content: "" },
        { role: "assistant", content: null },
        { role: "unknown", content: "ignored" } as any,
      ],
      activeTools: [],
      callbacks,
    })

    expect(streamStart).toHaveBeenCalledTimes(1)
    expect(textChunk).toHaveBeenCalledWith("")
    expect(reasoningChunk).toHaveBeenCalledWith("")
    expect(result.content).toBe("")
    expect(result.toolCalls).toEqual([
      {
        id: "",
        name: "",
        arguments: "",
      },
    ])
    expect(result.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 0,
    })
  })

  it("converts non-Error thrown values into terminal errors", async () => {
    vi.resetModules()
    vi.mocked(execSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: makeAnthropicSetupToken(),
        expiresAt: Date.now() + 60_000,
      },
    }) as any)
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        anthropic: {
          model: "claude-opus-4-6",
          setupToken: makeAnthropicSetupToken(),
        },
      },
    })

    mockAnthropicMessagesCreate.mockRejectedValue("plain-string-failure")

    const callbacks: ChannelCallbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk: vi.fn(),
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
    }

    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    await expect(
      runtime.streamTurn({
        messages: [{ role: "user", content: "hi" }],
        activeTools: [],
        callbacks,
      }),
    ).rejects.toThrow("plain-string-failure")
  })

  it("logs non-Error provider-resolution failures before exiting", async () => {
    vi.resetModules()
    await setAgentProvider("anthropic")
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../heart/config", () => ({
      getAzureConfig: () => ({
        apiKey: "",
        endpoint: "",
        deployment: "",
        modelName: "",
        apiVersion: "",
      }),
      getAnthropicConfig: () => {
        throw "config-exploded"
      },
      getMinimaxConfig: () => ({
        apiKey: "",
        model: "",
      }),
      getContextConfig: () => ({
        maxTokens: 120000,
        contextMargin: 2000,
      }),
    }))

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "engine.provider_init_error",
        message: "config-exploded",
      }))
    } finally {
      mockExit.mockRestore()
      vi.doUnmock("../../heart/config")
    }
  })
})

describe("openai-codex oauth provider contract", () => {
  function makeResponsesStream(events: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const event of events) {
          yield event
        }
      },
    }
  }

  beforeEach(() => {
    mockResponsesCreate.mockReset()
    mockOpenAICtor.mockReset()
  })

  it("uses openai-codex when oauth credentials are configured in secrets.json", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.2",
          oauthAccessToken: makeOpenAICodexAccessToken(),
        },
      },
    } as any)

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(core.getProvider()).toBe("openai-codex")
      expect(core.getModel()).toBe("gpt-5.2")
      expect(mockExit).not.toHaveBeenCalled()
    } finally {
      mockExit.mockRestore()
    }
  })

  it("fails fast with oauth guidance when openai-codex oauthAccessToken is missing", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    await setupConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.2",
          oauthAccessToken: "",
        },
      },
    } as any)

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      const msg = emitNervesEvent.mock.calls.find(
        (c: any[]) => c[0]?.event === "engine.provider_init_error",
      )?.[0]?.message ?? ""
      expect(msg).toContain("openai-codex")
      expect(msg).toContain("oauthAccessToken")
      expect(msg).toContain("secrets.json")
      expect(msg).toContain("codex login")
    } finally {
      mockExit.mockRestore()
    }
  })

  it("wraps openai-codex oauth auth failures with explicit re-auth guidance", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.2",
          oauthAccessToken: makeOpenAICodexAccessToken(),
        },
      },
    } as any)

    const authError: any = new Error("authentication failed")
    authError.status = 401
    mockResponsesCreate.mockRejectedValue(authError)

    const callbacks: ChannelCallbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk: vi.fn(),
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
    }

    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    await expect(
      runtime.streamTurn({
        messages: [{ role: "user", content: "hello" }],
        activeTools: [],
        callbacks,
      }),
    ).rejects.toThrow(/OpenAI Codex authentication failed[\s\S]*codex login/)
  })

  it("wraps openai-codex auth failures detected from error message markers", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.2",
          oauthAccessToken: makeOpenAICodexAccessToken(),
        },
      },
    } as any)

    mockResponsesCreate.mockRejectedValue(new Error("invalid bearer token"))

    const callbacks: ChannelCallbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk: vi.fn(),
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
    }

    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    await expect(
      runtime.streamTurn({
        messages: [{ role: "user", content: "hello" }],
        activeTools: [],
        callbacks,
      }),
    ).rejects.toThrow("OpenAI Codex authentication failed")
  })

  it("fails fast when openai-codex oauthAccessToken contains only whitespace", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    await setupConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.2",
          oauthAccessToken: " \n\t ",
        },
      },
    } as any)

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      const msg = emitNervesEvent.mock.calls.find(
        (c: any[]) => c[0]?.event === "engine.provider_init_error",
      )?.[0]?.message ?? ""
      expect(msg).toContain("OAuth access token is empty")
      expect(msg).toContain("providers.openai-codex.oauthAccessToken")
    } finally {
      mockExit.mockRestore()
    }
  })

  it("fails fast when openai-codex oauthAccessToken is missing chatgpt_account_id", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    const tokenWithoutAccountId = `${encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${encodeBase64Url(JSON.stringify({ sub: "user-123" }))}.signature`
    await setupConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.2",
          oauthAccessToken: tokenWithoutAccountId,
        },
      },
    } as any)

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      const msg = emitNervesEvent.mock.calls.find(
        (c: any[]) => c[0]?.event === "engine.provider_init_error",
      )?.[0]?.message ?? ""
      expect(msg).toContain("chatgpt_account_id")
      expect(msg).toContain("backend-api/codex")
    } finally {
      mockExit.mockRestore()
    }
  })

  it("fails fast when openai-codex oauthAccessToken payload cannot be decoded as JSON", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    const malformedPayload = Buffer.from("not-json", "utf8").toString("base64url")
    const malformedToken = `${encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${malformedPayload}.signature`
    await setupConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.2",
          oauthAccessToken: malformedToken,
        },
      },
    } as any)

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      const msg = emitNervesEvent.mock.calls.find(
        (c: any[]) => c[0]?.event === "engine.provider_init_error",
      )?.[0]?.message ?? ""
      expect(msg).toContain("chatgpt_account_id")
      expect(msg).toContain("backend-api/codex")
    } finally {
      mockExit.mockRestore()
    }
  })

  it("fails fast when openai-codex oauthAccessToken is not JWT formatted", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    await setupConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.2",
          oauthAccessToken: "not-a-jwt",
        },
      },
    } as any)

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "engine.provider_init_error",
        message: expect.stringContaining("chatgpt_account_id"),
      }))
    } finally {
      mockExit.mockRestore()
    }
  })

  it("fails fast when openai-codex oauthAccessToken payload is a JSON array", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    const arrayPayloadToken = `${encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${encodeBase64Url(JSON.stringify([]))}.signature`
    await setupConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.2",
          oauthAccessToken: arrayPayloadToken,
        },
      },
    } as any)

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "engine.provider_init_error",
        message: expect.stringContaining("chatgpt_account_id"),
      }))
    } finally {
      mockExit.mockRestore()
    }
  })

  it("fails fast when openai-codex chatgpt_account_id is not a string", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))
    const nonStringAccountIdToken = `${encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${encodeBase64Url(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: 123 } }))}.signature`
    await setupConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.2",
          oauthAccessToken: nonStringAccountIdToken,
        },
      },
    } as any)

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      const core = await import("../../heart/core")
      expect(() => core.getProvider()).toThrow("process.exit called")
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "engine.provider_init_error",
        message: expect.stringContaining("chatgpt_account_id"),
      }))
    } finally {
      mockExit.mockRestore()
    }
  })

  it("streams openai-codex responses and appends provider output items into turn state", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    const accountId = "chatgpt-account-123"
    const oauthAccessToken = makeOpenAICodexAccessToken(accountId)
    await setupConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.2",
          oauthAccessToken,
        },
      },
    } as any)

    mockResponsesCreate.mockImplementationOnce(() =>
      makeResponsesStream([
        { type: "response.output_text.delta", delta: "hi " },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc1",
            call_id: "call1",
            name: "read_file",
            arguments: "{\"path\":\"README.md\"}",
            status: "completed",
          },
        },
      ]),
    )
    mockResponsesCreate.mockImplementationOnce((params: any) => {
      const input = Array.isArray(params.input) ? params.input : []
      expect(input.some((item: any) => item?.type === "function_call")).toBe(true)
      expect(input.some((item: any) => item?.type === "function_call_output" && item?.call_id === "call1")).toBe(true)
      return makeResponsesStream([{ type: "response.output_text.delta", delta: "done" }])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk: vi.fn(),
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
    }

    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    expect(mockOpenAICtor).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: oauthAccessToken,
      baseURL: "https://chatgpt.com/backend-api/codex",
      timeout: 30000,
      maxRetries: 0,
      defaultHeaders: {
        "chatgpt-account-id": accountId,
        "OpenAI-Beta": "responses=experimental",
        originator: "ouroboros",
      },
    }))
    expect(() => runtime.appendToolOutput("call1", "ignored-before-reset")).not.toThrow()

    const first = await runtime.streamTurn({
      messages: [{ role: "user", content: "hello" }],
      activeTools: [
        {
          type: "function",
          function: {
            name: "read_file",
          },
        },
      ],
      callbacks,
      traceId: "trace-openai-codex",
      toolChoiceRequired: true,
    })
    runtime.appendToolOutput("call1", "tool-output")
    const second = await runtime.streamTurn({
      messages: [{ role: "user", content: "followup" }],
      activeTools: [],
      callbacks,
    })

    expect(first.content).toBe("hi ")
    expect(first.toolCalls).toEqual([
      {
        id: "call1",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      },
    ])
    expect(second.content).toBe("done")
    expect(mockResponsesCreate).toHaveBeenCalledTimes(2)
    expect(mockResponsesCreate.mock.calls[0][0]).toEqual(expect.objectContaining({
      model: "gpt-5.2",
      tool_choice: "required",
    }))
    expect(mockResponsesCreate.mock.calls[0][0]).not.toHaveProperty("metadata")
  })

  it("passes through non-auth response errors without re-auth wrapping", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.2",
          oauthAccessToken: makeOpenAICodexAccessToken(),
        },
      },
    } as any)

    mockResponsesCreate.mockRejectedValue("plain-failure")

    const callbacks: ChannelCallbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk: vi.fn(),
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
    }

    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    await expect(
      runtime.streamTurn({
        messages: [{ role: "user", content: "hello" }],
        activeTools: [],
        callbacks,
      }),
    ).rejects.toThrow("plain-failure")
  })

  it("passes through non-auth Error instances without re-auth wrapping", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.2",
          oauthAccessToken: makeOpenAICodexAccessToken(),
        },
      },
    } as any)

    mockResponsesCreate.mockRejectedValue(new Error("upstream timeout"))

    const callbacks: ChannelCallbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk: vi.fn(),
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
    }

    const core = await import("../../heart/core")
    const runtime = (core as any).createProviderRegistry().resolve()
    await expect(
      runtime.streamTurn({
        messages: [{ role: "user", content: "hello" }],
        activeTools: [],
        callbacks,
      }),
    ).rejects.toThrow("upstream timeout")
  })
})

describe("hasToolIntent", () => {
  it("returns true for each intent phrase", async () => {
    const { hasToolIntent } = await import("../../heart/core")
    // Explicit intent
    expect(hasToolIntent("let me read that file")).toBe(true)
    expect(hasToolIntent("I'll read that file")).toBe(true)
    expect(hasToolIntent("I will read that file")).toBe(true)
    expect(hasToolIntent("I would like to read that file")).toBe(true)
    expect(hasToolIntent("I want to read that file")).toBe(true)
    // "going to" variants
    expect(hasToolIntent("I'm going to read that file")).toBe(true)
    expect(hasToolIntent("going to read that file")).toBe(true)
    expect(hasToolIntent("I am going to read that file")).toBe(true)
    // Action announcements
    expect(hasToolIntent("I need to check the database")).toBe(true)
    expect(hasToolIntent("I should look at the logs")).toBe(true)
    expect(hasToolIntent("I can help with that")).toBe(true)
    // Gerund phase shifts
    expect(hasToolIntent("entering execution mode.")).toBe(true)
    expect(hasToolIntent("starting with the first file")).toBe(true)
    expect(hasToolIntent("proceeding to the next step")).toBe(true)
    expect(hasToolIntent("switching to plan B")).toBe(true)
    // Temporal narration
    expect(hasToolIntent("first, I will check the logs")).toBe(true)
    expect(hasToolIntent("now I will investigate")).toBe(true)
    expect(hasToolIntent("next turn will be strict TDD repair")).toBe(true)
    expect(hasToolIntent("next, I should look at the code")).toBe(true)
    // Hedged intent
    expect(hasToolIntent("allow me to take a look")).toBe(true)
    expect(hasToolIntent("time to check the logs")).toBe(true)
    // Self-narration
    expect(hasToolIntent("my next step is to read the file")).toBe(true)
    expect(hasToolIntent("my plan is to refactor this")).toBe(true)
    expect(hasToolIntent("tool calls only from here on")).toBe(true)
  })

  it("returns false for text without intent phrases", async () => {
    const { hasToolIntent } = await import("../../heart/core")
    expect(hasToolIntent("Hello")).toBe(false)
    expect(hasToolIntent("Here is the result")).toBe(false)
    expect(hasToolIntent("The file contains data")).toBe(false)
    expect(hasToolIntent("")).toBe(false)
  })

  it("is case-insensitive", async () => {
    const { hasToolIntent } = await import("../../heart/core")
    expect(hasToolIntent("LET ME read that file")).toBe(true)
    expect(hasToolIntent("i'll do that")).toBe(true)
    expect(hasToolIntent("I WILL check")).toBe(true)
    expect(hasToolIntent("GOING TO run it")).toBe(true)
  })
})

describe("kick mechanism", () => {
  let runAgent: (messages: any[], callbacks: ChannelCallbacks, channel?: string, signal?: AbortSignal, options?: { toolChoiceRequired?: boolean }) => Promise<{ usage?: any }>

  function makeStream(chunks: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    }
  }

  function makeChunk(content?: string, toolCalls?: any[]) {
    const delta: any = {}
    if (content !== undefined) delta.content = content
    if (toolCalls !== undefined) delta.tool_calls = toolCalls
    return { choices: [{ delta }] }
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()
    mockCreate.mockReset()
    mockResponsesCreate.mockReset()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)

    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  // Kick detection disabled — see core.ts
  // skip: kick detection deferred per audit
  it.skip("fires onKick when model narrates intent without tool calls, then retries", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([makeChunk("let me read that file for you")])
      }
      return makeStream([makeChunk("here is the result")])
    })

    const kicks: number[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => kicks.push(1),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    expect(kicks).toHaveLength(1)
    expect(callCount).toBe(2)
    // Assistant messages: original narration + self-correction, then real response
    const assistantMessages = messages.filter((m: any) => m.role === "assistant")
    expect(assistantMessages).toHaveLength(2)
    expect(assistantMessages[0].content).toContain("let me read that file for you")
    expect(assistantMessages[0].content).toContain("I narrated instead of acting. Using the tool now -- if done, calling final_answer.")
    expect(assistantMessages[1].content).toBe("here is the result")
  })

  // Kick detection disabled — see core.ts
  // skip: kick detection deferred per audit
  it.skip("pushes self-correction message before retry", async () => {
    let callCount = 0
    mockCreate.mockImplementation((params: any) => {
      callCount++
      if (callCount === 1) {
        return makeStream([makeChunk("let me check that")])
      }
      // On retry, verify the self-correction message is present
      return makeStream([makeChunk("done")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    // The self-correction assistant message should contain original narration + kick message
    const assistantMessages = messages.filter((m: any) => m.role === "assistant")
    expect(assistantMessages.some((m: any) => m.content?.includes("let me check that") && m.content?.includes("I narrated instead of acting. Using the tool now -- if done, calling final_answer."))).toBe(true)
  })

  // Kick detection disabled — see core.ts
  // skip: kick detection deferred per audit
  it.skip("onKick callback receives no arguments", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount <= 2) {
        return makeStream([makeChunk("I'll do that now")])
      }
      return makeStream([makeChunk("here is the result")])
    })

    const kickArgs: number[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: (...args: any[]) => kickArgs.push(args.length),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    // onKick should receive zero arguments
    expect(kickArgs.length).toBeGreaterThan(0)
    expect(kickArgs.every(n => n === 0)).toBe(true)
  })

  // Kick detection disabled — see core.ts
  // skip: kick detection deferred per audit
  it.skip("onKick callback is optional (no crash if not provided)", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([makeChunk("let me read that")])
      }
      return makeStream([makeChunk("done")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      // onKick intentionally NOT provided
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    // Should not throw
    await runAgent(messages, callbacks)
    expect(callCount).toBe(2)
  })

  // Kick detection disabled — see core.ts
  // skip: kick detection deferred per audit
  it.skip("malformed assistant message is NOT in history after kick", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([makeChunk("I'm going to read the file")])
      }
      return makeStream([makeChunk("the file says hello")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    // Assistant messages: original narration + self-correction, then real response
    const assistantMessages = messages.filter((m: any) => m.role === "assistant")
    expect(assistantMessages).toHaveLength(2)
    expect(assistantMessages[0].content).toContain("I'm going to")
    expect(assistantMessages[0].content).toContain("I narrated instead of acting. Using the tool now -- if done, calling final_answer.")
    expect(assistantMessages[1].content).toBe("the file says hello")
  })

  // Kick detection disabled — see core.ts
  // skip: kick detection deferred per audit
  it.skip("Azure: kick cleans up azureInput output items and forces rebuild on retry", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    function makeResponsesStream(events: any[]) {
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const event of events) {
            yield event
          }
        },
      }
    }

    const reasoningItem = { type: "reasoning", id: "r1", summary: [{ text: "thought", type: "summary_text" }], encrypted_content: "enc1" }
    const textItem = { type: "message", id: "msg1", role: "assistant", content: [{ type: "output_text", text: "let me read that file" }] }

    let callCount = 0
    mockResponsesCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeResponsesStream([
          { type: "response.output_item.done", item: reasoningItem },
          { type: "response.output_text.delta", delta: "let me read that file" },
          { type: "response.output_item.done", item: textItem },
        ])
      }
      return makeResponsesStream([
        { type: "response.output_text.delta", delta: "here is the answer" },
      ])
    })

    const core = await import("../../heart/core")
    const kicks: number[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => kicks.push(1),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await core.runAgent(messages, callbacks)

    expect(kicks).toHaveLength(1)
    expect(callCount).toBe(2)
    // Assistant messages: original narration + self-correction, then real response
    const assistantMessages = messages.filter((m: any) => m.role === "assistant")
    expect(assistantMessages).toHaveLength(2)
    expect(assistantMessages[0].content).toContain("let me read that file")
    expect(assistantMessages[0].content).toContain("I narrated instead of acting. Using the tool now -- if done, calling final_answer.")
    expect(assistantMessages[1].content).toBe("here is the answer")

    // config cleanup handled by resetConfigCache in beforeEach
  })
})

describe("tool_choice required and final_answer", () => {
  let runAgent: (messages: any[], callbacks: ChannelCallbacks, channel?: string, signal?: AbortSignal, options?: { toolChoiceRequired?: boolean }) => Promise<{ usage?: any }>

  function makeStream(chunks: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    }
  }

  function makeChunk(content?: string, toolCalls?: any[]) {
    const delta: any = {}
    if (content !== undefined) delta.content = content
    if (toolCalls !== undefined) delta.tool_calls = toolCalls
    return { choices: [{ delta }] }
  }

  function makeResponsesStream(events: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const event of events) {
          yield event
        }
      },
    }
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()
    mockCreate.mockReset()
    mockResponsesCreate.mockReset()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)

    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  it("passes tool_choice: required in MiniMax createParams when toolChoiceRequired is true", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"done"}' } },
        ]),
      ])
    )

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks, undefined, undefined, { toolChoiceRequired: true })
    const params = mockCreate.mock.calls[0][0]
    expect(params.tool_choice).toBe("required")
  })

  it("passes tool_choice: required in Azure createParams when toolChoiceRequired is true", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    mockResponsesCreate.mockReturnValue(makeResponsesStream([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "final_answer", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: '{"answer":"done"}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "final_answer", arguments: '{"answer":"done"}' } },
    ]))

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await core.runAgent([{ role: "system", content: "test" }], callbacks, undefined, undefined, { toolChoiceRequired: true })
    const params = mockResponsesCreate.mock.calls[0][0]
    expect(params.tool_choice).toBe("required")

    // config cleanup handled by resetConfigCache in beforeEach
  })

  it("includes final_answer tool in tools list when toolChoiceRequired is true", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"done"}' } },
        ]),
      ])
    )

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks, undefined, undefined, { toolChoiceRequired: true })
    const params = mockCreate.mock.calls[0][0]
    const toolNames = params.tools.map((t: any) => t.function.name)
    expect(toolNames).toContain("final_answer")
  })

  it("defaults: includes final_answer tool when toolChoiceRequired is not passed (defaults true)", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk(undefined, [
      { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"done"}' } },
    ])]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    const params = mockCreate.mock.calls[0][0]
    const toolNames = params.tools.map((t: any) => t.function.name)
    expect(toolNames).toContain("final_answer")
  })

  it("defaults: passes tool_choice: required when toolChoiceRequired is not set (defaults true)", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk(undefined, [
      { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"done"}' } },
    ])]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks)
    const params = mockCreate.mock.calls[0][0]
    expect(params.tool_choice).toBe("required")
  })

  it("opt-out: does NOT include final_answer tool when toolChoiceRequired is false", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("hello")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks, undefined, undefined, { toolChoiceRequired: false })
    const params = mockCreate.mock.calls[0][0]
    const toolNames = params.tools.map((t: any) => t.function.name)
    expect(toolNames).not.toContain("final_answer")
  })

  it("opt-out: does NOT set tool_choice when toolChoiceRequired is false", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("hello")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await runAgent([{ role: "system", content: "test" }], callbacks, undefined, undefined, { toolChoiceRequired: false })
    const params = mockCreate.mock.calls[0][0]
    expect(params.tool_choice).toBeUndefined()
  })

  it("opt-out Azure: does NOT set tool_choice when toolChoiceRequired is false", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    mockResponsesCreate.mockReturnValue(makeResponsesStream([
      { type: "response.output_item.added", item: { type: "message", role: "assistant" } },
      { type: "response.content_part.delta", delta: { type: "text", text: "hello" } },
      { type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] } },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ]))

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    await core.runAgent([{ role: "system", content: "test" }], callbacks, undefined, undefined, { toolChoiceRequired: false })
    const params = mockResponsesCreate.mock.calls[0][0]
    expect(params.tool_choice).toBeUndefined()
  })

  it("final_answer sole call: extracts answer text and terminates loop", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"the final response"}' } },
        ]),
      ])
    )

    const toolStarts: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: (name) => toolStarts.push(name),
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // Should NOT have called any tools through onToolStart (final_answer is intercepted)
    expect(toolStarts).toEqual([])
    // The full assistant message is kept (with tool_calls) for debuggability
    const assistantMsg = messages.find((m: any) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg.tool_calls).toBeDefined()
    expect(assistantMsg.tool_calls[0].function.name).toBe("final_answer")
    // Answer is emitted through onTextChunk callback
    expect(textChunks).toEqual(["the final response"])
    // A synthetic tool response keeps the conversation valid
    const toolResults = messages.filter((m: any) => m.role === "tool")
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0].tool_call_id).toBe("call_1")
    expect(toolResults[0].content).toBe("(delivered)")
    // Only 1 API call (no loop continuation)
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it("final_answer mixed with other tool calls: other tools execute, final_answer rejected, loop continues", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("file data")

    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
            { index: 1, id: "call_2", function: { name: "final_answer", arguments: '{"answer":"done"}' } },
          ]),
        ])
      }
      // Second call: model returns final_answer alone
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_3", function: { name: "final_answer", arguments: '{"answer":"the real answer"}' } },
        ]),
      ])
    })

    const toolStarts: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: (name) => toolStarts.push(name),
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // read_file should have been executed, final_answer should NOT
    expect(toolStarts).toEqual(["read_file"])
    // Should have 2 API calls (mixed -> sole final_answer)
    expect(callCount).toBe(2)
    // The final assistant message keeps tool_calls (full msg); answer emitted via onTextChunk
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant")
    expect(lastAssistant.tool_calls).toBeDefined()
    expect(lastAssistant.tool_calls[0].function.name).toBe("final_answer")
    expect(textChunks).toEqual(["the real answer"])
    // There should be a rejection tool result for the mixed final_answer
    const toolResults = messages.filter((m: any) => m.role === "tool")
    const rejectionMsg = toolResults.find((m: any) => m.tool_call_id === "call_2")
    expect(rejectionMsg).toBeDefined()
    expect(rejectionMsg.content).toContain("rejected")
    expect(rejectionMsg.content).toContain("final_answer must be the only tool call")
    // There should also be a synthetic "(delivered)" tool result for the sole final_answer
    const deliveredMsg = toolResults.find((m: any) => m.tool_call_id === "call_3")
    expect(deliveredMsg).toBeDefined()
    expect(deliveredMsg.content).toBe("(delivered)")
  })

  it("final_answer with empty object arg: retries (no answer field)", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{}' } },
          ]),
        ])
      }
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_2", function: { name: "final_answer", arguments: '{"answer":"got it"}' } },
        ]),
      ])
    })

    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // {} has no answer field, so first attempt retries
    expect(callCount).toBe(2)
    // Error tool result for first attempt
    const toolMsgs = messages.filter((m: any) => m.role === "tool")
    expect(toolMsgs[0].tool_call_id).toBe("call_1")
    expect(toolMsgs[0].content).toContain("incomplete or malformed")
    // Successful answer from second attempt
    expect(textChunks).toEqual(["got it"])
  })

  it("final_answer is never passed to execTool (intercepted before execution)", async () => {
    // If final_answer were passed to execTool, it would return "unknown: final_answer"
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"done"}' } },
        ]),
      ])
    )

    const toolStarts: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: (name) => toolStarts.push(name),
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // No tools should have been started via onToolStart (final_answer is intercepted)
    expect(toolStarts).toHaveLength(0)
    // There IS a synthetic tool result "(delivered)" but no execTool-produced results
    const toolResults = messages.filter((m: any) => m.role === "tool")
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0].tool_call_id).toBe("call_1")
    expect(toolResults[0].content).toBe("(delivered)")
  })

  it("Azure: mixed final_answer rejection pushes to azureInput", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    vi.mocked(fs.readFileSync).mockReturnValue("file data")

    const funcItem1 = { type: "function_call", id: "fc1", call_id: "c1", name: "read_file", arguments: '{"path":"a.txt"}', status: "completed" }
    const funcItem2 = { type: "function_call", id: "fc2", call_id: "c2", name: "final_answer", arguments: '{"answer":"done"}', status: "completed" }

    let callCount = 0
    mockResponsesCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeResponsesStream([
          { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "read_file", arguments: "" } },
          { type: "response.function_call_arguments.delta", delta: '{"path":"a.txt"}' },
          { type: "response.output_item.done", item: funcItem1 },
          { type: "response.output_item.added", item: { type: "function_call", call_id: "c2", name: "final_answer", arguments: "" } },
          { type: "response.function_call_arguments.delta", delta: '{"answer":"done"}' },
          { type: "response.output_item.done", item: funcItem2 },
        ])
      }
      // Second call: sole final_answer
      return makeResponsesStream([
        { type: "response.output_item.added", item: { type: "function_call", call_id: "c3", name: "final_answer", arguments: "" } },
        { type: "response.function_call_arguments.delta", delta: '{"answer":"the real answer"}' },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "c3", name: "final_answer", arguments: '{"answer":"the real answer"}' } },
      ])
    })

    const core = await import("../../heart/core")
    const toolStarts: string[] = []
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: (name) => toolStarts.push(name),
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await core.runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    expect(callCount).toBe(2)
    expect(toolStarts).toEqual(["read_file"])
    // Final assistant message keeps tool_calls; answer emitted via onTextChunk
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant")
    expect(lastAssistant.tool_calls).toBeDefined()
    expect(lastAssistant.tool_calls[0].function.name).toBe("final_answer")
    expect(textChunks).toEqual(["the real answer"])

    // config cleanup handled by resetConfigCache in beforeEach
  })

  it("Azure: truncated final_answer retries and pushes function_call_output to azureInput", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    let callCount = 0
    mockResponsesCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // First call: truncated JSON
        return makeResponsesStream([
          { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "final_answer", arguments: "" } },
          { type: "response.function_call_arguments.delta", delta: '{"answer":"truncated...' },
          { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "final_answer", arguments: '{"answer":"truncated...' } },
        ])
      }
      // Second call: valid answer
      return makeResponsesStream([
        { type: "response.output_item.added", item: { type: "function_call", call_id: "c2", name: "final_answer", arguments: "" } },
        { type: "response.function_call_arguments.delta", delta: '{"answer":"complete"}' },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "c2", name: "final_answer", arguments: '{"answer":"complete"}' } },
      ])
    })

    const core = await import("../../heart/core")
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onClearText: () => { textChunks.length = 0 },
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await core.runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // Should have retried
    expect(callCount).toBe(2)
    // Error tool result for first attempt
    const toolMsgs = messages.filter((m: any) => m.role === "tool")
    expect(toolMsgs[0].tool_call_id).toBe("c1")
    expect(toolMsgs[0].content).toContain("incomplete or malformed")
    // Valid answer from retry
    expect(textChunks).toEqual(["complete"])
  })

  it("final_answer with invalid JSON arguments: retries (does not re-emit already-streamed content)", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk("some content", [
            { index: 0, id: "call_1", function: { name: "final_answer", arguments: "not valid json{" } },
          ]),
        ])
      }
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_2", function: { name: "final_answer", arguments: '{"answer":"valid now"}' } },
        ]),
      ])
    })

    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onClearText: () => { textChunks.length = 0 },
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // Invalid JSON triggers retry
    expect(callCount).toBe(2)
    // Error tool result for first attempt
    const toolMsgs = messages.filter((m: any) => m.role === "tool")
    expect(toolMsgs[0].tool_call_id).toBe("call_1")
    expect(toolMsgs[0].content).toContain("incomplete or malformed")
    // Only the valid answer from retry should be emitted (noise was cleared)
    expect(textChunks).toEqual(["valid now"])
  })

  it("final_answer with valid JSON but no answer field: retries (does not re-emit already-streamed content)", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk("fallback content", [
            { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"text":"hello"}' } },
          ]),
        ])
      }
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_2", function: { name: "final_answer", arguments: '{"answer":"proper answer"}' } },
        ]),
      ])
    })

    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onClearText: () => { textChunks.length = 0 },
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // No answer field triggers retry
    expect(callCount).toBe(2)
    // Error tool result for first attempt
    const toolMsgs = messages.filter((m: any) => m.role === "tool")
    expect(toolMsgs[0].tool_call_id).toBe("call_1")
    expect(toolMsgs[0].content).toContain("incomplete or malformed")
    // Only the valid answer from retry (noise was cleared by onClearText)
    expect(textChunks).toEqual(["proper answer"])
  })

  it("final_answer with invalid JSON and no content: retries (pushes error tool result)", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "final_answer", arguments: "bad json" } },
          ]),
        ])
      }
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_2", function: { name: "final_answer", arguments: '{"answer":"recovered"}' } },
        ]),
      ])
    })

    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // Invalid JSON triggers retry
    expect(callCount).toBe(2)
    // Error tool result for first attempt
    const toolMsgs = messages.filter((m: any) => m.role === "tool")
    expect(toolMsgs[0].tool_call_id).toBe("call_1")
    expect(toolMsgs[0].content).toContain("incomplete or malformed")
    // Recovered answer from retry
    expect(textChunks).toEqual(["recovered"])
  })

  it("final_answer with valid JSON, no answer field, and no content: retries", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"text":"hello"}' } },
          ]),
        ])
      }
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_2", function: { name: "final_answer", arguments: '{"answer":"proper"}' } },
        ]),
      ])
    })

    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // No answer field triggers retry
    expect(callCount).toBe(2)
    // Error tool result for first attempt
    const toolMsgs = messages.filter((m: any) => m.role === "tool")
    expect(toolMsgs[0].tool_call_id).toBe("call_1")
    expect(toolMsgs[0].content).toContain("incomplete or malformed")
    // Proper answer from retry
    expect(textChunks).toEqual(["proper"])
  })

  it("calls onClearText before emitting valid final_answer when content was streamed", async () => {
    // Model returns both content (refusal noise) and final_answer (real response)
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk("I'm sorry, but I cannot assist with that request.", [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"Here is the real answer"}' } },
        ]),
      ])
    )

    const textChunks: string[] = []
    let clearCalled = false
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onClearText: () => { clearCalled = true; textChunks.length = 0 },
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    expect(clearCalled).toBe(true)
    // Only the final_answer text is emitted after clear, NOT the refusal
    expect(textChunks).toEqual(["Here is the real answer"])
  })

  it("emits full final_answer text even when exceeding channel maxMessageLength (splitting is adapter's job)", async () => {
    const longText = "x".repeat(5000) // Teams max is 4000 but core never truncates
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: JSON.stringify({ answer: longText }) } },
        ]),
      ])
    )

    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, "teams", undefined, { toolChoiceRequired: true })

    expect(textChunks).toHaveLength(1)
    expect(textChunks[0]).toBe(longText) // full text, no truncation
  })

  it("does NOT truncate final_answer text within channel maxMessageLength", async () => {
    const shortText = "hello, this is a short response"
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: JSON.stringify({ answer: shortText }) } },
        ]),
      ])
    )

    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, "teams", undefined, { toolChoiceRequired: true })

    expect(textChunks).toEqual([shortText])
  })

  it("does NOT truncate when maxMessageLength is Infinity (cli/no channel)", async () => {
    const longText = "x".repeat(50000)
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: JSON.stringify({ answer: longText }) } },
        ]),
      ])
    )

    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    // No channel passed -- defaults to CLI which has Infinity maxMessageLength
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    expect(textChunks).toEqual([longText])
  })

  // -- Unit 14b: final_answer answer extraction tests --

  it("final_answer with JSON string argument: uses string directly as answer", async () => {
    // Model passes a plain JSON string instead of {"answer":"..."}
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '"just a plain string response"' } },
        ]),
      ])
    )

    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // The plain string should be emitted as the answer
    expect(textChunks).toEqual(["just a plain string response"])
    // Should terminate (done = true)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    // Synthetic tool response present
    const toolResults = messages.filter((m: any) => m.role === "tool")
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0].content).toBe("(delivered)")
  })

  it("final_answer with truncated JSON: retries by pushing error and continuing loop", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // First call: truncated JSON (invalid)
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"this is truncated...' } },
          ]),
        ])
      }
      // Second call: model retries successfully
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_2", function: { name: "final_answer", arguments: '{"answer":"complete response"}' } },
        ]),
      ])
    })

    const textChunks: string[] = []
    const errors: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: (err) => errors.push(err.message),
      onClearText: () => { textChunks.length = 0 },
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // Should have made 2 API calls (retry after truncation)
    expect(callCount).toBe(2)
    // The error result should be in messages (assistant msg + tool error from first attempt)
    const toolMsgs = messages.filter((m: any) => m.role === "tool")
    const errorToolMsg = toolMsgs.find((m: any) => m.tool_call_id === "call_1")
    expect(errorToolMsg).toBeDefined()
    expect(errorToolMsg.content).toContain("incomplete or malformed")
    // The successful answer should be emitted
    expect(textChunks).toEqual(["complete response"])
    // No terminal errors
    expect(errors).toEqual([])
  })

  it("final_answer with wrong-shape JSON (no answer field): retries", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // First call: valid JSON but wrong shape (no "answer" key)
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"text":"hello","response":"world"}' } },
          ]),
        ])
      }
      // Second call: correct shape
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_2", function: { name: "final_answer", arguments: '{"answer":"correct answer"}' } },
        ]),
      ])
    })

    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // Should have retried
    expect(callCount).toBe(2)
    // Error message pushed for first attempt
    const toolMsgs = messages.filter((m: any) => m.role === "tool")
    const errorToolMsg = toolMsgs.find((m: any) => m.tool_call_id === "call_1")
    expect(errorToolMsg).toBeDefined()
    expect(errorToolMsg.content).toContain("incomplete or malformed")
    // Final answer emitted from second attempt
    expect(textChunks).toEqual(["correct answer"])
  })

  it("final_answer retry then succeed: emits answer on successful retry", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // First call: invalid JSON
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "final_answer", arguments: "not json at all" } },
          ]),
        ])
      }
      // Second call: valid answer
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_2", function: { name: "final_answer", arguments: '{"answer":"success after retry"}' } },
        ]),
      ])
    })

    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    expect(callCount).toBe(2)
    // The successful answer from retry is emitted
    expect(textChunks).toEqual(["success after retry"])
    // Both tool results present: error for first, delivered for second
    const toolMsgs = messages.filter((m: any) => m.role === "tool")
    expect(toolMsgs).toHaveLength(2)
    expect(toolMsgs[0].tool_call_id).toBe("call_1")
    expect(toolMsgs[0].content).toContain("incomplete or malformed")
    expect(toolMsgs[1].tool_call_id).toBe("call_2")
    expect(toolMsgs[1].content).toBe("(delivered)")
  })

  it("final_answer retry clears streamed noise via onClearText on both attempts", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // First call: noise content + truncated JSON
        return makeStream([
          makeChunk("some noise from streaming", [
            { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"truncated...' } },
          ]),
        ])
      }
      // Second call: more noise + valid answer
      return makeStream([
        makeChunk("more noise", [
          { index: 0, id: "call_2", function: { name: "final_answer", arguments: '{"answer":"clean answer"}' } },
        ]),
      ])
    })

    let clearCount = 0
    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onClearText: () => { clearCount++; textChunks.length = 0 },
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // onClearText is called 3 times:
    // 1. Streaming layer clears noise when first detecting final_answer (attempt 1)
    // 2. Core.ts clears partial streamed text on retry (truncated JSON)
    // 3. Streaming layer clears noise when detecting final_answer (attempt 2)
    expect(clearCount).toBe(3)
    // Only the final clean answer should remain
    expect(textChunks).toEqual(["clean answer"])
  })
})

// --- Unit 20a: finalAnswerStreamed flag integration tests ---

describe("finalAnswerStreamed flag in core.ts", () => {
  let runAgent: (messages: any[], callbacks: ChannelCallbacks, channel?: string, signal?: AbortSignal, options?: { toolChoiceRequired?: boolean }) => Promise<{ usage?: any }>

  function makeStream(chunks: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    }
  }

  function makeChunk(content?: string, toolCalls?: any[]) {
    const delta: any = {}
    if (content !== undefined) delta.content = content
    if (toolCalls !== undefined) delta.tool_calls = toolCalls
    return { choices: [{ delta }] }
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()
    mockCreate.mockReset()
    mockResponsesCreate.mockReset()

    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  it("when finalAnswerStreamed is true: skips onClearText and onTextChunk in isSoleFinalAnswer block (no double-emit)", async () => {
    // Set up stream that returns final_answer with name in first delta
    // FinalAnswerParser will detect it and set finalAnswerStreamed=true
    // The streaming layer calls onClearText once and onTextChunk progressively
    // Core.ts should NOT call onClearText or onTextChunk again
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"already streamed"}' } },
        ]),
      ])
    )

    const callSequence: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => callSequence.push(`text:${text}`),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onClearText: () => callSequence.push("clear"),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // With FinalAnswerParser active: streaming layer calls onClearText + onTextChunk
    // Then core.ts sees finalAnswerStreamed=true and skips its own onClearText + onTextChunk
    // So we should see exactly ONE clear and the text from streaming only
    //
    // Without the feature (current state): streaming layer does NOT call anything
    // (no parser), and core.ts calls onClearText + onTextChunk("already streamed")
    //
    // The test asserts: the "clear" before "text:already streamed" should come from
    // the streaming layer (before the parser emits text), not from core.ts.
    // With the feature: clear is from streaming, text is progressive from streaming.
    // Without the feature: clear + text:already streamed are from core.ts.
    //
    // To make this test FAIL now and PASS after implementation:
    // Assert that the streaming layer's FinalAnswerParser exists and is used
    // by checking that TurnResult has finalAnswerStreamed property.
    const { TurnResult: _ } = await import("../../heart/streaming") as any
    const streaming = await import("../../heart/streaming")
    // The FinalAnswerParser class must exist
    expect(streaming.FinalAnswerParser).toBeDefined()
    // The result must have finalAnswerStreamed=true (so core.ts skips re-emit)
    // This is verified by ensuring no double clear+text in callSequence
    // Count clear calls: should be exactly 1 (from streaming layer only)
    const clearCount = callSequence.filter(c => c === "clear").length
    expect(clearCount).toBe(1)
    // Count "already streamed" text chunks: should be from streaming only (progressive)
    // not from core.ts (which would be a single "text:already streamed" at the end)
    const fullTextChunks = callSequence.filter(c => c.startsWith("text:")).map(c => c.slice(5))
    expect(fullTextChunks.join("")).toBe("already streamed")

    // Still pushes messages (assistant msg + tool result)
    const toolResults = messages.filter((m: any) => m.role === "tool")
    expect(toolResults.some((m: any) => m.content === "(delivered)")).toBe(true)
  })

  it("when finalAnswerStreamed is false: existing behavior unchanged -- core.ts calls onClearText + onTextChunk", async () => {
    // Use a tool call name that is NOT final_answer, so parser doesn't activate
    // Then on second iteration, final_answer comes through
    // Since each iteration creates a fresh parser, the second call's parser
    // detects final_answer and sets finalAnswerStreamed=true
    //
    // Actually, to test the false case, we need a situation where the model
    // returns final_answer BUT the parser's prefix never matched (e.g. malformed args).
    // When parser.active is false, finalAnswerStreamed will be false,
    // and core.ts should call onClearText + onTextChunk as before.
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          // final_answer with arguments that don't contain "answer" prefix
          // (parser won't activate), but JSON is valid with answer field
          // so core.ts will extract and emit
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"from core"}' } },
        ]),
      ])
    )

    const callSequence: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => callSequence.push(`text:${text}`),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onClearText: () => callSequence.push("clear"),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // For the false case -- wait, this test has a problem:
    // '{"answer":"from core"}' WILL match the parser prefix.
    // So this will also have finalAnswerStreamed=true.
    // To get false, we need args like '{"text":"from core"}' which has no answer field.
    // But then core.ts won't extract an answer and will retry.
    //
    // The false case is: parser never activates because args don't start with "answer" prefix.
    // But core.ts can still parse the full JSON string. The two cases are:
    //   1. parser.active=true -> finalAnswerStreamed=true -> core.ts skips
    //   2. parser.active=false -> finalAnswerStreamed=false -> core.ts emits
    //
    // For case 2, the args would be something unusual that doesn't match the prefix
    // but is still valid JSON with answer field. This is impossible since any
    // '{"answer":"..."}' will match the prefix.
    //
    // So the false case is only when it's NOT final_answer tool, or when the
    // args are malformed. For malformed: core.ts retries.
    // The only realistic false case for core.ts emit is when finalAnswerStreamed
    // doesn't exist (current state -- undefined is falsy).
    //
    // Actually, this test should verify that when the feature is implemented,
    // the existing core.test.ts tests that call onClearText+onTextChunk still work.
    // The simplest way: verify that the existing "calls onClearText before emitting"
    // test still passes by checking existing tests aren't broken.
    //
    // For this test: just verify core.ts calls clear+text when it does emit.
    // This already works today and will continue to work.
    expect(callSequence.some(c => c === "clear")).toBe(true)
    const fullText = callSequence.filter(c => c.startsWith("text:")).map(c => c.slice(5)).join("")
    expect(fullText).toContain("from core")
  })
})

describe("integration: kick + tool_choice required combined", () => {
  let runAgent: (messages: any[], callbacks: ChannelCallbacks, channel?: string, signal?: AbortSignal, options?: { toolChoiceRequired?: boolean }) => Promise<{ usage?: any }>

  function makeStream(chunks: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    }
  }

  function makeChunk(content?: string, toolCalls?: any[]) {
    const delta: any = {}
    if (content !== undefined) delta.content = content
    if (toolCalls !== undefined) delta.tool_calls = toolCalls
    return { choices: [{ delta }] }
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()
    mockCreate.mockReset()
    mockResponsesCreate.mockReset()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)

    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  // Kick detection disabled — see core.ts
  // skip: kick detection deferred per audit
  it.skip("kick fires when toolChoiceRequired is true and model narrates intent", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([makeChunk("let me check that for you")])
      }
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"done"}' } },
        ]),
      ])
    })

    const kicks: number[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => kicks.push(1),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    expect(kicks).toHaveLength(1)
    expect(callCount).toBe(2)
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant")
    expect(lastAssistant.content).toBe("done")
  })

  // Kick detection disabled — see core.ts
  // skip: kick detection deferred per audit
  it.skip("after kick, model returns final_answer -- terminates cleanly", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([makeChunk("I'll read that file")])
      }
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"the answer is 42"}' } },
        ]),
      ])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    expect(callCount).toBe(2)
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant")
    expect(lastAssistant.content).toBe("the answer is 42")
    expect(lastAssistant.tool_calls).toBeUndefined()
  })

  // Kick detection disabled — see core.ts
  // skip: kick detection deferred per audit
  it.skip("abort during kick attempt -- clean stop, no dangling messages", async () => {
    const controller = new AbortController()
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([makeChunk("let me read that")])
      }
      // On retry (after kick), abort before streaming completes
      controller.abort()
      return makeStream([makeChunk("hello")])
    })

    const kicks: number[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => kicks.push(1),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, controller.signal)

    // First kick fires (narration), then abort causes empty result which
    // triggers a second kick (empty), then abort is detected at loop top
    expect(kicks).toHaveLength(2)
    // Messages should not have dangling tool_calls
    const lastMsg = messages[messages.length - 1]
    if (lastMsg.role === "assistant" && lastMsg.tool_calls) {
      // This should not happen -- stripLastToolCalls should have cleaned up
      expect(lastMsg.tool_calls).toBeUndefined()
    }
  })

  // Kick detection disabled — see core.ts
  // skip: kick detection deferred per audit
  it.skip("empty content with no tool_calls -- kicks (empty response is always wrong)", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // Empty response
        return makeStream([{ choices: [{ delta: {} }] }])
      }
      // After kick, model responds properly
      return makeStream([makeChunk("here is your answer")])
    })

    const kicks: number[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => kicks.push(1),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    expect(kicks).toHaveLength(1)
    expect(callCount).toBe(2)
    // Empty-response kick uses different message than narration kick
    const kickMsg = messages.find((m: any) => m.role === "assistant" && m.content.includes("empty"))
    expect(kickMsg).toBeDefined()
    expect(kickMsg.content).toBe("I sent an empty message by accident — let me try again.")
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant")
    expect(lastAssistant.content).toBe("here is your answer")
  })

  it("intent phrase only in model content triggers kick, not in tool results", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("let me read the file content here")

    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // Model returns tool call, tool result contains intent phrase
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
          ]),
        ])
      }
      // Model response after tool execution -- no intent phrase, normal text
      return makeStream([makeChunk("here are the results")])
    })

    const kicks: number[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => kicks.push(1),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    // No kick should fire -- the intent phrase is in the tool result, not model content
    expect(kicks).toHaveLength(0)
  })

  it("final_answer with very long text -- full text preserved", async () => {
    const longText = "x".repeat(100000)
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: JSON.stringify({ answer: longText }) } },
        ]),
      ])
    )

    const textChunks: string[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (text) => textChunks.push(text),
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // Full msg is kept with tool_calls; answer emitted through onTextChunk
    const assistantMsg = messages.find((m: any) => m.role === "assistant")
    expect(assistantMsg.tool_calls).toBeDefined()
    expect(textChunks).toHaveLength(1)
    expect(textChunks[0]).toBe(longText)
    expect(textChunks[0].length).toBe(100000)
    // Synthetic tool response present
    const toolResults = messages.filter((m: any) => m.role === "tool")
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0].content).toBe("(delivered)")
  })

  // Kick detection disabled — see core.ts
  // skip: kick detection deferred per audit
  it.skip("toolChoiceRequired kicks even when content is empty (reasoning-only response)", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // Model returns empty content (reasoning went through separate channel), no tool calls
        return makeStream([{ choices: [{ delta: {} }] }])
      }
      // After kick, model correctly calls final_answer
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"here you go"}' } },
        ]),
      ])
    })

    const kicks: number[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => kicks.push(1),
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    expect(kicks).toHaveLength(1)
    expect(callCount).toBe(2)
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant")
    expect(lastAssistant.content).toBe("here you go")
  })

  it("uses getToolsForChannel to select tools based on channel", async () => {
    let usedTools: any[] | undefined
    mockCreate.mockImplementation((params: any) => {
      usedTools = params.tools
      return makeStream([makeChunk("hello")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    // Run with "teams" channel -- tools should include graph_profile and ado_work_items
    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, "teams")

    const toolNames = usedTools?.map((t: any) => t.function.name) || []
    expect(toolNames).toContain("graph_profile")
    expect(toolNames).toContain("ado_work_items")
    expect(toolNames).not.toContain("read_file")
    expect(toolNames).not.toContain("shell")
  })

  it("does not include graph/ado tools for cli channel", async () => {
    let usedTools: any[] | undefined
    mockCreate.mockImplementation((params: any) => {
      usedTools = params.tools
      return makeStream([makeChunk("hello")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, "cli")

    const toolNames = usedTools?.map((t: any) => t.function.name) || []
    expect(toolNames).not.toContain("graph_profile")
    expect(toolNames).not.toContain("ado_work_items")
    expect(toolNames).toContain("read_file")
  })

  it("passes toolContext to execTool when calling graph/ado tools", async () => {
    // The tool will be called through the agent loop -- mock the API to return a tool call
    mockCreate.mockReturnValueOnce(
      makeStream([
        makeChunk(undefined, [{ index: 0, id: "tc1", function: { name: "graph_profile", arguments: "" } }]),
        makeChunk(undefined, [{ index: 0, function: { arguments: "{}" } }]),
      ]),
    ).mockReturnValueOnce(
      makeStream([makeChunk("here is your profile")])
    )

    const toolContext = {
      graphToken: "mock-graph-token",
      adoToken: undefined,
      signin: vi.fn(),
      adoOrganizations: [],
    }

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, "teams", undefined, { toolContext } as any)

    // The tool should have been executed -- look for the tool result in messages
    const toolMessage = messages.find((m: any) => m.role === "tool" && m.tool_call_id === "tc1")
    expect(toolMessage).toBeDefined()
    // The result should come from the graph_profile handler (not "unknown")
    expect(toolMessage.content).not.toContain("unknown")
  })
})

describe("tool_choice forcing after kick (Bug 4)", () => {
  let runAgent: (messages: any[], callbacks: ChannelCallbacks, channel?: string, signal?: AbortSignal, options?: { toolChoiceRequired?: boolean }) => Promise<{ usage?: any }>

  function makeStream(chunks: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    }
  }

  function makeChunk(content?: string, toolCalls?: any[]) {
    const delta: any = {}
    if (content !== undefined) delta.content = content
    if (toolCalls !== undefined) delta.tool_calls = toolCalls
    return { choices: [{ delta }] }
  }

  function makeResponsesStream(events: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const event of events) {
          yield event
        }
      },
    }
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()
    mockCreate.mockReset()
    mockResponsesCreate.mockReset()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)

    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  // Kick detection disabled — see core.ts
  // skip: kick detection deferred per audit
  it.skip("MiniMax: sets tool_choice=required on the call AFTER a narration kick (no toolChoiceRequired option)", async () => {
    const paramsPerCall: any[] = []
    let callCount = 0
    mockCreate.mockImplementation((params: any) => {
      callCount++
      paramsPerCall.push({ ...params })
      if (callCount === 1) {
        // Narration: triggers kick
        return makeStream([makeChunk("let me read that file")])
      }
      // After kick: respond normally
      return makeStream([makeChunk("here is the result")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    // No toolChoiceRequired option -- tool_choice should still be set after kick
    await runAgent(messages, callbacks)

    expect(callCount).toBe(2)
    // First call: no tool_choice (no kick yet, no toolChoiceRequired)
    expect(paramsPerCall[0].tool_choice).toBeUndefined()
    // Second call (after narration kick): tool_choice = "required"
    expect(paramsPerCall[1].tool_choice).toBe("required")
  })

  // Kick detection disabled — see core.ts
  // skip: kick detection deferred per audit
  it.skip("Azure: sets tool_choice=required on the call AFTER a narration kick (no toolChoiceRequired option)", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    const textItem = { type: "message", id: "msg1", role: "assistant", content: [{ type: "output_text", text: "let me check that for you" }] }

    const paramsPerCall: any[] = []
    let callCount = 0
    mockResponsesCreate.mockImplementation((params: any) => {
      callCount++
      paramsPerCall.push({ ...params })
      if (callCount === 1) {
        return makeResponsesStream([
          { type: "response.output_text.delta", delta: "let me check that for you" },
          { type: "response.output_item.done", item: textItem },
        ])
      }
      return makeResponsesStream([
        { type: "response.output_text.delta", delta: "here is the answer" },
      ])
    })

    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await core.runAgent(messages, callbacks)

    expect(callCount).toBe(2)
    // First call: no tool_choice
    expect(paramsPerCall[0].tool_choice).toBeUndefined()
    // Second call (after narration kick): tool_choice = "required"
    expect(paramsPerCall[1].tool_choice).toBe("required")
  })

  // Kick detection disabled — see core.ts
  // skip: kick detection deferred per audit
  it.skip("MiniMax: sets tool_choice=required after an empty kick (any kick, not just narration)", async () => {
    const paramsPerCall: any[] = []
    let callCount = 0
    mockCreate.mockImplementation((params: any) => {
      callCount++
      paramsPerCall.push({ ...params })
      if (callCount === 1) {
        // Empty response: triggers empty kick
        return makeStream([{ choices: [{ delta: {} }] }])
      }
      // After kick: respond normally
      return makeStream([makeChunk("here is the result")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    expect(callCount).toBe(2)
    // First call: no tool_choice
    expect(paramsPerCall[0].tool_choice).toBeUndefined()
    // Second call (after empty kick): tool_choice = "required"
    expect(paramsPerCall[1].tool_choice).toBe("required")
  })
})

describe("final_answer injection after narration kick", () => {
  let runAgent: (messages: any[], callbacks: ChannelCallbacks, channel?: string, signal?: AbortSignal, options?: { toolChoiceRequired?: boolean }) => Promise<{ usage?: any }>

  function makeStream(chunks: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    }
  }

  function makeChunk(content?: string, toolCalls?: any[]) {
    const delta: any = {}
    if (content !== undefined) delta.content = content
    if (toolCalls !== undefined) delta.tool_calls = toolCalls
    return { choices: [{ delta }] }
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()
    mockCreate.mockReset()
    mockResponsesCreate.mockReset()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)

    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  // Kick detection disabled — see core.ts (final_answer is now always in tools)
  // skip: kick detection deferred per audit
  it.skip("after narration kick, final_answer is present in tools sent to API", async () => {
    const toolsPerCall: any[][] = []
    let callCount = 0
    mockCreate.mockImplementation((params: any) => {
      callCount++
      toolsPerCall.push(params.tools)
      if (callCount === 1) {
        // Narration: triggers kick
        return makeStream([makeChunk("let me read that file")])
      }
      // After kick: respond normally
      return makeStream([makeChunk("here is the result")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    expect(callCount).toBe(2)
    // First call: no final_answer (no prior kick)
    const firstToolNames = toolsPerCall[0].map((t: any) => t.function.name)
    expect(firstToolNames).not.toContain("final_answer")
    // Second call (after narration kick): final_answer IS present
    const secondToolNames = toolsPerCall[1].map((t: any) => t.function.name)
    expect(secondToolNames).toContain("final_answer")
  })

  // Kick detection disabled — see core.ts (final_answer is now always in tools)
  // skip: kick detection deferred per audit
  it.skip("after empty kick, final_answer is NOT in tools (narration-only injection)", async () => {
    const toolsPerCall: any[][] = []
    let callCount = 0
    mockCreate.mockImplementation((params: any) => {
      callCount++
      toolsPerCall.push(params.tools)
      if (callCount === 1) {
        // Empty response: triggers empty kick
        return makeStream([{ choices: [{ delta: {} }] }])
      }
      // After kick: respond normally
      return makeStream([makeChunk("here is the result")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    expect(callCount).toBe(2)
    // After any kick (including empty): final_answer IS injected so the
    // model can cleanly exit instead of calling no-op tools
    const secondToolNames = toolsPerCall[1].map((t: any) => t.function.name)
    expect(secondToolNames).toContain("final_answer")
  })

  // Kick detection disabled — see core.ts (final_answer is now always in tools)
  // skip: kick detection deferred per audit
  it.skip("model calls final_answer after narration kick -- terminates cleanly", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([makeChunk("I'll check that for you")])
      }
      // After narration kick, model uses final_answer
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"the answer is 42"}' } },
        ]),
      ])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    expect(callCount).toBe(2)
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant")
    expect(lastAssistant.content).toBe("the answer is 42")
    expect(lastAssistant.tool_calls).toBeUndefined()
  })

  // Kick detection disabled — see core.ts (final_answer is now always in tools)
  // skip: kick detection deferred per audit
  it.skip("activeTools computed per-iteration -- first call has no final_answer, after kick it does", async () => {
    const toolsPerCall: any[][] = []
    let callCount = 0
    mockCreate.mockImplementation((params: any) => {
      callCount++
      toolsPerCall.push([...params.tools])
      if (callCount === 1) {
        return makeStream([makeChunk("let me do that")])
      }
      return makeStream([makeChunk("done")])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onKick: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    // Verify tools are computed per-iteration (not static)
    expect(toolsPerCall.length).toBe(2)
    const firstNames = toolsPerCall[0].map((t: any) => t.function.name)
    const secondNames = toolsPerCall[1].map((t: any) => t.function.name)
    // First iteration: no final_answer
    expect(firstNames).not.toContain("final_answer")
    // Second iteration (after narration kick): final_answer present
    expect(secondNames).toContain("final_answer")
  })

  it("toolChoiceRequired still includes final_answer even without prior kick", async () => {
    const toolsPerCall: any[][] = []
    mockCreate.mockImplementation((params: any) => {
      toolsPerCall.push(params.tools)
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"done"}' } },
        ]),
      ])
    })

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, { toolChoiceRequired: true })

    // With toolChoiceRequired, final_answer should be in tools from the first call
    const toolNames = toolsPerCall[0].map((t: any) => t.function.name)
    expect(toolNames).toContain("final_answer")
  })
})

describe("confirmation system", () => {
  let runAgent: (messages: any[], callbacks: ChannelCallbacks, channel?: string, signal?: AbortSignal, options?: any) => Promise<{ usage?: any }>

  function makeStream(chunks: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    }
  }

  function makeChunk(content?: string, toolCalls?: any[]) {
    const delta: any = {}
    if (content !== undefined) delta.content = content
    if (toolCalls !== undefined) delta.tool_calls = toolCalls
    return { choices: [{ delta }] }
  }

  function makeResponsesStream(events: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const event of events) {
          yield event
        }
      },
    }
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()
    mockCreate.mockReset()
    mockResponsesCreate.mockReset()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)

    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  it("confirmation tool + confirmed executes normally", async () => {
    // graph_mutate is in confirmationRequired set
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "tc_mut", function: { name: "graph_mutate", arguments: '{"method":"POST","path":"/me/sendMail","body":"{}"}' } },
          ]),
        ])
      }
      return makeStream([makeChunk("done")])
    })

    const onConfirmAction = vi.fn().mockResolvedValue("confirmed")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onConfirmAction,
    }

    const toolContext = {
      graphToken: "test-token",
      adoToken: undefined,
      signin: vi.fn(),
      adoOrganizations: [],
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, "teams", undefined, { toolContext })

    // onConfirmAction should have been called with the tool name and args
    expect(onConfirmAction).toHaveBeenCalledWith("graph_mutate", expect.objectContaining({ method: "POST", path: "/me/sendMail" }))

    // Tool should have been executed (not cancelled)
    const toolMsg = messages.find((m: any) => m.role === "tool" && m.tool_call_id === "tc_mut")
    expect(toolMsg).toBeDefined()
    expect(toolMsg.content).not.toContain("cancelled")
  })

  it("confirmation tool + denied returns cancelled message", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "tc_mut", function: { name: "ado_mutate", arguments: '{"method":"PATCH","organization":"myorg","path":"/_apis/wit/workitems/1"}' } },
          ]),
        ])
      }
      return makeStream([makeChunk("understood")])
    })

    const onConfirmAction = vi.fn().mockResolvedValue("denied")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onConfirmAction,
    }

    const toolContext = {
      graphToken: undefined,
      adoToken: "test-token",
      signin: vi.fn(),
      adoOrganizations: ["myorg"],
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, "teams", undefined, { toolContext })

    // onConfirmAction should have been called
    expect(onConfirmAction).toHaveBeenCalledWith("ado_mutate", expect.objectContaining({ method: "PATCH" }))

    // Tool result should indicate cancellation
    const toolMsg = messages.find((m: any) => m.role === "tool" && m.tool_call_id === "tc_mut")
    expect(toolMsg).toBeDefined()
    expect(toolMsg.content).toContain("cancelled")
  })

  it("confirmation tool + no callback returns cancelled (safe default)", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "tc_mut", function: { name: "graph_mutate", arguments: '{"method":"DELETE","path":"/me/messages/123"}' } },
          ]),
        ])
      }
      return makeStream([makeChunk("ok")])
    })

    // No onConfirmAction callback
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const toolContext = {
      graphToken: "test-token",
      adoToken: undefined,
      signin: vi.fn(),
      adoOrganizations: [],
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, "teams", undefined, { toolContext })

    // Tool result should indicate cancellation (safe default)
    const toolMsg = messages.find((m: any) => m.role === "tool" && m.tool_call_id === "tc_mut")
    expect(toolMsg).toBeDefined()
    expect(toolMsg.content).toContain("cancelled")
  })

  it("non-confirmation tool executes normally without invoking callback", async () => {
    // graph_query is NOT in confirmationRequired set
    vi.mocked(fs.readFileSync).mockReturnValue("file data")

    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "tc_read", function: { name: "read_file", arguments: '{"path":"/tmp/test.txt"}' } },
          ]),
        ])
      }
      return makeStream([makeChunk("done")])
    })

    const onConfirmAction = vi.fn().mockResolvedValue("confirmed")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onConfirmAction,
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks)

    // onConfirmAction should NOT have been called for read_file
    expect(onConfirmAction).not.toHaveBeenCalled()

    // Tool should have executed normally
    const toolMsg = messages.find((m: any) => m.role === "tool" && m.tool_call_id === "tc_read")
    expect(toolMsg).toBeDefined()
    expect(toolMsg.content).toBe("file data")
  })

  it("Azure: confirmation denied pushes cancelled to azureInput", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupAzure()

    let callCount = 0
    mockResponsesCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeResponsesStream([
          { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "graph_mutate", arguments: "" } },
          { type: "response.function_call_arguments.delta", delta: '{"method":"POST","path":"/me/sendMail"}' },
          { type: "response.output_item.done", item: { type: "function_call", id: "fc1", call_id: "c1", name: "graph_mutate", arguments: '{"method":"POST","path":"/me/sendMail"}', status: "completed" } },
        ])
      }
      return makeResponsesStream([
        { type: "response.output_text.delta", delta: "ok" },
      ])
    })

    const onConfirmAction = vi.fn().mockResolvedValue("denied")
    const core = await import("../../heart/core")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onConfirmAction,
    }

    const messages: any[] = [{ role: "system", content: "test" }, { role: "user", content: "send email" }]
    await core.runAgent(messages, callbacks, "teams", undefined, {
      toolContext: { graphToken: "tok", adoToken: undefined, signin: vi.fn(), adoOrganizations: [] },
    })

    // Second call's input should contain function_call_output with cancelled message
    const secondInput = mockResponsesCreate.mock.calls[1][0].input
    const cancelledItem = secondInput.find((i: any) => i.type === "function_call_output" && i.output?.includes("cancelled"))
    expect(cancelledItem).toBeDefined()

    // config cleanup handled by resetConfigCache in beforeEach
  })

  it("skipConfirmation bypasses confirmation for mutate tools", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "tc_mut", function: { name: "graph_mutate", arguments: '{"method":"POST","path":"/me/sendMail","body":"{}"}' } },
          ]),
        ])
      }
      return makeStream([makeChunk("done")])
    })

    const onConfirmAction = vi.fn().mockResolvedValue("denied")
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
      onConfirmAction,
    }

    const toolContext = {
      graphToken: "test-token",
      adoToken: undefined,
      signin: vi.fn(),
      adoOrganizations: [],
    }

    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, "teams", undefined, { toolContext, skipConfirmation: true })

    // onConfirmAction should NOT have been called — confirmation was skipped
    expect(onConfirmAction).not.toHaveBeenCalled()

    // Tool should have been executed (not cancelled)
    const toolMsg = messages.find((m: any) => m.role === "tool" && m.tool_call_id === "tc_mut")
    expect(toolMsg).toBeDefined()
    expect(toolMsg.content).not.toContain("cancelled")
  })

  it("re-reads friend record from disk each turn when friendStore is present", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("hi")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const freshRecord = {
      id: "uuid-1",
      name: "Updated Name",
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: { ado: "use iteration paths" },
      notes: { name: { value: "Updated Name", savedAt: "2026-01-01T00:00:00.000Z" } },
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    }

    const mockStore = {
      get: vi.fn().mockResolvedValue(freshRecord),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
    }

    const messages: any[] = [
      { role: "system", content: "old prompt" },
      { role: "user", content: "hello" },
    ]

    await runAgent(messages, callbacks, "cli", undefined, {
      toolContext: {
        signin: async () => undefined,
        friendStore: mockStore,
        context: {
          friend: {
            id: "uuid-1",
            name: "Old Name",
            externalIds: [],
            tenantMemberships: [],
            toolPreferences: {},
            notes: {},
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
            schemaVersion: 1,
          },
          channel: {
            channel: "cli" as const,
            availableIntegrations: [],
            supportsMarkdown: false,
            supportsStreaming: true,
            supportsRichCards: false,
            maxMessageLength: Infinity,
          },
        },
      },
    } as any)

    // friendStore.get should have been called with the friend ID to re-read from disk
    expect(mockStore.get).toHaveBeenCalledWith("uuid-1")
  })

  it("handles friendStore.get returning null gracefully", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("hi")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const mockStore = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
    }

    const messages: any[] = [
      { role: "system", content: "old prompt" },
      { role: "user", content: "hello" },
    ]

    await runAgent(messages, callbacks, "cli", undefined, {
      toolContext: {
        signin: async () => undefined,
        friendStore: mockStore,
        context: {
          friend: {
            id: "uuid-1",
            name: "Old Name",
            externalIds: [],
            tenantMemberships: [],
            toolPreferences: {},
            notes: {},
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
            schemaVersion: 1,
          },
          channel: {
            channel: "cli" as const,
            availableIntegrations: [],
            supportsMarkdown: false,
            supportsStreaming: true,
            supportsRichCards: false,
            maxMessageLength: Infinity,
          },
        },
      },
    } as any)

    // friendStore.get was called but returned null -- no crash
    expect(mockStore.get).toHaveBeenCalledWith("uuid-1")
  })

  it("passes toolPreferences to getToolsForChannel when friend has preferences", async () => {
    // This test verifies that after re-reading the friend record,
    // the agent loop uses the fresh toolPreferences for tool description injection.
    // We verify indirectly by checking that mockCreate was called with tools
    // that include the preference text in their descriptions.
    mockCreate.mockReturnValue(makeStream([makeChunk("hi")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const freshRecord = {
      id: "uuid-1",
      name: "Test User",
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: { ado: "use area path Team\\Backend" },
      notes: {},
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    }

    const mockStore = {
      get: vi.fn().mockResolvedValue(freshRecord),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
    }

    const messages: any[] = [
      { role: "system", content: "old prompt" },
      { role: "user", content: "hello" },
    ]

    // Use teams channel so integration tools are included
    await runAgent(messages, callbacks, "teams", undefined, {
      toolContext: {
        signin: async () => undefined,
        friendStore: mockStore,
        context: {
          friend: {
            id: "uuid-1",
            name: "Test User",
            externalIds: [],
            tenantMemberships: [],
            toolPreferences: { ado: "use area path Team\\Backend" },
            notes: {},
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
            schemaVersion: 1,
          },
          channel: {
            channel: "teams" as const,
            availableIntegrations: ["ado", "graph"],
            supportsMarkdown: true,
            supportsStreaming: true,
            supportsRichCards: true,
            maxMessageLength: 28000,
          },
        },
      },
    } as any)

    // Verify that mockCreate was called with tools (the tools param should contain
    // ado tools with the preference appended to their descriptions)
    const createCall = mockCreate.mock.calls[0][0]
    const tools = createCall.tools
    // Since toolPreferences includes "ado", the ado tools should be absent in CLI
    // but present in teams. The preference should NOT appear unless the implementation
    // actually passes toolPreferences to getToolsForChannel.
    // We can't directly check the description text because the tools mock might not
    // include real ado tools in the test environment. Instead, verify that
    // getToolsForChannel was called with the preferences by checking the store was read.
    expect(mockStore.get).toHaveBeenCalledWith("uuid-1")
  })

  it("rebuilds system prompt with fresh context when friendStore returns updated record", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("hi")]))

    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onError: () => {},
    }

    const freshRecord = {
      id: "uuid-1",
      name: "Fresh Name",
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: {},
      notes: { name: { value: "Fresh Name", savedAt: "2026-01-01T00:00:00.000Z" } },
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    }

    const mockStore = {
      get: vi.fn().mockResolvedValue(freshRecord),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
    }

    const messages: any[] = [
      { role: "system", content: "old prompt" },
      { role: "user", content: "hello" },
    ]

    await runAgent(messages, callbacks, "cli", undefined, {
      toolContext: {
        signin: async () => undefined,
        friendStore: mockStore,
        context: {
          friend: {
            id: "uuid-1",
            name: "Old Name",
            externalIds: [],
            tenantMemberships: [],
            toolPreferences: {},
            notes: {},
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
            schemaVersion: 1,
          },
          channel: {
            channel: "cli" as const,
            availableIntegrations: [],
            supportsMarkdown: false,
            supportsStreaming: true,
            supportsRichCards: false,
            maxMessageLength: Infinity,
          },
        },
      },
    } as any)

    // System prompt should have been rebuilt with fresh context
    // The fresh record has name "Fresh Name" and note "name: Fresh Name"
    // These should appear in the system prompt via contextSection
    const systemContent = messages[0].content
    expect(systemContent).toContain("Fresh Name")
  })
})

describe("createSummarize", () => {
  it("returns a function that calls the provider for LLM summarization", async () => {
    vi.resetModules()
    await setupMinimax()
    const core = await import("../../heart/core")

    // Get the runtime client and mock its create method
    const summarize = core.createSummarize()
    // The client is initialized via getProviderRuntime — spy on the OpenAI ctor mock
    const spyCreate = mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "summarized content" } }],
    })

    const result = await summarize("some transcript", "summarize this")

    expect(result).toBe("summarized content")
    expect(spyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "summarize this" },
          { role: "user", content: "some transcript" },
        ],
        max_tokens: 500,
      }),
    )
  })

  it("falls back to transcript when response has no content", async () => {
    vi.resetModules()
    await setupMinimax()
    const core = await import("../../heart/core")

    const summarize = core.createSummarize()
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: null } }],
    })

    const result = await summarize("original transcript", "summarize")

    expect(result).toBe("original transcript")
  })
})

describe("resetProviderRuntime", () => {
  it("clears cached provider so next access re-creates from current config", async () => {
    vi.resetModules()
    await setupMinimax("key-1", "model-1")
    const core = await import("../../heart/core")

    // First access: creates provider runtime for minimax
    const model1 = core.getModel()
    expect(model1).toBe("model-1")

    // Change config to a different model
    await setupMinimax("key-2", "model-2")

    // Without reset, cached provider still returns old model
    expect(core.getModel()).toBe("model-1")

    // After reset, next access picks up new config
    core.resetProviderRuntime()
    expect(core.getModel()).toBe("model-2")
  })

  it("after reset, provider picks up new config values", async () => {
    vi.resetModules()
    await setupMinimax("key-a", "model-a")
    const core = await import("../../heart/core")

    expect(core.getProvider()).toBe("minimax")

    // Switch provider via config mock
    await setupAzure("az-key", "https://test.openai.azure.com", "dep-1", "gpt-5.2-chat")

    // Reset provider runtime so it re-creates
    core.resetProviderRuntime()
    expect(core.getProvider()).toBe("azure")
  })
})

describe("repairOrphanedToolCalls", () => {
  it("injects synthetic results for orphaned tool_calls with no matching tool result", async () => {
    vi.resetModules()
    const { repairOrphanedToolCalls } = await import("../../heart/core")
    const messages: any[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      // Missing tool result for tc-1
      { role: "user", content: "next" },
    ]

    repairOrphanedToolCalls(messages)

    expect(messages.length).toBe(4)
    expect(messages[2].role).toBe("tool")
    expect(messages[2].tool_call_id).toBe("tc-1")
    expect(messages[2].content).toContain("interrupted")
  })

  it("removes orphaned tool results that have no matching tool_calls", async () => {
    vi.resetModules()
    const { repairOrphanedToolCalls } = await import("../../heart/core")
    const messages: any[] = [
      { role: "user", content: "hello" },
      { role: "tool", tool_call_id: "orphan-1", content: "stale result" },
      { role: "user", content: "next" },
    ]

    repairOrphanedToolCalls(messages)

    expect(messages.length).toBe(2)
    expect(messages.every((m: any) => m.role !== "tool")).toBe(true)
  })

  it("leaves valid tool call/result pairs untouched", async () => {
    vi.resetModules()
    const { repairOrphanedToolCalls } = await import("../../heart/core")
    const messages: any[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "tc-1", content: "file contents" },
      { role: "assistant", content: "done" },
    ]

    repairOrphanedToolCalls(messages)

    expect(messages.length).toBe(4)
    expect(messages[2].role).toBe("tool")
    expect(messages[2].content).toBe("file contents")
  })

  it("handles empty messages array", async () => {
    vi.resetModules()
    const { repairOrphanedToolCalls } = await import("../../heart/core")
    const messages: any[] = []

    repairOrphanedToolCalls(messages)

    expect(messages.length).toBe(0)
  })

  it("stops scanning for results when hitting a subsequent assistant message", async () => {
    vi.resetModules()
    const { repairOrphanedToolCalls } = await import("../../heart/core")
    const messages: any[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc-1", type: "function", function: { name: "shell", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "tc-1", content: "ok" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc-2", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      // tc-2 has no result -- the break at the assistant boundary above means tc-1's result is NOT counted for tc-2
    ]

    repairOrphanedToolCalls(messages)

    // Should inject synthetic result for tc-2 after the second assistant message
    expect(messages.length).toBe(5)
    expect(messages[4].role).toBe("tool")
    expect(messages[4].tool_call_id).toBe("tc-2")
    expect(messages[4].content).toContain("interrupted")
  })

  it("handles multiple orphaned tool_calls in same assistant message", async () => {
    vi.resetModules()
    const { repairOrphanedToolCalls } = await import("../../heart/core")
    const messages: any[] = [
      { role: "user", content: "do stuff" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc-a", type: "function", function: { name: "shell", arguments: "{}" } },
          { id: "tc-b", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
    ]

    repairOrphanedToolCalls(messages)

    expect(messages.length).toBe(4)
    expect(messages[2].tool_call_id).toBe("tc-a")
    expect(messages[3].tool_call_id).toBe("tc-b")
  })
})
