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
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
  })),
  DEFAULT_AGENT_CONTEXT: {
    maxTokens: 80_000,
    contextMargin: 20,
  },
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

const mockCreate = vi.fn()
const mockResponsesCreate = vi.fn()
vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: mockCreate } }
    responses = { create: mockResponsesCreate }
    constructor(_opts?: any) {}
  }
  return {
    default: MockOpenAI,
    AzureOpenAI: MockOpenAI,
  }
})

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: vi.fn() }
    constructor(_opts?: any) {}
  }
  return { default: MockAnthropic }
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

import * as fs from "fs"
import * as identity from "../../heart/identity"
import type { ChannelCallbacks, RunAgentOutcome } from "../../heart/core"

async function setupMinimax() {
  vi.mocked(identity.loadAgentConfig).mockReturnValue({
    name: "testagent",
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
  })
  const config = await import("../../heart/config")
  config.resetConfigCache()
  config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
}

function makeStream(chunks: any[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeChunk(content?: string, toolCalls?: any[]) {
  const delta: any = {}
  if (content !== undefined) delta.content = content
  if (toolCalls !== undefined) delta.tool_calls = toolCalls
  return { choices: [{ delta }] }
}

function makeCallbacks(overrides: Partial<ChannelCallbacks> = {}): ChannelCallbacks {
  return {
    onModelStart: vi.fn(),
    onModelStreamStart: vi.fn(),
    onTextChunk: vi.fn(),
    onReasoningChunk: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onError: vi.fn(),
    onClearText: vi.fn(),
    flushNow: vi.fn(),
    ...overrides,
  }
}

function speakChunk(message: string, callId = "call_speak_1") {
  return [
    makeChunk(undefined, [{ index: 0, id: callId, function: { name: "speak", arguments: JSON.stringify({ message }) } }]),
  ]
}

function speakChunkRaw(rawArgs: string, callId = "call_speak_raw") {
  return [
    makeChunk(undefined, [{ index: 0, id: callId, function: { name: "speak", arguments: rawArgs } }]),
  ]
}

function settleChunks(answer: string, callId = "call_settle_1") {
  return [
    makeChunk(undefined, [{ index: 0, id: callId, function: { name: "settle", arguments: JSON.stringify({ answer, intent: "complete" }) } }]),
  ]
}

describe("speak interception in runAgent", () => {
  let runAgent: (
    messages: any[],
    callbacks: ChannelCallbacks,
    channel?: string,
    signal?: AbortSignal,
    options?: Record<string, unknown>,
  ) => Promise<{ usage?: any; outcome: RunAgentOutcome; completion?: any }>

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    mockCreate.mockReset()
    mockEmitNervesEvent.mockReset()
    await setupMinimax()
    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  it("happy path: sole speak then settle — emits text, flushes, persists, settles", async () => {
    mockCreate.mockReturnValueOnce(makeStream(speakChunk("got it, kicking off")))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "user", content: "do a thing" }]
    const result = await runAgent(messages, callbacks, "cli", undefined, {
      toolContext: { signin: async () => undefined },
    })

    expect(result.outcome).toBe("settled")

    // onTextChunk: speak first, then settle answer
    const textChunkCalls = (callbacks.onTextChunk as any).mock.calls.map((c: any[]) => c[0])
    expect(textChunkCalls[0]).toBe("got it, kicking off")
    expect(textChunkCalls).toContain("done")

    // flushNow called exactly once (after the speak)
    expect(callbacks.flushNow).toHaveBeenCalledTimes(1)

    // Assistant tool_call for speak persisted
    const assistantSpeak = messages.find((m: any) =>
      m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls[0]?.function?.name === "speak"
    )
    expect(assistantSpeak).toBeDefined()
    // Tool result "(spoken)" pushed
    const toolResultSpoken = messages.find((m: any) => m.role === "tool" && m.content === "(spoken)")
    expect(toolResultSpoken).toBeDefined()
    // Then settle assistant message
    const assistantSettle = messages.find((m: any) =>
      m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls[0]?.function?.name === "settle"
    )
    expect(assistantSettle).toBeDefined()
  })

  it("interleave: speak + read_file in same response — both run, turn continues", async () => {
    // Iter 1: speak + read_file
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [
        { index: 0, id: "call_speak_il", function: { name: "speak", arguments: JSON.stringify({ message: "hi" }) } },
        { index: 1, id: "call_read_il", function: { name: "read_file", arguments: JSON.stringify({ path: "/tmp/x" }) } },
      ]),
    ]))
    // Iter 2: settle to terminate
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const execTool = vi.fn().mockResolvedValue("file contents")
    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "user", content: "do a thing" }]
    const result = await runAgent(messages, callbacks, "cli", undefined, {
      execTool,
      toolContext: { signin: async () => undefined },
    })

    expect(result.outcome).toBe("settled")
    expect(callbacks.onTextChunk).toHaveBeenCalledWith("hi")
    expect(callbacks.flushNow).toHaveBeenCalledTimes(1)
    expect(execTool).toHaveBeenCalledWith("read_file", { path: "/tmp/x" }, expect.anything())
  })

  it("speak + settle in same response: settle rejected, speak runs, follow-up settle terminates", async () => {
    // Iter 1: speak + settle (settle rejected by sole-call enforcement)
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [
        { index: 0, id: "call_speak_se", function: { name: "speak", arguments: JSON.stringify({ message: "hi" }) } },
        { index: 1, id: "call_settle_se", function: { name: "settle", arguments: JSON.stringify({ answer: "done", intent: "complete" }) } },
      ]),
    ]))
    // Iter 2: sole settle that goes through
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done", "call_settle_2")))

    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "user", content: "do a thing" }]
    const result = await runAgent(messages, callbacks, "cli", undefined, {
      toolContext: { signin: async () => undefined },
    })

    expect(result.outcome).toBe("settled")
    // speak ran (text emitted + flushed + (spoken) tool result)
    expect(callbacks.onTextChunk).toHaveBeenCalledWith("hi")
    expect(callbacks.flushNow).toHaveBeenCalledTimes(1)
    // settle was rejected with the SOLE_CALL_REJECTION message
    const rejection = messages.find((m: any) =>
      m.role === "tool" && typeof m.content === "string" && m.content.startsWith("rejected: settle must be the only tool call")
    )
    expect(rejection).toBeDefined()
  })

  it("empty message: no onTextChunk, no flushNow, error result, nerves engine.speak_invalid", async () => {
    mockCreate.mockReturnValueOnce(makeStream(speakChunk("")))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "user", content: "x" }]
    await runAgent(messages, callbacks, "cli", undefined, {
      toolContext: { signin: async () => undefined },
    })

    // The first onTextChunk is the settle answer "done", not an empty speak text
    const speakTextCalls = (callbacks.onTextChunk as any).mock.calls.filter((c: any[]) => c[0] === "")
    expect(speakTextCalls).toHaveLength(0)
    expect(callbacks.flushNow).not.toHaveBeenCalled()

    const errMsg = messages.find((m: any) =>
      m.role === "tool" && m.content === "speak requires a non-empty `message` string."
    )
    expect(errMsg).toBeDefined()
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "engine.speak_invalid",
      component: "engine",
    }))
  })

  it("missing message: no onTextChunk, no flushNow, error result", async () => {
    mockCreate.mockReturnValueOnce(makeStream(speakChunkRaw("{}")))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "user", content: "x" }]
    await runAgent(messages, callbacks, "cli", undefined, {
      toolContext: { signin: async () => undefined },
    })

    expect(callbacks.flushNow).not.toHaveBeenCalled()
    const errMsg = messages.find((m: any) =>
      m.role === "tool" && m.content === "speak requires a non-empty `message` string."
    )
    expect(errMsg).toBeDefined()
  })

  it("malformed JSON args: no onTextChunk, no flushNow, error result", async () => {
    mockCreate.mockReturnValueOnce(makeStream(speakChunkRaw("not-json")))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "user", content: "x" }]
    await runAgent(messages, callbacks, "cli", undefined, {
      toolContext: { signin: async () => undefined },
    })

    expect(callbacks.flushNow).not.toHaveBeenCalled()
    const errMsg = messages.find((m: any) =>
      m.role === "tool" && m.content === "speak requires a non-empty `message` string."
    )
    expect(errMsg).toBeDefined()
  })

  it("flushNow undefined: no error thrown; onTextChunk still called; (spoken) result still pushed", async () => {
    mockCreate.mockReturnValueOnce(makeStream(speakChunk("hi")))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    // Build callbacks WITHOUT a flushNow field
    const base = makeCallbacks()
    const { flushNow: _drop, ...withoutFlushNow } = base as any
    const callbacks = withoutFlushNow as ChannelCallbacks

    const messages: any[] = [{ role: "user", content: "x" }]
    const result = await runAgent(messages, callbacks, "cli", undefined, {
      toolContext: { signin: async () => undefined },
    })

    expect(result.outcome).toBe("settled")
    expect(callbacks.onTextChunk).toHaveBeenCalledWith("hi")
    const spoken = messages.find((m: any) => m.role === "tool" && m.content === "(spoken)")
    expect(spoken).toBeDefined()
  })

  it("delivery failure: flushNow throws → onToolEnd(success=false), error tool result, engine.speak_delivery_failed event, turn continues", async () => {
    mockCreate.mockReturnValueOnce(makeStream(speakChunk("got it")))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const flushNowError = new Error("teams delivery failed: stream dead and sendMessage failed")
    const callbacks = makeCallbacks({
      flushNow: vi.fn(async () => { throw flushNowError }),
    })
    const messages: any[] = [{ role: "user", content: "x" }]
    const result = await runAgent(messages, callbacks, "cli", undefined, {
      toolContext: { signin: async () => undefined },
    })

    // Turn does NOT crash; settle still completes after speak failure
    expect(result.outcome).toBe("settled")

    // onToolEnd called with success=false for speak
    const onToolEndCalls = (callbacks.onToolEnd as any).mock.calls
    const speakEnd = onToolEndCalls.find((c: any[]) => c[0] === "speak")
    expect(speakEnd).toBeDefined()
    expect(speakEnd[2]).toBe(false)

    // Error tool result pushed (NOT "(spoken)")
    const errMsg = messages.find((m: any) =>
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.includes("speak delivery failed") &&
      m.content.includes("did not reach your friend")
    )
    expect(errMsg).toBeDefined()
    // (spoken) was NOT pushed for the failed speak call
    const spokenForFailed = messages.find((m: any) =>
      m.role === "tool" && m.content === "(spoken)" && m.tool_call_id === "call_speak_1"
    )
    expect(spokenForFailed).toBeUndefined()

    // Nerves event fired
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "engine.speak_delivery_failed",
      component: "engine",
      level: "error",
    }))
  })

  it("delivery failure: flushNow throws a NON-Error value (string) → engine wraps it in Error and reports failure", async () => {
    mockCreate.mockReturnValueOnce(makeStream(speakChunk("got it")))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks({
      // Throwing a non-Error (e.g. a string) — the engine must coerce it to Error.
      flushNow: vi.fn(async () => { throw "boom-not-an-error" }),
    })
    const messages: any[] = [{ role: "user", content: "x" }]
    const result = await runAgent(messages, callbacks, "cli", undefined, {
      toolContext: { signin: async () => undefined },
    })

    expect(result.outcome).toBe("settled")
    const errMsg = messages.find((m: any) =>
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.includes("speak delivery failed: boom-not-an-error")
    )
    expect(errMsg).toBeDefined()
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "engine.speak_delivery_failed",
    }))
  })

  it("emits engine.speak nerves event on success with messageLength meta", async () => {
    mockCreate.mockReturnValueOnce(makeStream(speakChunk("hello")))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "user", content: "x" }]
    await runAgent(messages, callbacks, "cli", undefined, {
      toolContext: { signin: async () => undefined },
    })

    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "engine.speak",
      component: "engine",
      meta: expect.objectContaining({ messageLength: 5 }),
    }))
  })
})
