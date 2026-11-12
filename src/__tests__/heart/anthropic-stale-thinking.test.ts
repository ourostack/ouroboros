import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}))
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))
vi.mock("child_process", () => ({ execSync: vi.fn(), spawnSync: vi.fn() }))
vi.mock("../../repertoire/skills", () => ({ listSkills: vi.fn(), loadSkill: vi.fn() }))
vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "anthropic",
    humanFacing: { provider: "anthropic", model: "claude-opus-5-5" },
    agentFacing: { provider: "anthropic", model: "claude-opus-5-5" },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

const sent: Array<Array<Record<string, any>>> = []
const create = vi.fn()
vi.mock("openai", () => {
  class MockOpenAI { chat = { completions: { create: vi.fn() } }; responses = { create: vi.fn() }; constructor() {} }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic { messages = { create }; constructor() {} }
  return { default: MockAnthropic }
})

const answer = {
  [Symbol.asyncIterator]: async function* () {
    yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }
    yield { type: "content_block_stop", index: 0 }
    yield { type: "message_delta", usage: { input_tokens: 10, output_tokens: 5 } }
  },
}
const STALE = "400 messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."

const history = [
  { role: "user", content: "find the film" },
  {
    role: "assistant", content: "on it",
    _thinking_blocks: [{ type: "thinking", thinking: "check the queue", signature: "sig" }, { type: "redacted_thinking", data: "x" }],
  },
  { role: "user", content: "and the show?" },
]

async function turn() {
  const config = await import("../../heart/config")
  config.resetConfigCache()
  config.patchRuntimeConfig({ providers: { anthropic: { setupToken: `sk-ant-oat01-${"a".repeat(80)}` } } })
  const { createAnthropicProviderRuntime } = await import("../../heart/providers/anthropic")
  const noop = () => {}
  return createAnthropicProviderRuntime("claude-opus-5-5").streamTurn({
    messages: history as any,
    activeTools: [],
    callbacks: { onModelStart: noop, onModelStreamStart: noop, onTextChunk: noop, onReasoningChunk: noop, onToolStart: noop, onToolEnd: noop, onError: noop },
  })
}

describe("a replayed thinking block the API refuses as bound to another conversation", () => {
  beforeEach(() => {
    vi.resetModules()
    sent.length = 0
    create.mockReset()
  })

  it("is dropped and the turn is asked once more without the old reasoning", async () => {
    create.mockImplementationOnce(async (params: any) => { sent.push(structuredClone(params.messages)); throw new Error(STALE) })
    create.mockImplementationOnce(async (params: any) => { sent.push(structuredClone(params.messages)); return answer })
    const result = await turn()
    expect(create).toHaveBeenCalledTimes(2)
    const types = (messages: Array<Record<string, any>>) => messages.filter((m) => m.role === "assistant").flatMap((m) => (m.content as any[]).map((b) => b.type))
    expect(types(sent[0])).toEqual(["thinking", "redacted_thinking", "text"])
    expect(types(sent[1])).toEqual(["text"])
    expect(JSON.stringify(result)).toContain("done")
  })

  it("leaves any other failure to the caller, with no second request", async () => {
    create.mockRejectedValueOnce(new Error("529 overloaded"))
    await expect(turn()).rejects.toThrow("529 overloaded")
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("rethrows a non-Error rejection as an Error", async () => {
    create.mockRejectedValueOnce("socket hang up")
    await expect(turn()).rejects.toThrow("socket hang up")
  })
})

describe("withoutThinkingBlocks", () => {
  it("removes thinking and redacted thinking from assistant turns only", async () => {
    const { withoutThinkingBlocks } = await import("../../heart/providers/anthropic")
    const user = { role: "user", content: [{ type: "thinking" }] }
    expect(withoutThinkingBlocks([
      user,
      { role: "assistant", content: [{ type: "thinking" }, { type: "redacted_thinking" }, { type: "tool_use", id: "t" }] },
      { role: "assistant", content: "plain" },
    ])).toEqual([user, { role: "assistant", content: [{ type: "tool_use", id: "t" }] }, { role: "assistant", content: "plain" }])
  })
})
