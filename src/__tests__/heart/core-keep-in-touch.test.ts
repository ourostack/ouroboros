import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

type Visible = { at: number; text: string }
type WorkRun = { at: number; name: string; quietMs: number }

// Slugger, 2026-11-27: Ari asked over iMessage whether Slugger needed more to get his Imbox to zero. Slugger read it,
// spent about 3.5 minutes setting up a lane (worktree, brief, waiting on the terminal) and said nothing until the end.
// This replays that turn's shape on synthetic data: a slow first model call on a big context, then shell work.
const ASK = "i also still have loads of emails in my imbox, do you need more to get me to imbox 0?"
const ACK = "Nope, your calls so far are plenty. I'm handing the rest to a lane that goes through your Imbox sender by sender; I'll tell you once it's moving."
const PROGRESS = "Lane's up and through the first 300 threads: marketing screened out, receipts in Paper Trail. Working on the newsletters next."

function call(id: string, name: string, args: Record<string, unknown>) {
  return { index: 0, id, function: { name, arguments: JSON.stringify(args) } }
}
function batch(...calls: any[]) {
  return makeStream([makeChunk(undefined, calls.map((entry, index) => ({ ...entry, index })))])
}

describe("nobody is left on read (keep in touch)", () => {
  let runAgent: (messages: any[], callbacks: ChannelCallbacks, channel?: string, signal?: AbortSignal, options?: Record<string, unknown>) => Promise<{ outcome: RunAgentOutcome }>
  let start: number

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers({ toFake: ["Date"] })
    start = Date.parse("2026-11-27T19:39:42.000Z")
    vi.setSystemTime(start)
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    mockCreate.mockReset()
    mockEmitNervesEvent.mockReset()
    await setupMinimax()
    runAgent = (await import("../../heart/core")).runAgent
  })
  afterEach(() => { vi.useRealTimers() })

  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

  function harness(options: { context?: Record<string, unknown>; flushNow?: () => Promise<void>; toolMs?: number } = {}) {
    const visible: Visible[] = []
    const work: WorkRun[] = []
    let pending = ""
    let lastVisibleAt = start
    const callbacks = makeCallbacks({
      onTextChunk: vi.fn((text: string) => { pending += text }),
      onClearText: vi.fn(() => { pending = "" }),
      flushNow: vi.fn(options.flushNow ?? (async () => {
        visible.push({ at: Date.now() - start, text: pending })
        lastVisibleAt = Date.now()
        pending = ""
      })),
    })
    // A tool that takes real time, like Slugger's `sleep 30` while waiting on the lane's terminal.
    const execTool = vi.fn(async (name: string) => {
      work.push({ at: Date.now() - start, name, quietMs: Date.now() - lastVisibleAt })
      advance(options.toolMs ?? 40_000)
      return "ok"
    })
    const run = (channel = "bluebubbles") => runAgent([{ role: "user", content: ASK }], callbacks, channel, undefined, {
      execTool, toolContext: { signin: async () => undefined, ...(options.context ? { context: options.context } : {}) },
    })
    return { visible, work, run, callbacks }
  }

  /** A model that does the work as Slugger did, and speaks only when the engine holds it. */
  function sluggerModel() {
    let step = 0
    mockCreate.mockImplementation((request: any) => {
      const last = JSON.stringify(request.messages.at(-1))
      advance(step === 0 ? 40_000 : 8_000)
      step += 1
      if (last.includes("speak-first") && last.includes("nothing from you")) {
        return batch(call(`speak_${step}`, "speak", { message: ACK }), call(`shell_${step}`, "read_file", { path: "/tmp/brief.txt" }))
      }
      if (last.includes("speak-first")) {
        return batch(call(`speak_${step}`, "speak", { message: PROGRESS }), call(`shell_${step}`, "read_file", { path: `/tmp/lane-${step}.txt` }))
      }
      if (step > 16) return batch(call(`settle_${step}`, "settle", { answer: "All done: Imbox is at zero.", intent: "complete" }))
      return batch(call(`shell_${step}`, "read_file", { path: `/tmp/lane-${step}.txt` }))
    })
  }

  it("before any work runs past the 15-second bound, the agent has acked in its own words", async () => {
    sluggerModel()
    const { visible, work, run } = harness()

    expect((await run()).outcome).toBe("settled")

    // The ack is the agent's own text, sent before the first work call, at the first step boundary after the bound.
    expect(visible[0]).toEqual({ at: 48_000, text: ACK })
    expect(work[0]!.at).toBeGreaterThanOrEqual(visible[0]!.at)
    // No work ever ran once the person had waited past the bound with nothing said, and none waited past the update interval.
    for (const entry of work) expect(entry.quietMs, `${entry.name} at ${entry.at}ms`).toBeLessThan(5 * 60_000)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "engine.keep_in_touch_held", meta: { channel: "bluebubbles", kind: "ack", quietMs: 40_000 } }))
  })

  it("keeps the person posted at the long interval, and never per tool call", async () => {
    sluggerModel()
    const { visible, run } = harness()

    await run()

    const progress = visible.filter((entry) => entry.text === PROGRESS)
    expect(progress.length).toBeGreaterThanOrEqual(1)
    // A dozen tool calls over about 12 minutes of work sent an ack and a progress note or two: no spam.
    expect(visible.length).toBeLessThanOrEqual(3)
    for (let index = 1; index < visible.length; index++) expect(visible[index]!.at - visible[index - 1]!.at).toBeGreaterThanOrEqual(5 * 60_000)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "engine.keep_in_touch_held", meta: expect.objectContaining({ kind: "update" }) }))
    const held = mockCreate.mock.calls.map((entry: any[]) => JSON.stringify(entry[0].messages.at(-1))).find((text: string) => text.includes("min ago"))
    expect(held).toContain("speak first with real progress in your own voice")
  })

  it("leaves a quick turn alone: it works and answers without an ack", async () => {
    mockCreate.mockImplementationOnce(() => { advance(3_000); return batch(call("read_1", "read_file", { path: "/tmp/imbox-count" })) })
    mockCreate.mockImplementationOnce(() => { advance(3_000); return batch(call("settle_1", "settle", { answer: "Nope, 12 left and they're all yours to answer.", intent: "complete" })) })
    const { visible, work, run } = harness({ toolMs: 2_000 })

    expect((await run()).outcome).toBe("settled")

    expect(work).toHaveLength(1)
    expect(mockCreate).toHaveBeenCalledTimes(2)
    expect(visible).toEqual([])
  })

  it("sends only the speak's words on iMessage, never the model's unsent narration from a held batch", async () => {
    mockCreate.mockImplementationOnce(() => { advance(20_000); return makeStream([makeChunk("Let me check your inbox."), makeChunk(undefined, [call("read_1", "read_file", { path: "/tmp/a" })])]) })
    mockCreate.mockImplementationOnce(() => { advance(5_000); return batch(call("speak_2", "speak", { message: ACK }), call("read_2", "read_file", { path: "/tmp/b" })) })
    mockCreate.mockImplementationOnce(() => { advance(5_000); return batch(call("settle_3", "settle", { answer: "Done.", intent: "complete" })) })
    const { visible, callbacks, run } = harness()

    await run()

    expect(visible[0]).toEqual({ at: 25_000, text: ACK })
    expect(callbacks.onClearText).toHaveBeenCalled()
  })

  it("leaves streamed text alone on channels that stream it live", async () => {
    mockCreate.mockImplementationOnce(() => batch(call("speak_1", "speak", { message: ACK })))
    mockCreate.mockImplementationOnce(() => batch(call("settle_2", "settle", { answer: "Done.", intent: "complete" })))
    const { callbacks, run } = harness()

    await run("teams")

    // Only the settle's own stream clears text here, after the speak went out.
    const speakAt = vi.mocked(callbacks.onTextChunk).mock.invocationCallOrder[0]!
    for (const at of vi.mocked(callbacks.onClearText!).mock.invocationCallOrder) expect(at).toBeGreaterThan(speakAt)
  })

  it("stays out of group chats, where staying quiet can be the right reply", async () => {
    sluggerModel()
    const { visible, run } = harness({ context: { isGroupChat: true } })

    await run()

    expect(visible).toEqual([])
    expect(mockEmitNervesEvent).not.toHaveBeenCalledWith(expect.objectContaining({ event: "engine.keep_in_touch_held" }))
  })

  it("stops holding work once a speak can't reach the person", async () => {
    sluggerModel()
    const { work, run } = harness({ flushNow: async () => { throw new Error("BlueBubbles unreachable") } })

    expect((await run()).outcome).toBe("settled")

    expect(work.length).toBeGreaterThan(5)
    expect(mockEmitNervesEvent.mock.calls.filter(([event]: any[]) => event.event === "engine.keep_in_touch_held")).toHaveLength(1)
  })
})
