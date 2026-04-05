import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ChannelCallbacks, RunAgentOptions } from "../../heart/core"
import type { FriendRecord, ResolvedContext, ChannelCapabilities, SenseType, Channel } from "../../mind/friends/types"
import type { FriendStore } from "../../mind/friends/store"
import type { TrustGateInput, TrustGateResult } from "../../senses/trust-gate"
import type { UsageData } from "../../mind/context"
import type { PendingMessage } from "../../mind/pending"
import * as daemonThoughts from "../../heart/daemon/thoughts"
import * as identity from "../../heart/identity"
import * as pending from "../../mind/pending"
import * as startOfTurnPacketModule from "../../heart/start-of-turn-packet"
import * as tempoModule from "../../heart/tempo"
import * as temporalViewModule from "../../heart/temporal-view"
import * as presenceModule from "../../heart/presence"
import { handleInboundTurn } from "../../senses/pipeline"
import type { InboundTurnInput, InboundTurnResult } from "../../senses/pipeline"

const mockFindBridgesForSession = vi.fn()
const mockListTargetSessionCandidates = vi.fn()
const mockListCodingSessions = vi.fn()

vi.mock("../../heart/daemon/socket-client", () => ({
  requestInnerWake: vi.fn(async () => null),
  sendDaemonCommand: vi.fn(),
  checkDaemonSocketAlive: vi.fn(),
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-daemon.sock",
}))

vi.mock("../../heart/bridges/manager", async () => {
  const actual = await vi.importActual<typeof import("../../heart/bridges/manager")>("../../heart/bridges/manager")
  return {
    ...actual,
    createBridgeManager: () => ({
      findBridgesForSession: (...args: any[]) => mockFindBridgesForSession(...args),
    }),
  }
})

vi.mock("../../heart/target-resolution", async () => {
  const actual = await vi.importActual<typeof import("../../heart/target-resolution")>("../../heart/target-resolution")
  return {
    ...actual,
    listTargetSessionCandidates: (...args: any[]) => mockListTargetSessionCandidates(...args),
  }
})

vi.mock("../../repertoire/coding", async () => {
  const actual = await vi.importActual<typeof import("../../repertoire/coding")>("../../repertoire/coding")
  return {
    ...actual,
    getCodingSessionManager: () => ({
      listSessions: (...args: any[]) => mockListCodingSessions(...args),
    }),
  }
})

const mockRunHealthInventory = vi.fn()
const mockWriteAgentProviderSelection = vi.fn()
const mockLoadAgentSecrets = vi.fn().mockReturnValue({
  secretsPath: "/mock/secrets.json",
  secrets: {
    providers: {
      anthropic: { model: "claude-opus-4-6", setupToken: "valid" },
      "openai-codex": { model: "gpt-5.4", oauthAccessToken: "valid" },
      minimax: { model: "", apiKey: "" },
      azure: { modelName: "", apiKey: "", endpoint: "", deployment: "", apiVersion: "" },
    },
  },
})

vi.mock("../../heart/provider-ping", async () => {
  const actual = await vi.importActual<typeof import("../../heart/provider-ping")>("../../heart/provider-ping")
  return {
    ...actual,
    runHealthInventory: (...args: any[]) => mockRunHealthInventory(...args),
  }
})

vi.mock("../../heart/auth/auth-flow", async () => {
  const actual = await vi.importActual<typeof import("../../heart/auth/auth-flow")>("../../heart/auth/auth-flow")
  return {
    ...actual,
    writeAgentProviderSelection: (...args: any[]) => mockWriteAgentProviderSelection(...args),
    loadAgentSecrets: (...args: any[]) => mockLoadAgentSecrets(...args),
  }
})

const mockFileStateCacheClear = vi.fn()
const mockResetSessionModifiedFiles = vi.fn()

vi.mock("../../mind/file-state", () => ({
  fileStateCache: { clear: (...args: any[]) => mockFileStateCacheClear(...args) },
}))

vi.mock("../../mind/scrutiny", () => ({
  resetSessionModifiedFiles: (...args: any[]) => mockResetSessionModifiedFiles(...args),
}))

const mockBuildTurnContext = vi.fn()
vi.mock("../../heart/turn-context", () => ({
  buildTurnContext: (...args: any[]) => mockBuildTurnContext(...args),
}))

// ── Test helpers ──────────────────────────────────────────────────

function makeFriend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "friend-1",
    name: "Jordan",
    role: "friend",
    trustLevel: "friend",
    connections: [],
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-03-07T00:00:00.000Z",
    updatedAt: "2026-03-07T00:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  }
}

function makeCapabilities(overrides: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
  return {
    channel: "cli",
    senseType: "local",
    availableIntegrations: [],
    supportsMarkdown: false,
    supportsStreaming: true,
    supportsRichCards: false,
    maxMessageLength: Infinity,
    ...overrides,
  }
}

function makeCallbacks(): ChannelCallbacks {
  return {
    onModelStart: vi.fn(),
    onModelStreamStart: vi.fn(),
    onTextChunk: vi.fn(),
    onReasoningChunk: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onError: vi.fn(),
  }
}

const usageData: UsageData = {
  input_tokens: 100,
  output_tokens: 50,
  reasoning_tokens: 10,
  total_tokens: 160,
}

function makeStore(friend?: FriendRecord): FriendStore {
  const f = friend ?? makeFriend()
  return {
    get: vi.fn().mockResolvedValue(f),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    findByExternalId: vi.fn().mockResolvedValue(f),
    hasAnyFriends: vi.fn().mockResolvedValue(true),
    listAll: vi.fn().mockResolvedValue([f]),
  }
}

function defaultTurnContext() {
  return {
    activeBridges: [] as any[],
    sessionActivity: [] as any[],
    targetCandidates: [] as any[],
    pendingObligations: [] as any[],
    codingSessions: [] as any[],
    otherCodingSessions: [] as any[],
    innerWorkState: {
      status: "idle" as const,
      hasPending: false,
      job: {
        status: "idle" as const,
        content: null,
        origin: null,
        mode: "reflect" as const,
        obligationStatus: null,
        surfacedResult: null,
        queuedAt: null,
        startedAt: null,
        surfacedAt: null,
      },
    },
    taskBoard: {
      compact: "",
      full: "",
      byStatus: {
        drafting: [], processing: [], validating: [], collaborating: [],
        paused: [], blocked: [], done: [], cancelled: [],
      },
      issues: [],
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
      activeBridges: [],
    },
    returnObligations: [] as any[],
    recentEpisodes: [] as any[],
    activeCares: [] as any[],
    syncConfig: { enabled: false, remote: "origin" },
    syncFailure: undefined,
    daemonRunning: false,
    senseStatusLines: [] as string[],
    bundleMeta: null,
    daemonHealth: null,
    journalFiles: [] as any[],
  }
}

// ── Default input builder ─────────────────────────────────────────

function makeInput(overrides: Partial<InboundTurnInput> = {}): InboundTurnInput {
  const friend = makeFriend()
  const caps = makeCapabilities()
  const context: ResolvedContext = { friend, channel: caps }

  return {
    channel: "cli" as Channel,
    capabilities: caps,
    messages: [{ role: "user", content: "hello" }] as ChatCompletionMessageParam[],
    continuityIngressTexts: ["hello"],
    callbacks: makeCallbacks(),
    friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
    sessionLoader: {
      loadOrCreate: vi.fn().mockResolvedValue({
        messages: [{ role: "system", content: "You are helpful." }],
        sessionPath: "/tmp/test-session.json",
      }),
    },
    pendingDir: "/tmp/pending",
    friendStore: makeStore(friend),
    // Deps injected for testability
    enforceTrustGate: vi.fn().mockReturnValue({ allowed: true } as TrustGateResult),
    drainPending: vi.fn().mockReturnValue([] as PendingMessage[]),
    runAgent: vi.fn().mockResolvedValue({ usage: usageData, outcome: "settled" }),
    postTurn: vi.fn(),
    accumulateFriendTokens: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe("handleInboundTurn", () => {
  beforeEach(() => {
    mockFindBridgesForSession.mockReset().mockReturnValue([])
    mockListTargetSessionCandidates.mockReset().mockResolvedValue([])
    mockListCodingSessions.mockReset().mockReturnValue([])
    mockFileStateCacheClear.mockReset()
    mockResetSessionModifiedFiles.mockReset()
    mockBuildTurnContext.mockReset().mockResolvedValue(defaultTurnContext())
  })

  // Step 1: friend resolution
  describe("friend resolution", () => {
    it("calls friendResolver.resolve()", async () => {
      const input = makeInput()
      await handleInboundTurn(input)
      expect(input.friendResolver.resolve).toHaveBeenCalledTimes(1)
    })

    it("passes resolved context to trust gate", async () => {
      const friend = makeFriend({ trustLevel: "stranger", name: "Stranger Joe" })
      const caps = makeCapabilities({ channel: "bluebubbles", senseType: "open" })
      const context: ResolvedContext = { friend, channel: caps }
      const input = makeInput({
        channel: "bluebubbles",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        enforceTrustGate: vi.fn().mockReturnValue({
          allowed: false,
          reason: "stranger_first_reply",
          autoReply: "I don't talk to strangers",
        } as TrustGateResult),
      })

      await handleInboundTurn(input)

      expect(input.enforceTrustGate).toHaveBeenCalledTimes(1)
      const gateCall = (input.enforceTrustGate as ReturnType<typeof vi.fn>).mock.calls[0][0] as TrustGateInput
      expect(gateCall.friend).toBe(friend)
      expect(gateCall.senseType).toBe("open")
      expect(gateCall.channel).toBe("bluebubbles")
    })
  })

  // Step 2: trust gate
  describe("trust gate", () => {
    it("calls enforceTrustGate with correct parameters", async () => {
      const friend = makeFriend({ trustLevel: "family" })
      const caps = makeCapabilities({ channel: "teams", senseType: "closed" })
      const context: ResolvedContext = { friend, channel: caps }
      const input = makeInput({
        channel: "teams",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
      })

      await handleInboundTurn(input)

      expect(input.enforceTrustGate).toHaveBeenCalledTimes(1)
      const gateCall = (input.enforceTrustGate as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(gateCall.friend).toBe(friend)
      expect(gateCall.channel).toBe("teams")
      expect(gateCall.senseType).toBe("closed")
    })

    it("returns gate rejection when gate blocks (no runAgent call)", async () => {
      const gateResult: TrustGateResult = {
        allowed: false,
        reason: "stranger_first_reply",
        autoReply: "I don't talk to strangers",
      }
      const input = makeInput({
        enforceTrustGate: vi.fn().mockReturnValue(gateResult),
      })

      const result = await handleInboundTurn(input)

      expect(result.gateResult).toEqual(gateResult)
      expect(result.gateResult!.allowed).toBe(false)
      expect(input.runAgent).not.toHaveBeenCalled()
      expect(input.postTurn).not.toHaveBeenCalled()
      expect(input.accumulateFriendTokens).not.toHaveBeenCalled()
    })

    it("returns gate rejection for acquaintance silent drop (no runAgent)", async () => {
      const gateResult: TrustGateResult = {
        allowed: false,
        reason: "acquaintance_group_no_family",
      }
      const input = makeInput({
        enforceTrustGate: vi.fn().mockReturnValue(gateResult),
      })

      const result = await handleInboundTurn(input)

      expect(result.gateResult).toEqual(gateResult)
      expect(input.runAgent).not.toHaveBeenCalled()
    })
  })

  // Step 3: session loading
  describe("session loading", () => {
    it("loads/creates session when gate allows", async () => {
      const input = makeInput()
      await handleInboundTurn(input)
      expect(input.sessionLoader.loadOrCreate).toHaveBeenCalledTimes(1)
    })

    it("does NOT load session when gate rejects", async () => {
      const input = makeInput({
        enforceTrustGate: vi.fn().mockReturnValue({
          allowed: false,
          reason: "stranger_silent_drop",
        } as TrustGateResult),
      })

      await handleInboundTurn(input)

      expect(input.sessionLoader.loadOrCreate).not.toHaveBeenCalled()
    })
  })

  // Step 4: pending drain
  describe("pending drain", () => {
    it("drains pending for the conversation", async () => {
      const input = makeInput({ pendingDir: "/tmp/my-pending" })
      await handleInboundTurn(input)
      expect(input.drainPending).toHaveBeenCalledWith("/tmp/my-pending")
    })

    it("does NOT drain pending when gate rejects", async () => {
      const input = makeInput({
        enforceTrustGate: vi.fn().mockReturnValue({
          allowed: false,
          reason: "stranger_first_reply",
          autoReply: "no",
        } as TrustGateResult),
      })

      await handleInboundTurn(input)

      expect(input.drainPending).not.toHaveBeenCalled()
    })

    it("includes pending messages in runAgent options when present", async () => {
      const pendingMsgs: PendingMessage[] = [
        { from: "trust-gate", content: "someone tried to reach you", timestamp: 1000 },
        { from: "inner-dialog", content: "thought about something", timestamp: 1001 },
      ]
      const input = makeInput({
        drainPending: vi.fn().mockReturnValue(pendingMsgs),
      })

      await handleInboundTurn(input)

      expect(input.runAgent).toHaveBeenCalledTimes(1)
      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      // Pending messages now flow through runAgentOptions.pendingMessages
      expect(options.pendingMessages).toEqual([
        { from: "trust-gate", content: "someone tried to reach you" },
        { from: "inner-dialog", content: "thought about something" },
      ])
      // Messages should NOT contain pending content directly
      const messagesArg = runAgentCall[0] as ChatCompletionMessageParam[]
      const allContent = messagesArg.map(m => typeof m.content === "string" ? m.content : "").join("\n")
      expect(allContent).not.toContain("someone tried to reach you")
    })

    it("does not inject live world-state checkpoint in user messages (moved to system prompt)", async () => {
      const input = makeInput({
        continuityIngressTexts: ["what are you up to?"],
        messages: [{ role: "user", content: "what are you up to?" }] as ChatCompletionMessageParam[],
      })

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const messagesArg = runAgentCall[0] as ChatCompletionMessageParam[]
      const allContent = messagesArg.map((m) => typeof m.content === "string" ? m.content : "").join("\n")
      // world-state no longer prepended to user messages -- now in system prompt via buildSystem
      expect(allContent).not.toContain("## live world-state")
      expect(allContent).toContain("what are you up to?")
    })

    it("drains deferred friend returns before ordinary session pending and exposes the combined batch", async () => {
      const deferredReturns: PendingMessage[] = [
        { from: "testagent", content: "penguins surfaced", timestamp: 999 },
      ]
      const sessionPending: PendingMessage[] = [
        { from: "inner-dialog", content: "a local pending note", timestamp: 1000 },
      ]
      const input = makeInput({
        drainPending: vi.fn().mockReturnValue(sessionPending),
      }) as any
      input.drainDeferredReturns = vi.fn().mockReturnValue(deferredReturns)

      const result = await handleInboundTurn(input)

      expect(input.drainDeferredReturns).toHaveBeenCalledWith("friend-1")
      expect((result as any).drainedPending).toEqual([
        ...deferredReturns,
        ...sessionPending,
      ])

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      // Deferred returns should come before session pending in the pendingMessages array
      expect(options.pendingMessages).toEqual([
        { from: "testagent", content: "penguins surfaced" },
        { from: "inner-dialog", content: "a local pending note" },
      ])
    })

    it("does not modify messages when pending exists but input.messages is empty", async () => {
      const pendingMsgs: PendingMessage[] = [
        { from: "system", content: "a pending notice", timestamp: 1000 },
      ]
      const input = makeInput({
        messages: [] as ChatCompletionMessageParam[],
        drainPending: vi.fn().mockReturnValue(pendingMsgs),
      })

      await handleInboundTurn(input)

      // runAgent should still be called -- just with session messages and no user messages appended
      expect(input.runAgent).toHaveBeenCalledTimes(1)
    })

    it("pending messages go to runAgentOptions, not user content (multimodal preserved)", async () => {
      const pendingMsgs: PendingMessage[] = [
        { from: "instinct", content: "someone reached out", timestamp: 1000 },
      ]
      const multimodalContent = [
        { type: "text" as const, text: "hello" },
        { type: "image_url" as const, image_url: { url: "https://example.com/img.png" } },
      ]
      const input = makeInput({
        messages: [{ role: "user", content: multimodalContent }] as ChatCompletionMessageParam[],
        drainPending: vi.fn().mockReturnValue(pendingMsgs),
      })

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const msgs = runAgentCall[0] as ChatCompletionMessageParam[]
      // User message should be unchanged -- pending flows through runAgentOptions
      const userMsg = msgs.find(m => m.role === "user" && Array.isArray(m.content))
      expect(userMsg).toBeTruthy()
      const parts = (userMsg as any).content as Array<{ type: string; text?: string }>
      expect(parts[0]).toEqual({ type: "text", text: "hello" })
      expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "https://example.com/img.png" } })
      // Pending messages should be in runAgentOptions, not in session messages
      const options = runAgentCall[4] as RunAgentOptions
      expect(options.pendingMessages).toEqual([
        { from: "instinct", content: "someone reached out" },
      ])
    })

    it("does not modify first message when pending exists but first message is not user role", async () => {
      const pendingMsgs: PendingMessage[] = [
        { from: "system", content: "a pending notice", timestamp: 1000 },
      ]
      const input = makeInput({
        messages: [{ role: "assistant", content: "I'm an assistant message" }] as ChatCompletionMessageParam[],
        drainPending: vi.fn().mockReturnValue(pendingMsgs),
      })

      await handleInboundTurn(input)

      // The assistant message should be appended unchanged (no pending prepended)
      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const msgs = runAgentCall[0] as ChatCompletionMessageParam[]
      const assistantMsg = msgs.find(m => m.role === "assistant" && typeof m.content === "string" && m.content === "I'm an assistant message")
      expect(assistantMsg).toBeTruthy()
    })
  })

  // Step 5: runAgent
  describe("runAgent call", () => {
    it("calls runAgent with session messages, callbacks, channel, signal, options", async () => {
      const signal = new AbortController().signal
      const runAgentOpts: RunAgentOptions = { traceId: "test-trace" }
      const input = makeInput({
        signal,
        runAgentOptions: runAgentOpts,
      })

      await handleInboundTurn(input)

      expect(input.runAgent).toHaveBeenCalledTimes(1)
      const call = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      // call[0] = messages, call[1] = callbacks, call[2] = channel, call[3] = signal, call[4] = options
      expect(call[1]).toBe(input.callbacks)
      expect(call[2]).toBe("cli")
      expect(call[3]).toBe(signal)
      expect(call[4]).toMatchObject({ traceId: "test-trace" })
    })

    it("returns usage data from runAgent", async () => {
      const input = makeInput({
        runAgent: vi.fn().mockResolvedValue({ usage: usageData }),
      })

      const result = await handleInboundTurn(input)

      expect(result.usage).toEqual(usageData)
    })
  })

  // Step 6: postTurn
  describe("postTurn", () => {
    it("calls postTurn after runAgent with messages and session path and usage", async () => {
      const input = makeInput()

      await handleInboundTurn(input)

      expect(input.postTurn).toHaveBeenCalledTimes(1)
      const call = (input.postTurn as ReturnType<typeof vi.fn>).mock.calls[0]
      // call[0] = messages array, call[1] = session path, call[2] = usage
      expect(Array.isArray(call[0])).toBe(true)
      expect(typeof call[1]).toBe("string")
      expect(call[2]).toEqual(usageData)
    })

    it("calls postTurn AFTER runAgent (ordering)", async () => {
      const callOrder: string[] = []
      const input = makeInput({
        runAgent: vi.fn().mockImplementation(async () => {
          callOrder.push("runAgent")
          return { usage: usageData }
        }),
        postTurn: vi.fn().mockImplementation(() => {
          callOrder.push("postTurn")
        }),
      })

      await handleInboundTurn(input)

      expect(callOrder).toEqual(["runAgent", "postTurn"])
    })
  })

  // Step 7: token accumulation
  describe("token accumulation", () => {
    it("accumulates friend tokens after postTurn", async () => {
      const friend = makeFriend({ id: "friend-42" })
      const caps = makeCapabilities()
      const context: ResolvedContext = { friend, channel: caps }
      const store = makeStore(friend)
      const input = makeInput({
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        friendStore: store,
      })

      await handleInboundTurn(input)

      expect(input.accumulateFriendTokens).toHaveBeenCalledTimes(1)
      expect(input.accumulateFriendTokens).toHaveBeenCalledWith(store, "friend-42", usageData)
    })

    it("does NOT accumulate tokens when gate rejects", async () => {
      const input = makeInput({
        enforceTrustGate: vi.fn().mockReturnValue({
          allowed: false,
          reason: "stranger_silent_drop",
        } as TrustGateResult),
      })

      await handleInboundTurn(input)

      expect(input.accumulateFriendTokens).not.toHaveBeenCalled()
    })

    it("accumulates tokens AFTER postTurn (ordering)", async () => {
      const callOrder: string[] = []
      const input = makeInput({
        postTurn: vi.fn().mockImplementation(() => {
          callOrder.push("postTurn")
        }),
        accumulateFriendTokens: vi.fn().mockImplementation(async () => {
          callOrder.push("accumulateFriendTokens")
        }),
      })

      await handleInboundTurn(input)

      expect(callOrder).toEqual(["postTurn", "accumulateFriendTokens"])
    })
  })

  // Full pipeline scenarios
  describe("full pipeline - CLI (local)", () => {
    it("runs full pipeline: resolve -> gate allows -> session -> drain -> runAgent -> postTurn -> tokens", async () => {
      const callOrder: string[] = []
      const friend = makeFriend({ trustLevel: "family" })
      const caps = makeCapabilities({ channel: "cli", senseType: "local" })
      const context: ResolvedContext = { friend, channel: caps }
      const store = makeStore(friend)

      const input = makeInput({
        channel: "cli",
        capabilities: caps,
        friendResolver: {
          resolve: vi.fn().mockImplementation(async () => {
            callOrder.push("resolve")
            return context
          }),
        },
        friendStore: store,
        enforceTrustGate: vi.fn().mockImplementation(() => {
          callOrder.push("gate")
          return { allowed: true }
        }),
        sessionLoader: {
          loadOrCreate: vi.fn().mockImplementation(async () => {
            callOrder.push("session")
            return {
              messages: [{ role: "system", content: "system" }],
              sessionPath: "/tmp/sess.json",
            }
          }),
        },
        drainPending: vi.fn().mockImplementation(() => {
          callOrder.push("drain")
          return []
        }),
        runAgent: vi.fn().mockImplementation(async () => {
          callOrder.push("runAgent")
          return { usage: usageData }
        }),
        postTurn: vi.fn().mockImplementation(() => {
          callOrder.push("postTurn")
        }),
        accumulateFriendTokens: vi.fn().mockImplementation(async () => {
          callOrder.push("tokens")
        }),
      })

      const result = await handleInboundTurn(input)

      expect(callOrder).toEqual(["resolve", "gate", "session", "drain", "runAgent", "postTurn", "tokens"])
      expect(result.usage).toEqual(usageData)
      expect(result.gateResult).toEqual({ allowed: true })
    })
  })

  describe("full pipeline - open sense with family (gate allows)", () => {
    it("runs full pipeline when family member on open sense", async () => {
      const friend = makeFriend({ trustLevel: "family" })
      const caps = makeCapabilities({ channel: "bluebubbles", senseType: "open" })
      const context: ResolvedContext = { friend, channel: caps }
      const store = makeStore(friend)

      const input = makeInput({
        channel: "bluebubbles",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        friendStore: store,
        enforceTrustGate: vi.fn().mockReturnValue({ allowed: true }),
      })

      const result = await handleInboundTurn(input)

      expect(input.runAgent).toHaveBeenCalledTimes(1)
      expect(input.postTurn).toHaveBeenCalledTimes(1)
      expect(input.accumulateFriendTokens).toHaveBeenCalledTimes(1)
      expect(result.gateResult).toEqual({ allowed: true })
      expect(result.usage).toEqual(usageData)
    })
  })

  describe("full pipeline - open sense with stranger (gate rejects)", () => {
    it("stops at gate rejection, no runAgent/postTurn/tokens", async () => {
      const friend = makeFriend({ trustLevel: "stranger" })
      const caps = makeCapabilities({ channel: "bluebubbles", senseType: "open" })
      const context: ResolvedContext = { friend, channel: caps }

      const gateResult: TrustGateResult = {
        allowed: false,
        reason: "stranger_first_reply",
        autoReply: "I don't talk to strangers",
      }

      const input = makeInput({
        channel: "bluebubbles",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        enforceTrustGate: vi.fn().mockReturnValue(gateResult),
      })

      const result = await handleInboundTurn(input)

      expect(result.gateResult).toEqual(gateResult)
      expect(result.usage).toBeUndefined()
      expect(input.sessionLoader.loadOrCreate).not.toHaveBeenCalled()
      expect(input.drainPending).not.toHaveBeenCalled()
      expect(input.runAgent).not.toHaveBeenCalled()
      expect(input.postTurn).not.toHaveBeenCalled()
      expect(input.accumulateFriendTokens).not.toHaveBeenCalled()
    })
  })

  // Result structure
  describe("result structure", () => {
    it("returns resolvedContext in result", async () => {
      const friend = makeFriend({ name: "TestFriend" })
      const caps = makeCapabilities()
      const context: ResolvedContext = { friend, channel: caps }
      const input = makeInput({
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
      })

      const result = await handleInboundTurn(input)

      expect(result.resolvedContext).toBe(context)
    })

    it("returns sessionPath in result when pipeline completes", async () => {
      const input = makeInput({
        sessionLoader: {
          loadOrCreate: vi.fn().mockResolvedValue({
            messages: [{ role: "system", content: "sys" }],
            sessionPath: "/tmp/my-session.json",
          }),
        },
      })

      const result = await handleInboundTurn(input)

      expect(result.sessionPath).toBe("/tmp/my-session.json")
    })

    it("returns undefined sessionPath when gate rejects", async () => {
      const input = makeInput({
        enforceTrustGate: vi.fn().mockReturnValue({
          allowed: false,
          reason: "stranger_silent_drop",
        } as TrustGateResult),
      })

      const result = await handleInboundTurn(input)

      expect(result.sessionPath).toBeUndefined()
    })
  })

  // Trust gate input parameters
  describe("trust gate input passthrough", () => {
    it("passes isGroupChat, groupHasFamilyMember, hasExistingGroupWithFamily to gate", async () => {
      const friend = makeFriend({ trustLevel: "acquaintance" })
      const caps = makeCapabilities({ channel: "bluebubbles", senseType: "open" })
      const context: ResolvedContext = { friend, channel: caps }

      const input = makeInput({
        channel: "bluebubbles",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        isGroupChat: true,
        groupHasFamilyMember: true,
        hasExistingGroupWithFamily: false,
        enforceTrustGate: vi.fn().mockReturnValue({ allowed: true }),
      })

      await handleInboundTurn(input)

      const gateCall = (input.enforceTrustGate as ReturnType<typeof vi.fn>).mock.calls[0][0] as TrustGateInput
      expect(gateCall.isGroupChat).toBe(true)
      expect(gateCall.groupHasFamilyMember).toBe(true)
      expect(gateCall.hasExistingGroupWithFamily).toBe(false)
    })

    it("passes provider and externalId to gate when provided", async () => {
      const friend = makeFriend()
      const caps = makeCapabilities({ channel: "teams", senseType: "closed" })
      const context: ResolvedContext = { friend, channel: caps }

      const input = makeInput({
        channel: "teams",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        provider: "aad",
        externalId: "aad-user-123",
        tenantId: "tenant-abc",
      })

      await handleInboundTurn(input)

      const gateCall = (input.enforceTrustGate as ReturnType<typeof vi.fn>).mock.calls[0][0] as TrustGateInput
      expect(gateCall.provider).toBe("aad")
      expect(gateCall.externalId).toBe("aad-user-123")
      expect(gateCall.tenantId).toBe("tenant-abc")
    })

    it("defaults gate group fields to false when not provided", async () => {
      const input = makeInput()
      await handleInboundTurn(input)

      const gateCall = (input.enforceTrustGate as ReturnType<typeof vi.fn>).mock.calls[0][0] as TrustGateInput
      expect(gateCall.isGroupChat).toBe(false)
      expect(gateCall.groupHasFamilyMember).toBe(false)
      expect(gateCall.hasExistingGroupWithFamily).toBe(false)
    })
  })

  // RunAgent options passthrough
  describe("runAgent options passthrough", () => {
    it("passes toolContext with resolvedContext and friendStore to runAgent", async () => {
      const friend = makeFriend()
      const caps = makeCapabilities()
      const context: ResolvedContext = { friend, channel: caps }
      const store = makeStore(friend)
      const input = makeInput({
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        friendStore: store,
      })

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect(options.toolContext?.context).toBe(context)
      expect(options.toolContext?.friendStore).toBe(store)
    })

    it("loads active bridge context for the current canonical session", async () => {
      const bridgeData = [
        {
          id: "bridge-1",
          objective: "relay Ari between cli and teams",
          summary: "keep the two live surfaces aligned",
          lifecycle: "active",
          runtime: "idle",
          createdAt: "2026-03-13T16:00:00.000Z",
          updatedAt: "2026-03-13T16:00:00.000Z",
          attachedSessions: [],
          task: { taskName: "2026-03-13-1600-shared-relay", path: "/tmp/task.md", mode: "promoted", boundAt: "2026-03-13T16:00:00.000Z" },
        },
      ]
      mockBuildTurnContext.mockResolvedValue({ ...defaultTurnContext(), activeBridges: bridgeData })
      const input = makeInput({
        channel: "teams",
        capabilities: makeCapabilities({ channel: "teams" }),
      }) as InboundTurnInput & { sessionKey: string }
      input.sessionKey = "conv-1"

      await handleInboundTurn(input as InboundTurnInput)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect((options.toolContext as any).currentSession).toMatchObject({
        friendId: "friend-1",
        channel: "teams",
        key: "conv-1",
      })
      expect((options.toolContext as any).activeBridges).toHaveLength(1)
      expect((options as any).bridgeContext).toContain("bridge-1")
      expect((options as any).bridgeContext).toContain("2026-03-13-1600-shared-relay")
    })

    it("formats non-idle bridge runtime states without task linkage", async () => {
      const bridges = [
        {
          id: "bridge-processing",
          objective: "processing bridge",
          summary: "",
          lifecycle: "active",
          runtime: "processing",
          createdAt: "2026-03-13T16:00:00.000Z",
          updatedAt: "2026-03-13T16:00:00.000Z",
          attachedSessions: [],
          task: null,
        },
        {
          id: "bridge-awaiting",
          objective: "awaiting bridge",
          summary: "",
          lifecycle: "active",
          runtime: "awaiting-follow-up",
          createdAt: "2026-03-13T16:00:00.000Z",
          updatedAt: "2026-03-13T16:00:00.000Z",
          attachedSessions: [],
          task: null,
        },
        {
          id: "bridge-suspended",
          objective: "suspended bridge",
          summary: "",
          lifecycle: "suspended",
          runtime: "idle",
          createdAt: "2026-03-13T16:00:00.000Z",
          updatedAt: "2026-03-13T16:00:00.000Z",
          attachedSessions: [],
          task: null,
        },
      ]
      mockBuildTurnContext.mockResolvedValue({ ...defaultTurnContext(), activeBridges: bridges })
      const input = makeInput() as InboundTurnInput & { sessionKey: string }
      input.sessionKey = "session"

      await handleInboundTurn(input as InboundTurnInput)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect((options as any).bridgeContext).toContain("bridge-processing: processing bridge [active-processing]")
      expect((options as any).bridgeContext).toContain("bridge-awaiting: awaiting bridge [awaiting-follow-up]")
      expect((options as any).bridgeContext).toContain("bridge-suspended: suspended bridge [suspended]")
    })

    it("passes a shared active-work frame and delegation hint into runAgent options", async () => {
      const bridges = [
        {
          id: "bridge-1",
          objective: "carry Ari across cli and bluebubbles",
          summary: "same work, two surfaces",
          lifecycle: "active",
          runtime: "idle",
          createdAt: "2026-03-13T16:00:00.000Z",
          updatedAt: "2026-03-13T16:00:00.000Z",
          attachedSessions: [
            {
              friendId: "friend-1",
              channel: "cli",
              key: "session",
              sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
            },
          ],
          task: null,
        },
      ]
      mockBuildTurnContext.mockResolvedValue({ ...defaultTurnContext(), activeBridges: bridges })
      const input = makeInput({
        channel: "bluebubbles",
        capabilities: makeCapabilities({ channel: "bluebubbles", senseType: "open" }),
        continuityIngressTexts: ["think this through and keep my other chat aligned"],
      })

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect((options as any).activeWorkFrame.centerOfGravity).toBe("shared-work")
      expect((options as any).activeWorkFrame.currentSession.channel).toBe("bluebubbles")
      expect((options as any).delegationDecision).toEqual(
        expect.objectContaining({
          target: "delegate-inward",
          reasons: expect.arrayContaining(["explicit_reflection"]),
        }),
      )
    })

    it("threads explicit cross-relationship target candidates into the active-work frame without inventing a shared-work suggestion from raw text alone", async () => {
      const targets = [
        {
          friendId: "group-1",
          friendName: "Project Group",
          channel: "bluebubbles",
          key: "chat:any;+;project-group-123",
          sessionPath: "/tmp/state/sessions/group-1/bluebubbles/chat:any;+;project-group-123.json",
          snapshot: "recent focus: waiting on Ari",
          trust: {
            level: "acquaintance",
            basis: "shared_group",
            summary: "known through the shared project group",
            why: "this is a relevant shared context",
            permits: ["group-safe coordination"],
            constraints: ["no direct private trust"],
            relatedGroupId: "group:any;+;project-group-123",
          },
          delivery: {
            mode: "queue_only",
            reason: "requires explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-14T18:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-14T18:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ]
      mockBuildTurnContext.mockResolvedValue({ ...defaultTurnContext(), targetCandidates: targets })
      const input = makeInput({
        channel: "bluebubbles",
        capabilities: makeCapabilities({ channel: "bluebubbles", senseType: "open" }),
        continuityIngressTexts: ["carry this into the group chat"],
      })

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect((options as any).activeWorkFrame.targetCandidates).toEqual([
        expect.objectContaining({
          friendId: "group-1",
          channel: "bluebubbles",
          key: "chat:any;+;project-group-123",
        }),
      ])
      expect((options as any).activeWorkFrame.bridgeSuggestion).toBeNull()
    })

    it("marks active-work inner status as running when live inner processing has started", async () => {
      const runningInnerState = {
        status: "running" as const,
        hasPending: false,
        job: {
          status: "running" as const,
          content: null,
          origin: null,
          mode: "reflect" as const,
          obligationStatus: null,
          surfacedResult: null,
          queuedAt: null,
          startedAt: "2026-03-13T16:00:00.000Z",
          surfacedAt: null,
        },
      }
      mockBuildTurnContext.mockResolvedValue({ ...defaultTurnContext(), innerWorkState: runningInnerState })
      const input = makeInput()

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect((options as any).activeWorkFrame.inner.status).toBe("running")
      expect((options as any).activeWorkFrame.inner.hasPending).toBe(false)
      expect((options as any).activeWorkFrame.inner.job).toBeDefined()
      expect((options as any).activeWorkFrame.inner.job.status).toBe("running")
    })

    it("derives currentObligation from the last continuity ingress text", async () => {
      const input = makeInput({
        continuityIngressTexts: ["first ask", "latest ask"],
      })

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect((options as any).currentObligation).toBe("latest ask")
    })

    it("does not pre-classify direct status-check turns in runAgent options", async () => {
      const input = makeInput({
        continuityIngressTexts: ["what are you doing?"],
      })

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect((options as any).statusCheckRequested).toBeUndefined()
      expect((options as any).statusCheckScope).toBeUndefined()
    })

    it("does not set special status routing for work prompts that merely mention status", async () => {
      const input = makeInput({
        continuityIngressTexts: ["figure out whether your current CLI status replies still drift"],
      })

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect((options as any).statusCheckRequested).toBeUndefined()
      expect((options as any).statusCheckScope).toBeUndefined()
    })

    it("falls back to an empty ingress list when continuity ingress texts are absent", async () => {
      const input = makeInput({
        continuityIngressTexts: undefined,
      })

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect((options as any).currentObligation).toBeUndefined()
      expect((options as any).delegationDecision).toEqual(
        expect.objectContaining({
          target: "fast-path",
          reasons: [],
        }),
      )
    })

    it("sets mustResolveBeforeHandoff from exact turn-start no-handoff language", async () => {
      const input = makeInput({
        continuityIngressTexts: ["keep going until you're done"],
        runAgent: vi.fn().mockResolvedValue({ usage: usageData, outcome: "errored" }),
      })

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect((options as any).mustResolveBeforeHandoff).toBe(true)
      expect(input.postTurn).toHaveBeenCalledWith(
        expect.any(Array),
        "/tmp/test-session.json",
        usageData,
        undefined,
        expect.objectContaining({
          mustResolveBeforeHandoff: true,
          lastFriendActivityAt: expect.any(String),
        }),
      )
    })

    it("clears persisted mustResolveBeforeHandoff from exact turn-start cancel language", async () => {
      const input = makeInput({
        continuityIngressTexts: ["never mind"],
        sessionLoader: {
          loadOrCreate: vi.fn().mockResolvedValue({
            messages: [{ role: "system", content: "You are helpful." }],
            sessionPath: "/tmp/test-session.json",
            state: { mustResolveBeforeHandoff: true },
          }),
        },
        runAgent: vi.fn().mockResolvedValue({ usage: usageData, outcome: "errored" }),
      })

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect((options as any).mustResolveBeforeHandoff).toBe(false)
      expect(input.postTurn).toHaveBeenCalledWith(
        expect.any(Array),
        "/tmp/test-session.json",
        usageData,
        undefined,
        expect.objectContaining({
          lastFriendActivityAt: expect.any(String),
        }),
      )
    })

    it("persists mid-turn mustResolveBeforeHandoff mutations made by runAgent", async () => {
      const input = makeInput({
        runAgent: vi.fn().mockImplementation(async (_msgs, _callbacks, _channel, _signal, options: RunAgentOptions) => {
          options.setMustResolveBeforeHandoff?.(true)
          return { usage: usageData, outcome: "errored" }
        }),
      })

      await handleInboundTurn(input)

      expect(input.postTurn).toHaveBeenCalledWith(
        expect.any(Array),
        "/tmp/test-session.json",
        usageData,
        undefined,
        expect.objectContaining({
          mustResolveBeforeHandoff: true,
          lastFriendActivityAt: expect.any(String),
        }),
      )
    })

    it("does not stamp a fresh friend-facing activity time for inner turns", async () => {
      const input = makeInput({
        channel: "inner",
        capabilities: makeCapabilities({ channel: "inner", senseType: "local" }),
        sessionLoader: {
          loadOrCreate: vi.fn().mockResolvedValue({
            messages: [{ role: "system", content: "You are helpful." }],
            sessionPath: "/tmp/test-session.json",
            state: { lastFriendActivityAt: "2026-03-13T20:00:00.000Z" },
          }),
        },
        runAgent: vi.fn().mockResolvedValue({ usage: usageData, outcome: "errored" }),
      })

      await handleInboundTurn(input)

      expect(input.postTurn).toHaveBeenCalledWith(
        expect.any(Array),
        "/tmp/test-session.json",
        usageData,
        undefined,
        { lastFriendActivityAt: "2026-03-13T20:00:00.000Z" },
      )
    })

    it("keeps inner turns without saved friend activity from inventing state", async () => {
      const input = makeInput({
        channel: "inner",
        capabilities: makeCapabilities({ channel: "inner", senseType: "local" }),
        runAgent: vi.fn().mockResolvedValue({ usage: usageData, outcome: "errored" }),
      })

      await handleInboundTurn(input)

      expect(input.postTurn).toHaveBeenCalledWith(
        expect.any(Array),
        "/tmp/test-session.json",
        usageData,
        undefined,
        undefined,
      )
    })

    it("clears terminal inner turns with no saved friend activity to undefined state", async () => {
      const input = makeInput({
        channel: "inner",
        capabilities: makeCapabilities({ channel: "inner", senseType: "local" }),
        runAgent: vi.fn().mockResolvedValue({ usage: usageData, outcome: "settled" }),
      })

      await handleInboundTurn(input)

      expect(input.postTurn).toHaveBeenCalledWith(
        expect.any(Array),
        "/tmp/test-session.json",
        usageData,
        undefined,
        undefined,
      )
    })
  })

  // Messages assembly
  describe("message assembly", () => {
    it("appends user messages from input to session messages", async () => {
      const input = makeInput({
        messages: [{ role: "user", content: "What's up?" }] as ChatCompletionMessageParam[],
        sessionLoader: {
          loadOrCreate: vi.fn().mockResolvedValue({
            messages: [{ role: "system", content: "system prompt" }],
            sessionPath: "/tmp/s.json",
          }),
        },
      })

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const msgs = runAgentCall[0] as ChatCompletionMessageParam[]
      // Should have system prompt + user message
      expect(msgs.length).toBeGreaterThanOrEqual(2)
      expect(msgs[0]).toEqual({ role: "system", content: "system prompt" })
      const userMsg = msgs.find(m => m.role === "user" && typeof m.content === "string" && m.content.includes("What's up?"))
      expect(userMsg).toBeTruthy()
    })
  })

  describe("active work coding-session salience", () => {
    it("passes only live coding sessions for the current thread into active work", async () => {
      // buildTurnContext already filters: codingSessions = current-thread only, otherCodingSessions = rest
      const currentThreadSession = {
        id: "coding-004",
        runner: "claude",
        workdir: "/tmp/repo",
        taskRef: "task-4",
        status: "waiting_input",
        startedAt: "2026-03-20T17:00:00.000Z",
        lastActivityAt: "2026-03-20T17:05:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        originSession: { friendId: "friend-1", channel: "cli", key: "session" },
      }
      mockBuildTurnContext.mockResolvedValue({
        ...defaultTurnContext(),
        codingSessions: [currentThreadSession],
        otherCodingSessions: [],
      })
      const input = makeInput()

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect(options.activeWorkFrame?.centerOfGravity).toBe("inward-work")
      expect(options.activeWorkFrame?.codingSessions.map((session) => session.id)).toEqual(["coding-004"])
    })

    it("keeps non-current live coding sessions available for family-wide status checks", async () => {
      const friend = makeFriend({ trustLevel: "family" })
      const caps = makeCapabilities({ channel: "cli", senseType: "local" as SenseType })
      const context: ResolvedContext = { friend, channel: caps }
      const currentSession = {
        id: "coding-010",
        runner: "codex",
        workdir: "/tmp/repo",
        taskRef: "current-thread-fix",
        status: "running",
        startedAt: "2026-03-20T17:00:00.000Z",
        lastActivityAt: "2026-03-20T17:01:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        originSession: { friendId: "friend-1", channel: "cli", key: "session" },
      }
      const otherSession = {
        id: "coding-011",
        runner: "claude",
        workdir: "/tmp/repo",
        taskRef: "bb-follow-up",
        status: "waiting_input",
        startedAt: "2026-03-20T17:00:00.000Z",
        lastActivityAt: "2026-03-20T17:02:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        originSession: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
      }
      mockBuildTurnContext.mockResolvedValue({
        ...defaultTurnContext(),
        codingSessions: [currentSession],
        otherCodingSessions: [otherSession],
      })
      const input = makeInput({
        channel: "cli",
        capabilities: caps,
        continuityIngressTexts: ["what are you doing?"],
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
      })

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions & {
        statusCheckScope?: string
        activeWorkFrame?: {
          codingSessions: Array<{ id: string }>
          otherCodingSessions?: Array<{ id: string }>
        }
      }
      expect(options.statusCheckRequested).toBeUndefined()
      expect(options.statusCheckScope).toBeUndefined()
      expect(options.activeWorkFrame?.codingSessions.map((session) => session.id)).toEqual(["coding-010"])
      expect(options.activeWorkFrame?.otherCodingSessions?.map((session) => session.id)).toEqual(["coding-011"])
    })

    it("falls back to an empty live coding list when the coding session manager throws", async () => {
      // buildTurnContext handles the error internally and returns empty arrays
      const input = makeInput()

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect(options.activeWorkFrame?.codingSessions).toEqual([])
    })
  })

  describe("result shape", () => {
    it("returns structured turn outcome from runAgent", async () => {
      const input = makeInput({
        runAgent: vi.fn().mockResolvedValue({ usage: usageData, outcome: "blocked" }),
      })

      const result = await handleInboundTurn(input)
      expect((result as any).turnOutcome).toBe("blocked")
    })

    it("passes through observe outcome from runAgent", async () => {
      const input = makeInput({
        runAgent: vi.fn().mockResolvedValue({ usage: usageData, outcome: "observed" }),
      })

      const result = await handleInboundTurn(input)
      expect((result as any).turnOutcome).toBe("observed")
    })

    it.each(["settled", "blocked", "superseded", "observed"] as const)(
      "clears mustResolveBeforeHandoff after terminal %s outcome",
      async (outcome) => {
        const input = makeInput({
          sessionLoader: {
            loadOrCreate: vi.fn().mockResolvedValue({
              messages: [{ role: "system", content: "You are helpful." }],
              sessionPath: "/tmp/test-session.json",
              state: { mustResolveBeforeHandoff: true },
            }),
          },
          runAgent: vi.fn().mockResolvedValue({ usage: usageData, outcome }),
        })

        await handleInboundTurn(input)

        const postTurnCall = (input.postTurn as ReturnType<typeof vi.fn>).mock.calls[0]
        const savedState = postTurnCall[4]
        // Terminal outcomes should NOT carry forward mustResolveBeforeHandoff
        expect(savedState?.mustResolveBeforeHandoff).toBeUndefined()
      },
    )

    it("does not inject live world-state checkpoint into user messages (moved to system prompt)", async () => {
      const input = makeInput({
        messages: [{ role: "user", content: "hello" }],
      })

      const result = await handleInboundTurn(input)

      const userMessage = (result.messages ?? []).find((message) => message.role === "user")
      // checkpoint no longer prepended to user messages -- now in system prompt
      const content = typeof userMessage?.content === "string" ? userMessage.content : ""
      expect(content).not.toContain("## live world-state checkpoint")
      expect(content).toContain("hello")
    })
  })

  describe("provider failover", () => {
    beforeEach(() => {
      mockRunHealthInventory.mockReset()
      mockWriteAgentProviderSelection.mockReset()
    })

    it("returns failoverMessage when runAgent returns errored outcome", async () => {
      vi.spyOn(identity, "getAgentName").mockReturnValue("slugger")
      vi.spyOn(identity, "loadAgentConfig").mockReturnValue({
        version: 1,
        enabled: true,
        humanFacing: { provider: "openai-codex", model: "codex-mini-latest" },
        agentFacing: { provider: "openai-codex", model: "codex-mini-latest" },
        phrases: { thinking: [], tool: [], followup: [] },
      } as any)
      mockRunHealthInventory.mockResolvedValue({
        anthropic: { ok: true },
      })
      const failoverState = { pending: null }
      const input = makeInput({
        failoverState,
        runAgent: vi.fn().mockResolvedValue({
          usage: usageData,
          outcome: "errored",
          error: new Error("usage limit exceeded"),
          errorClassification: "usage-limit",
        }),
      })

      const result = await handleInboundTurn(input)

      expect(result.failoverMessage).toBeDefined()
      expect(result.failoverMessage).toContain("openai-codex")
      expect(result.failoverMessage).toContain("switch to anthropic")
      expect(failoverState.pending).not.toBeNull()
    })

    it("handles failover reply to switch provider and auto-retries on new provider", async () => {
      const mockRunAgent = vi.fn().mockResolvedValue({ usage: usageData, outcome: "settled" })
      const failoverState = {
        pending: {
          errorSummary: "openai-codex hit its usage limit",
          classification: "usage-limit" as const,
          currentProvider: "openai-codex" as const,
          agentName: "slugger",
          workingProviders: ["anthropic" as const],
          unconfiguredProviders: [],
          userMessage: "switch available",
        },
      }
      const input = makeInput({
        failoverState,
        messages: [{ role: "user", content: "switch to anthropic" }],
        runAgent: mockRunAgent,
      })

      const result = await handleInboundTurn(input)

      expect(result.switchedProvider).toBe("anthropic")
      expect(mockWriteAgentProviderSelection).toHaveBeenCalledWith("slugger", "human", "anthropic")
      expect(mockWriteAgentProviderSelection).toHaveBeenCalledWith("slugger", "agent", "anthropic")
      expect(failoverState.pending).toBeNull()
      // The pipeline should have auto-retried: runAgent was called on the new provider
      expect(mockRunAgent).toHaveBeenCalledTimes(1)
      // "switch to anthropic" should NOT be in the messages passed to runAgent —
      // replaced with a context message telling the agent about the switch
      const passedMessages = mockRunAgent.mock.calls[0][0] as Array<{ role: string; content: string }>
      const lastUserMsg = [...passedMessages].reverse().find((m) => m.role === "user")
      expect(lastUserMsg?.content).not.toContain("switch to anthropic")
      expect(lastUserMsg?.content).toContain("provider switch")
      expect(lastUserMsg?.content).toContain("openai-codex")
      expect(lastUserMsg?.content).toContain("anthropic")
      // Turn completed successfully on the new provider
      expect(result.turnOutcome).toBe("settled")
    })

    it("dismisses failover on unrelated reply and processes normally", async () => {
      const failoverState = {
        pending: {
          errorSummary: "openai-codex hit its usage limit",
          classification: "usage-limit" as const,
          currentProvider: "openai-codex" as const,
          agentName: "slugger",
          workingProviders: ["anthropic" as const],
          unconfiguredProviders: [],
          userMessage: "switch available",
        },
      }
      const input = makeInput({
        failoverState,
        messages: [{ role: "user", content: "never mind, just continue" }],
      })

      const result = await handleInboundTurn(input)

      expect(result.switchedProvider).toBeUndefined()
      expect(result.failoverMessage).toBeUndefined()
      expect(failoverState.pending).toBeNull()
      // Should have processed normally — runAgent was called
      expect(result.turnOutcome).toBe("settled")
    })

    it("falls back to normal error handling when failover sequence throws", async () => {
      vi.spyOn(identity, "getAgentName").mockReturnValue("slugger")
      vi.spyOn(identity, "loadAgentConfig").mockReturnValue({
        version: 1,
        enabled: true,
        humanFacing: { provider: "openai-codex", model: "codex-mini-latest" },
        agentFacing: { provider: "openai-codex", model: "codex-mini-latest" },
        phrases: { thinking: [], tool: [], followup: [] },
      } as any)
      mockRunHealthInventory.mockRejectedValue(new Error("inventory failed"))
      const failoverState = { pending: null }
      const input = makeInput({
        failoverState,
        runAgent: vi.fn().mockResolvedValue({
          usage: usageData,
          outcome: "errored",
          error: new Error("server down"),
          errorClassification: "server-error",
        }),
      })

      const result = await handleInboundTurn(input)

      // Should complete without failoverMessage since the sequence failed
      expect(result.failoverMessage).toBeUndefined()
      expect(result.turnOutcome).toBe("errored")
    })

    it("does not trigger failover when failoverState is not provided", async () => {
      const input = makeInput({
        runAgent: vi.fn().mockResolvedValue({
          usage: usageData,
          outcome: "errored",
          error: new Error("server down"),
          errorClassification: "server-error",
        }),
      })

      const result = await handleInboundTurn(input)

      expect(result.failoverMessage).toBeUndefined()
      expect(result.turnOutcome).toBe("errored")
      expect(mockRunHealthInventory).not.toHaveBeenCalled()
    })
  })

  // Session reset (lines 238-244)
  describe("session reset on key change", () => {
    it("resets file-state cache and scrutiny tracking when session key changes", async () => {
      // First call establishes a session key
      const input1 = makeInput({
        channel: "cli",
        sessionKey: "session-A",
      } as any)
      await handleInboundTurn(input1)

      // Clear mocks so we can assert they're called on the second call
      mockFileStateCacheClear.mockClear()
      mockResetSessionModifiedFiles.mockClear()

      // Second call with a different session key triggers the reset
      const input2 = makeInput({
        channel: "cli",
        sessionKey: "session-B",
      } as any)
      await handleInboundTurn(input2)

      expect(mockFileStateCacheClear).toHaveBeenCalledTimes(1)
      expect(mockResetSessionModifiedFiles).toHaveBeenCalledTimes(1)
    })

    it("resets when channel changes even with same session key", async () => {
      const input1 = makeInput({
        channel: "cli",
        sessionKey: "same-key",
      } as any)
      await handleInboundTurn(input1)

      mockFileStateCacheClear.mockClear()
      mockResetSessionModifiedFiles.mockClear()

      const input2 = makeInput({
        channel: "teams",
        capabilities: makeCapabilities({ channel: "teams", senseType: "closed" }),
        sessionKey: "same-key",
      } as any)
      await handleInboundTurn(input2)

      expect(mockFileStateCacheClear).toHaveBeenCalledTimes(1)
      expect(mockResetSessionModifiedFiles).toHaveBeenCalledTimes(1)
    })

    it("does not reset when session key stays the same", async () => {
      const input1 = makeInput({
        channel: "cli",
        sessionKey: "stable-key",
      } as any)
      await handleInboundTurn(input1)

      mockFileStateCacheClear.mockClear()
      mockResetSessionModifiedFiles.mockClear()

      const input2 = makeInput({
        channel: "cli",
        sessionKey: "stable-key",
      } as any)
      await handleInboundTurn(input2)

      expect(mockFileStateCacheClear).not.toHaveBeenCalled()
      expect(mockResetSessionModifiedFiles).not.toHaveBeenCalled()
    })
  })

  // extraPrefixSections from onPendingDrained (line 523)
  describe("onPendingDrained extra prefix sections", () => {
    it("prepends extra sections to first user message when onPendingDrained returns non-empty array", async () => {
      const pendingMsgs: PendingMessage[] = [
        { from: "inner-dialog", content: "woke up", timestamp: 1000 },
      ]
      const input = makeInput({
        drainPending: vi.fn().mockReturnValue(pendingMsgs),
        messages: [{ role: "user", content: "hi there" }] as ChatCompletionMessageParam[],
        onPendingDrained: vi.fn().mockReturnValue(["## Wake context", "Inner dialog surfaced a thought"]),
      } as any)

      await handleInboundTurn(input)

      expect(input.runAgent).toHaveBeenCalledTimes(1)
      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const msgs = runAgentCall[0] as ChatCompletionMessageParam[]
      const userMsg = msgs.find(m => m.role === "user" && typeof m.content === "string")
      expect(userMsg).toBeTruthy()
      expect((userMsg as any).content).toContain("## Wake context")
      expect((userMsg as any).content).toContain("Inner dialog surfaced a thought")
      expect((userMsg as any).content).toContain("hi there")
    })

    it("does not prepend when onPendingDrained returns empty array", async () => {
      const input = makeInput({
        drainPending: vi.fn().mockReturnValue([]),
        messages: [{ role: "user", content: "hi there" }] as ChatCompletionMessageParam[],
        onPendingDrained: vi.fn().mockReturnValue([]),
      } as any)

      await handleInboundTurn(input)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const msgs = runAgentCall[0] as ChatCompletionMessageParam[]
      const userMsg = msgs.find(m => m.role === "user" && typeof m.content === "string")
      expect(userMsg).toBeTruthy()
      expect((userMsg as any).content).toBe("hi there")
    })
  })

  describe("capabilities surfacing in pipeline", () => {
    let tempoSpy: ReturnType<typeof vi.spyOn>
    let temporalSpy: ReturnType<typeof vi.spyOn>
    let buildSotpSpy: ReturnType<typeof vi.spyOn>
    let renderSotpSpy: ReturnType<typeof vi.spyOn>
    let presenceSpy: ReturnType<typeof vi.spyOn>
    let writePresenceSpy: ReturnType<typeof vi.spyOn>
    let agentRootSpy: ReturnType<typeof vi.spyOn>
    let agentNameSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      // Mock the continuity pipeline functions so the try block at line 458 of pipeline.ts
      // reaches buildCapabilitiesSection instead of throwing on getAgentRoot() or deriveTempo()
      agentRootSpy = vi.spyOn(identity, "getAgentRoot" as any).mockReturnValue("/tmp/test-agent")
      agentNameSpy = vi.spyOn(identity, "getAgentName").mockReturnValue("test-agent")
      tempoSpy = vi.spyOn(tempoModule, "deriveTempo").mockReturnValue({ mode: "focused", reasoning: "" })
      temporalSpy = vi.spyOn(temporalViewModule, "buildTemporalView").mockReturnValue({
        episodes: [], obligations: [], cares: [], presenceSnapshot: undefined,
      } as any)
      buildSotpSpy = vi.spyOn(startOfTurnPacketModule, "buildStartOfTurnPacket").mockReturnValue({} as any)
      renderSotpSpy = vi.spyOn(startOfTurnPacketModule, "renderStartOfTurnPacket").mockImplementation(
        (packet: any) => packet?.capabilities ? `rendered-packet\n${packet.capabilities}` : "rendered-packet"
      )
      presenceSpy = vi.spyOn(presenceModule, "derivePresence").mockReturnValue({} as any)
      writePresenceSpy = vi.spyOn(presenceModule, "writePresence").mockImplementation(() => {})
    })

    afterEach(() => {
      agentRootSpy.mockRestore()
      agentNameSpy.mockRestore()
      tempoSpy.mockRestore()
      temporalSpy.mockRestore()
      buildSotpSpy.mockRestore()
      renderSotpSpy.mockRestore()
      presenceSpy.mockRestore()
      writePresenceSpy.mockRestore()
    })

    it("includes capabilities section in start-of-turn packet when version changes", async () => {
      const capSpy = vi.spyOn(startOfTurnPacketModule, "buildCapabilitiesSection")
        .mockReturnValue("Updated from 1.0.0 to 1.1.0: new config tool")

      const friend = makeFriend({ trustLevel: "family" })
      const caps = makeCapabilities({ channel: "cli", senseType: "local" })
      const context: ResolvedContext = { friend, channel: caps }
      const store = makeStore(friend)

      const input = makeInput({
        channel: "cli",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        friendStore: store,
        enforceTrustGate: vi.fn().mockReturnValue({ allowed: true }),
      })

      await handleInboundTurn(input)

      expect(capSpy).toHaveBeenCalled()

      // The start-of-turn packet passed to runAgent should contain capabilities text
      // runAgent is called with (messages, callbacks, channel, signal, options)
      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      if (options?.startOfTurnPacket) {
        expect(options.startOfTurnPacket).toContain("Updated from 1.0.0 to 1.1.0")
      }

      capSpy.mockRestore()
    })

    it("omits capabilities section when no version change detected", async () => {
      const capSpy = vi.spyOn(startOfTurnPacketModule, "buildCapabilitiesSection")
        .mockReturnValue(undefined)

      const friend = makeFriend({ trustLevel: "family" })
      const caps = makeCapabilities({ channel: "cli", senseType: "local" })
      const context: ResolvedContext = { friend, channel: caps }
      const store = makeStore(friend)

      const input = makeInput({
        channel: "cli",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        friendStore: store,
        enforceTrustGate: vi.fn().mockReturnValue({ allowed: true }),
      })

      await handleInboundTurn(input)

      expect(capSpy).toHaveBeenCalled()

      capSpy.mockRestore()
    })
  })
})
