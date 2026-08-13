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
const mockInjectKeptNotes = vi.hoisted(() => vi.fn())
const mockBuildSystem = vi.hoisted(() => vi.fn(async () => ({ stable: "core system prompt", volatile: "current turn state" })))
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
  buildSystem: (...args: any[]) => mockBuildSystem(...args),
  flattenSystemPrompt: (prompt: { stable: string; volatile: string }) => `${prompt.stable}\n\n${prompt.volatile}`,
}))

vi.mock("../../heart/kept-notes", () => ({
  createKeptNotesJudge: vi.fn(() => vi.fn()),
  injectKeptNotes: (...args: any[]) => mockInjectKeptNotes(...args),
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

function contextWindowForInputLimit(inputTokenLimit: number): number {
  for (let contextWindow = 1; contextWindow <= Math.max(100, inputTokenLimit * 3); contextWindow += 1) {
    const outputReserve = Math.floor(contextWindow * 0.2)
    const protocolReserve = Math.floor(contextWindow * 0.1)
    if (contextWindow - outputReserve - protocolReserve === inputTokenLimit) return contextWindow
  }
  throw new Error(`no context window found for input limit ${inputTokenLimit}`)
}

describe("runAgent prompt budget integration", () => {
  beforeEach(async () => {
    vi.resetModules()
    mockCreate.mockReset()
    mockInjectKeptNotes.mockReset().mockResolvedValue({ status: "none", elapsedMs: 0, pressure: [] })
    mockBuildSystem.mockReset().mockResolvedValue({ stable: "core system prompt", volatile: "current turn state" })
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

  it("rejects an oversized required floor before kept-note judging or the main provider", async () => {
    const predecessor = { role: "system" as const, content: "verified predecessor " + "p".repeat(260) }
    const current = { role: "user" as const, content: "current request " + "c".repeat(260) }
    const { estimatePromptBudgetTokens } = await import("../../mind/prompt-budget")
    const requiredTokens = estimatePromptBudgetTokens([predecessor, current])
    mockLoadAgentConfig.mockReturnValue({
      name: "testagent",
      humanFacing: { provider: "minimax", model: "MiniMax-M2.7" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.7" },
      context: {
        maxTokens: contextWindowForInputLimit(requiredTokens - 1),
        contextMargin: 20,
      },
    })
    const { runAgent } = await import("../../heart/core")
    const cb = callbacks()

    const result = await runAgent(
      [{ role: "system", content: "optional prompt" }, predecessor, current],
      cb,
      "bluebubbles",
      undefined,
      {
        requiredPromptEvidence: {
          currentUserMessage: current,
          verifiedPredecessorMessage: predecessor,
        },
      },
    )

    expect(result).toMatchObject({
      outcome: "errored",
      error: { message: expect.stringContaining("required_evidence_over_budget") },
    })
    expect(result.error?.message).toContain(`needs ${requiredTokens} tokens`)
    expect(mockInjectKeptNotes).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(cb.onModelStart).not.toHaveBeenCalled()
    expect(cb.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("required_evidence_over_budget") }),
      "terminal",
    )
  })

  it("fails closed before provider work when typed evidence is structurally invalid", async () => {
    const invalidCurrent = { role: "assistant" as const, content: "not a current user message" }
    const captureGeneratedMessages = vi.fn()
    const { runAgent } = await import("../../heart/core")
    const cb = callbacks()

    const result = await runAgent(
      [invalidCurrent],
      cb,
      undefined,
      undefined,
      {
        captureGeneratedMessages,
        requiredPromptEvidence: { currentUserMessage: invalidCurrent as any },
      },
    )

    expect(result).toMatchObject({
      outcome: "errored",
      error: { message: "required current user message must have role=user" },
    })
    expect(cb.onError).toHaveBeenCalledWith(expect.any(Error), "terminal")
    expect(captureGeneratedMessages).toHaveBeenCalledWith([])
    expect(mockInjectKeptNotes).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("normalizes a non-Error evidence validation failure before provider work", async () => {
    const current = Object.defineProperty({}, "role", {
      enumerable: true,
      get: () => {
        throw "non-error evidence failure"
      },
    })
    const { runAgent } = await import("../../heart/core")
    const cb = callbacks()

    const result = await runAgent(
      [current as any],
      cb,
      undefined,
      undefined,
      { requiredPromptEvidence: { currentUserMessage: current as any } },
    )

    expect(result).toMatchObject({
      outcome: "errored",
      error: { message: "non-error evidence failure" },
    })
    expect(cb.onError).toHaveBeenCalledWith(expect.any(Error), "terminal")
    expect(mockInjectKeptNotes).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("keeps typed evidence as the same objects in the actual chat-completions payload", async () => {
    mockLoadAgentConfig.mockReturnValue({
      name: "testagent",
      humanFacing: { provider: "minimax", model: "MiniMax-M2.7" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.7" },
      context: { maxTokens: 300, contextMargin: 20 },
    })
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))
    const predecessor = { role: "system" as const, content: "verified predecessor evidence" }
    const current = { role: "user" as const, content: "current request" }
    const { runAgent } = await import("../../heart/core")

    await runAgent(
      [
        { role: "system", content: "old system" },
        { role: "assistant", content: "optional old history " + "x".repeat(500) },
        predecessor,
        current,
      ],
      callbacks(),
      "bluebubbles",
      undefined,
      {
        requiredPromptEvidence: {
          currentUserMessage: current,
          verifiedPredecessorMessage: predecessor,
        },
      },
    )

    const providerMessages = mockCreate.mock.calls[0]?.[0]?.messages ?? []
    expect(providerMessages).toContain(predecessor)
    expect(providerMessages).toContain(current)
    expect(providerMessages.filter((message: unknown) => message === predecessor)).toHaveLength(1)
    expect(providerMessages.filter((message: unknown) => message === current)).toHaveLength(1)
  })

  it("keeps fresh-session optional evidence through system refresh into the actual provider payload", async () => {
    mockLoadAgentConfig.mockReturnValue({
      name: "testagent",
      humanFacing: { provider: "minimax", model: "MiniMax-M2.7" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.7" },
      context: { maxTokens: 500, contextMargin: 20 },
    })
    let providerMessages: unknown[] = []
    mockCreate.mockImplementationOnce((request: { messages: unknown[] }) => {
      providerMessages = [...request.messages]
      return makeStream(settleChunks("done"))
    })
    const optional = Object.freeze({ role: "system" as const, content: "older optional same-chat evidence" })
    const predecessor = Object.freeze({ role: "system" as const, content: "verified predecessor evidence" })
    const current = Object.freeze({ role: "user" as const, content: "current request" })
    const { runAgent } = await import("../../heart/core")

    await runAgent(
      [optional, predecessor, current],
      callbacks(),
      "bluebubbles",
      undefined,
      {
        skipKeptNotes: true,
        promptOnlyEvidenceMessages: [optional],
        requiredPromptEvidence: {
          currentUserMessage: current,
          verifiedPredecessorMessage: predecessor,
        },
      } as any,
    )

    expect(JSON.stringify(providerMessages).match(/older optional same-chat evidence/g)).toHaveLength(1)
    expect(JSON.stringify(providerMessages).match(/verified predecessor evidence/g)).toHaveLength(1)
    expect(JSON.stringify(providerMessages).match(/current request/g)).toHaveLength(1)
    expect(providerMessages.findIndex((message: any) => message.content === "older optional same-chat evidence"))
      .toBeLessThan(providerMessages.findIndex((message) => message === predecessor))
  })

  it("preserves required evidence exactly once when system-prompt construction fails", async () => {
    mockLoadAgentConfig.mockReturnValue({
      name: "testagent",
      humanFacing: { provider: "minimax", model: "MiniMax-M2.7" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.7" },
      context: { maxTokens: 300, contextMargin: 20 },
    })
    mockBuildSystem.mockRejectedValueOnce(new Error("prompt assembly failed"))
    let providerMessages: unknown[] = []
    mockCreate.mockImplementationOnce((request: { messages: unknown[] }) => {
      providerMessages = [...request.messages]
      return makeStream(settleChunks("done"))
    })
    const predecessor = Object.freeze({ role: "system" as const, content: "verified predecessor evidence" })
    const current = Object.freeze({ role: "user" as const, content: "current request" })
    const { runAgent } = await import("../../heart/core")

    await runAgent(
      [predecessor, current],
      callbacks(),
      "bluebubbles",
      undefined,
      {
        skipKeptNotes: true,
        requiredPromptEvidence: {
          currentUserMessage: current,
          verifiedPredecessorMessage: predecessor,
        },
      },
    )

    expect(providerMessages.filter((message: unknown) => message === predecessor)).toHaveLength(1)
    expect(providerMessages.filter((message: unknown) => message === current)).toHaveLength(1)
    expect(providerMessages[0]).not.toBe(predecessor)
    expect(providerMessages.at(-2)).toBe(predecessor)
    expect(providerMessages.at(-1)).toBe(current)
  })

  it("preserves required evidence by identity across context-overflow recovery", async () => {
    mockLoadAgentConfig.mockReturnValue({
      name: "testagent",
      humanFacing: { provider: "minimax", model: "MiniMax-M2.7" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.7" },
      context: { maxTokens: 300, contextMargin: 20 },
    })
    const payloads: unknown[][] = []
    mockCreate
      .mockImplementationOnce((request: { messages: unknown[] }) => {
        payloads.push([...request.messages])
        const error = new Error("context_length_exceeded") as Error & { code: string }
        error.code = "context_length_exceeded"
        throw error
      })
      .mockImplementationOnce((request: { messages: unknown[] }) => {
        payloads.push([...request.messages])
        return makeStream(settleChunks("done"))
      })
    const predecessor = Object.freeze({ role: "system" as const, content: "verified predecessor evidence" })
    const current = Object.freeze({ role: "user" as const, content: "current request" })
    const { runAgent } = await import("../../heart/core")

    await runAgent(
      [{ role: "system", content: "optional core" }, { role: "user", content: "old history" }, predecessor, current],
      callbacks(),
      "bluebubbles",
      undefined,
      {
        skipKeptNotes: true,
        requiredPromptEvidence: {
          currentUserMessage: current,
          verifiedPredecessorMessage: predecessor,
        },
      },
    )

    expect(payloads).toHaveLength(2)
    for (const payload of payloads) {
      expect(payload.filter((message) => message === predecessor)).toHaveLength(1)
      expect(payload.filter((message) => message === current)).toHaveLength(1)
    }
  })
})
