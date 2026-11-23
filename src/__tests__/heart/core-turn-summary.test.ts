import { beforeEach, describe, expect, it, vi } from "vitest"

// engine.turn_summary through the real runAgent loop, with scripted provider replies.

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

const mockCreate = vi.fn()
vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: mockCreate } }
    responses = { create: vi.fn() }
    constructor(_opts?: any) {}
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: vi.fn() }
    constructor(_opts?: any) {}
  }
  return { default: MockAnthropic }
})

vi.mock("../../mind/note-search", () => ({
  injectNoteSearchContext: vi.fn().mockResolvedValue(undefined),
}))

import * as fs from "fs"
import * as identity from "../../heart/identity"
import type { ChannelCallbacks } from "../../heart/core"

const CANARY = "zebracanary7731"

function makeStream(chunks: any[]) {
  return { [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk } }
}

/** One scripted reply: a tool call, then a usage chunk, as the chat completions stream sends them. */
function call(name: string, args: Record<string, unknown>, id: string, usage = { prompt_tokens: 100, completion_tokens: 10 }) {
  return makeStream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] },
    { choices: [], usage },
  ])
}

function makeCallbacks(): ChannelCallbacks {
  return {
    onModelStart: vi.fn(), onModelStreamStart: vi.fn(), onTextChunk: vi.fn(), onReasoningChunk: vi.fn(),
    onToolStart: vi.fn(), onToolEnd: vi.fn(), onError: vi.fn(), onClearText: vi.fn(), flushNow: vi.fn(),
  }
}

const probeTool = {
  type: "function",
  function: {
    name: "probe",
    description: "test probe",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  },
}

describe("engine.turn_summary", () => {
  let runAgent: typeof import("../../heart/core").runAgent
  let MAX_PROVIDER_ITERATIONS: number
  let events: any[]
  let setRuntimeLogger: typeof import("../../nerves/runtime").setRuntimeLogger
  let createLogger: typeof import("../../nerves/index").createLogger

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    mockCreate.mockReset()
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
    } as any)
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    ;({ setRuntimeLogger } = await import("../../nerves/runtime"))
    ;({ createLogger } = await import("../../nerves/index"))
    events = []
    setRuntimeLogger(createLogger({ level: "debug", sinks: [(entry) => events.push(entry)] }))
    const core = await import("../../heart/core")
    runAgent = core.runAgent
    MAX_PROVIDER_ITERATIONS = core.MAX_PROVIDER_ITERATIONS
  })

  const summaries = () => events.filter((entry) => entry.event === "engine.turn_summary")
  const summary = () => {
    expect(summaries()).toHaveLength(1)
    return summaries()[0].meta
  }
  const withProbe = (execTool: any, signal?: AbortSignal, content = "keep probing") =>
    runAgent([{ role: "user", content }], makeCallbacks(), "cli", signal, {
      tools: [probeTool] as any, execTool, toolContext: { signin: async () => undefined },
    })
  const withCatalog = (content: string) =>
    runAgent([{ role: "user", content }], makeCallbacks(), "cli", undefined, { toolContext: { signin: async () => undefined } })

  it("counts a settled turn: steps, tools and tokens summed over every call", async () => {
    mockCreate.mockReturnValueOnce(call("probe", { value: "a" }, "p1", { prompt_tokens: 1000, completion_tokens: 20 }))
    mockCreate.mockReturnValueOnce(call("settle", { answer: "done", intent: "complete" }, "s1", { prompt_tokens: 1200, completion_tokens: 30 }))
    const result = await withProbe(vi.fn().mockResolvedValue("ok"))
    expect(result.outcome).toBe("settled")
    const meta = summary()
    expect(meta).toMatchObject({
      channel: "cli", outcome: "settled", steps: 2, stepBudgetExhausted: 0, toolErrors: 0, unknownToolCalls: 0,
      findToolsCalls: 0, inputTokens: 2200, outputTokens: 50,
    })
    expect(meta.toolCalls).toEqual({ probe: 1, settle: 1 })
  })

  it("counts a step-budget stop", async () => {
    for (let i = 1; i <= MAX_PROVIDER_ITERATIONS; i++) mockCreate.mockReturnValueOnce(call("probe", { value: "same" }, `p${i}`))
    mockCreate.mockReturnValueOnce(call("settle", { answer: "report", intent: "complete" }, "s1"))
    const result = await withProbe(vi.fn().mockResolvedValue("ok"))
    expect(result.outcome).toBe("settled")
    const meta = summary()
    expect(meta.stepBudgetExhausted).toBe(1)
    expect(meta.steps).toBe(MAX_PROVIDER_ITERATIONS + 1)
  })

  it("counts tool errors", async () => {
    mockCreate.mockReturnValueOnce(call("probe", { value: "a" }, "p1"))
    mockCreate.mockReturnValueOnce(call("settle", { answer: "it failed", intent: "complete" }, "s1"))
    await withProbe(vi.fn().mockRejectedValue(new Error("boom")))
    expect(summary().toolErrors).toBe(1)
  })

  it("counts a find_tools call that loaded nothing", async () => {
    mockCreate.mockReturnValueOnce(call("find_tools", { query: "qqqxxyy zzvvkk" }, "f1"))
    mockCreate.mockReturnValueOnce(call("settle", { answer: "none", intent: "complete" }, "s1"))
    await withCatalog("find something")
    const meta = summary()
    expect(meta).toMatchObject({ findToolsCalls: 1, findToolsLoaded: 0, loadedThenCalled: 0 })
    expect(meta.deferredDoors).toBeGreaterThan(0)
    expect(meta.eagerDoors).toBeGreaterThan(0)
    expect(meta.toolCalls.find_tools).toBeUndefined()
  })

  it("counts a find_tools call that loaded a door, and the loaded door's call", async () => {
    mockCreate.mockReturnValueOnce(call("find_tools", { query: "select:coding_status" }, "f1"))
    mockCreate.mockReturnValueOnce(call("coding_status", {}, "c1"))
    mockCreate.mockReturnValueOnce(call("settle", { answer: "ok", intent: "complete" }, "s1"))
    await withCatalog("status?")
    const meta = summary()
    expect(meta).toMatchObject({ findToolsCalls: 1, findToolsLoaded: 1, loadedThenCalled: 1 })
    expect(meta.toolCalls.coding_status).toBe(1)
    // The same menu as a turn that loaded nothing: a loaded door isn't counted as offered up front.
    mockCreate.mockReturnValueOnce(call("settle", { answer: "ok", intent: "complete" }, "s2"))
    await withCatalog("status?")
    const [loaded, plain] = summaries().map((entry) => entry.meta)
    expect({ eager: loaded.eagerDoors, deferred: loaded.deferredDoors }).toEqual({ eager: plain.eagerDoors, deferred: plain.deferredDoors })
  })

  it("counts a made-up tool name as unknown and never repeats it", async () => {
    mockCreate.mockReturnValueOnce(call(`tell_${CANARY}`, { value: "a" }, "u1"))
    mockCreate.mockReturnValueOnce(call("settle", { answer: "done", intent: "complete" }, "s1"))
    await withProbe(vi.fn().mockResolvedValue("ok"))
    const meta = summary()
    expect(meta.unknownToolCalls).toBe(1)
    expect(meta.toolCalls.unknown).toBe(1)
    expect(JSON.stringify(summaries())).not.toContain(CANARY)
  })

  it("counts an aborted turn", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await withProbe(vi.fn(), controller.signal)
    expect(result.outcome).toBe("aborted")
    expect(summary()).toMatchObject({ outcome: "aborted", steps: 0 })
  })

  it("counts a turn that ended errored (the progress report after the step budget didn't settle)", async () => {
    for (let i = 1; i <= MAX_PROVIDER_ITERATIONS + 1; i++) mockCreate.mockReturnValueOnce(call("probe", { value: "same" }, `p${i}`))
    const result = await withProbe(vi.fn().mockResolvedValue("ok"))
    expect(result.outcome).toBe("errored")
    expect(summary()).toMatchObject({ outcome: "errored", errorClass: "unknown", stepBudgetExhausted: 1, steps: MAX_PROVIDER_ITERATIONS + 1 })
  })

  it("counts a turn that ended on a provider error, with the error's class", async () => {
    vi.useFakeTimers()
    try {
      mockCreate.mockRejectedValue(Object.assign(new Error("401 invalid api key"), { status: 401 }))
      const promise = withProbe(vi.fn())
      for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(2100)
      const result = await promise
      expect(result.outcome).toBe("errored")
      expect(summary()).toMatchObject({ outcome: "errored", errorClass: result.errorClassification, steps: 0, provider: "minimax" })
      expect(result.errorClassification).toBe("auth-failure")
    } finally {
      vi.useRealTimers()
    }
  })

  it("counts a turn that ended by throwing", async () => {
    await expect(runAgent([{ role: "user", content: "go" }], makeCallbacks(), "cli", undefined, {
      tools: [probeTool] as any, execTool: vi.fn(), toolContext: { signin: async () => undefined },
      requiredToolCalls: { names: ["never_offered"], retryMessage: "call it" },
    })).rejects.toThrow("required tool is not advertised")
    expect(summary()).toMatchObject({ outcome: "errored", errorClass: "unknown", steps: 0 })
  })

  it("never carries the turn's content (content canary)", async () => {
    const words = `please read the ${CANARY} ledger and tell me what the ${CANARY} entry says about tomorrow`
    mockCreate.mockReturnValueOnce(call("probe", { value: `${CANARY}/notes-${CANARY}.md ${words}` }, "p1"))
    mockCreate.mockReturnValueOnce(call("settle", { answer: `the ${CANARY} entry says ${words}`, intent: "complete" }, "s1"))
    await withProbe(vi.fn().mockResolvedValue(`file ${CANARY}.md: ${words}`), undefined, words)
    const serialized = JSON.stringify(summaries())
    expect(serialized).not.toContain(CANARY)
    const fixture = words.split(" ")
    for (let i = 0; i + 8 <= fixture.length; i++) expect(serialized).not.toContain(fixture.slice(i, i + 8).join(" "))
  })

  it("never carries a find_tools query (content canary, default menu)", async () => {
    mockCreate.mockReturnValueOnce(call("find_tools", { query: `look up ${CANARY} for me` }, "f1"))
    mockCreate.mockReturnValueOnce(call("settle", { answer: `nothing on ${CANARY}`, intent: "complete" }, "s1"))
    await withCatalog(`what is ${CANARY}?`)
    expect(summary().findToolsCalls).toBe(1)
    expect(JSON.stringify(summaries())).not.toContain(CANARY)
  })

  it("holds only numbers and values from fixed lists (schema)", async () => {
    const { TURN_SUMMARY_CHANNELS, TURN_SUMMARY_ERROR_CLASSES, TURN_SUMMARY_OUTCOMES } = await import("../../heart/turn-summary")
    mockCreate.mockReturnValueOnce(call("probe", { value: "a" }, "p1"))
    mockCreate.mockReturnValueOnce(call("settle", { answer: "done", intent: "complete" }, "s1"))
    await withProbe(vi.fn().mockResolvedValue("ok"))
    const meta = summary()
    const strings = ["channel", "outcome", "errorClass", "provider", "model"]
    expect(Object.keys(meta).sort()).toEqual([
      "channel", "deferredDoors", "eagerDoors", "errorClass", "findToolsCalls", "findToolsLoaded", "inputTokens", "loadedThenCalled", "model",
      "outcome", "outputTokens", "provider", "providerSwitches", "reasoningTokens", "stepBudgetExhausted", "steps", "toolCalls", "toolErrors",
      "unknownToolCalls",
    ])
    for (const [key, value] of Object.entries(meta)) {
      if (key === "toolCalls") continue
      if (strings.includes(key)) expect(typeof value).toBe("string")
      else expect(Number.isInteger(value) && (value as number) >= 0).toBe(true)
    }
    expect(TURN_SUMMARY_CHANNELS).toContain(meta.channel)
    expect(TURN_SUMMARY_OUTCOMES).toContain(meta.outcome)
    expect(TURN_SUMMARY_ERROR_CLASSES).toContain(meta.errorClass)
    expect(meta.provider).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/)
    expect(meta.model).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/)
    for (const [name, count] of Object.entries(meta.toolCalls)) {
      expect(["probe", "settle"]).toContain(name)
      expect(Number.isInteger(count)).toBe(true)
    }
  })

  it("never breaks the turn when the summary can't be logged", async () => {
    // Sinks are already guarded by the fanout, so the logger itself throws, as a broken logger would.
    const inner = createLogger({ level: "debug", sinks: [(entry) => events.push(entry)] })
    const guard = (level: "debug" | "info" | "warn" | "error") => (entry: any) => {
      if (entry.event === "engine.turn_summary") throw new Error("disk full")
      inner[level](entry)
    }
    setRuntimeLogger({ ...inner, debug: guard("debug"), info: guard("info"), warn: guard("warn"), error: guard("error") })
    mockCreate.mockReturnValueOnce(call("settle", { answer: "done", intent: "complete" }, "s1"))
    const result = await withProbe(vi.fn())
    expect(result.outcome).toBe("settled")
    expect(summaries()).toHaveLength(0)
    expect(events.some((entry) => entry.event === "engine.turn_end")).toBe(true)
  })
})
