import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Fake providers inject credit, auth, 429/overload and network errors so the turn's automatic fallback is exercised end to end.

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

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

const OPUS = { provider: "anthropic" as const, model: "claude-opus-5-5" }
const SONNET = { provider: "anthropic" as const, model: "claude-sonnet-5-5" }
const MINIMAX = { provider: "minimax" as const, model: "MiniMax-M3" }

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80_000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

const mockOpenAICreate = vi.fn()
vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: mockOpenAICreate } }
    responses = { create: vi.fn() }
    constructor(_opts?: any) {}
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

const mockAnthropicCreate = vi.fn()
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockAnthropicCreate }
    constructor(_opts?: any) {}
  }
  return { default: MockAnthropic }
})

const credentialRecords = vi.hoisted(() => ({ missing: new Set<string>() }))
const mockRefreshPool = vi.hoisted(() => vi.fn(async () => ({ ok: true })))
vi.mock("../../heart/provider-credentials", async () => {
  const actual = await vi.importActual<typeof import("../../heart/provider-credentials")>("../../heart/provider-credentials")
  return {
    ...actual,
    readProviderCredentialRecord: vi.fn(async (_agent: string, provider: string) => {
      if (credentialRecords.missing.has(provider)) return { ok: false, reason: "missing", poolPath: "vault:testagent:providers/*", error: `no ${provider} credentials` }
      return {
        ok: true,
        poolPath: "vault:testagent:providers/*",
        record: actual.createProviderCredentialRecord({
          provider: provider as any,
          credentials: { apiKey: `${provider}-test-key` },
          config: {},
          provenance: { source: "manual" },
          now: new Date("2026-11-15T00:00:00.000Z"),
        }),
      }
    }),
    refreshProviderCredentialPool: mockRefreshPool,
  }
})

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", async () => {
  const actual = await vi.importActual<typeof import("../../nerves/runtime")>("../../nerves/runtime")
  return {
    ...actual,
    emitNervesEvent: (...args: any[]) => {
      mockEmitNervesEvent(...args)
      return (actual as any).emitNervesEvent(...args)
    },
  }
})

vi.mock("../../mind/note-search", () => ({
  injectNoteSearchContext: vi.fn().mockResolvedValue(undefined),
}))

import * as identity from "../../heart/identity"
import type { ChannelCallbacks } from "../../heart/core"
import { resetProviderFallbackState, setProviderFallbackOwnerNotifier } from "../../heart/provider-fallback"

function setConfig(providerFallback?: Array<{ provider: "minimax" | "anthropic"; model: string }>): void {
  vi.mocked(identity.loadAgentConfig).mockReturnValue({
    name: "testagent",
    humanFacing: OPUS,
    agentFacing: SONNET,
    ...(providerFallback ? { providerFallback } : {}),
  } as any)
}

function openAIStream(text: string) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { choices: [{ delta: { content: text } }] }
    },
  }
}

function anthropicStream(text: string) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { type: "content_block_delta", delta: { type: "text_delta", text } }
      yield { type: "message_delta", usage: { input_tokens: 1, output_tokens: 1 } }
    },
  }
}

function httpError(message: string, status?: number): Error {
  return Object.assign(new Error(message), status === undefined ? {} : { status })
}

const CREDIT = () => httpError("400 Your credit balance is too low to access the Anthropic API.", 400)

function makeCallbacks(): ChannelCallbacks & { text: string[]; errors: Array<{ message: string; severity: string }> } {
  const text: string[] = []
  const errors: Array<{ message: string; severity: string }> = []
  return {
    text,
    errors,
    onModelStart: vi.fn(),
    onModelStreamStart: vi.fn(),
    onTextChunk: (chunk: string) => { text.push(chunk) },
    onReasoningChunk: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onError: (error: Error, severity: string) => { errors.push({ message: error.message, severity }) },
    onClearText: vi.fn(),
    flushNow: vi.fn(),
  } as any
}

function eventsNamed(name: string): any[] {
  return mockEmitNervesEvent.mock.calls.map(([event]) => event).filter((event) => event.event === name)
}

async function runTurn(channel?: "inner") {
  const { runAgent } = await import("../../heart/core")
  const callbacks = makeCallbacks()
  const result = await runAgent([{ role: "system", content: "sys" }, { role: "user", content: "hi" }], callbacks, channel)
  return { result, callbacks }
}

async function runTurnWithTimers(channel?: "inner") {
  const { runAgent } = await import("../../heart/core")
  const callbacks = makeCallbacks()
  const promise = runAgent([{ role: "system", content: "sys" }, { role: "user", content: "hi" }], callbacks, channel)
  for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(2100)
  return { result: await promise, callbacks }
}

describe("automatic provider fallback within a turn", () => {
  const notices: Array<{ noticeId: string; text: string }> = []

  beforeEach(async () => {
    mockEmitNervesEvent.mockClear()
    mockOpenAICreate.mockReset()
    mockAnthropicCreate.mockReset()
    mockRefreshPool.mockClear()
    credentialRecords.missing.clear()
    notices.length = 0
    resetProviderFallbackState()
    setProviderFallbackOwnerNotifier((_root, _agent, notice) => { notices.push(notice) })
    const core = await import("../../heart/core")
    core.resetProviderRuntime()
  }, 60_000)

  afterEach(() => {
    vi.useRealTimers()
    setProviderFallbackOwnerNotifier(null)
  })

  it("answers on MiniMax when Claude is out of credit, without asking anyone, and skips Claude on the next turn", async () => {
    setConfig([MINIMAX])
    mockAnthropicCreate.mockRejectedValue(CREDIT())
    mockOpenAICreate.mockResolvedValue(openAIStream("answered by the backup"))

    const first = await runTurn()
    expect(first.result.outcome).not.toBe("errored")
    expect(first.result.error).toBeUndefined()
    expect(first.callbacks.text.join("")).toContain("answered by the backup")
    expect(first.callbacks.errors.filter((error) => error.severity === "terminal")).toEqual([])
    // Spent credit is not retried on the same account, and Sonnet shares that account, so it is skipped too.
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1)
    expect(eventsNamed("engine.provider_fallback")).toEqual([expect.objectContaining({
      meta: expect.objectContaining({ fromProvider: "anthropic", fromModel: "claude-opus-5-5", toProvider: "minimax", toModel: "MiniMax-M3", classification: "usage-limit", lane: "outward" }),
    })])
    expect(eventsNamed("engine.provider_served").at(-1)).toEqual(expect.objectContaining({
      meta: expect.objectContaining({ provider: "minimax", fallback: true }),
    }))
    expect(notices).toHaveLength(1)
    expect(notices[0].text).toContain("out of credit")

    const second = await runTurn()
    expect(second.callbacks.text.join("")).toContain("answered by the backup")
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1)
    expect(notices).toHaveLength(1)
  })

  it("moves from an overloaded Opus to Sonnet after the usual retries", async () => {
    vi.useFakeTimers()
    setConfig([MINIMAX])
    mockAnthropicCreate.mockImplementation(async (params: any) => {
      if (params.model === "claude-opus-5-5") throw httpError("529 overloaded_error", 529)
      return anthropicStream("sonnet here")
    })

    const { result, callbacks } = await runTurnWithTimers()
    expect(result.outcome).not.toBe("errored")
    expect(callbacks.text.join("")).toContain("sonnet here")
    const models = mockAnthropicCreate.mock.calls.map(([params]) => params.model)
    expect(models.filter((model) => model === "claude-opus-5-5")).toHaveLength(3)
    expect(models.at(-1)).toBe("claude-sonnet-5-5")
    expect(mockOpenAICreate).not.toHaveBeenCalled()
    expect(eventsNamed("engine.provider_fallback")[0].meta).toEqual(expect.objectContaining({ classification: "server-error", toModel: "claude-sonnet-5-5" }))
  })

  it("rebuilds the backup, not the primary, when the backup itself needs a retry", async () => {
    vi.useFakeTimers()
    setConfig([MINIMAX])
    mockAnthropicCreate.mockRejectedValue(httpError("401 invalid x-api-key", 401))
    let minimaxCalls = 0
    mockOpenAICreate.mockImplementation(async () => {
      minimaxCalls += 1
      if (minimaxCalls === 1) throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })
      return openAIStream("minimax after a blip")
    })

    const { result, callbacks } = await runTurnWithTimers()
    expect(result.outcome).not.toBe("errored")
    expect(callbacks.text.join("")).toContain("minimax after a blip")
    expect(mockRefreshPool).toHaveBeenCalledWith("testagent", expect.objectContaining({ providers: ["minimax"] }))
    // Auth failure benches the whole Anthropic account: Opus retried with refreshes, Sonnet skipped.
    expect(mockAnthropicCreate.mock.calls.map(([params]) => params.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5"])
  })

  it("keeps the ask-to-switch path only when every entry in the chain failed", async () => {
    setConfig([MINIMAX])
    mockAnthropicCreate.mockRejectedValue(CREDIT())
    mockOpenAICreate.mockRejectedValue(httpError("401 invalid api key", 401))
    vi.useFakeTimers()

    const { result, callbacks } = await runTurnWithTimers()
    expect(result.outcome).toBe("errored")
    expect(result.errorClassification).toBe("auth-failure")
    expect(callbacks.errors.filter((error) => error.severity === "terminal")).toHaveLength(1)
    expect(eventsNamed("engine.provider_served")).toEqual([])
    expect(notices).toEqual([])
  })

  it("skips a fallback entry with no credentials", async () => {
    setConfig([MINIMAX])
    credentialRecords.missing.add("minimax")
    mockAnthropicCreate.mockRejectedValue(CREDIT())

    const { result } = await runTurn()
    expect(result.outcome).toBe("errored")
    expect(result.errorClassification).toBe("usage-limit")
    expect(eventsNamed("engine.provider_fallback_unavailable")[0].meta).toEqual(expect.objectContaining({ provider: "minimax" }))
  })

  it("does not fall back without providerFallback in agent.json", async () => {
    vi.useFakeTimers()
    setConfig()
    mockAnthropicCreate.mockRejectedValue(CREDIT())
    mockOpenAICreate.mockResolvedValue(openAIStream("should not be used"))

    const { result } = await runTurnWithTimers()
    expect(result.outcome).toBe("errored")
    expect(mockOpenAICreate).not.toHaveBeenCalled()
    expect(eventsNamed("engine.provider_fallback")).toEqual([])
    expect(eventsNamed("engine.provider_served")).toEqual([])
  })

  it("does not fall back on an error that is not the provider's fault", async () => {
    vi.useFakeTimers()
    setConfig([MINIMAX])
    mockAnthropicCreate.mockRejectedValue(httpError("400 invalid_request_error: messages: field required", 400))
    mockOpenAICreate.mockResolvedValue(openAIStream("should not be used"))

    const { result } = await runTurnWithTimers()
    expect(result.outcome).toBe("errored")
    expect(result.errorClassification).toBe("unknown")
    expect(mockOpenAICreate).not.toHaveBeenCalled()
  })

  it("starts on the backup while the primary cools down, and moves back by itself when it recovers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-15T12:00:00.000Z"))
    setConfig([MINIMAX])
    mockAnthropicCreate.mockRejectedValueOnce(CREDIT()).mockResolvedValue(anthropicStream("claude is back"))
    mockOpenAICreate.mockResolvedValue(openAIStream("backup"))

    await runTurn()
    expect(eventsNamed("engine.provider_served").at(-1).meta.provider).toBe("minimax")

    vi.setSystemTime(new Date("2026-11-15T13:00:01.000Z"))
    const later = await runTurn()
    expect(later.callbacks.text.join("")).toContain("claude is back")
    expect(eventsNamed("engine.provider_served").at(-1).meta).toEqual(expect.objectContaining({ provider: "anthropic", fallback: false }))
    expect(eventsNamed("engine.provider_fallback_recovered")).toHaveLength(1)
    expect(notices).toHaveLength(1)
  })

  it("uses the inner lane's chain for inner turns", async () => {
    setConfig([MINIMAX])
    mockAnthropicCreate.mockRejectedValue(CREDIT())
    mockOpenAICreate.mockResolvedValue(openAIStream("inner backup"))

    const { result } = await runTurn("inner")
    expect(result.outcome).not.toBe("errored")
    expect(mockAnthropicCreate.mock.calls[0][0].model).toBe("claude-sonnet-5-5")
    expect(eventsNamed("engine.provider_served").at(-1).meta).toEqual(expect.objectContaining({ lane: "inner", provider: "minimax" }))
  })
})
