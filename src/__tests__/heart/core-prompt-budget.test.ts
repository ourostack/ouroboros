import { beforeEach, describe, expect, it, vi } from "vitest"

function defaultReadFileSync(filePath: any, _encoding?: any): string {
  const p = String(filePath)
  if (p.endsWith("SOUL.md")) return "mock soul"
  if (p.endsWith("IDENTITY.md")) return "mock identity"
  if (p.endsWith("LORE.md")) return "mock lore"
  if (p.endsWith("FRIENDS.md")) return "mock friends"
  if (p.endsWith("package.json")) return JSON.stringify({ name: "ouro" })
  return ""
}

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(defaultReadFileSync),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  }
})

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(() => []),
  loadSkill: vi.fn(),
}))

const mockLoadAgentConfig = vi.hoisted(() => vi.fn())
vi.mock("../../heart/identity", () => ({
  loadAgentConfig: (...args: any[]) => mockLoadAgentConfig(...args),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 120, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
  HARNESS_CANONICAL_REPO_URL: "https://github.com/ourostack/ouroboros.git",
}))

vi.mock("../../heart/daemon/runtime-mode", () => ({
  detectRuntimeMode: vi.fn(() => "dev"),
}))

vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

vi.mock("@ouro.bot/friends", async () => {
  const actual = await vi.importActual<typeof import("@ouro.bot/friends")>("@ouro.bot/friends")
  return {
    ...actual,
    getChannelCapabilities: vi.fn(() => ({
      channel: "cli",
      availableIntegrations: [],
      supportsMarkdown: true,
      supportsStreaming: true,
      supportsRichCards: false,
    })),
    isRemoteChannel: vi.fn(() => false),
    channelToFacing: vi.fn(() => "human"),
  }
})

vi.mock("../../mind/first-impressions", () => ({
  getFirstImpressions: vi.fn(() => null),
}))

vi.mock("../../mind/prompt", () => ({
  buildSystem: vi.fn(async () => ({ stable: "core system prompt", volatile: "current turn state" })),
  flattenSystemPrompt: (prompt: { stable: string; volatile: string }) => `${prompt.stable}\n\n${prompt.volatile}`,
}))

vi.mock("../../heart/kept-notes", () => ({
  createKeptNotesJudge: vi.fn(() => vi.fn()),
  injectKeptNotes: vi.fn().mockResolvedValue({ status: "none", elapsedMs: 0, pressure: [] }),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

const mockCreate = vi.hoisted(() => vi.fn())
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

function settleChunks(answer: string) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_final", function: { name: "settle", arguments: "" } }]),
    makeChunk(undefined, [{ index: 0, function: { arguments: JSON.stringify({ answer, intent: "complete" }) } }]),
  ]
}

function callbacks() {
  return {
    onModelStart: vi.fn(),
    onModelStreamStart: vi.fn(),
    onTextChunk: vi.fn(),
    onReasoningChunk: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onError: vi.fn(),
    onClearText: vi.fn(),
  }
}

describe("runAgent prompt budget integration", () => {
  beforeEach(async () => {
    vi.resetModules()
    mockCreate.mockReset()
    mockLoadAgentConfig.mockReturnValue({
      name: "testagent",
      humanFacing: { provider: "minimax", model: "MiniMax-M2.7" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.7" },
      context: { maxTokens: 120, contextMargin: 20 },
    })
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
  })

  it("sends the budgeted final message body to the provider", async () => {
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))
    const { runAgent } = await import("../../heart/core")
    const messages = [
      { role: "system" as const, content: "old system replaced by buildSystem" },
      { role: "user" as const, content: "old history " + "old ".repeat(180) },
      { role: "assistant" as const, content: "old answer " + "old ".repeat(180) },
      { role: "system" as const, content: "Untrusted bluebubbles context for this same thread.\n[bbmsg:chat:one] " + "context ".repeat(120) },
      { role: "user" as const, content: "current question must be sent" },
    ]
    const originalLength = JSON.stringify(messages).length

    await runAgent(messages, callbacks(), "cli", undefined, { toolChoiceRequired: true })

    const providerMessages = mockCreate.mock.calls[0]?.[0]?.messages ?? []
    const rendered = JSON.stringify(providerMessages)
    expect(rendered).toContain("current question must be sent")
    expect(rendered).toContain("bbmsg:chat:one")
    expect(rendered).not.toContain("old history")
    expect(rendered).not.toContain("old answer")
    expect(rendered.length).toBeLessThan(originalLength)
  })
})
