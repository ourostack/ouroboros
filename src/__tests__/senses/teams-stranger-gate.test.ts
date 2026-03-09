import { beforeEach, describe, expect, it, vi } from "vitest"

const mockRunAgent = vi.fn()
const mockBuildSystem = vi.fn()
const mockLoadSession = vi.fn()
const mockPostTurn = vi.fn()
const mockCreateTraceId = vi.fn()
const mockResolve = vi.fn()
const mockEnforceTrustGate = vi.fn()

vi.mock("../../heart/core", () => ({
  runAgent: (...args: any[]) => mockRunAgent(...args),
  createSummarize: () => vi.fn(),
}))

vi.mock("../../mind/prompt", () => ({
  buildSystem: (...args: any[]) => mockBuildSystem(...args),
}))

vi.mock("../../mind/context", () => ({
  loadSession: (...args: any[]) => mockLoadSession(...args),
  postTurn: (...args: any[]) => mockPostTurn(...args),
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
    dispatch: vi.fn(() => ({ handled: false })),
  })),
  registerDefaultCommands: vi.fn(),
  parseSlashCommand: vi.fn(() => null),
}))

vi.mock("../../nerves", () => ({
  createTraceId: (...args: any[]) => mockCreateTraceId(...args),
}))

vi.mock("../../mind/friends/store-file", () => ({
  FileFriendStore: vi.fn(function (this: any) {
    this.get = vi.fn()
    this.put = vi.fn()
    this.delete = vi.fn()
    this.findByExternalId = vi.fn()
  }),
}))

vi.mock("../../mind/friends/resolver", () => ({
  FriendResolver: vi.fn(function (this: any) {
    this.resolve = (...args: any[]) => mockResolve(...args)
  }),
}))

vi.mock("../../mind/friends/tokens", () => ({
  accumulateFriendTokens: vi.fn(),
}))

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
    configPath: "~/.agentsecrets/testagent/secrets.json",
    context: { maxTokens: 80000, contextMargin: 20 },
    phrases: {
      thinking: ["thinking"],
      tool: ["tooling"],
      followup: ["followup"],
    },
  })),
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getRepoRoot: vi.fn(() => "/tmp/mock-repo"),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../senses/trust-gate", () => ({
  enforceTrustGate: (...args: any[]) => mockEnforceTrustGate(...args),
}))

describe("teams stranger gate integration", () => {
  beforeEach(() => {
    vi.resetModules()
    mockRunAgent.mockReset().mockResolvedValue({ usage: undefined })
    mockBuildSystem.mockReset().mockResolvedValue("system prompt")
    mockLoadSession.mockReset().mockReturnValue(null)
    mockPostTurn.mockReset()
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
  })

  it("blocks stranger traffic before runAgent and sends first auto-reply", async () => {
    mockEnforceTrustGate.mockReturnValueOnce({
      allowed: false,
      reason: "stranger_first_reply",
      autoReply: "I'm sorry, I'm not allowed to talk to strangers",
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

    expect(mockEnforceTrustGate).toHaveBeenCalled()
    expect(stream.emit).toHaveBeenCalledWith("I'm sorry, I'm not allowed to talk to strangers")
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it("silently drops subsequent stranger traffic before runAgent", async () => {
    mockEnforceTrustGate.mockReturnValueOnce({
      allowed: false,
      reason: "stranger_silent_drop",
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

    expect(mockEnforceTrustGate).toHaveBeenCalled()
    expect(stream.emit).not.toHaveBeenCalled()
    expect(mockRunAgent).not.toHaveBeenCalled()
  })
})
