import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ChannelCallbacks, RunAgentOptions } from "../../heart/core"
import type { FriendRecord, ResolvedContext, ChannelCapabilities, SenseType, Channel } from "../../mind/friends/types"
import type { FriendStore } from "../../mind/friends/store"
import type { TrustGateInput, TrustGateResult } from "../../senses/trust-gate"
import type { UsageData } from "../../mind/context"
import type { PendingMessage } from "../../mind/pending"
import { handleInboundTurn } from "../../senses/pipeline"
import type { InboundTurnInput, InboundTurnResult } from "../../senses/pipeline"

const mockFindBridgesForSession = vi.fn()

vi.mock("../../heart/bridges/manager", async () => {
  const actual = await vi.importActual<typeof import("../../heart/bridges/manager")>("../../heart/bridges/manager")
  return {
    ...actual,
    createBridgeManager: () => ({
      findBridgesForSession: (...args: any[]) => mockFindBridgesForSession(...args),
    }),
  }
})

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
    runAgent: vi.fn().mockResolvedValue({ usage: usageData, outcome: "complete" }),
    postTurn: vi.fn(),
    accumulateFriendTokens: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe("handleInboundTurn", () => {
  beforeEach(() => {
    mockFindBridgesForSession.mockReset().mockReturnValue([])
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

    it("includes pending messages in runAgent context when present", async () => {
      const pendingMsgs: PendingMessage[] = [
        { from: "trust-gate", content: "someone tried to reach you", timestamp: 1000 },
        { from: "inner-dialog", content: "thought about something", timestamp: 1001 },
      ]
      const input = makeInput({
        drainPending: vi.fn().mockReturnValue(pendingMsgs),
      })

      await handleInboundTurn(input)

      expect(input.runAgent).toHaveBeenCalledTimes(1)
      // The pipeline should have included pending in the messages
      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const messagesArg = runAgentCall[0] as ChatCompletionMessageParam[]
      // Pending messages should be formatted and included before the user message
      const allContent = messagesArg.map(m => typeof m.content === "string" ? m.content : "").join("\n")
      expect(allContent).toContain("someone tried to reach you")
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

    it("prepends pending to multimodal (array) content without losing parts", async () => {
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
      const userMsg = msgs.find(m => m.role === "user" && Array.isArray(m.content))
      expect(userMsg).toBeTruthy()
      const parts = (userMsg as any).content as Array<{ type: string; text?: string }>
      // Pending text part prepended, original parts preserved
      expect(parts[0].type).toBe("text")
      expect(parts[0].text).toContain("someone reached out")
      expect(parts[1]).toEqual({ type: "text", text: "hello" })
      expect(parts[2]).toEqual({ type: "image_url", image_url: { url: "https://example.com/img.png" } })
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
      mockFindBridgesForSession.mockReturnValue([
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
      ])
      const input = makeInput({
        channel: "teams",
        capabilities: makeCapabilities({ channel: "teams" }),
      }) as InboundTurnInput & { sessionKey: string }
      input.sessionKey = "conv-1"

      await handleInboundTurn(input as InboundTurnInput)

      expect(mockFindBridgesForSession).toHaveBeenCalledWith({
        friendId: "friend-1",
        channel: "teams",
        key: "conv-1",
      })
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
      mockFindBridgesForSession.mockReturnValue([
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
      ])
      const input = makeInput() as InboundTurnInput & { sessionKey: string }
      input.sessionKey = "session"

      await handleInboundTurn(input as InboundTurnInput)

      const runAgentCall = (input.runAgent as ReturnType<typeof vi.fn>).mock.calls[0]
      const options = runAgentCall[4] as RunAgentOptions
      expect((options as any).bridgeContext).toContain("bridge-processing: processing bridge [active-processing]")
      expect((options as any).bridgeContext).toContain("bridge-awaiting: awaiting bridge [awaiting-follow-up]")
      expect((options as any).bridgeContext).toContain("bridge-suspended: suspended bridge [suspended]")
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
        runAgent: vi.fn().mockResolvedValue({ usage: usageData, outcome: "complete" }),
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

  describe("result shape", () => {
    it("returns structured turn outcome from runAgent", async () => {
      const input = makeInput({
        runAgent: vi.fn().mockResolvedValue({ usage: usageData, outcome: "blocked" }),
      })

      const result = await handleInboundTurn(input)
      expect((result as any).turnOutcome).toBe("blocked")
    })

    it.each(["complete", "blocked", "superseded"] as const)(
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

        expect(input.postTurn).toHaveBeenCalledWith(
          expect.any(Array),
          "/tmp/test-session.json",
          usageData,
          undefined,
          expect.objectContaining({
            lastFriendActivityAt: expect.any(String),
          }),
        )
      },
    )
  })
})
