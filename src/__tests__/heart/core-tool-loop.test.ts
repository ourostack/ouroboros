import { beforeEach, describe, expect, it, vi } from "vitest"

function defaultReadFileSync(filePath: any, _encoding?: any): string {
  const target = String(filePath)
  if (target.endsWith("SOUL.md")) return "mock soul"
  if (target.endsWith("IDENTITY.md")) return "mock identity"
  if (target.endsWith("LORE.md")) return "mock lore"
  if (target.endsWith("FRIENDS.md")) return "mock friends"
  if (target.endsWith("package.json")) return JSON.stringify({ name: "other" })
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

// Hard-mock the daemon socket client so this test never connects to the real
// /tmp/ouroboros-daemon.sock. Tests that don't mock this leak inner.wake commands
// for the literal "testagent" name into whatever real daemon happens to be running.
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
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
    maxTokens: 80000,
    contextMargin: 20,
  },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

const mockCreate = vi.fn()
const mockResponsesCreate = vi.fn()
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

const mockInjectNoteSearchContext = vi.fn().mockResolvedValue(undefined)
vi.mock("../../mind/note-search", () => ({
  injectNoteSearchContext: (...args: any[]) => mockInjectNoteSearchContext(...args),
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
    ...overrides,
  }
}

describe("runAgent tool loop guard", () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    mockCreate.mockReset()
    mockResponsesCreate.mockReset()
    await setupMinimax()
  })

  it("blocks repeated no-progress polling and lets the model recover with settle", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount += 1
      if (callCount <= 4) {
        return makeStream([
          makeChunk(undefined, [
            {
              index: 0,
              id: `call_${callCount}`,
              function: {
                name: "coding_status",
                arguments: '{"sessionId":"coding-001"}',
              },
            },
          ]),
        ])
      }

      return makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_final",
            function: {
              name: "settle",
              arguments: '{"answer":"using the current coding status"}',
            },
          },
        ]),
      ])
    })

    const { runAgent } = await import("../../heart/core")
    const execTool = vi.fn().mockResolvedValue("status: running")
    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "system", content: "test" }]

    const result = await runAgent(messages, callbacks, undefined, undefined, {
      toolChoiceRequired: true,
      execTool,
      toolContext: {
        signin: async () => undefined,
      },
    })

    expect(execTool).toHaveBeenCalledTimes(3)
    expect(execTool).toHaveBeenNthCalledWith(1, "coding_status", { sessionId: "coding-001" }, expect.anything())
    expect(result.completion).toEqual({
      answer: "using the current coding status",
      intent: "complete",
    })
    expect(callbacks.onTextChunk).toHaveBeenCalledWith("using the current coding status")

    const toolMessages = messages.filter((message: any) => message.role === "tool")
    const loopGuardMessage = toolMessages.find((message: any) =>
      typeof message.content === "string" && message.content.startsWith("loop guard:")
    )
    expect(loopGuardMessage?.content).toContain("stop polling")
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("coding_status", "sessionId=coding-001", false)
  })
})
