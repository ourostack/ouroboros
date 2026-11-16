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
const mockDrainOutbound = vi.fn((..._args: unknown[]) => 0)
vi.mock("../../mind/outbound-record", async (original) => ({
  ...await original<typeof import("../../mind/outbound-record")>(),
  drainOutboundRecords: (...args: unknown[]) => mockDrainOutbound(...args),
}))

vi.mock("../../senses/pipeline", () => ({
  handleInboundTurn: (...args: any[]) => mockHandleInboundTurn(...args),
}))

const mockStatusAnswer = vi.fn()
vi.mock("../../senses/app-sessions/digest", () => ({ statusAnswer: (...args: any[]) => mockStatusAnswer(...args) }))

const friend = (trustLevel: string) => ({
  friend: {
    id: "friend-1", name: "Owner", role: "primary", trustLevel, connections: [], externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0,
    createdAt: "2026-03-07T00:00:00.000Z", updatedAt: "2026-03-07T00:00:00.000Z", schemaVersion: 1,
  },
  channel: { channel: "teams", availableIntegrations: [], supportsMarkdown: true, supportsStreaming: true, supportsRichCards: true, maxMessageLength: 28000 },
})

describe("teams status answer", () => {
  beforeEach(() => {
    mockRunAgent.mockReset().mockResolvedValue({ usage: undefined })
    mockBuildSystem.mockReset().mockResolvedValue({ stable: "system prompt", volatile: "" })
    mockLoadSession.mockReset().mockReturnValue(null)
    mockCreateTraceId.mockReset().mockReturnValue("trace-1")
    mockHandleInboundTurn.mockReset().mockResolvedValue({ resolvedContext: friend("family"), gateResult: { allowed: true }, messages: [] })
    mockStatusAnswer.mockReset()
  })

  const send = async (text: string) => {
    const { handleTeamsMessage } = await import("../../senses/teams")
    const stream = { update: vi.fn(), emit: vi.fn(), close: vi.fn() }
    await handleTeamsMessage(text, stream as any, "conv-1", { signin: vi.fn(async () => undefined), aadObjectId: "aad-1", tenantId: "t-1", displayName: "Owner" })
    return stream
  }

  it("answers the owner's status question from the digest, with no model turn", async () => {
    mockResolve.mockReset().mockResolvedValue(friend("family"))
    mockStatusAnswer.mockReturnValue("**Ouroboros status**")
    const stream = await send("how's it going?")
    expect(mockStatusAnswer).toHaveBeenCalledWith("how's it going?", "/tmp/mock-agent", expect.any(Number))
    expect(stream.emit).toHaveBeenCalledWith("**Ouroboros status**")
    expect(mockHandleInboundTurn).not.toHaveBeenCalled()
  })

  it("leaves any other message from the owner to the agent", async () => {
    mockResolve.mockReset().mockResolvedValue(friend("family"))
    mockStatusAnswer.mockReturnValue(null)
    await send("book me a flight")
    expect(mockHandleInboundTurn).toHaveBeenCalled()
  })

  it("puts a message sent while the turn ran into the session when the turn ends, under the same lease, before the next message", async () => {
    mockResolve.mockReset().mockResolvedValue(friend("family"))
    mockStatusAnswer.mockReturnValue(null)
    mockDrainOutbound.mockClear()
    await send("is it the latest build?")
    expect(mockDrainOutbound).toHaveBeenCalledTimes(2)
    expect(mockDrainOutbound.mock.calls[1]![4]).toBe(mockDrainOutbound.mock.calls[0]![4])
    expect(mockDrainOutbound.mock.invocationCallOrder[1]!).toBeGreaterThan(mockHandleInboundTurn.mock.invocationCallOrder.at(-1)!)
  })

  it("never answers anyone but family from the digest", async () => {
    mockResolve.mockReset().mockResolvedValue(friend("friend"))
    mockStatusAnswer.mockReturnValue("**Ouroboros status**")
    await send("how's it going?")
    expect(mockStatusAnswer).not.toHaveBeenCalled()
    expect(mockHandleInboundTurn).toHaveBeenCalled()
  })
})
