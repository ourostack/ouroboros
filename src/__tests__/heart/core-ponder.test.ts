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
    getInnerDialogPendingDir: vi.fn(() => "/mock/pending/self/inner/dialog"),
  }
})

const mockRequestInnerWake = vi.fn().mockResolvedValue(undefined)
vi.mock("../../heart/daemon/socket-client", () => ({
  requestInnerWake: (...args: any[]) => mockRequestInnerWake(...args),
}))

const mockCreateObligation = vi.fn(() => ({ id: "obl-test-123" }))
const mockCreateReturnObligation = vi.fn()
const mockGenerateObligationId = vi.fn(() => "ret-test-123")
vi.mock("../../arc/obligations", () => ({
  createObligation: (...args: any[]) => mockCreateObligation(...args),
  createReturnObligation: (...args: any[]) => mockCreateReturnObligation(...args),
  generateObligationId: (...args: any[]) => mockGenerateObligationId(...args),
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
const mockRevisePonderPacket = vi.fn()
const mockFindHarnessFrictionPacket = vi.fn(() => null)
vi.mock("../../arc/packets", () => ({
  createPonderPacket: (...args: any[]) => mockCreatePonderPacket(...args),
  revisePonderPacket: (...args: any[]) => mockRevisePonderPacket(...args),
  findHarnessFrictionPacket: (...args: any[]) => mockFindHarnessFrictionPacket(...args),
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

function settleChunks(answer: string) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_final", function: { name: "settle", arguments: "" } }]),
    makeChunk(undefined, [{ index: 0, function: { arguments: JSON.stringify({ answer, intent: "complete" }) } }]),
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
    mockCreateObligation.mockReset().mockReturnValue({ id: "obl-test-123" })
    mockCreateReturnObligation.mockReset()
    mockGenerateObligationId.mockReset().mockReturnValue("ret-test-123")
    mockCreatePonderPacket.mockClear()
    mockRevisePonderPacket.mockReset()
    mockFindHarnessFrictionPacket.mockReset().mockReturnValue(null)
    await setupMinimax()
    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  it("creates a packet and keeps the turn alive until settle", async () => {
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
      }),
    )
    expect(mockCreateReturnObligation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        id: "ret-test-123",
        packetId: "pkt-test-123",
        status: "queued",
      }),
    )
    expect(mockQueuePendingMessage).not.toHaveBeenCalled()
    expect(mockRequestInnerWake).toHaveBeenCalledWith("testagent")
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

    await runAgent([{ role: "user", content: "hi" }], makeCallbacks(), "cli")

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

    await runAgent([{ role: "user", content: "hi" }], makeCallbacks(), "cli")

    expect(mockCreateReturnObligation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        delegatedContent: "Objective fallback",
      }),
    )
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

    await runAgent([{ role: "user", content: "hi" }], makeCallbacks(), "cli")

    expect(mockCreateReturnObligation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        delegatedContent: `${"B".repeat(117)}...`,
      }),
    )
  })
})
