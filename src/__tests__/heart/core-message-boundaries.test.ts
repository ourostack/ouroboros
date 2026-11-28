import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs")
  return {
    ...actual,
    readFileSync: vi.fn((filePath: any, encoding?: any) => {
      const p = String(filePath)
      if (/(SOUL|IDENTITY|LORE|FRIENDS)\.md$/.test(p)) return "mock"
      if (p.endsWith("package.json")) return JSON.stringify({ name: "other" })
      return actual.readFileSync(filePath, encoding)
    }),
  }
})

vi.mock("../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
  return {
    ...actual,
    loadAgentConfig: vi.fn(() => ({
      name: "testagent",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      phrases: { thinking: ["thinking"], tool: ["working"], followup: ["following up"] },
    })),
    getAgentName: vi.fn(() => "testagent"),
    getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
    getRepoRoot: vi.fn(() => "/mock/repo"),
  }
})

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

vi.mock("../../mind/note-search", () => ({
  injectNoteSearchContext: vi.fn().mockResolvedValue(undefined),
}))

import type { ChannelCallbacks } from "../../heart/core"

// Slugger on iMessage, 2026-11-28: the model wrote a line to Ari, called a tool, then answered. The line and the answer
// reached Ari as one message with no space between them: "...as promised.Quarantine retry is the big one".
const NARRATION = "Pulling the actual error emails now, as promised."
const ANSWER = "Quarantine retry is the big one: three of the four errors are the same bounce."

function chunk(content?: string, toolCalls?: any[]) {
  const delta: any = {}
  if (content !== undefined) delta.content = content
  if (toolCalls !== undefined) delta.tool_calls = toolCalls
  return { choices: [{ delta }] }
}
function stream(...chunks: any[]) {
  return { [Symbol.asyncIterator]: async function* () { yield* chunks } }
}
function call(id: string, name: string, args: Record<string, unknown>) {
  return { index: 0, id, function: { name, arguments: JSON.stringify(args) } }
}
const narrateThenRead = () => stream(chunk(NARRATION), chunk(undefined, [call("read_1", "read_file", { path: "/tmp/errors" })]))
const settle = (answer: string) => stream(chunk(undefined, [call("settle_1", "settle", { answer, intent: "complete" })]))

async function blueBubbles() {
  const { createBlueBubblesCallbacks } = await import("../../senses/bluebubbles")
  const sendText = vi.fn(async (_request: { text: string }) => ({ messageGuid: "sent" }))
  const client = { sendText, setTyping: vi.fn(async () => {}), markChatRead: vi.fn(async () => {}), editMessage: vi.fn(async () => {}) }
  const replyTarget = { getReplyToMessageGuid: () => undefined, setSelection: () => "ok" }
  const callbacks = createBlueBubblesCallbacks(client as any, { chatGuid: "chat-1", participants: [] } as any, replyTarget as any, false, undefined, { enableActivitySignals: false })
  return { callbacks, finish: () => callbacks.flush(), sent: () => sendText.mock.calls.map(([request]) => request.text) }
}

async function teams() {
  const { createTeamsCallbacks } = await import("../../senses/teams")
  let shown = ""
  const teamsStream = { emit: vi.fn((activity: { text: string }) => { shown += activity.text }), update: vi.fn(), close: vi.fn() }
  const callbacks = createTeamsCallbacks(teamsStream as any, new AbortController(), undefined, { flushIntervalMs: 60_000 } as any)
  return { callbacks, finish: () => callbacks.flush(), sent: () => [shown] }
}

describe("a turn's messages never run together", () => {
  let runAgent: (messages: any[], callbacks: ChannelCallbacks, channel?: string, signal?: AbortSignal, options?: Record<string, unknown>) => Promise<unknown>

  beforeEach(async () => {
    vi.resetModules()
    mockCreate.mockReset()
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    runAgent = (await import("../../heart/core")).runAgent
  })

  const run = (callbacks: ChannelCallbacks, channel: string) => runAgent([{ role: "user", content: "what were those errors?" }], callbacks, channel, undefined, {
    execTool: vi.fn(async () => "four bounce emails"),
    toolContext: { signin: async () => undefined },
  })

  it("iMessage sends the answer alone: narration beside a tool call is not glued onto it", async () => {
    for (const answerTurn of [() => settle(ANSWER), () => stream(chunk(ANSWER))]) {
      mockCreate.mockReset()
      mockCreate.mockImplementationOnce(narrateThenRead).mockImplementationOnce(answerTurn)
      const sense = await blueBubbles()

      await run(sense.callbacks, "bluebubbles")
      await sense.finish()

      expect(sense.sent()).toEqual([ANSWER])
    }
  })

  it("Teams shows the narration and the answer as separate paragraphs", async () => {
    mockCreate.mockImplementationOnce(narrateThenRead).mockImplementationOnce(() => settle(ANSWER))
    const sense = await teams()

    await run(sense.callbacks, "teams")
    await sense.finish()

    expect(sense.sent()).toEqual([`${NARRATION}\n\n${ANSWER}`])
  })

  it("Teams starts each speak and the answer on a new paragraph, even after a tool step", async () => {
    mockCreate
      .mockImplementationOnce(narrateThenRead)
      .mockImplementationOnce(() => stream(chunk(undefined, [call("read_2", "read_file", { path: "/tmp/more" }), { ...call("speak_1", "speak", { message: "Found four." }), index: 1 }])))
      .mockImplementationOnce(() => stream(chunk(undefined, [call("speak_2", "speak", { message: "All bounces." })])))
      .mockImplementationOnce(() => settle(ANSWER))
    const sense = await teams()

    await run(sense.callbacks, "teams")
    await sense.finish()

    expect(sense.sent()).toEqual([`${NARRATION}\n\nFound four.\n\nAll bounces.\n\n${ANSWER}`])
  })
})
