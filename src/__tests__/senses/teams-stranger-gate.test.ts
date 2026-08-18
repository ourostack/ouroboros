import { beforeEach, describe, expect, it, vi } from "vitest"

// After pipeline refactor (U7), Teams no longer calls enforceTrustGate directly.
// Trust gate is handled by handleInboundTurn in the shared pipeline.
// Teams is a "closed" sense, so the gate allows everyone through.
// This test verifies that Teams:
// 1. Delegates to handleInboundTurn (pipeline)
// 2. Handles gate rejection results from the pipeline (auto-reply via stream)
// 3. Does NOT call enforceTrustGate directly

const mockRunAgent = vi.fn()
const mockBuildSystem = vi.fn()
const mockLoadSession = vi.fn()
const mockPostTurnTrim = vi.fn().mockReturnValue({ currentMessages: [], trimmedMessages: [], currentIngressTimes: [], maxTokens: 128000, contextMargin: 0 })
const mockDeferPostTurnPersist = vi.fn().mockResolvedValue([])
const mockCreateTraceId = vi.fn()
const mockResolve = vi.fn()
const mockHandleInboundTurn = vi.fn()

vi.mock("../../heart/core", () => ({
  runAgent: (...args: any[]) => mockRunAgent(...args),
  createSummarize: () => vi.fn(),
  repairOrphanedToolCalls: vi.fn(),
}))

// Hard-mock the daemon socket client. The runtime guard in socket-client.ts
// already prevents real socket calls under vitest (by detecting process.argv),
// but the explicit mock lets tests that care assert on call counts and avoids
// the per-file allowlist in test-isolation.contract.test.ts.
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

vi.mock("../../mind/prompt", () => ({
  buildSystem: (...args: any[]) => mockBuildSystem(...args),
  flattenSystemPrompt: (sp: any) => [sp?.stable, sp?.volatile].filter(Boolean).join("\n\n"),
}))

vi.mock("../../mind/context", () => ({
  loadSession: (...args: any[]) => mockLoadSession(...args),
  postTurnTrim: (...args: any[]) => mockPostTurnTrim(...args),
  deferPostTurnPersist: (...args: any[]) => mockDeferPostTurnPersist(...args),
  deleteSession: vi.fn(),
}))

vi.mock("../../heart/config", () => ({
  sessionPath: vi.fn(() => "/tmp/mock-session.json"),
  getTeamsConfig: vi.fn(() => ({ clientId: "", clientSecret: "", tenantId: "" })),
  getTeamsChannelConfig: vi.fn(() => ({ skipConfirmation: true, flushIntervalMs: 1000, port: 3978 })),
  getOAuthConfig: vi.fn(() => ({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "github" })),
}))

vi.mock("../../senses/commands", () => ({
  createCommandRegistry: vi.fn(() => ({
    register: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    dispatch: vi.fn(() => ({ handled: false })),
  })),
  registerDefaultCommands: vi.fn(),
  parseSlashCommand: vi.fn(() => null),
  getSharedCommandRegistry: vi.fn(() => ({
    register: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    dispatch: vi.fn(() => ({ handled: false })),
  })),
  resetSharedCommandRegistry: vi.fn(),
  getDebugMode: vi.fn(() => false),
  resetDebugMode: vi.fn(),
  getToolChoiceRequired: vi.fn(() => false),
  resetToolChoiceRequired: vi.fn(),
}))

vi.mock("../../nerves", () => ({
  createTraceId: (...args: any[]) => mockCreateTraceId(...args),
}))

// Friends now lives in the @ouro.bot/friends package (a single barrel module).
// The previously separate store-file/resolver/tokens mocks merge into one package
// mock that spreads the real barrel and overrides the three used symbols.
vi.mock("@ouro.bot/friends", async () => {
  const actual = await vi.importActual<typeof import("@ouro.bot/friends")>("@ouro.bot/friends")
  return {
    ...actual,
    FileFriendStore: vi.fn(function (this: any) {
      this.get = vi.fn()
      this.put = vi.fn()
      this.delete = vi.fn()
      this.findByExternalId = vi.fn()
    }),
    FriendResolver: vi.fn(function (this: any) {
      this.resolve = (...args: any[]) => mockResolve(...args)
    }),
    accumulateFriendTokens: vi.fn(),
  }
})

vi.mock("../../heart/turn-coordinator", () => ({
  createTurnCoordinator: vi.fn(() => ({
    tryBeginTurn: vi.fn(() => true),
    endTurn: vi.fn(),
    enqueueFollowUp: vi.fn(),
    drainFollowUps: vi.fn(() => []),
    withTurnLock: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()),
  })),
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/tmp/mock-agent"),
  resetAgentConfigCache: vi.fn(),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "minimax",
    context: { maxTokens: 80000, contextMargin: 20 },
    phrases: {
      thinking: ["thinking"],
      tool: ["tooling"],
      followup: ["followup"],
    },
  })),
  getAgentName: vi.fn(() => "testagent"),
  getRepoRoot: vi.fn(() => "/tmp/mock-repo"),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

// Pipeline mock -- Teams now delegates to handleInboundTurn
vi.mock("../../senses/pipeline", () => ({
  handleInboundTurn: (...args: any[]) => mockHandleInboundTurn(...args),
}))

describe("teams stranger gate integration (pipeline-based)", () => {
  beforeEach(() => {
    mockRunAgent.mockReset().mockResolvedValue({ usage: undefined })
    mockBuildSystem.mockReset().mockResolvedValue({ stable: "system prompt", volatile: "" })
    mockLoadSession.mockReset().mockReturnValue(null)
    mockPostTurnTrim.mockReset().mockReturnValue({ currentMessages: [], trimmedMessages: [], currentIngressTimes: [], maxTokens: 128000, contextMargin: 0 })
    mockDeferPostTurnPersist.mockReset().mockResolvedValue([])
    mockCreateTraceId.mockReset().mockReturnValue("trace-1")
    mockResolve.mockReset().mockResolvedValue({
      friend: {
        id: "friend-1",
        name: "Unknown",
        role: "stranger",
        trustLevel: "stranger",
        connections: [],
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-03-07T00:00:00.000Z",
        updatedAt: "2026-03-07T00:00:00.000Z",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams",
        availableIntegrations: [],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    })

    // Default: pipeline simulates successful turn
    mockHandleInboundTurn.mockReset().mockImplementation(async (input: any) => {
      const resolvedContext = await input.friendResolver.resolve()
      const session = await input.sessionLoader.loadOrCreate()
      const msgs = session.messages
      for (const m of input.messages) msgs.push(m)
      const existingToolContext = input.runAgentOptions?.toolContext
      const pipelineOpts = {
        ...input.runAgentOptions,
        toolContext: {
          signin: async () => undefined,
          ...existingToolContext,
          context: resolvedContext,
          friendStore: input.friendStore,
        },
      }
      const result = await input.runAgent(msgs, input.callbacks, input.channel, input.signal, pipelineOpts)
      input.postTurn(msgs, session.sessionPath, result.usage)
      await input.accumulateFriendTokens(input.friendStore, resolvedContext.friend.id, result.usage)
      return {
        resolvedContext,
        gateResult: { allowed: true },
        usage: result.usage,
        sessionPath: session.sessionPath,
        messages: msgs,
      }
    })
  })

  it("delegates trust gating to pipeline (does not call enforceTrustGate directly)", async () => {
    const { handleTeamsMessage } = await import("../../senses/teams")

    const stream = {
      update: vi.fn(),
      emit: vi.fn(),
      close: vi.fn(),
    }

    await handleTeamsMessage(
      "hello",
      stream as any,
      "conv-1",
      {
        signin: vi.fn(async () => undefined),
        aadObjectId: "aad-user-1",
        tenantId: "tenant-1",
        displayName: "Unknown",
      },
    )

    // Pipeline should be called
    expect(mockHandleInboundTurn).toHaveBeenCalled()
    // Pipeline passes enforceTrustGate as dependency
    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(typeof input.enforceTrustGate).toBe("function")
  })

  it("behaviorally holds the turn lease before load/provider through persistence and stream delivery", async () => {
    const entered = Promise.withResolvers<void>()
    const allowTurn = Promise.withResolvers<void>()
    const order: string[] = []
    const withSessionTurnLease = vi.fn(async (_path: string, work: (lease: any) => Promise<any>) => {
      order.push("lease:acquired")
      entered.resolve()
      await allowTurn.promise
      const result = await work({ sessionPath: "/tmp/mock-session.json", ownerId: "owner-a", ownerToken: "token-a" })
      order.push("lease:released")
      return result
    })
    mockLoadSession.mockImplementation(() => { order.push("session:load"); return null })
    mockRunAgent.mockImplementation(async () => { order.push("provider:run"); return { outcome: "settled" } })
    mockDeferPostTurnPersist.mockImplementation(async () => { order.push("session:persist"); return [] })
    const stream = {
      update: vi.fn(),
      emit: vi.fn(() => { order.push("outward:delivered") }),
      close: vi.fn(),
    }
    const { handleTeamsMessage } = await import("../../senses/teams")
    const running = handleTeamsMessage(
      "hello",
      stream as any,
      "conv-lease",
      { signin: vi.fn(async () => undefined), aadObjectId: "aad-user-1", tenantId: "tenant-1", displayName: "Unknown" },
      undefined,
      undefined,
      { _withSessionTurnLease: withSessionTurnLease } as any,
    )

    await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("lease was not acquired")), 100))])
    expect(mockHandleInboundTurn).not.toHaveBeenCalled()
    expect(mockLoadSession).not.toHaveBeenCalled()
    expect(mockRunAgent).not.toHaveBeenCalled()
    allowTurn.resolve()
    await running

    expect(order.indexOf("lease:acquired")).toBe(0)
    expect(order.indexOf("session:load")).toBeGreaterThan(0)
    expect(order.indexOf("provider:run")).toBeGreaterThan(order.indexOf("session:load"))
    expect(order.indexOf("session:persist")).toBeGreaterThan(order.indexOf("provider:run"))
    expect(order.indexOf("lease:released")).toBeGreaterThan(order.indexOf("session:persist"))
    expect(order.indexOf("lease:released")).toBeGreaterThan(order.lastIndexOf("outward:delivered"))
  })

  it("emits no thinking activity before a busy lease decision and returns a retryable notice", async () => {
    const busy = new Error("busy")
    busy.name = "SessionTurnBusyError"
    const stream = { update: vi.fn(), emit: vi.fn(), close: vi.fn() }
    const { handleTeamsMessage } = await import("../../senses/teams")

    await handleTeamsMessage(
      "hello",
      stream as any,
      "conv-busy",
      { signin: vi.fn(async () => undefined), aadObjectId: "aad-user-1", tenantId: "tenant-1", displayName: "Unknown" },
      undefined,
      undefined,
      { _withSessionTurnLease: vi.fn(async () => { throw busy }) } as any,
    )

    expect(stream.update).not.toHaveBeenCalled()
    expect(mockLoadSession).not.toHaveBeenCalled()
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(stream.emit).toHaveBeenCalledWith(expect.stringContaining("busy"))
  })

  it("sends auto-reply via stream when pipeline gate rejects with stranger_first_reply", async () => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: {
        friend: {
          id: "friend-1",
          name: "Unknown",
          trustLevel: "stranger",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: "2026-03-07T00:00:00.000Z",
          updatedAt: "2026-03-07T00:00:00.000Z",
          schemaVersion: 1,
        },
        channel: {
          channel: "teams",
          availableIntegrations: [],
          supportsMarkdown: true,
          supportsStreaming: true,
          supportsRichCards: true,
          maxMessageLength: 28000,
        },
      },
      gateResult: {
        allowed: false,
        reason: "stranger_first_reply",
        autoReply: "I'm sorry, I'm not allowed to talk to strangers",
      },
    })

    const { handleTeamsMessage } = await import("../../senses/teams")

    const stream = {
      update: vi.fn(),
      emit: vi.fn(),
      close: vi.fn(),
    }

    await handleTeamsMessage(
      "hello",
      stream as any,
      "conv-1",
      {
        signin: vi.fn(async () => undefined),
        aadObjectId: "aad-user-1",
        tenantId: "tenant-1",
        displayName: "Unknown",
      },
    )

    expect(stream.emit).toHaveBeenCalledWith("I'm sorry, I'm not allowed to talk to strangers")
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it("silently drops when pipeline gate rejects with stranger_silent_drop", async () => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: {
        friend: {
          id: "friend-1",
          name: "Unknown",
          trustLevel: "stranger",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: "2026-03-07T00:00:00.000Z",
          updatedAt: "2026-03-07T00:00:00.000Z",
          schemaVersion: 1,
        },
        channel: {
          channel: "teams",
          availableIntegrations: [],
          supportsMarkdown: true,
          supportsStreaming: true,
          supportsRichCards: true,
          maxMessageLength: 28000,
        },
      },
      gateResult: {
        allowed: false,
        reason: "stranger_silent_drop",
      },
    })

    const { handleTeamsMessage } = await import("../../senses/teams")

    const stream = {
      update: vi.fn(),
      emit: vi.fn(),
      close: vi.fn(),
    }

    await handleTeamsMessage(
      "hello again",
      stream as any,
      "conv-1",
      {
        signin: vi.fn(async () => undefined),
        aadObjectId: "aad-user-1",
        tenantId: "tenant-1",
        displayName: "Unknown",
      },
    )

    expect(stream.emit).not.toHaveBeenCalled()
    expect(mockRunAgent).not.toHaveBeenCalled()
  })
})
