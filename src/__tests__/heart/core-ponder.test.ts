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

const mockInjectNoteSearchContext = vi.fn().mockResolvedValue(undefined)
vi.mock("../../mind/note-search", () => ({
  injectNoteSearchContext: (...args: any[]) => mockInjectNoteSearchContext(...args),
}))

const mockQueuePendingMessage = vi.fn()
vi.mock("../../mind/pending", async () => {
  const actual = await vi.importActual<typeof import("../../mind/pending")>("../../mind/pending")
  return {
    ...actual,
    queuePendingMessage: (...args: any[]) => mockQueuePendingMessage(...args),
    getPrivateRuntimePendingDir: vi.fn(() => "/mock/pending/self/inner/dialog"),
  }
})

const mockRequestInnerWake = vi.fn().mockResolvedValue(undefined)
const mockRequestPrivateWake = vi.fn().mockResolvedValue(undefined)
vi.mock("../../heart/daemon/socket-client", () => ({
  requestInnerWake: (...args: any[]) => mockRequestInnerWake(...args),
  requestPrivateWake: (...args: any[]) => mockRequestPrivateWake(...args),
}))

const mockCreateObligation = vi.fn(() => ({ id: "obl-test-123" }))
const mockCreateReturnObligation = vi.fn()
const mockGenerateObligationId = vi.fn(() => "ret-test-123")
const mockReadReturnObligation = vi.fn(() => null)
vi.mock("../../arc/obligations", () => ({
  createObligation: (...args: any[]) => mockCreateObligation(...args),
  createReturnObligation: (...args: any[]) => mockCreateReturnObligation(...args),
  generateObligationId: (...args: any[]) => mockGenerateObligationId(...args),
  readReturnObligation: (...args: any[]) => mockReadReturnObligation(...args),
  readObligations: vi.fn(() => []),
  readPendingObligations: vi.fn(() => []),
  advanceObligation: vi.fn(),
  fulfillObligation: vi.fn(),
  findPendingObligationForOrigin: vi.fn(),
  isOpenObligation: vi.fn(),
  isOpenObligationStatus: vi.fn(),
}))

const mockCreatePonderPacket = vi.fn((_: string, input: Record<string, unknown>) => ({
  id: "pkt-test-123",
  sop: "harness_friction_v1",
  status: "drafting",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...input,
}))
const mockAdvancePonderPacket = vi.fn((_: string, __: string, update: Record<string, unknown>) => ({
  id: "pkt-test-123",
  sop: "harness_friction_v1",
  status: "drafting",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...update,
}))
const mockRevisePonderPacket = vi.fn()
const mockFindHarnessFrictionPacket = vi.fn(() => null)
vi.mock("../../arc/packets", () => ({
  advancePonderPacket: (...args: any[]) => mockAdvancePonderPacket(...args),
  createPonderPacket: (...args: any[]) => mockCreatePonderPacket(...args),
  revisePonderPacket: (...args: any[]) => mockRevisePonderPacket(...args),
  findHarnessFrictionPacket: (...args: any[]) => mockFindHarnessFrictionPacket(...args),
}))

import * as fs from "fs"
import * as identity from "../../heart/identity"
import type { ChannelCallbacks, RunAgentOutcome } from "../../heart/core"

function expectPonderPrivateWake(options: {
  packetId: string
  returnObligationId: string
  sessionId: string
  socketPath?: string
}) {
  expect(mockRequestPrivateWake).toHaveBeenCalledTimes(1)
  expect(mockRequestPrivateWake).toHaveBeenCalledWith(
    "testagent",
    options.socketPath,
    expect.objectContaining({
      reason: "ponder return obligation private attention",
      triggerSource: "ponder-return-obligation",
      budgetClass: "interactive",
      idempotencyKey: `ponder-return:testagent:${options.returnObligationId}:${options.packetId}:${options.sessionId}`,
      originRefs: expect.arrayContaining([
        { kind: "tool", id: "ponder" },
        { kind: "ponder-packet", id: options.packetId },
        { kind: "return-obligation", id: options.returnObligationId },
        { kind: "session", id: options.sessionId },
      ]),
    }),
  )
  expect(mockRequestInnerWake).not.toHaveBeenCalled()
}

function expectNoPonderWake() {
  expect(mockRequestInnerWake).not.toHaveBeenCalled()
  expect(mockRequestPrivateWake).not.toHaveBeenCalled()
}

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
    ...overrides,
  }
}

function ponderCreateChunks(args: Record<string, unknown>) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_ponder", function: { name: "ponder", arguments: "" } }]),
    makeChunk(undefined, [{ index: 0, function: { arguments: JSON.stringify(args) } }]),
  ]
}

function ponderRawChunks(argumentsText: string) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_ponder", function: { name: "ponder", arguments: "" } }]),
    makeChunk(undefined, [{ index: 0, function: { arguments: argumentsText } }]),
  ]
}

function sendMessageSelfChunks(content: string) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_send_self", function: { name: "send_message", arguments: "" } }]),
    makeChunk(undefined, [{
      index: 0,
      function: { arguments: JSON.stringify({ friendId: "self", channel: "inner", content }) },
    }]),
  ]
}

function surfaceChunks(args: Record<string, unknown>) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_surface", function: { name: "surface", arguments: "" } }]),
    makeChunk(undefined, [{ index: 0, function: { arguments: JSON.stringify(args) } }]),
  ]
}

function restChunks(args: Record<string, unknown> = {}) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_rest", function: { name: "rest", arguments: "" } }]),
    makeChunk(undefined, [{ index: 0, function: { arguments: JSON.stringify(args) } }]),
  ]
}

function settleChunks(answer: string) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_final", function: { name: "settle", arguments: "" } }]),
    makeChunk(undefined, [{ index: 0, function: { arguments: JSON.stringify({ answer, intent: "complete" }) } }]),
  ]
}

function settleRawChunks(argumentsText: string) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_final", function: { name: "settle", arguments: "" } }]),
    makeChunk(undefined, [{ index: 0, function: { arguments: argumentsText } }]),
  ]
}

describe("ponder packets in runAgent", () => {
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
    mockQueuePendingMessage.mockReset()
    mockRequestInnerWake.mockReset().mockResolvedValue(undefined)
    mockRequestPrivateWake.mockReset().mockResolvedValue(undefined)
    mockCreateObligation.mockReset().mockReturnValue({ id: "obl-test-123" })
    mockCreateReturnObligation.mockReset()
    mockGenerateObligationId.mockReset().mockReturnValue("ret-test-123")
    mockReadReturnObligation.mockReset().mockReturnValue(null)
    mockCreatePonderPacket.mockClear()
    mockAdvancePonderPacket.mockReset().mockImplementation((_: string, __: string, update: Record<string, unknown>) => ({
      id: "pkt-test-123",
      sop: "harness_friction_v1",
      status: "drafting",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      ...update,
    }))
    mockRevisePonderPacket.mockReset()
    mockFindHarnessFrictionPacket.mockReset().mockReturnValue(null)
    await setupMinimax()
    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  it("creates a packet and keeps the turn alive until settle", async () => {
    mockRequestPrivateWake.mockResolvedValueOnce({
      ok: true,
      message: "private-runtime wake denied for testagent: default policy deny",
      data: { decision: { result: "deny", executable: false, deniedReason: "default policy deny" } },
    })
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "harness_friction",
      objective: "Keep screenshot handling bulletproof",
      summary: "Oversize TIFF interrogation should become a harness fix candidate",
      success_criteria: "- keep original attachment reachable\n- replay the original objective",
      payload_json: JSON.stringify({
        frictionSignature: "describe_image:image/tiff:oversize",
        userObjective: "Read the hotel confirmation screenshot",
      }),
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("handled")))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
        },
      },
    )

    expect(result.outcome).toBe("settled")
    expect(mockCreate).toHaveBeenCalledTimes(2)
    expect(mockCreatePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      expect.objectContaining({
        kind: "harness_friction",
        objective: "Keep screenshot handling bulletproof",
        origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
        relatedObligationId: "obl-test-123",
        relatedReturnObligationId: "ret-test-123",
        payload: expect.objectContaining({
          sourceRequest: "hi",
        }),
      }),
    )
    expect(mockCreateReturnObligation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        id: "ret-test-123",
        packetId: "pkt-test-123",
        status: "queued",
        delegatedContent: expect.stringContaining("source request: hi"),
      }),
    )
    expect(mockQueuePendingMessage).not.toHaveBeenCalled()
    expectPonderPrivateWake({
      packetId: "pkt-test-123",
      returnObligationId: "ret-test-123",
      sessionId: "ari/bluebubbles/chat",
    })
  })

  it("does not advertise or execute ponder continuations under immutable no-send authority", async () => {
    mockCreate
      .mockReturnValueOnce(makeStream(ponderCreateChunks({
        action: "create",
        kind: "reflection",
        objective: "Escape the probe through a continuation",
        summary: "must remain blocked",
        success_criteria: "- no continuation",
        payload_json: "{}",
      })))
      .mockReturnValueOnce(makeStream(restChunks({ status: "HEARTBEAT_OK" })))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "probe only" }],
      callbacks,
      "inner",
      undefined,
      {
        toolContext: {
          noSend: true,
          currentSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
        },
      },
    )

    const advertisedNames = mockCreate.mock.calls[0][0].tools.map((tool: any) => tool.function.name)
    expect(advertisedNames).not.toContain("ponder")
    expect(result.outcome).toBe("rested")
    expect(mockCreatePonderPacket).not.toHaveBeenCalled()
    expect(mockRevisePonderPacket).not.toHaveBeenCalled()
    expectNoPonderWake()
    expect(callbacks.onToolStart).not.toHaveBeenCalledWith("ponder", expect.anything())
    expect(callbacks.onToolEnd).not.toHaveBeenCalledWith("ponder", expect.any(String), expect.any(Boolean))
  })

  it("retries a text-only immutable no-send turn with rest-only guidance", async () => {
    mockCreate
      .mockReturnValueOnce(makeStream([makeChunk("<think>trying to continue</think>")]))
      .mockReturnValueOnce(makeStream(restChunks({ status: "HEARTBEAT_OK" })))

    const result = await runAgent(
      [{ role: "user", content: "probe only" }],
      makeCallbacks(),
      "inner",
      undefined,
      { toolContext: { noSend: true } },
    )

    expect(result.outcome).toBe("rested")
    expect(mockCreate).toHaveBeenCalledTimes(2)
    expect(mockCreate.mock.calls[1][0].messages).toContainEqual({
      role: "user",
      content: "no tool was called this turn. this is an immutable no-send turn; call rest now without creating a continuation.",
    })
    expectNoPonderWake()
  })

  it("extracts source request text from structured user content", async () => {
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "reflection",
      objective: "Preserve structured user text",
      summary: "Structured summary",
      success_criteria: "- keep source text",
      payload_json: "{}",
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("handled")))

    await runAgent(
      [{
        role: "user",
        content: [
          "Lead text",
          { text: "Structured return request" },
          { text: 123 },
          null,
        ],
      }],
      makeCallbacks(),
      "mcp",
      undefined,
      { toolContext: { currentSession: { friendId: "ari", channel: "mcp", key: "session" } } },
    )

    expect(mockCreatePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      expect.objectContaining({
        payload: expect.objectContaining({
          sourceRequest: "Lead text\nStructured return request",
        }),
      }),
    )
    expect(mockCreateReturnObligation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        delegatedContent: "Structured summary\nsource request: Lead text\nStructured return request",
      }),
    )
  })

  it("overrides model-supplied sourceRequest with the runtime latest user request", async () => {
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "reflection",
      objective: "Validate runtime source request authority",
      summary: "Private return should preserve the originating request",
      success_criteria: "- return AX_RUNTIME_SOURCE_AUTHORITY_20260524",
      payload_json: JSON.stringify({
        marker: "AX_RUNTIME_SOURCE_AUTHORITY_20260524",
        sourceRequest: "AX_RUNTIME_SOURCE_AUTHORITY_20260524",
      }),
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("Private pass queued. Will return when ready.")))

    await runAgent(
      [{
        role: "user",
        content: "Please think privately and return marker AX_RUNTIME_SOURCE_AUTHORITY_20260524 later.",
      }],
      makeCallbacks(),
      "mcp",
      undefined,
      { toolContext: { currentSession: { friendId: "ari", channel: "mcp", key: "session" } } },
    )

    expect(mockCreatePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      expect.objectContaining({
        payload: expect.objectContaining({
          marker: "AX_RUNTIME_SOURCE_AUTHORITY_20260524",
          sourceRequest: "Please think privately and return marker AX_RUNTIME_SOURCE_AUTHORITY_20260524 later.",
        }),
      }),
    )
    expect(mockCreateReturnObligation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        delegatedContent: expect.stringContaining("source request: Please think privately and return marker AX_RU"),
      }),
    )
  })

  it("creates follow-up packet links and truncates overly long delegated summaries", async () => {
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "research",
      objective: "Keep attachments and friction packets legible",
      summary: "A".repeat(140),
      follows_packet_id: "pkt-parent-123",
      success_criteria: "- keep the packet linked",
      payload_json: JSON.stringify({ source: "coverage" }),
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("handled")))

    await runAgent(
      [{ role: "user", content: "hi" }],
      makeCallbacks(),
      "cli",
      undefined,
      { toolContext: { currentSession: { friendId: "ari", channel: "mcp", key: "session" } } },
    )

    expect(mockCreatePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      expect.objectContaining({
        followsPacketId: "pkt-parent-123",
        relatedReturnObligationId: "ret-test-123",
      }),
    )
    expect(mockCreateReturnObligation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        delegatedContent: `${"A".repeat(117)}...`,
      }),
    )
  })

  it("uses the objective as delegated content when summary is blank", async () => {
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "reflection",
      objective: "Objective fallback",
      summary: "   ",
      success_criteria: "- one",
      payload_json: JSON.stringify({ source: "coverage" }),
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("handled")))

    await runAgent(
      [{ role: "user", content: "hi" }],
      makeCallbacks(),
      "cli",
      undefined,
      { toolContext: { currentSession: { friendId: "ari", channel: "mcp", key: "session" } } },
    )

    expect(mockCreateReturnObligation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        delegatedContent: expect.stringContaining("Objective fallback"),
      }),
    )
  })

  it("uses the primary summary as delegated content when no user source request exists", async () => {
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "reflection",
      objective: "Objective without user text",
      summary: "Summary without source",
      success_criteria: "- one",
      payload_json: "{}",
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("handled")))

    await runAgent(
      [{ role: "assistant", content: "prior assistant-only context" }],
      makeCallbacks(),
      "mcp",
      undefined,
      { toolContext: { currentSession: { friendId: "ari", channel: "mcp", key: "session" } } },
    )

    expect(mockCreatePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      expect.objectContaining({
        payload: {},
      }),
    )
    expect(mockCreateReturnObligation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        delegatedContent: "Summary without source",
      }),
    )
  })

  it("falls back past empty latest user content and ignores short marker-like tokens", async () => {
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "reflection",
      objective: "Preserve fallback source text",
      summary: "Fallback source summary",
      success_criteria: "- queue the return",
      payload_json: "{}",
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("queued")))

    await runAgent(
      [
        { role: "user", content: "Please think privately and return A_B_C later." },
        { role: "assistant", content: "queued" },
        { role: "user", content: { text: "" } as any },
      ],
      makeCallbacks(),
      "mcp",
      undefined,
      { toolContext: { currentSession: { friendId: "ari", channel: "mcp", key: "session" } } },
    )

    expect(mockCreatePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      expect.objectContaining({
        payload: expect.objectContaining({
          sourceRequest: "Please think privately and return A_B_C later.",
        }),
      }),
    )
    expect(mockCreateReturnObligation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        delegatedContent: expect.stringContaining("A_B_C"),
      }),
    )
  })

  it("creates a fresh return obligation when a reused packet points at a terminal return", async () => {
    const existingPacket = {
      id: "pkt-existing-123",
      kind: "harness_friction",
      sop: "harness_friction_v1",
      status: "drafting",
      objective: "Old objective",
      summary: "Old summary",
      successCriteria: ["old"],
      origin: { friendId: "ari", channel: "mcp", key: "session" },
      relatedReturnObligationId: "ret-old-123",
      payload: { frictionSignature: "private-loop-repeat" },
      createdAt: 1,
      updatedAt: 1,
    }
    mockFindHarnessFrictionPacket.mockReturnValueOnce(existingPacket)
    mockReadReturnObligation.mockReturnValueOnce({
      id: "ret-old-123",
      status: "returned",
      origin: { friendId: "ari", channel: "mcp", key: "session" },
      delegatedContent: "old",
      createdAt: 1,
    })
    mockGenerateObligationId.mockReturnValueOnce("ret-fresh-123")
    mockRevisePonderPacket.mockReturnValueOnce({
      ...existingPacket,
      objective: "Preserve repeat",
      summary: "New private pass",
    })
    mockAdvancePonderPacket.mockReturnValueOnce({
      ...existingPacket,
      objective: "Preserve repeat",
      summary: "New private pass",
      relatedReturnObligationId: "ret-fresh-123",
    })
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "harness_friction",
      objective: "Preserve repeat",
      summary: "New private pass",
      success_criteria: "- return AX_REPEAT_MARKER",
      payload_json: JSON.stringify({ frictionSignature: "private-loop-repeat" }),
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("queued")))

    await runAgent(
      [{ role: "user", content: "Please think privately and return AX_REPEAT_MARKER later." }],
      makeCallbacks(),
      "mcp",
      undefined,
      { toolContext: { currentSession: { friendId: "ari", channel: "mcp", key: "session" } } },
    )

    expect(mockRevisePonderPacket).toHaveBeenCalled()
    expect(mockAdvancePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      "pkt-existing-123",
      { relatedReturnObligationId: "ret-fresh-123" },
    )
    expect(mockCreateReturnObligation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        id: "ret-fresh-123",
        packetId: "pkt-existing-123",
        status: "queued",
        delegatedContent: expect.stringContaining("AX_REPEAT_MARKER"),
      }),
    )
    expectPonderPrivateWake({
      packetId: "pkt-existing-123",
      returnObligationId: "ret-fresh-123",
      sessionId: "ari/mcp/session",
    })
  })

  it("tells the model a ponder-created return is queued, not complete", async () => {
    const { buildPonderResult } = await import("../../heart/core")
    const result = JSON.parse(buildPonderResult({
      id: "pkt-test",
      kind: "reflection",
      sop: "reflection_v1",
      status: "drafting",
      objective: "Evaluate private attention AX",
      summary: "",
      successCriteria: ["Return AX_MARKER"],
      payload: {},
      createdAt: 1,
      updatedAt: 1,
    }, "created", "ret-test"))

    expect(result.private_return_contract).toContain("queued for private-runtime attention")
    expect(result.private_return_contract).toContain("do not present the requested private answer as complete")
  })

  it("rejects same-turn outward acknowledgements that repeat private return markers", async () => {
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "reflection",
      objective: "Evaluate current private return loop",
      summary: "Return the marker privately",
      success_criteria: "- include AX_PRIVATE_LEAK_123 in the private return",
      payload_json: JSON.stringify({ marker: "AX_PRIVATE_LEAK_123" }),
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("Private pass queued with marker AX_PRIVATE_LEAK_123.")))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("Private pass queued. Will return when ready.")))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Please think privately and later return marker AX_PRIVATE_LEAK_123." }],
      callbacks,
      "mcp",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "ari", channel: "mcp", key: "session" },
        },
      },
    )

    expect(callbacks.onToolEnd).toHaveBeenCalledWith("settle", expect.any(String), false)
    expect(result.completion?.answer).toBe("Private pass queued. Will return when ready.")
  })

  it("rejects private-return queued acknowledgements that did not create a ponder packet", async () => {
    mockCreate.mockReturnValueOnce(makeStream(settleChunks(
      "Private pass is queued. Will return the validation result when the private runtime completes.",
    )))
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "reflection",
      objective: "Validate private attention return loop",
      summary: "Run the private pass and return when complete",
      success_criteria: "- return AX_POSTMERGE_PRIVATE_20260524_VALIDATED to the MCP session",
      payload_json: JSON.stringify({ marker: "AX_POSTMERGE_PRIVATE_20260524_VALIDATED" }),
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("Private pass queued. Will return when ready.")))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{
        role: "user",
        content: "Please think privately and return marker AX_POSTMERGE_PRIVATE_20260524_VALIDATED later.",
      }],
      callbacks,
      "mcp",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "ari", channel: "mcp", key: "session" },
        },
      },
    )

    expect(callbacks.onToolEnd).toHaveBeenCalledWith("settle", expect.any(String), false)
    expect(mockCreatePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      expect.objectContaining({
        kind: "reflection",
        objective: "Validate private attention return loop",
        relatedReturnObligationId: "ret-test-123",
        payload: expect.objectContaining({
          marker: "AX_POSTMERGE_PRIVATE_20260524_VALIDATED",
          sourceRequest: "Please think privately and return marker AX_POSTMERGE_PRIVATE_20260524_VALIDATED later.",
        }),
      }),
    )
    expect(mockCreateReturnObligation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        id: "ret-test-123",
        packetId: "pkt-test-123",
        status: "queued",
        delegatedContent: expect.stringContaining("Run the private pass"),
      }),
    )
    expectPonderPrivateWake({
      packetId: "pkt-test-123",
      returnObligationId: "ret-test-123",
      sessionId: "ari/mcp/session",
    })
    expect(result.outcome).toBe("settled")
    expect(result.completion?.answer).toBe("Private pass queued. Will return when ready.")
  })

  it("rejects legacy private-runtime completion acknowledgements that did not create a ponder packet", async () => {
    const legacyPrivateRuntimeLabel = ["inner", "dialog"].join(" ")
    mockCreate.mockReturnValueOnce(makeStream(settleChunks(
      `I'll bring the validation result back after the ${legacyPrivateRuntimeLabel} completes.`,
    )))
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "reflection",
      objective: "Validate private attention return loop from legacy acknowledgement wording",
      summary: "Run the private pass and return when complete",
      success_criteria: "- return AX_LEGACY_PRIVATE_20260524_VALIDATED to the MCP session",
      payload_json: JSON.stringify({ marker: "AX_LEGACY_PRIVATE_20260524_VALIDATED" }),
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("Private pass queued. Will return when ready.")))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{
        role: "user",
        content: "Please think privately and return marker AX_LEGACY_PRIVATE_20260524_VALIDATED later.",
      }],
      callbacks,
      "mcp",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "ari", channel: "mcp", key: "session" },
        },
      },
    )

    expect(callbacks.onToolEnd).toHaveBeenCalledWith("settle", expect.any(String), false)
    expect(mockCreatePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      expect.objectContaining({
        kind: "reflection",
        objective: "Validate private attention return loop from legacy acknowledgement wording",
        relatedReturnObligationId: "ret-test-123",
      }),
    )
    expectPonderPrivateWake({
      packetId: "pkt-test-123",
      returnObligationId: "ret-test-123",
      sessionId: "ari/mcp/session",
    })
    expect(result.outcome).toBe("settled")
    expect(result.completion?.answer).toBe("Private pass queued. Will return when ready.")
  })

  it("rejects text-only private-return queued acknowledgements that did not create a ponder packet", async () => {
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk("Private pass is queued. Will return the validation result when the private runtime completes."),
    ]))
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "reflection",
      objective: "Validate text-only private attention return loop",
      summary: "Run the private pass and return when complete",
      success_criteria: "- return AX_TEXT_ONLY_PRIVATE_20260524_VALIDATED to the MCP session",
      payload_json: JSON.stringify({ marker: "AX_TEXT_ONLY_PRIVATE_20260524_VALIDATED" }),
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("Private pass queued. Will return when ready.")))

    const delivered: string[] = []
    const callbacks = makeCallbacks({
      onTextChunk: vi.fn((chunk: string) => { delivered.push(chunk) }),
      onClearText: vi.fn(() => { delivered.length = 0 }),
    })
    const result = await runAgent(
      [{
        role: "user",
        content: "Please think privately and return marker AX_TEXT_ONLY_PRIVATE_20260524_VALIDATED later.",
      }],
      callbacks,
      "mcp",
      undefined,
      {
        toolChoiceRequired: false,
        toolContext: {
          currentSession: { friendId: "ari", channel: "mcp", key: "session" },
        },
      },
    )

    expect(mockCreate).toHaveBeenCalledTimes(3)
    expect(callbacks.onClearText).toHaveBeenCalled()
    expect(delivered.join("")).toBe("Private pass queued. Will return when ready.")
    expect(mockCreatePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      expect.objectContaining({
        kind: "reflection",
        objective: "Validate text-only private attention return loop",
        relatedReturnObligationId: "ret-test-123",
        payload: expect.objectContaining({
          marker: "AX_TEXT_ONLY_PRIVATE_20260524_VALIDATED",
          sourceRequest: "Please think privately and return marker AX_TEXT_ONLY_PRIVATE_20260524_VALIDATED later.",
        }),
      }),
    )
    expect(mockCreateReturnObligation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        id: "ret-test-123",
        packetId: "pkt-test-123",
        status: "queued",
        delegatedContent: expect.stringContaining("Run the private pass"),
      }),
    )
    expectPonderPrivateWake({
      packetId: "pkt-test-123",
      returnObligationId: "ret-test-123",
      sessionId: "ari/mcp/session",
    })
    expect(result.outcome).toBe("settled")
    expect(result.completion?.answer).toBe("Private pass queued. Will return when ready.")
  })

  it("allows a text-only blocking clarification for private-return requests without a ponder packet", async () => {
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk("Which MCP session should receive the private return?"),
    ]))

    const delivered: string[] = []
    const callbacks = makeCallbacks({
      onTextChunk: vi.fn((chunk: string) => { delivered.push(chunk) }),
      onClearText: vi.fn(() => { delivered.length = 0 }),
    })
    const result = await runAgent(
      [{ role: "user", content: "Please think privately and return the validation result later." }],
      callbacks,
      "mcp",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "ari", channel: "mcp", key: "session" },
        },
      },
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(callbacks.onClearText).not.toHaveBeenCalled()
    expect(delivered.join("")).toBe("Which MCP session should receive the private return?")
    expect(mockCreatePonderPacket).not.toHaveBeenCalled()
    expect(result.outcome).toBe("settled")
    expect(result.completion).toBeUndefined()
  })

  it("does not treat an empty no-tool turn as a private-return queued acknowledgement", async () => {
    mockCreate.mockReturnValueOnce(makeStream([]))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Please think privately and return the validation result later." }],
      callbacks,
      "mcp",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "ari", channel: "mcp", key: "session" },
        },
      },
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(callbacks.onClearText).not.toHaveBeenCalled()
    expect(mockCreatePonderPacket).not.toHaveBeenCalled()
    expect(result.outcome).toBe("settled")
  })

  it("fails closed when text-only private-return acknowledgements keep skipping ponder", async () => {
    const fakeAck = "Private pass is queued. Will return the validation result when the private runtime completes."
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(fakeAck)]))
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(fakeAck)]))
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(fakeAck)]))

    const delivered: string[] = []
    const callbacks = makeCallbacks({
      onTextChunk: vi.fn((chunk: string) => { delivered.push(chunk) }),
      onClearText: vi.fn(() => { delivered.length = 0 }),
    })
    const result = await runAgent(
      [{ role: "user", content: "Please think privately and return the validation result later." }],
      callbacks,
      "mcp",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "ari", channel: "mcp", key: "session" },
        },
      },
    )

    expect(mockCreate).toHaveBeenCalledTimes(3)
    expect(callbacks.onClearText).toHaveBeenCalledTimes(3)
    expect(delivered.join("")).toBe("I could not start the private pass. No private-attention packet was created, so no return work was queued.")
    expect(mockCreatePonderPacket).not.toHaveBeenCalled()
    expect(mockCreateReturnObligation).not.toHaveBeenCalled()
    expectNoPonderWake()
    expect(result.outcome).toBe("blocked")
    expect(result.completion).toEqual({
      answer: "I could not start the private pass. No private-attention packet was created, so no return work was queued.",
      intent: "blocked",
    })
  })

  it("allows a blocking clarification for private-return requests without a ponder packet", async () => {
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("Which MCP session should receive the private return?")))

    const result = await runAgent(
      [{ role: "user", content: "Please think privately and return the validation result later." }],
      makeCallbacks(),
      "mcp",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "ari", channel: "mcp", key: "session" },
        },
      },
    )

    expect(mockCreatePonderPacket).not.toHaveBeenCalled()
    expect(result.outcome).toBe("settled")
    expect(result.completion?.answer).toBe("Which MCP session should receive the private return?")
  })

  it("fails malformed private-return settle payloads without a provider retry", async () => {
    mockCreate.mockReturnValueOnce(makeStream(settleRawChunks("{}")))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("Which MCP session should receive the private return?")))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Please think privately and return the validation result later." }],
      callbacks,
      "mcp",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "ari", channel: "mcp", key: "session" },
        },
      },
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(callbacks.onToolEnd).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "invalid_settle_arguments" }),
      "terminal",
    )
    expect(mockCreatePonderPacket).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      outcome: "errored",
      error: { message: "invalid_settle_arguments" },
    })
    expect(result.completion).toBeUndefined()
  })

  it("does not create a self-return obligation for private-runtime ponder packets", async () => {
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "reflection",
      objective: "Preserve inner thought",
      summary: "This should stay as packet state",
      success_criteria: "- no self-return loop",
      payload_json: "{}",
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("rested")))

    await runAgent(
      [{ role: "user", content: "heartbeat" }],
      makeCallbacks(),
      "inner",
      undefined,
      { toolContext: { currentSession: { friendId: "self", channel: "inner", key: "dialog" } } },
    )

    expect(mockCreatePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      expect.not.objectContaining({ relatedReturnObligationId: expect.any(String) }),
    )
    expect(mockCreateReturnObligation).not.toHaveBeenCalled()
    expectNoPonderWake()
  })

  it("rejects private-runtime replacement ponder packets while a held return is waiting", async () => {
    const delegatedOrigins = [{
      id: "ret-1",
      friendId: "ari",
      friendName: "Ari",
      channel: "mcp",
      key: "session",
      delegatedContent: "return marker",
      source: "obligation-recovery" as const,
      timestamp: 1,
    }]
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "reflection",
      objective: "Replace held return",
      summary: "This would duplicate the queue item",
      success_criteria: "- no duplicate",
      payload_json: "{}",
    })))
    mockCreate.mockReturnValueOnce(makeStream(surfaceChunks({ delegationId: "ret-1", content: "returned" })))
    mockCreate.mockReturnValueOnce(makeStream(restChunks({ status: "HEARTBEAT_OK" })))
    const callbacks = makeCallbacks()
    const execTool = vi.fn().mockImplementation((name: string) => {
      if (name === "surface") {
        delegatedOrigins.splice(0)
        return "delivered"
      }
      return "ok"
    })

    await runAgent(
      [{ role: "user", content: "heartbeat" }],
      callbacks,
      "inner",
      undefined,
      {
        execTool,
        toolContext: {
          currentSession: { friendId: "self", channel: "inner", key: "dialog" },
          delegatedOrigins,
        },
      },
    )

    expect(mockCreatePonderPacket).not.toHaveBeenCalled()
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("ponder", expect.any(String), false)
    expect(execTool).toHaveBeenCalledWith("surface", expect.objectContaining({ delegationId: "ret-1" }), expect.any(Object))
  })

  it("does not create a return obligation when no outward session origin exists", async () => {
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "reflection",
      objective: "Preserve local thought",
      summary: "No route-back target exists",
      success_criteria: "- packet is created",
      payload_json: "{}",
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("handled")))

    await runAgent([{ role: "user", content: "hi" }], makeCallbacks(), "cli")

    expect(mockCreatePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      expect.not.objectContaining({ relatedReturnObligationId: expect.any(String) }),
    )
    expect(mockCreateReturnObligation).not.toHaveBeenCalled()
    expectNoPonderWake()
  })

  it("rejects legacy send_message(self) for private-return requests so ponder owns the contract", async () => {
    mockCreate.mockReturnValueOnce(makeStream(sendMessageSelfChunks("AX_PRIVATE_RETURN — ready")))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("handled")))
    const execTool = vi.fn().mockResolvedValue("queued")
    const callbacks = makeCallbacks()

    await runAgent(
      [{ role: "user", content: "Please think privately and return marker AX_PRIVATE_RETURN later." }],
      callbacks,
      "mcp",
      undefined,
      {
        execTool,
        toolContext: {
          currentSession: { friendId: "ari", channel: "mcp", key: "session" },
        },
      },
    )

    expect(execTool).not.toHaveBeenCalled()
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("send_message", expect.any(String), false)
  })

  it("normalizes legacy thought into a reflection packet without ending the turn", async () => {
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      thought: "Think through the attachment architecture",
      say: "let me think",
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    expect(result.outcome).toBe("settled")
    expect(mockCreatePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      expect.objectContaining({
        kind: "reflection",
        objective: "Think through the attachment architecture",
        summary: "let me think",
      }),
    )
  })

  it("normalizes legacy thought with a non-string say into an empty summary", async () => {
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      thought: "Think through the attachment architecture",
      say: 42 as any,
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    await runAgent(
      [{ role: "user", content: "hi" }],
      makeCallbacks(),
      "cli",
    )

    expect(mockCreatePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      expect.objectContaining({
        kind: "reflection",
        objective: "Think through the attachment architecture",
        summary: "",
      }),
    )
  })

  it("rejects create when the packet spec is incomplete", async () => {
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "harness_friction",
      summary: "Missing objective",
      success_criteria: "- one",
      payload_json: "{}",
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    expect(mockCreatePonderPacket).not.toHaveBeenCalled()
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("ponder", expect.any(String), false)
  })

  it("rejects create when success criteria collapse to empty lines or payload_json is not an object", async () => {
    mockCreate
      .mockReturnValueOnce(makeStream(ponderCreateChunks({
        action: "create",
        kind: "reflection",
        objective: "Blank criteria",
        summary: "oops",
        success_criteria: "  \n -   \n",
        payload_json: "{}",
      })))
      .mockReturnValueOnce(makeStream(ponderCreateChunks({
        action: "create",
        kind: "reflection",
        objective: "Array payload",
        summary: "oops",
        success_criteria: "- one",
        payload_json: "[]",
      })))
      .mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    await runAgent([{ role: "user", content: "hi" }], callbacks, "cli")

    expect(mockCreatePonderPacket).not.toHaveBeenCalled()
    expect((callbacks.onToolEnd as any).mock.calls[0][2]).toBe(false)
    expect((callbacks.onToolEnd as any).mock.calls[1][2]).toBe(false)
  })

  it("revises drafting packets in place", async () => {
    mockRevisePonderPacket.mockReturnValue({
      id: "pkt-test-123",
      status: "drafting",
    })
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "revise",
      packet_id: "pkt-test-123",
      kind: "research",
      objective: "Refined objective",
      summary: "Refined summary",
      success_criteria: "- one\n- two",
      payload_json: "{\"source\":\"revised\"}",
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "heartbeat" }],
      callbacks,
      "inner",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "self", channel: "inner", key: "dialog" },
        },
      },
    )

    expect(result.outcome).toBe("settled")
    expect(mockRevisePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      "pkt-test-123",
      expect.objectContaining({
        objective: "Refined objective",
        payload: { source: "revised" },
      }),
    )
  })

  it("keeps revised outward packets linked to their existing return obligation", async () => {
    mockRequestPrivateWake.mockRejectedValueOnce(new Error("daemon unavailable"))
    mockRevisePonderPacket.mockReturnValue({
      id: "pkt-test-123",
      sop: "reflection_v1",
      kind: "reflection",
      status: "drafting",
      objective: "Refined outward objective",
      summary: "Refined outward summary",
      successCriteria: ["Return later"],
      payload: {},
      origin: { friendId: "ari", channel: "mcp", key: "session" },
      relatedReturnObligationId: "ret-existing-123",
      createdAt: 1,
      updatedAt: 1,
    })
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "revise",
      packet_id: "pkt-test-123",
      kind: "reflection",
      objective: "Refined outward objective",
      summary: "Refined outward summary",
      success_criteria: "- Return later",
      payload_json: "{}",
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const result = await runAgent(
      [{ role: "user", content: "revise that return packet" }],
      makeCallbacks(),
      "mcp",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "ari", channel: "mcp", key: "session" },
          daemonSocketPath: "/tmp/ouro-test.sock",
        },
      },
    )

    expect(result.outcome).toBe("settled")
    expectPonderPrivateWake({
      packetId: "pkt-test-123",
      returnObligationId: "ret-existing-123",
      sessionId: "ari/mcp/session",
      socketPath: "/tmp/ouro-test.sock",
    })
  })

  it("drops stale self-return links when revising private-runtime packets", async () => {
    mockRevisePonderPacket.mockReturnValue({
      id: "pkt-test-123",
      sop: "reflection_v1",
      kind: "reflection",
      status: "drafting",
      objective: "Refined inner objective",
      summary: "Refined inner summary",
      successCriteria: ["Stay internal"],
      payload: {},
      origin: { friendId: "self", channel: "inner", key: "dialog" },
      relatedReturnObligationId: "ret-stale-self-123",
      createdAt: 1,
      updatedAt: 1,
    })
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "revise",
      packet_id: "pkt-test-123",
      kind: "reflection",
      objective: "Refined inner objective",
      summary: "Refined inner summary",
      success_criteria: "- Stay internal",
      payload_json: "{}",
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const result = await runAgent(
      [{ role: "user", content: "heartbeat" }],
      makeCallbacks(),
      "inner",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "self", channel: "inner", key: "dialog" },
        },
      },
    )

    expect(result.outcome).toBe("settled")
    expectNoPonderWake()
  })

  it("rejects revise against non-drafting packets and tells the agent to file a follow-up", async () => {
    mockRevisePonderPacket.mockImplementation(() => {
      throw new Error("packet is no longer drafting; file a follow-up packet instead")
    })
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "revise",
      packet_id: "pkt-test-123",
      kind: "research",
      objective: "Refined objective",
      summary: "Refined summary",
      success_criteria: "- one",
      payload_json: "{}",
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "heartbeat" }],
      callbacks,
      "inner",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "self", channel: "inner", key: "dialog" },
        },
      },
    )

    expect(callbacks.onToolEnd).toHaveBeenCalledWith("ponder", expect.any(String), false)
  })

  it("rejects revise when objective and summary are not strings", async () => {
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "revise",
      packet_id: "pkt-test-123",
      kind: "research",
      objective: 7 as any,
      summary: 9 as any,
      success_criteria: "- one",
      payload_json: "{}",
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    await runAgent([{ role: "user", content: "heartbeat" }], callbacks, "inner")

    expect(mockRevisePonderPacket).not.toHaveBeenCalled()
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("ponder", expect.any(String), false)
  })

  it("treats malformed ponder JSON and invalid revise specs as tool failures", async () => {
    mockCreate
      .mockReturnValueOnce(makeStream(ponderRawChunks("{not json")))
      .mockReturnValueOnce(makeStream(ponderCreateChunks({
        action: "revise",
        kind: "reflection",
        objective: "Missing packet id",
        summary: "oops",
        success_criteria: "- one",
        payload_json: "{}",
      })))
      .mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    const result = await runAgent([{ role: "user", content: "hi" }], callbacks, "cli")

    expect(result.outcome).toBe("settled")
    expect((callbacks.onToolEnd as any).mock.calls[0][2]).toBe(false)
    expect((callbacks.onToolEnd as any).mock.calls[1][2]).toBe(false)
  })

  it("treats valid non-object ponder JSON as a tool failure", async () => {
    mockCreate
      .mockReturnValueOnce(makeStream(ponderRawChunks("7")))
      .mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    const result = await runAgent([{ role: "user", content: "hi" }], callbacks, "cli")

    expect(result.outcome).toBe("settled")
    expect((callbacks.onToolEnd as any).mock.calls[0][2]).toBe(false)
  })

  it("coerces non-Error ponder failures into tool output text", async () => {
    mockRevisePonderPacket.mockImplementation(() => {
      throw "string failure"
    })
    mockCreate
      .mockReturnValueOnce(makeStream(ponderCreateChunks({
        action: "revise",
        packet_id: "pkt-test-123",
        kind: "reflection",
        objective: "Refined objective",
        summary: "Refined summary",
        success_criteria: "- one",
        payload_json: "{}",
      })))
      .mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    const result = await runAgent([{ role: "user", content: "hi" }], callbacks, "cli")

    expect(result.outcome).toBe("settled")
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("ponder", expect.any(String), false)
  })

  it("rejects invalid actions and invalid payload_json cleanly", async () => {
    mockCreate
      .mockReturnValueOnce(makeStream(ponderCreateChunks({
        action: "explode",
        kind: "reflection",
        objective: "Bad action",
        summary: "oops",
        success_criteria: "- one",
        payload_json: "{}",
      })))
      .mockReturnValueOnce(makeStream(ponderCreateChunks({
        action: "create",
        kind: "reflection",
        objective: "Bad payload",
        summary: "oops",
        success_criteria: "- one",
        payload_json: "[",
      })))
      .mockReturnValueOnce(makeStream(settleChunks("done")))

    const callbacks = makeCallbacks()
    await runAgent([{ role: "user", content: "hi" }], callbacks, "cli")

    expect((callbacks.onToolEnd as any).mock.calls[0][2]).toBe(false)
    expect((callbacks.onToolEnd as any).mock.calls[1][2]).toBe(false)
  })

  it("revises an existing drafting harness_friction packet instead of creating a duplicate", async () => {
    mockFindHarnessFrictionPacket.mockReturnValue({
      id: "pkt-existing",
      kind: "harness_friction",
      sop: "harness_friction_v1",
      status: "drafting",
      objective: "Old objective",
      summary: "Old summary",
      successCriteria: ["Old"],
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      relatedReturnObligationId: "ret-existing",
      payload: { frictionSignature: "describe_image:image/tiff:oversize" },
      createdAt: 1,
      updatedAt: 1,
    })
    mockReadReturnObligation.mockReturnValueOnce({
      id: "ret-existing",
      status: "queued",
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      delegatedContent: "old",
      createdAt: 1,
    })
    mockRevisePonderPacket.mockReturnValue({
      id: "pkt-existing",
      kind: "harness_friction",
      sop: "harness_friction_v1",
      status: "drafting",
      objective: "New objective",
      summary: "New summary",
      successCriteria: ["New"],
      relatedReturnObligationId: "ret-existing",
      payload: { frictionSignature: "describe_image:image/tiff:oversize" },
      createdAt: 1,
      updatedAt: 2,
    })
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "harness_friction",
      objective: "New objective",
      summary: "New summary",
      success_criteria: "- New",
      payload_json: JSON.stringify({ frictionSignature: "describe_image:image/tiff:oversize" }),
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    await runAgent(
      [{ role: "user", content: "hi" }],
      makeCallbacks(),
      "cli",
      undefined,
      { toolContext: { currentSession: { friendId: "ari", channel: "bluebubbles", key: "chat" } } },
    )

    expect(mockRevisePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      "pkt-existing",
      expect.objectContaining({ objective: "New objective" }),
    )
    expect(mockCreatePonderPacket).not.toHaveBeenCalled()
  })

  it("revises an existing drafting harness_friction packet even when it has no linked return obligation yet", async () => {
    mockFindHarnessFrictionPacket.mockReturnValue({
      id: "pkt-existing",
      kind: "harness_friction",
      sop: "harness_friction_v1",
      status: "drafting",
      objective: "Old objective",
      summary: "Old summary",
      successCriteria: ["Old"],
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      payload: { frictionSignature: "describe_image:image/tiff:oversize" },
      createdAt: 1,
      updatedAt: 1,
    })
    mockRevisePonderPacket.mockReturnValue({
      id: "pkt-existing",
      kind: "harness_friction",
      sop: "harness_friction_v1",
      status: "drafting",
      objective: "New objective",
      summary: "New summary",
      successCriteria: ["New"],
      payload: { frictionSignature: "describe_image:image/tiff:oversize" },
      createdAt: 1,
      updatedAt: 2,
    })
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "harness_friction",
      objective: "New objective",
      summary: "New summary",
      success_criteria: "- New",
      payload_json: JSON.stringify({ frictionSignature: "describe_image:image/tiff:oversize" }),
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    await runAgent(
      [{ role: "user", content: "hi" }],
      makeCallbacks(),
      "cli",
      undefined,
      { toolContext: { currentSession: { friendId: "ari", channel: "bluebubbles", key: "chat" } } },
    )

    expect(mockRevisePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      "pkt-existing",
      expect.objectContaining({ objective: "New objective" }),
    )
  })

  it("revises an existing inner harness_friction packet without creating return work", async () => {
    mockFindHarnessFrictionPacket.mockReturnValue({
      id: "pkt-existing-inner",
      kind: "harness_friction",
      sop: "harness_friction_v1",
      status: "drafting",
      objective: "Old inner objective",
      summary: "Old inner summary",
      successCriteria: ["Old"],
      origin: { friendId: "self", channel: "inner", key: "dialog" },
      payload: { frictionSignature: "inner-private-loop-repeat" },
      createdAt: 1,
      updatedAt: 1,
    })
    mockRevisePonderPacket.mockReturnValue({
      id: "pkt-existing-inner",
      kind: "harness_friction",
      sop: "harness_friction_v1",
      status: "drafting",
      objective: "New inner objective",
      summary: "New inner summary",
      successCriteria: ["New"],
      origin: { friendId: "self", channel: "inner", key: "dialog" },
      payload: { frictionSignature: "inner-private-loop-repeat" },
      createdAt: 1,
      updatedAt: 2,
    })
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "harness_friction",
      objective: "New inner objective",
      summary: "New inner summary",
      success_criteria: "- New",
      payload_json: JSON.stringify({ frictionSignature: "inner-private-loop-repeat" }),
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    await runAgent(
      [{ role: "user", content: "heartbeat" }],
      makeCallbacks(),
      "inner",
      undefined,
      { toolContext: { currentSession: { friendId: "self", channel: "inner", key: "dialog" } } },
    )

    expect(mockRevisePonderPacket).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      "pkt-existing-inner",
      expect.objectContaining({ objective: "New inner objective" }),
    )
    expect(mockCreateReturnObligation).not.toHaveBeenCalled()
    expectNoPonderWake()
  })

  it("reuses an existing non-drafting harness_friction packet and tolerates obligation creation failure", async () => {
    mockCreateObligation.mockImplementationOnce(() => {
      throw new Error("obligation store unavailable")
    })
    mockFindHarnessFrictionPacket.mockReturnValue({
      id: "pkt-existing",
      kind: "harness_friction",
      sop: "harness_friction_v1",
      status: "processing",
      objective: "Old objective",
      summary: "Old summary",
      successCriteria: ["Old"],
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      relatedReturnObligationId: "ret-existing",
      payload: { frictionSignature: "describe_image:image/tiff:oversize" },
      createdAt: 1,
      updatedAt: 1,
    })
    mockReadReturnObligation.mockReturnValueOnce({
      id: "ret-existing",
      status: "queued",
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      delegatedContent: "old",
      createdAt: 1,
    })
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "harness_friction",
      objective: "New objective",
      summary: "New summary",
      success_criteria: "- New",
      payload_json: JSON.stringify({ frictionSignature: "describe_image:image/tiff:oversize" }),
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

    await runAgent(
      [{ role: "user", content: "hi" }],
      makeCallbacks(),
      "cli",
      undefined,
      { toolContext: { currentSession: { friendId: "ari", channel: "bluebubbles", key: "chat" } } },
    )

    expect(mockRevisePonderPacket).not.toHaveBeenCalled()
    expect(mockCreatePonderPacket).not.toHaveBeenCalled()
    expect(mockCreateReturnObligation).not.toHaveBeenCalled()
    expectPonderPrivateWake({
      packetId: "pkt-existing",
      returnObligationId: "ret-existing",
      sessionId: "ari/bluebubbles/chat",
    })
  })

  it("truncates a long objective when summary is blank", async () => {
    const objective = "B".repeat(140)
    mockCreate.mockReturnValueOnce(makeStream(ponderCreateChunks({
      action: "create",
      kind: "reflection",
      objective,
      summary: "   ",
      success_criteria: "- keep the fallback concise",
      payload_json: JSON.stringify({ source: "coverage" }),
    })))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("handled")))

    await runAgent(
      [{ role: "user", content: "hi" }],
      makeCallbacks(),
      "cli",
      undefined,
      { toolContext: { currentSession: { friendId: "ari", channel: "mcp", key: "session" } } },
    )

    expect(mockCreateReturnObligation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        delegatedContent: `${"B".repeat(117)}...`,
      }),
    )
  })
})
