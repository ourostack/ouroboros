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
const mockResponsesCreate = vi.fn()
vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: mockCreate } }
    responses = { create: mockResponsesCreate }
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

describe("speak end-to-end (Unit 10)", () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    mockCreate.mockReset()
    await setupMinimax()
  })

  it("speak -> read_file -> settle: full sequence with onTextChunk, flushNow, onToolStart in order", async () => {
    // Iter 1: speak
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [
        { index: 0, id: "call_speak_e2e", function: { name: "speak", arguments: JSON.stringify({ message: "got it, kicking off" }) } },
      ]),
    ]))
    // Iter 2: read_file
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [
        { index: 0, id: "call_read_e2e", function: { name: "read_file", arguments: JSON.stringify({ path: "/tmp/x" }) } },
      ]),
    ]))
    // Iter 3: settle
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [
        { index: 0, id: "call_settle_e2e", function: { name: "settle", arguments: JSON.stringify({ answer: "done", intent: "complete" }) } },
      ]),
    ]))

    type Event =
      | { kind: "text"; text: string }
      | { kind: "flush" }
      | { kind: "toolStart"; name: string }
    const events: Event[] = []
    const callbacks: ChannelCallbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk: (text: string) => { events.push({ kind: "text", text }) },
      onReasoningChunk: vi.fn(),
      onToolStart: (name: string, _args: Record<string, string>) => { events.push({ kind: "toolStart", name }) },
      onToolEnd: vi.fn(),
      onError: vi.fn(),
      onClearText: vi.fn(),
      flushNow: () => { events.push({ kind: "flush" }) },
    }

    const execTool = vi.fn().mockResolvedValue("file contents")
    const messages: any[] = [{ role: "user", content: "do a thing" }]
    const { runAgent } = await import("../../heart/core")
    const result = await runAgent(messages, callbacks, "cli", undefined, {
      execTool,
      toolContext: { signin: async () => undefined },
    })

    expect(result.outcome).toBe("settled")

    // Verify ordered sub-sequence: text "got it, kicking off" → flush → onToolStart "read_file" → text "done"
    const textKickoffIdx = events.findIndex((e) => e.kind === "text" && e.text === "got it, kicking off")
    const firstFlushIdx = events.findIndex((e) => e.kind === "flush")
    const readFileStartIdx = events.findIndex((e) => e.kind === "toolStart" && e.name === "read_file")
    const textDoneIdx = events.findIndex((e) => e.kind === "text" && e.text === "done")

    expect(textKickoffIdx).toBeGreaterThanOrEqual(0)
    expect(firstFlushIdx).toBeGreaterThan(textKickoffIdx)
    expect(readFileStartIdx).toBeGreaterThan(firstFlushIdx)
    expect(textDoneIdx).toBeGreaterThan(readFileStartIdx)

    // Verify messages array contains assistant tool_calls in order: speak, read_file, settle
    const assistantToolNames = messages
      .filter((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls))
      .map((m: any) => m.tool_calls[0]?.function?.name)
    expect(assistantToolNames).toEqual(["speak", "read_file", "settle"])
  })
})
