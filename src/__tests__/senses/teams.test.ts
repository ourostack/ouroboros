import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ChannelCallbacks } from "../../heart/core"
import { emitNervesEvent } from "../../nerves/runtime"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/agent/root"),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "minimax",
    phrases: {
      thinking: ["test thinking"],
      tool: ["test tool"],
      followup: ["test followup"],
    },
  })),
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
    this.resolve = vi.fn().mockResolvedValue({
      friend: { id: "mock-uuid", name: "Test User", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01", schemaVersion: 1 },
      channel: { channel: "teams", availableIntegrations: ["graph", "ado"], supportsMarkdown: true, supportsStreaming: true, supportsRichCards: true, maxMessageLength: 28000 },
    })
  }),
}))

import { getPhrases } from "../../mind/phrases"

// Tests for src/teams.ts Teams channel adapter.

// Config is now loaded from config.json only (no env var fallbacks).
// No env var save/restore needed.

describe("Teams adapter - exports", () => {
  it("exports createTeamsCallbacks", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    expect(typeof teams.createTeamsCallbacks).toBe("function")
  })

  it("exports startTeamsApp", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    expect(typeof teams.startTeamsApp).toBe("function")
  })

})

describe("Teams adapter - createTeamsCallbacks (SDK-delegated streaming)", () => {
  let mockStream: { emit: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  let controller: AbortController

  beforeEach(() => {
    mockStream = {
      emit: vi.fn(),
      update: vi.fn(),
      close: vi.fn(),
    }
    controller = new AbortController()
  })

  it("onModelStart sends a phrase from THINKING_PHRASES with trailing ...", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onModelStart()
    const calledWith = mockStream.update.mock.calls[0][0] as string
    expect(calledWith).toMatch(/\.\.\.$/)
    const phrase = calledWith.replace(/\.\.\.$/, "")
    expect(getPhrases().thinking).toContain(phrase)
    // Clean up timer
    callbacks.onTextChunk("done")
  })

  it("onModelStreamStart stops phrase rotation (does not throw)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    expect(() => callbacks.onModelStreamStart()).not.toThrow()
  })

  it("onClearText resets the text buffer", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onTextChunk("accumulated text")
    callbacks.onClearText()
    // After clear, flushing should not emit the accumulated text
    // (it may emit a fallback "no text" message, but the original buffer is gone)
    await callbacks.flush()
    expect(mockStream.emit).not.toHaveBeenCalledWith("accumulated text")
  })

  // --- Chunked streaming: text is always accumulated, never emitted per-token ---

  it("onTextChunk accumulates text in buffer (does not emit per-token)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onTextChunk("Hello")
    // Text should be buffered, NOT emitted per-token
    expect(mockStream.emit).not.toHaveBeenCalled()
  })

  it("onTextChunk accumulates multiple chunks (flushed later, not per-token)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)

    callbacks.onTextChunk("Hello")
    callbacks.onTextChunk(" world")

    // Nothing emitted yet -- text is buffered for periodic flush
    expect(mockStream.emit).not.toHaveBeenCalled()
    // Flush delivers accumulated text
    await callbacks.flush()
    expect(mockStream.emit).toHaveBeenCalledTimes(1)
    expect(mockStream.emit).toHaveBeenCalledWith("Hello world")
  })

  // --- Stop-streaming tests (403 detected during flush, not per-token) ---

  it("when emit throws (403) during flush, controller is aborted", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    mockStream.emit.mockImplementation(() => { throw new Error("403 Forbidden") })
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onTextChunk("data")
    // onTextChunk accumulates -- 403 not triggered yet
    expect(controller.signal.aborted).toBe(false)
    // flush triggers emit which throws 403
    await callbacks.flush()
    expect(controller.signal.aborted).toBe(true)
  })

  it("after abort via flush, subsequent onTextChunk calls silently accumulate", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onTextChunk("first")
    mockStream.emit.mockImplementation(() => { throw new Error("403 Forbidden") })
    await callbacks.flush() // triggers abort
    mockStream.emit.mockClear()
    // Subsequent text is silently ignored (stopped=true)
    callbacks.onTextChunk("second")
    expect(mockStream.emit).not.toHaveBeenCalled()
  })

  it("onError after abort does not emit or send (graceful stop)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)

    callbacks.onTextChunk("data")
    mockStream.emit.mockImplementation(() => { throw new Error("403 Forbidden") })
    await callbacks.flush() // triggers abort via emit
    mockStream.emit.mockClear()
    sendMessage.mockClear()
    callbacks.onError(new Error("connection lost"), "terminal")
    expect(mockStream.emit).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  // --- update() error handling ---

  it("when update throws (403), controller is aborted", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    mockStream.update.mockImplementation(() => { throw new Error("403 Forbidden") })
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onToolStart("read_file", { path: "test.txt" })
    expect(controller.signal.aborted).toBe(true)
  })

  it("after abort via update, subsequent updates are skipped", async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const teams = await import("../../senses/teams")
    mockStream.update.mockImplementationOnce(() => { throw new Error("403") })
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onModelStart() // this throws and aborts
    mockStream.update.mockClear()
    callbacks.onToolStart("shell", { command: "ls" }) // should be skipped
    expect(mockStream.update).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  // --- onReasoningChunk tests ---

  it("onReasoningChunk accumulates and flushes reasoning via periodic update (not per-token)", async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onReasoningChunk("analyzing code")
    // NOT sent per-token -- accumulated internally
    expect(mockStream.update).not.toHaveBeenCalled()
    // After flush interval, reasoning is pushed via safeUpdate
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS)
    expect(mockStream.update).toHaveBeenCalledWith("analyzing code")
    expect(mockStream.emit).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("onReasoningChunk after stop (403) is still a no-op", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    mockStream.emit.mockImplementation(() => { throw new Error("403 Forbidden") })
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onTextChunk("data") // triggers 403, sets stopped
    mockStream.update.mockClear()
    callbacks.onReasoningChunk("should not appear")
    expect(mockStream.update).not.toHaveBeenCalled()
  })

  // --- async (Promise-based) error handling ---

  it("when emit returns a rejected Promise during flush, controller is aborted", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    mockStream.emit.mockReturnValue(Promise.reject(new Error("403 Forbidden")))
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onTextChunk("data")
    // onTextChunk accumulates, no emit yet
    expect(controller.signal.aborted).toBe(false)
    // flush triggers emit which returns rejected Promise
    await callbacks.flush()
    // Let the microtask (Promise rejection handler) run
    await new Promise(r => setTimeout(r, 0))
    expect(controller.signal.aborted).toBe(true)
  })

  it("when update returns a rejected Promise, controller is aborted", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    mockStream.update.mockReturnValue(Promise.reject(new Error("403 Forbidden")))
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onToolStart("read_file", { path: "test.txt" })
    await new Promise(r => setTimeout(r, 0))
    expect(controller.signal.aborted).toBe(true)
  })

  it("after async abort via flush emit, phrase rotation stops", async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const teams = await import("../../senses/teams")
    mockStream.emit.mockReturnValue(Promise.reject(new Error("403")))
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    // Start phrase rotation
    callbacks.onModelStart()
    mockStream.update.mockClear()

    // Text accumulates, flush triggers emit which rejects
    callbacks.onTextChunk("data")
    await callbacks.flush()
    await vi.advanceTimersByTimeAsync(0) // flush microtasks

    // Phrase timer should have been cleared -- advancing time should not produce updates
    mockStream.update.mockClear()
    vi.advanceTimersByTime(3000)
    expect(mockStream.update).not.toHaveBeenCalled()

    vi.useRealTimers()
  })

  it("markStopped is idempotent -- second async rejection does not abort twice", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    // update returns rejected Promise (used by onToolStart)
    mockStream.update.mockReturnValue(Promise.reject(new Error("403")))
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onToolStart("x", {})      // first async rejection via update
    callbacks.onToolStart("y", {})      // second async rejection (markStopped early-returns)
    await new Promise(r => setTimeout(r, 0))
    expect(controller.signal.aborted).toBe(true)
  })

  it("onTextChunk accumulates text (no per-token emit)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onTextChunk("hello")
    // Text is buffered, not emitted per-token
    expect(mockStream.emit).not.toHaveBeenCalled()
  })

  it("onReasoningChunk accumulates multiple chunks and flushes cumulative text", async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onReasoningChunk("step 1")
    callbacks.onReasoningChunk(" step 2")
    // NOT sent per-token
    expect(mockStream.update).not.toHaveBeenCalled()
    // After flush interval, cumulative reasoning pushed via update
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS)
    expect(mockStream.update).toHaveBeenCalledWith("step 1 step 2")
    expect(mockStream.emit).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("text without prior reasoning accumulates in buffer", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)

    callbacks.onTextChunk("just text")
    // Text accumulated, not emitted per-token
    expect(mockStream.emit).not.toHaveBeenCalled()
    // Flush delivers it
    await callbacks.flush()
    expect(mockStream.emit).toHaveBeenCalledWith("just text")
  })

  it("reasoning never leaks into emitted text", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)

    callbacks.onReasoningChunk("old reasoning")
    callbacks.onModelStart()
    callbacks.onTextChunk("answer")
    // Text is accumulated, not emitted yet
    expect(mockStream.emit).not.toHaveBeenCalled()
    await callbacks.flush()
    // Only text is emitted, not reasoning
    expect(mockStream.emit).toHaveBeenCalledTimes(1)
    expect(mockStream.emit).toHaveBeenCalledWith("answer")
  })

  // --- Tool/status callbacks ---

  it("onToolStart sends informative status", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onToolStart("read_file", { path: "package.json" })
    expect(mockStream.update).toHaveBeenCalledWith("running read_file (path=package.json)...")
  })

  it("onToolStart always flushes accumulated textBuffer before showing tool status", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("accumulated text")
    callbacks.onToolStart("read_file", { path: "test.txt" })
    // First flush goes to stream.emit (primary output)
    expect(mockStream.emit).toHaveBeenCalledWith("accumulated text")
  })

  // --- Unified onToolEnd: always via stream.update (transient status) ---

  it("onToolEnd success shows formatted result via stream.update (not emit)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onToolEnd("read_file", "package.json", true)
    expect(mockStream.update).toHaveBeenCalledWith("\u2713 read_file (package.json)")
    expect(mockStream.emit).not.toHaveBeenCalled()
  })

  it("onToolEnd with empty summary shows formatted result via stream.update", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onToolEnd("get_current_time", "", true)
    expect(mockStream.update).toHaveBeenCalledWith("\u2713 get_current_time")
    expect(mockStream.emit).not.toHaveBeenCalled()
  })

  it("onToolEnd failure shows formatted error via stream.update (not emit)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onToolEnd("read_file", "missing.txt", false)
    expect(mockStream.update).toHaveBeenCalledWith("\u2717 read_file: missing.txt")
    expect(mockStream.emit).not.toHaveBeenCalled()
  })

  it("onToolEnd after abort does NOT call stream.update or stream.emit", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    mockStream.update.mockImplementationOnce(() => { throw new Error("403 Forbidden") })
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onToolStart("x", {}) // triggers abort via update
    mockStream.update.mockClear()
    mockStream.emit.mockClear()
    callbacks.onToolEnd("read_file", "test.txt", true)
    expect(mockStream.update).not.toHaveBeenCalled()
    expect(mockStream.emit).not.toHaveBeenCalled()
  })

  // --- Unified onKick: always via stream.update (transient status) ---

  it("onKick shows formatted kick via stream.update (not emit)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onKick!()
    expect(mockStream.update).toHaveBeenCalledWith("\u21BB kick")
    expect(mockStream.emit).not.toHaveBeenCalled()
  })

  it("onKick after abort does NOT call stream.update", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    mockStream.update.mockImplementationOnce(() => { throw new Error("403 Forbidden") })
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onToolStart("x", {}) // triggers abort via update
    mockStream.update.mockClear()
    callbacks.onKick!()
    expect(mockStream.update).not.toHaveBeenCalled()
  })

  // --- Unified onError: terminal uses safeSend, transient uses safeUpdate ---

  it("onError transient calls stream.update (ephemeral)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onError(new Error("context overflow"), "transient")
    expect(mockStream.update).toHaveBeenCalledWith("Error: context overflow")
    expect(mockStream.emit).not.toHaveBeenCalled()
  })

  it("onError terminal uses safeSend (sendMessage), not safeEmit", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onError(new Error("something broke"), "terminal")
    expect(sendMessage).toHaveBeenCalledWith("Error: something broke")
    expect(mockStream.emit).not.toHaveBeenCalled()
  })

  it("onError terminal after abort does NOT send or emit", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    mockStream.update.mockImplementationOnce(() => { throw new Error("403 Forbidden") })
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onToolStart("x", {}) // triggers abort via update
    sendMessage.mockClear()
    mockStream.emit.mockClear()
    callbacks.onError(new Error("connection lost"), "terminal")
    expect(sendMessage).not.toHaveBeenCalled()
    expect(mockStream.emit).not.toHaveBeenCalled()
  })
})

describe("Teams adapter - message handling", () => {
  function mockHandlingDeps(mockRunAgent: any) {
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: mockRunAgent,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/teams-test-session.json"),
      getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "" }),
      getAdoConfig: vi.fn().mockReturnValue({ organizations: [] }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: false, port: 3978 }),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),

      postTurn: vi.fn(),
    }))
    vi.doMock("../../senses/commands", () => ({
      createCommandRegistry: vi.fn().mockReturnValue({
        register: vi.fn(),
        get: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        dispatch: vi.fn().mockReturnValue({ handled: false }),
      }),
      registerDefaultCommands: vi.fn(),
      parseSlashCommand: vi.fn().mockReturnValue(null),
    }))
  }

  it("on incoming message, pushes system and user message and calls runAgent", async () => {
    vi.resetModules()

    const mockRunAgent = vi.fn().mockResolvedValue({ usage: undefined })
    mockHandlingDeps(mockRunAgent)

    const teams = await import("../../senses/teams")

    const mockStream = {
      emit: vi.fn(),
      update: vi.fn(),
      close: vi.fn(),
    }

    await teams.handleTeamsMessage("hello from Teams", mockStream as any, "conv-test")

    expect(mockRunAgent).toHaveBeenCalled()
    const messages = mockRunAgent.mock.calls[0][0]
    expect(messages.some((m: any) => m.role === "system")).toBe(true)
    expect(messages.some((m: any) => m.role === "user" && m.content === "hello from Teams")).toBe(true)
  })

  it("passes AbortSignal to runAgent", async () => {
    vi.resetModules()

    const mockRunAgent = vi.fn().mockResolvedValue({ usage: undefined })
    mockHandlingDeps(mockRunAgent)

    const teams = await import("../../senses/teams")

    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await teams.handleTeamsMessage("test", mockStream as any, "conv-test")

    // Fourth argument to runAgent should be an AbortSignal (channel is third)
    expect(mockRunAgent).toHaveBeenCalled()
    expect(mockRunAgent.mock.calls[0][2]).toBe("teams")
    const signal = mockRunAgent.mock.calls[0][3]
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it("does not explicitly close stream (framework auto-closes)", async () => {
    vi.resetModules()

    mockHandlingDeps(vi.fn().mockResolvedValue({ usage: undefined }))

    const teams = await import("../../senses/teams")

    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await teams.handleTeamsMessage("hi", mockStream as any, "conv-test")

    expect(mockStream.close).not.toHaveBeenCalled()
  })

  it("per-conversation sessions: each call loads/saves independently", async () => {
    vi.resetModules()

    const capturedMessages: any[][] = []
    const mockRunAgent = vi.fn().mockImplementation((msgs: any[]) => {
      capturedMessages.push([...msgs])
      return { usage: undefined }
    })
    mockHandlingDeps(mockRunAgent)

    const teams = await import("../../senses/teams")

    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    await teams.handleTeamsMessage("first", mockStream as any, "conv-1")
    await teams.handleTeamsMessage("second", mockStream as any, "conv-2")

    // Both calls get fresh sessions (loadSession returns null), so each has system + user = 2 msgs
    expect(capturedMessages[0].length).toBe(2)
    expect(capturedMessages[1].length).toBe(2)
  })
})

describe("Teams adapter - stripMentions", () => {
  let stripMentions: (text: string) => string

  beforeEach(async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    stripMentions = teams.stripMentions
  })

  it("is exported from teams.ts", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    expect(typeof teams.stripMentions).toBe("function")
  })

  it("returns text unchanged when no mentions", () => {
    expect(stripMentions("hello world")).toBe("hello world")
  })

  it("strips mention at start of text", () => {
    expect(stripMentions("<at>Ouroboros</at> hello")).toBe("hello")
  })

  it("strips mention in middle of text", () => {
    expect(stripMentions("hey <at>Ouroboros</at> do something")).toBe("hey  do something")
  })

  it("strips multiple mentions", () => {
    expect(stripMentions("<at>Bot</at> and <at>User</at> chat")).toBe("and  chat")
  })

  it("handles extra whitespace after mention removal", () => {
    expect(stripMentions("  <at>Bot</at>  hello  ")).toBe("hello")
  })

  it("returns empty string for empty input", () => {
    expect(stripMentions("")).toBe("")
  })

  it("returns empty string for undefined/null input", () => {
    expect(stripMentions(undefined as any)).toBe("")
    expect(stripMentions(null as any)).toBe("")
  })
})

describe("Teams adapter - splitMessage", () => {
  let splitMessage: (text: string, maxLen: number) => string[]

  beforeEach(async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    splitMessage = teams.splitMessage
  })

  it("returns single chunk when text fits within limit", () => {
    expect(splitMessage("hello", 100)).toEqual(["hello"])
  })

  it("splits at paragraph boundary (\\n\\n)", () => {
    const text = "first paragraph\n\nsecond paragraph"
    const chunks = splitMessage(text, 20)
    expect(chunks).toEqual(["first paragraph", "second paragraph"])
  })

  it("splits at line boundary when no paragraph break", () => {
    const text = "line one\nline two"
    const chunks = splitMessage(text, 12)
    expect(chunks).toEqual(["line one", "line two"])
  })

  it("splits at word boundary when no line break", () => {
    const text = "hello world foo"
    const chunks = splitMessage(text, 12)
    expect(chunks).toEqual(["hello world", "foo"])
  })

  it("hard-cuts when no boundary found", () => {
    const text = "x".repeat(10)
    const chunks = splitMessage(text, 4)
    expect(chunks.join("")).toBe(text)
    expect(chunks.every(c => c.length <= 4)).toBe(true)
  })

  it("preserves all content across multiple chunks", () => {
    const text = "a".repeat(3000) + "\n\n" + "b".repeat(3000) + "\n\n" + "c".repeat(3000)
    const chunks = splitMessage(text, 4000)
    // All content preserved (ignoring stripped newlines between chunks)
    expect(chunks.length).toBeGreaterThan(1)
    const reassembled = chunks.join("\n\n")
    expect(reassembled).toContain("a".repeat(3000))
    expect(reassembled).toContain("b".repeat(3000))
    expect(reassembled).toContain("c".repeat(3000))
  })

  it("never returns empty strings", () => {
    const text = "a".repeat(100)
    const chunks = splitMessage(text, 10)
    expect(chunks.every(c => c.length > 0)).toBe(true)
  })
})

describe("Teams adapter - startTeamsApp (DevtoolsPlugin mode)", () => {
  afterEach(() => {
    // Config is loaded from config.json only, no env vars to clear
  })

  it("creates App with DevtoolsPlugin when CLIENT_ID is not set", async () => {
    vi.resetModules()
    // no env vars to clear

    let capturedOpts: any = null
    const mockOn = vi.fn()
    const mockStart = vi.fn()
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(opts: any) { capturedOpts = opts }
        on = mockOn
        event = vi.fn()
        start = mockStart
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    expect(capturedOpts.plugins).toHaveLength(1)
    expect(mockOn).toHaveBeenCalledWith("message", expect.any(Function))
    expect(mockStart).toHaveBeenCalledWith(3978)

    consoleSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it("emits app_started event with DevtoolsPlugin mode", async () => {
    vi.resetModules()
    const emitNervesEventLocal = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent: emitNervesEventLocal }))

    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn()
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    expect(emitNervesEventLocal).toHaveBeenCalledWith(expect.objectContaining({
      level: "info",
      event: "channel.app_started",
      component: "channels",
      meta: expect.objectContaining({ mode: "DevtoolsPlugin" }),
    }))

    vi.restoreAllMocks()
  })

  it("passes activity.mentions.stripText in DevtoolsPlugin mode", async () => {
    vi.resetModules()
    // no env vars to clear

    let capturedOpts: any = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(opts: any) { capturedOpts = opts }
        on = vi.fn()
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))

    vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    expect(capturedOpts.activity).toEqual({ mentions: { stripText: true } })

    vi.restoreAllMocks()
  })

  it("uses teamsChannel.port config when set", async () => {
    vi.resetModules()

    const mockStart = vi.fn()
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn()
        event = vi.fn()
        start = mockStart
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/teams-session.json"),
      getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "" }),
      getAdoConfig: vi.fn().mockReturnValue({ organizations: [] }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: false, port: 4000 }),
    }))

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    expect(mockStart).toHaveBeenCalledWith(4000)

    consoleSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it("message handler calls handleTeamsMessage with text and stream", async () => {
    vi.resetModules()
    // no env vars to clear

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))

    const mockRunAgent = vi.fn().mockResolvedValue({ usage: undefined })
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: mockRunAgent,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),

      postTurn: vi.fn(),
    }))

    vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    expect(capturedHandler).not.toBeNull()

    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await capturedHandler!({
      stream: mockStream,
      activity: { text: "hello from devtools" },
    })

    expect(mockRunAgent).toHaveBeenCalled()

    vi.restoreAllMocks()
  })

  it("same-conversation follow-up during active turn is steered without starting a second turn", async () => {
    vi.resetModules()

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))

    let releaseFirst: (() => void) | undefined
    const firstTurn = new Promise<void>((resolve) => { releaseFirst = resolve })
    let drainedFollowUps: Array<{ text: string }> = []
    const runAgentFn = vi.fn()
      .mockImplementationOnce(async (_messages: any, _callbacks: any, _channel: any, _signal: any, options: any) => {
        await firstTurn
        drainedFollowUps = options?.drainSteeringFollowUps?.() ?? []
        return { usage: undefined }
      })
      .mockResolvedValue({ usage: undefined })

    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: runAgentFn,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),
      postTurn: vi.fn(),
    }))

    vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const stream1 = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    const stream2 = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    const api = {
      users: {
        token: {
          get: vi.fn().mockResolvedValue({ token: undefined }),
        },
      },
    }

    const firstMessage = capturedHandler!({
      stream: stream1,
      activity: { text: "first", conversation: { id: "conv-steer" }, from: { id: "user-1" }, channelId: "msteams" },
      api,
      signin: vi.fn(),
      send: vi.fn(),
    })

    for (let i = 0; i < 20 && runAgentFn.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 1))
    }
    expect(runAgentFn).toHaveBeenCalledTimes(1)

    await capturedHandler!({
      stream: stream2,
      activity: { text: "follow-up", conversation: { id: "conv-steer" }, from: { id: "user-1" }, channelId: "msteams" },
      api,
      signin: vi.fn(),
      send: vi.fn(),
    })

    // Follow-up should be buffered for steering and not open a second turn.
    expect(runAgentFn).toHaveBeenCalledTimes(1)
    expect(stream2.emit).not.toHaveBeenCalled()

    releaseFirst?.()
    await firstMessage
    expect(runAgentFn).toHaveBeenCalledTimes(1)
    expect(drainedFollowUps.map((m) => m.text)).toEqual(["follow-up"])

    vi.restoreAllMocks()
  })

  it("message handler fetches tokens and passes teamsContext to handleTeamsMessage", async () => {
    vi.resetModules()
    // no env vars to clear

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))

    const mockRunAgent = vi.fn().mockResolvedValue({ usage: undefined })
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: mockRunAgent,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),

      postTurn: vi.fn(),
    }))

    vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    // Simulate a full activity context with api.users.token.get and signin
    const mockSignin = vi.fn().mockResolvedValue("token-from-signin")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await capturedHandler!({
      stream: mockStream,
      activity: {
        text: "test",
        conversation: { id: "conv-test" },
        from: { id: "user-123" },
        channelId: "msteams",
      },
      api: {
        users: {
          token: {
            get: vi.fn()
              .mockResolvedValueOnce({ token: "graph-token-123" })
              .mockResolvedValueOnce({ token: "ado-token-456" }),
          },
        },
      },
      signin: mockSignin,
    })

    // runAgent should have been called with toolContext containing both tokens
    expect(mockRunAgent).toHaveBeenCalled()
    const callArgs = mockRunAgent.mock.calls[0]
    const options = callArgs[4]
    expect(options).toBeDefined()
    expect(options.toolContext).toBeDefined()
    expect(options.toolContext.graphToken).toBe("graph-token-123")
    expect(options.toolContext.adoToken).toBe("ado-token-456")
    expect(typeof options.toolContext.signin).toBe("function")

    // Test that the signin function proxies to ctx.signin with connectionName
    await options.toolContext.signin("ado")
    expect(mockSignin).toHaveBeenCalledWith({ connectionName: "ado" })

    vi.restoreAllMocks()
  })

  it("message handler handles missing activity.text", async () => {
    vi.resetModules()
    // no env vars to clear

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))

    const mockRunAgent = vi.fn().mockResolvedValue({ usage: undefined })
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: mockRunAgent,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),

      postTurn: vi.fn(),
    }))

    vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await capturedHandler!({
      stream: mockStream,
      activity: {}, // no text property
    })

    expect(mockRunAgent).toHaveBeenCalled()
    const messages = mockRunAgent.mock.calls[0][0]
    const userMsg = messages.filter((m: any) => m.role === "user").pop()
    expect(userMsg.content).toBe("")

    vi.restoreAllMocks()
  })

  it("message handler catches errors and emits handler_error event", async () => {
    vi.resetModules()
    const emitNervesEventLocal = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent: emitNervesEventLocal }))

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))

    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn().mockRejectedValue(new Error("agent crashed")),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await expect(capturedHandler!({
      stream: mockStream,
      activity: { text: "test" },
    })).resolves.not.toThrow()

    expect(emitNervesEventLocal).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "channel.handler_error",
      component: "channels",
    }))

    vi.restoreAllMocks()
  })

  it("message handler catches non-Error thrown values with handler_error event", async () => {
    vi.resetModules()
    const emitNervesEventLocal = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent: emitNervesEventLocal }))

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))

    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn().mockRejectedValue("string-crash"),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await expect(capturedHandler!({
      stream: mockStream,
      activity: { text: "test" },
    })).resolves.not.toThrow()

    expect(emitNervesEventLocal).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "channel.handler_error",
      component: "channels",
      message: expect.stringContaining("string-crash"),
    }))

    vi.restoreAllMocks()
  })

  it("signin wrapper catches errors and emits signin_error event", async () => {
    vi.resetModules()
    const emitNervesEventLocal = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent: emitNervesEventLocal }))

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))

    const mockRunAgent = vi.fn().mockResolvedValue({ usage: undefined })
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: mockRunAgent,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),
      postTurn: vi.fn(),
    }))

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const failingSignin = vi.fn().mockRejectedValue(new Error("signin failed"))
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await capturedHandler!({
      stream: mockStream,
      activity: {
        text: "test",
        conversation: { id: "conv-test" },
        from: { id: "user-123" },
        channelId: "msteams",
      },
      api: {
        users: { token: { get: vi.fn().mockRejectedValue(new Error("no token")) } },
      },
      signin: failingSignin,
    })

    const handleCall = mockRunAgent.mock.calls[0]
    const opts = handleCall[4]
    const result = await opts.toolContext.signin("graph")
    expect(result).toBeUndefined()
    expect(emitNervesEventLocal).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "channel.signin_error",
      component: "channels",
    }))

    vi.restoreAllMocks()
  })

  it("signin wrapper emits signin_result when signin returns falsy", async () => {
    vi.resetModules()
    const emitNervesEventLocal = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent: emitNervesEventLocal }))

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))

    const mockRunAgent = vi.fn().mockResolvedValue({ usage: undefined })
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: mockRunAgent,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),
      postTurn: vi.fn(),
    }))

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const mockSignin = vi.fn().mockResolvedValue(undefined)
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await capturedHandler!({
      stream: mockStream,
      activity: {
        text: "test",
        conversation: { id: "conv-no-token" },
        from: { id: "user-123" },
        channelId: "msteams",
      },
      api: {
        users: { token: { get: vi.fn().mockRejectedValue(new Error("no token")) } },
      },
      signin: mockSignin,
    })

    const opts = mockRunAgent.mock.calls[0][4]
    const result = await opts.toolContext.signin("graph")
    expect(result).toBeUndefined()
    expect(emitNervesEventLocal).toHaveBeenCalledWith(expect.objectContaining({
      level: "info",
      event: "channel.signin_result",
      component: "channels",
    }))

    vi.restoreAllMocks()
  })

  it("signin wrapper handles non-Error thrown values with signin_error event", async () => {
    vi.resetModules()
    const emitNervesEventLocal = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent: emitNervesEventLocal }))

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))

    const mockRunAgent = vi.fn().mockResolvedValue({ usage: undefined })
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: mockRunAgent,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),
      postTurn: vi.fn(),
    }))

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const mockSignin = vi.fn().mockRejectedValue("string-error")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await capturedHandler!({
      stream: mockStream,
      activity: {
        text: "test",
        conversation: { id: "conv-str-err" },
        from: { id: "user-123" },
        channelId: "msteams",
      },
      api: {
        users: { token: { get: vi.fn().mockRejectedValue(new Error("no token")) } },
      },
      signin: mockSignin,
    })

    const opts = mockRunAgent.mock.calls[0][4]
    const result = await opts.toolContext.signin("graph")
    expect(result).toBeUndefined()
    expect(emitNervesEventLocal).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "channel.signin_error",
      component: "channels",
    }))

    vi.restoreAllMocks()
  })

  it("app.event error handler emits app_error nerves event", async () => {
    vi.resetModules()
    const emitNervesEventLocal = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent: emitNervesEventLocal }))

    let capturedEventHandler: ((args: any) => void) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn()
        event = vi.fn().mockImplementation((_name: string, handler: any) => {
          capturedEventHandler = handler
        })
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    expect(capturedEventHandler).toBeDefined()
    capturedEventHandler!({ error: new Error("SDK blew up") })
    expect(emitNervesEventLocal).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "channel.app_error",
      component: "channels",
      message: "[primary] SDK blew up",
    }))

    // Cover non-Error branch
    emitNervesEventLocal.mockClear()
    capturedEventHandler!({ error: "string error" })
    expect(emitNervesEventLocal).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "channel.app_error",
      component: "channels",
      message: "[primary] string error",
    }))

    vi.restoreAllMocks()
  })
})

describe("Teams adapter - startTeamsApp signin.verify-state handler", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function setupVerifyStateTest() {
    vi.resetModules()
    const emitNervesEventMock = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent: emitNervesEventMock }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/test-session"),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "github" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "github" }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: false, port: 3978, flushIntervalMs: 1000 }),
    }))

    const handlers: Record<string, (args: any) => Promise<any>> = {}
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((event: string, handler: any) => {
          handlers[event] = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))

    return { handlers, emitNervesEventMock }
  }

  it("returns 404 when activity.value.state is missing", async () => {
    const { handlers } = setupVerifyStateTest()
    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const handler = handlers["signin.verify-state"]
    expect(handler).toBeDefined()

    const result = await handler({
      api: { users: { token: { get: vi.fn() } } },
      activity: { value: {}, channelId: "msteams", from: { id: "u1" } },
    })
    expect(result).toEqual({ status: 404 })

    /* v8 ignore next -- branch: value is undefined @preserve */
    const result2 = await handler({
      api: { users: { token: { get: vi.fn() } } },
      activity: { channelId: "msteams", from: { id: "u1" } },
    })
    expect(result2).toEqual({ status: 404 })
  })

  it("returns 200 and emits verify_state info event when a connection matches", async () => {
    const { handlers, emitNervesEventMock } = setupVerifyStateTest()
    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const handler = handlers["signin.verify-state"]
    const mockGet = vi.fn()
      .mockRejectedValueOnce(new Error("wrong connection"))
      .mockResolvedValueOnce({ token: "t" })

    const result = await handler({
      api: { users: { token: { get: mockGet } } },
      activity: { value: { state: "code123" }, channelId: "msteams", from: { id: "u1" } },
    })

    expect(result).toEqual({ status: 200 })
    expect(emitNervesEventMock).toHaveBeenCalledWith(expect.objectContaining({
      level: "info",
      event: "channel.verify_state",
      component: "channels",
    }))
  })

  it("returns 412 and emits verify_state warn event when all connections fail", async () => {
    const { handlers, emitNervesEventMock } = setupVerifyStateTest()
    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const handler = handlers["signin.verify-state"]
    const mockGet = vi.fn().mockRejectedValue(new Error("no match"))

    const result = await handler({
      api: { users: { token: { get: mockGet } } },
      activity: { value: { state: "code123" }, channelId: "msteams", from: { id: "u1" } },
    })

    expect(result).toEqual({ status: 412 })
    expect(emitNervesEventMock).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "channel.verify_state",
      component: "channels",
      message: "[primary] verify-state failed for all connections",
    }))
  })
})

describe("Teams adapter - channel.message_received event", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("emits channel.message_received nerves event on incoming message", async () => {
    vi.resetModules()
    const emitNervesEventMock = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent: emitNervesEventMock }))

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/test-session"),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "github" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "github" }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: false, port: 3978, flushIntervalMs: 1000 }),
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn().mockResolvedValue({ usage: undefined }),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
    }))

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await capturedHandler!({
      stream: mockStream,
      activity: {
        text: "hello",
        conversation: { id: "conv-123" },
        from: { id: "user-abc123456789" },
        channelId: "msteams",
      },
      api: { users: { token: { get: vi.fn().mockResolvedValue({}) } } },
      signin: vi.fn(),
    })

    expect(emitNervesEventMock).toHaveBeenCalledWith(expect.objectContaining({
      level: "info",
      event: "channel.message_received",
      component: "channels",
    }))
  })

  it("emits channel.token_status nerves event with token availability", async () => {
    vi.resetModules()
    const emitNervesEventMock = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent: emitNervesEventMock }))

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/test-session"),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "github" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "github" }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: false, port: 3978, flushIntervalMs: 1000 }),
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn().mockResolvedValue({ usage: undefined }),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
    }))

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await capturedHandler!({
      stream: mockStream,
      activity: {
        text: "hello",
        conversation: { id: "conv-token-status" },
        from: { id: "user-abc123456789" },
        channelId: "msteams",
      },
      api: { users: { token: { get: vi.fn().mockResolvedValueOnce({ token: "g" }).mockResolvedValueOnce(null).mockResolvedValueOnce({ token: "gh" }) } } },
      signin: vi.fn(),
    })

    expect(emitNervesEventMock).toHaveBeenCalledWith(expect.objectContaining({
      level: "info",
      event: "channel.token_status",
      component: "channels",
      meta: expect.objectContaining({ graph: true, ado: false, github: true }),
    }))
  })
})

describe("Teams adapter - startTeamsApp AAD extraction (Bug 1)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("extracts aadObjectId, tenantId, and displayName from activity into teamsContext", async () => {
    vi.resetModules()

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))

    const mockRunAgent = vi.fn().mockResolvedValue({ usage: undefined })
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: mockRunAgent,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),
      postTurn: vi.fn(),
    }))

    // Mock FriendResolver to capture constructor args
    const MockFriendResolver = vi.fn(function (this: any) {
      this.resolve = vi.fn().mockResolvedValue({
        friend: { id: "mock-uuid", name: "Alice AAD", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01", schemaVersion: 1 },
        channel: { channel: "teams", availableIntegrations: ["graph", "ado"], supportsMarkdown: true, supportsStreaming: true, supportsRichCards: true, maxMessageLength: 28000 },
      })
    })
    vi.doMock("../../mind/friends/resolver", () => ({
      FriendResolver: MockFriendResolver,
    }))

    vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await capturedHandler!({
      stream: mockStream,
      activity: {
        text: "hello",
        conversation: { id: "conv-aad", tenantId: "tenant-from-activity" },
        from: { id: "user-456", aadObjectId: "aad-obj-from-activity", name: "Alice AAD" },
        channelId: "msteams",
      },
      api: {
        users: { token: { get: vi.fn().mockResolvedValue({ token: "t" }) } },
      },
      signin: vi.fn(),
    })

    // FriendResolver should have been called with AAD provider because the
    // message handler extracted aadObjectId from the activity into teamsContext
    expect(MockFriendResolver).toHaveBeenCalledWith(
      expect.anything(), // store
      expect.objectContaining({
        provider: "aad",
        externalId: "aad-obj-from-activity",
        tenantId: "tenant-from-activity",
        displayName: "Alice AAD",
        channel: "teams",
      }),
    )
  })

  it("falls back to teams-conversation provider when activity lacks AAD fields", async () => {
    vi.resetModules()

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))

    const mockRunAgent = vi.fn().mockResolvedValue({ usage: undefined })
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: mockRunAgent,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),
      postTurn: vi.fn(),
    }))

    // Mock FriendResolver to capture constructor args
    const MockFriendResolver = vi.fn(function (this: any) {
      this.resolve = vi.fn().mockResolvedValue({
        friend: { id: "mock-uuid", name: "Unknown", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01", schemaVersion: 1 },
        channel: { channel: "teams", availableIntegrations: ["graph", "ado"], supportsMarkdown: true, supportsStreaming: true, supportsRichCards: true, maxMessageLength: 28000 },
      })
    })
    vi.doMock("../../mind/friends/resolver", () => ({
      FriendResolver: MockFriendResolver,
    }))

    vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await capturedHandler!({
      stream: mockStream,
      activity: {
        text: "hello",
        conversation: { id: "conv-no-aad" },
        from: { id: "user-789" },
        channelId: "msteams",
      },
      api: {
        users: { token: { get: vi.fn().mockResolvedValue({ token: "t" }) } },
      },
      signin: vi.fn(),
    })

    // Without AAD fields, should fall back to teams-conversation provider
    expect(MockFriendResolver).toHaveBeenCalledWith(
      expect.anything(), // store
      expect.objectContaining({
        provider: "teams-conversation",
        externalId: "conv-no-aad",
        displayName: "Unknown",
        channel: "teams",
      }),
    )
  })
})

describe("Teams adapter - unhandledRejection guard", () => {
  afterEach(() => {
    // Clean up any __agentHandler listeners we registered
    const listeners = process.listeners("unhandledRejection")
    for (const l of listeners) {
      if ((l as any).__agentHandler) process.removeListener("unhandledRejection", l)
    }
  })

  it("registers unhandledRejection handler that emits unhandled_rejection event", async () => {
    // Clean up any stale handlers from previous tests
    for (const l of process.listeners("unhandledRejection")) {
      if ((l as any).__agentHandler) process.removeListener("unhandledRejection", l)
    }

    vi.resetModules()
    const emitNervesEventLocal = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent: emitNervesEventLocal }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/test-session"),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "github" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "github" }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: false, port: 3978, flushIntervalMs: 1000 }),
    }))

    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn()
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    const listeners = process.listeners("unhandledRejection")
    const ouroboros = listeners.find((l) => (l as any).__agentHandler)
    expect(ouroboros).toBeDefined()

    ;(ouroboros as Function)(new Error("test rejection"))
    expect(emitNervesEventLocal).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "channel.unhandled_rejection",
      component: "channels",
      message: expect.stringContaining("test rejection"),
    }))

    // Cover non-Error branch
    emitNervesEventLocal.mockClear()
    ;(ouroboros as Function)("string rejection")
    expect(emitNervesEventLocal).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "channel.unhandled_rejection",
      component: "channels",
      message: expect.stringContaining("string rejection"),
    }))

    vi.restoreAllMocks()
  })

  it("does not register duplicate handler on second call", async () => {
    vi.resetModules()
    // no env vars to clear

    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn()
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))

    vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()
    teams.startTeamsApp()

    const listeners = process.listeners("unhandledRejection")
    const ouroborosCount = listeners.filter((l) => (l as any).__agentHandler).length
    expect(ouroborosCount).toBe(1)

    vi.restoreAllMocks()
  })
})

describe("Teams adapter - startTeamsApp (Bot mode)", () => {
  afterEach(() => {
    // Config is loaded from config.json only, no env vars to clear
  })

  function mockBotConfig(clientId: string, clientSecret: string, tenantId: string) {
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/bot-session.json"),
      getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId, clientSecret, tenantId }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "" }),
      getAdoConfig: vi.fn().mockReturnValue({ organizations: [] }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: false, port: 3978 }),
    }))
  }

  it("creates App WITHOUT DevtoolsPlugin when CLIENT_ID is set", async () => {
    vi.resetModules()

    let capturedOpts: any = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(opts: any) { capturedOpts = opts }
        on = vi.fn()
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      repairOrphanedToolCalls: vi.fn(),
    }))
    mockBotConfig("test-client-id", "test-secret", "test-tenant-id")

    vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    // Bot mode should NOT have plugins (no DevtoolsPlugin)
    expect(capturedOpts.plugins).toBeUndefined()

    vi.restoreAllMocks()
  })

  it("passes clientId, clientSecret, tenantId to App constructor", async () => {
    vi.resetModules()

    let capturedOpts: any = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(opts: any) { capturedOpts = opts }
        on = vi.fn()
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      repairOrphanedToolCalls: vi.fn(),
    }))
    mockBotConfig("my-app-id", "my-secret", "my-tenant")

    vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    expect(capturedOpts.clientId).toBe("my-app-id")
    expect(capturedOpts.clientSecret).toBe("my-secret")
    expect(capturedOpts.tenantId).toBe("my-tenant")

    vi.restoreAllMocks()
  })

  it("passes activity.mentions.stripText in bot mode", async () => {
    vi.resetModules()

    let capturedOpts: any = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(opts: any) { capturedOpts = opts }
        on = vi.fn()
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      repairOrphanedToolCalls: vi.fn(),
    }))
    mockBotConfig("test-id", "test-secret", "test-tenant")

    vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    expect(capturedOpts.activity).toEqual({ mentions: { stripText: true } })

    vi.restoreAllMocks()
  })

  it("emits app_started event with Bot Service mode", async () => {
    vi.resetModules()
    const emitNervesEventLocal = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent: emitNervesEventLocal }))

    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn()
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      repairOrphanedToolCalls: vi.fn(),
    }))
    mockBotConfig("test-id", "test-secret", "test-tenant")

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    expect(emitNervesEventLocal).toHaveBeenCalledWith(expect.objectContaining({
      level: "info",
      event: "channel.app_started",
      component: "channels",
      meta: expect.objectContaining({ mode: "Bot Service (client secret)" }),
    }))

    vi.restoreAllMocks()
  })

  it("registers message handler in bot mode", async () => {
    vi.resetModules()

    const mockOn = vi.fn()
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = mockOn
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      repairOrphanedToolCalls: vi.fn(),
    }))
    mockBotConfig("test-id", "test-secret", "test-tenant")

    vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    expect(mockOn).toHaveBeenCalledWith("message", expect.any(Function))

    vi.restoreAllMocks()
  })
})

describe("Teams adapter - phrase rotation", () => {
  let mockStream: { emit: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  let controller: AbortController

  beforeEach(() => {
    vi.useFakeTimers()
    mockStream = {
      emit: vi.fn(),
      update: vi.fn(),
      close: vi.fn(),
    }
    controller = new AbortController()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("rotates phrases every 1.5s during onModelStart", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onModelStart()
    const firstCall = mockStream.update.mock.calls[0][0] as string
    expect(firstCall).toMatch(/\.\.\.$/)

    mockStream.update.mockClear()
    vi.advanceTimersByTime(1500)
    expect(mockStream.update).toHaveBeenCalledTimes(1)
    const rotatedCall = mockStream.update.mock.calls[0][0] as string
    expect(rotatedCall).toMatch(/\.\.\.$/)
    const phrase = rotatedCall.replace(/\.\.\.$/, "")
    expect(getPhrases().thinking).toContain(phrase)

    callbacks.onTextChunk("done") // cleanup
  })

  it("onModelStreamStart is a no-op (phrases keep cycling through reasoning)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onModelStart()
    callbacks.onModelStreamStart() // no-op — does NOT stop rotation
    mockStream.update.mockClear()
    vi.advanceTimersByTime(1500)
    // Phrases still cycling
    expect(mockStream.update).toHaveBeenCalled()
    // cleanup
    callbacks.onTextChunk("done")
  })

  it("onReasoningChunk stops phrase rotation and shows reasoning via periodic flush", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onModelStart()
    callbacks.onReasoningChunk("thinking hard")
    mockStream.update.mockClear()
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS)
    // Phrase rotation stopped, but reasoning is flushed via periodic timer
    expect(mockStream.update).toHaveBeenCalledTimes(1)
    expect(mockStream.update).toHaveBeenCalledWith("thinking hard")
    // cleanup
    callbacks.onTextChunk("done")
  })

  it("onTextChunk stops phrase rotation", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onModelStart()
    vi.advanceTimersByTime(1500) // rotation fires
    mockStream.update.mockClear()
    callbacks.onTextChunk("hello") // stops rotation
    vi.advanceTimersByTime(3000)
    // No more rotation after text arrives
    expect(mockStream.update).not.toHaveBeenCalled()
  })

  it("onModelStart uses FOLLOWUP_PHRASES after a tool run (no prior text)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    // First model call — goes straight to tool without text/reasoning
    callbacks.onModelStart()
    callbacks.onToolStart("read_file", { path: "x" })
    callbacks.onToolEnd("read_file", "x", true)
    // Second model call — hadToolRun is true, hadRealOutput is false
    mockStream.update.mockClear()
    callbacks.onModelStart()
    expect(mockStream.update).toHaveBeenCalled()
    const phrase = (mockStream.update.mock.calls[0][0] as string).replace(/\.\.\.$/, "")
    expect(getPhrases().followup).toContain(phrase)

    callbacks.onTextChunk("done") // cleanup
  })

  it("onModelStart is suppressed after reasoning output even with tool run", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onModelStart()
    callbacks.onReasoningChunk("thinking") // sets hadRealOutput
    callbacks.onTextChunk("response")
    callbacks.onToolStart("read_file", { path: "x" })
    callbacks.onToolEnd("read_file", "x", true)
    // hadRealOutput is true (from reasoning), so onModelStart is suppressed
    mockStream.update.mockClear()
    callbacks.onModelStart()
    expect(mockStream.update).not.toHaveBeenCalled()

    callbacks.onTextChunk("done") // cleanup
  })

  it("onModelStart is suppressed after reasoning output", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onModelStart()
    callbacks.onReasoningChunk("deep thought") // sets hadRealOutput
    callbacks.onTextChunk("answer")
    // Second model call — no phrases
    mockStream.update.mockClear()
    callbacks.onModelStart()
    expect(mockStream.update).not.toHaveBeenCalled()

    callbacks.onTextChunk("done") // cleanup
  })

  it("onError stops phrase rotation", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onModelStart()
    callbacks.onError(new Error("boom"), "terminal")
    mockStream.update.mockClear()
    vi.advanceTimersByTime(3000)
    expect(mockStream.update).not.toHaveBeenCalled()
  })

  it("onToolStart stops phrase rotation from onModelStart", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)

    callbacks.onModelStart()
    callbacks.onToolStart("shell", { command: "ls" })
    mockStream.update.mockClear()
    vi.advanceTimersByTime(3000)
    // No rotation after tool start (it uses static tool name display)
    expect(mockStream.update).not.toHaveBeenCalled()
  })
})

describe("Teams adapter - session persistence", () => {
  beforeEach(() => {
    // no env vars to clear
  })

  function mockTeamsDeps(overrides: {
    runAgentFn?: any
    loadSessionReturn?: any
    saveSessionCalls?: any[][]
    postTurnCalls?: any[][]
    deleteSessionCalls?: string[]
    trimMessagesFn?: any
    parseSlashCommandFn?: any
    dispatchFn?: any
    teamsChannelConfig?: any
  } = {}) {
    const {
      runAgentFn = vi.fn().mockResolvedValue({ usage: undefined }),
      loadSessionReturn = null,
      saveSessionCalls = [],
      postTurnCalls = [],
      deleteSessionCalls = [],
      trimMessagesFn = ((msgs: any) => [...msgs]),
      parseSlashCommandFn = (() => null),
      dispatchFn = (() => ({ handled: false })),
      teamsChannelConfig = { skipConfirmation: false, port: 3978 },
    } = overrides

    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: runAgentFn,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/teams-session.json"),
      getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "" }),
      getAdoConfig: vi.fn().mockReturnValue({ organizations: [] }),
      getTeamsChannelConfig: vi.fn().mockReturnValue(teamsChannelConfig),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(loadSessionReturn),
      saveSession: vi.fn().mockImplementation((...args: any[]) => { saveSessionCalls.push(args) }),
      deleteSession: vi.fn().mockImplementation((...args: any[]) => { deleteSessionCalls.push(args[0]) }),
      trimMessages: vi.fn().mockImplementation(trimMessagesFn),

      postTurn: vi.fn().mockImplementation((...args: any[]) => { postTurnCalls.push(args) }),
    }))
    vi.doMock("../../senses/commands", () => ({
      createCommandRegistry: vi.fn().mockReturnValue({
        register: vi.fn(),
        get: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        dispatch: vi.fn().mockImplementation(dispatchFn),
      }),
      registerDefaultCommands: vi.fn(),
      parseSlashCommand: vi.fn().mockImplementation(parseSlashCommandFn),
    }))
    const MockFileFriendStore = vi.fn(function (this: any) {
      this.get = vi.fn()
      this.put = vi.fn()
      this.delete = vi.fn()
      this.findByExternalId = vi.fn()
    })
    vi.doMock("../../mind/friends/store-file", () => ({
      FileFriendStore: MockFileFriendStore,
    }))
    const mockResolve = vi.fn().mockResolvedValue({
      friend: {
        id: "mock-uuid",
        name: "Test User",
        externalIds: [{ provider: "aad", externalId: "aad-user-123", tenantId: "tenant-abc", linkedAt: "2026-01-01" }],
        tenantMemberships: ["tenant-abc"],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams",
        availableIntegrations: ["graph", "ado"],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    })
    const MockFriendResolver = vi.fn(function (this: any) {
      this.resolve = mockResolve
    })
    vi.doMock("../../mind/friends/resolver", () => ({
      FriendResolver: MockFriendResolver,
    }))
  }

  it("handleTeamsMessage accepts conversationId parameter", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDeps({ runAgentFn })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await teams.handleTeamsMessage("hello", mockStream as any, "conv-123")
    expect(runAgentFn).toHaveBeenCalled()
  })

  it("loads session for conversation on each message", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    const savedSession = [
      { role: "system", content: "old prompt" },
      { role: "user", content: "previous msg" },
    ]
    mockTeamsDeps({ runAgentFn, loadSessionReturn: { messages: savedSession, lastUsage: undefined } })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await teams.handleTeamsMessage("new msg", mockStream as any, "conv-123")

    const msgs = runAgentFn.mock.calls[0][0]
    // System prompt comes from loaded session (refresh now happens inside runAgent)
    expect(msgs[0].role).toBe("system")
    expect(msgs.some((m: any) => m.content === "new msg")).toBe(true)
  })

  it("calls postTurn after runAgent with usage", async () => {
    vi.resetModules()
    const usageData = { input_tokens: 200, output_tokens: 100, reasoning_tokens: 20, total_tokens: 320 }
    const postTurnCalls: any[][] = []
    mockTeamsDeps({
      runAgentFn: vi.fn().mockResolvedValue({ usage: usageData }),
      postTurnCalls,
    })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await teams.handleTeamsMessage("hello", mockStream as any, "conv-123")

    expect(postTurnCalls.length).toBe(1)
    expect(postTurnCalls[0][1]).toBe("/tmp/teams-session.json")
    expect(postTurnCalls[0][2]).toEqual(usageData)
  })

  it("does not call trimMessages directly (postTurn handles it)", async () => {
    vi.resetModules()
    const trimCalls: any[][] = []
    mockTeamsDeps({
      trimMessagesFn: (...args: any[]) => { trimCalls.push(args); return [...args[0]] },
    })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await teams.handleTeamsMessage("hello", mockStream as any, "conv-123")

    expect(trimCalls.length).toBe(0) // trimming moved to postTurn
  })

  it("creates fresh session when no session exists", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDeps({ runAgentFn, loadSessionReturn: null })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await teams.handleTeamsMessage("hello", mockStream as any, "conv-123")

    const msgs = runAgentFn.mock.calls[0][0]
    expect(msgs[0].role).toBe("system")
    expect(msgs[0].content).toBe("system prompt")
    expect(msgs.length).toBe(2) // system + user
  })

  it("/new clears session and sends confirmation via stream", async () => {
    vi.resetModules()
    const deleteSessionCalls: string[] = []
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDeps({
      runAgentFn,
      deleteSessionCalls,
      parseSlashCommandFn: (input: string) => input.startsWith("/") ? { command: input.slice(1).toLowerCase(), args: "" } : null,
      dispatchFn: (name: string) => {
        if (name === "new") return { handled: true, result: { action: "new" } }
        return { handled: false }
      },
    })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await teams.handleTeamsMessage("/new", mockStream as any, "conv-123")

    expect(deleteSessionCalls.length).toBe(1)
    expect(mockStream.emit).toHaveBeenCalledWith(expect.stringContaining("session cleared"))
    expect(runAgentFn).not.toHaveBeenCalled()
  })

  it("/commands sends command list via stream without calling runAgent", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDeps({
      runAgentFn,
      parseSlashCommandFn: (input: string) => input.startsWith("/") ? { command: input.slice(1).toLowerCase(), args: "" } : null,
      dispatchFn: (name: string) => {
        if (name === "commands") return { handled: true, result: { action: "response", message: "/new - start new" } }
        return { handled: false }
      },
    })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await teams.handleTeamsMessage("/commands", mockStream as any, "conv-123")

    expect(mockStream.emit).toHaveBeenCalledWith(expect.stringContaining("/new"))
    expect(runAgentFn).not.toHaveBeenCalled()
  })

  it("multiple conversations maintain separate sessions", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDeps({ runAgentFn })
    const teams = await import("../../senses/teams")
    const mockStream1 = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    const mockStream2 = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    await teams.handleTeamsMessage("msg for conv1", mockStream1 as any, "conv-1")
    await teams.handleTeamsMessage("msg for conv2", mockStream2 as any, "conv-2")

    // Each call gets its own session (both load null, get fresh messages)
    expect(runAgentFn).toHaveBeenCalledTimes(2)
    const msgs1 = runAgentFn.mock.calls[0][0]
    const msgs2 = runAgentFn.mock.calls[1][0]
    expect(msgs1.find((m: any) => m.content === "msg for conv1")).toBeDefined()
    expect(msgs2.find((m: any) => m.content === "msg for conv2")).toBeDefined()
  })

  it("graceful fallback on corrupt session file", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDeps({ runAgentFn, loadSessionReturn: null }) // null = corrupt
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await teams.handleTeamsMessage("hello", mockStream as any, "conv-123")

    expect(runAgentFn).toHaveBeenCalled()
    const msgs = runAgentFn.mock.calls[0][0]
    expect(msgs[0].role).toBe("system")
  })

  it("slash command handled but no result falls through to normal message handling", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDeps({
      runAgentFn,
      parseSlashCommandFn: (input: string) => input.startsWith("/") ? { command: input.slice(1).toLowerCase(), args: "" } : null,
      dispatchFn: () => ({ handled: true, result: undefined }),
    })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await teams.handleTeamsMessage("/unknown", mockStream as any, "conv-123")

    // Should fall through to runAgent since dispatch had no result
    expect(runAgentFn).toHaveBeenCalled()
  })

  it("/commands with no message field emits empty string", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDeps({
      runAgentFn,
      parseSlashCommandFn: (input: string) => input.startsWith("/") ? { command: input.slice(1).toLowerCase(), args: "" } : null,
      dispatchFn: (name: string) => {
        if (name === "commands") return { handled: true, result: { action: "response", message: undefined } }
        return { handled: false }
      },
    })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await teams.handleTeamsMessage("/commands", mockStream as any, "conv-123")

    expect(mockStream.emit).toHaveBeenCalledWith("")
    expect(runAgentFn).not.toHaveBeenCalled()
  })

  it("slash command with unrecognized action falls through to normal handling", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDeps({
      runAgentFn,
      parseSlashCommandFn: (input: string) => input.startsWith("/") ? { command: input.slice(1).toLowerCase(), args: "" } : null,
      dispatchFn: () => ({ handled: true, result: { action: "exit" } }),
    })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await teams.handleTeamsMessage("/exit", mockStream as any, "conv-123")

    // "exit" action is not handled in Teams, so falls through to runAgent
    expect(runAgentFn).toHaveBeenCalled()
  })

  it("withConversationLock serializes messages for same conversation", async () => {
    vi.resetModules()
    const order: string[] = []
    mockTeamsDeps({})
    const teams = await import("../../senses/teams")

    const { withConversationLock } = teams
    let callCount = 0
    await Promise.all([
      withConversationLock("conv-1", async () => {
        const id = callCount++
        order.push(`start-${id}`)
        await new Promise((r) => setTimeout(r, 10))
        order.push(`end-${id}`)
      }),
      withConversationLock("conv-1", async () => {
        const id = callCount++
        order.push(`start-${id}`)
        await new Promise((r) => setTimeout(r, 10))
        order.push(`end-${id}`)
      }),
    ])

    // Should be sequential: start-0, end-0, start-1, end-1
    expect(order).toEqual(["start-0", "end-0", "start-1", "end-1"])
  })

  it("withConversationLock allows parallel for different conversations", async () => {
    vi.resetModules()
    const order: string[] = []
    const runAgentFn = vi.fn().mockImplementation(async (id: string) => {
      order.push(`start-${id}`)
      await new Promise((r) => setTimeout(r, 10))
      order.push(`end-${id}`)
    })
    mockTeamsDeps({ runAgentFn })
    const teams = await import("../../senses/teams")

    const { withConversationLock } = teams
    await Promise.all([
      withConversationLock("conv-1", async () => { await runAgentFn("1") }),
      withConversationLock("conv-2", async () => { await runAgentFn("2") }),
    ])

    // Both start before either ends (parallel)
    expect(order[0]).toBe("start-1")
    expect(order[1]).toBe("start-2")
  })

  it("does not hard-reject concurrent conversations while one turn is in-flight", async () => {
    vi.resetModules()
    let releaseFirst: (() => void) | undefined
    const firstTurn = new Promise<void>((resolve) => { releaseFirst = resolve })
    const runAgentFn = vi.fn()
      .mockImplementationOnce(async () => {
        await firstTurn
        return { usage: undefined }
      })
      .mockResolvedValue({ usage: undefined })

    mockTeamsDeps({
      runAgentFn,
      teamsChannelConfig: { skipConfirmation: false, port: 3978 },
    })
    const teams = await import("../../senses/teams")

    const stream1 = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    const stream2 = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    const firstMessage = teams.handleTeamsMessage("first", stream1 as any, "conv-1")
    for (let i = 0; i < 20 && runAgentFn.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 1))
    }
    expect(runAgentFn).toHaveBeenCalledTimes(1)

    await teams.handleTeamsMessage("second", stream2 as any, "conv-2")
    const emitted = stream2.emit.mock.calls.map((c: any[]) => String(c[0] ?? "")).join("\n")
    expect(emitted).not.toContain("single-replica preview")
    expect(emitted).not.toContain("maximum concurrent conversations")
    expect(runAgentFn).toHaveBeenCalledTimes(2)

    releaseFirst?.()
    await firstMessage
  })

  it("handleTeamsMessage passes toolContext to runAgent when provided via TeamsMessageContext", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDeps({ runAgentFn })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    const teamsContext = {
      graphToken: "g-token",
      adoToken: "a-token",
      signin: vi.fn(),
    }

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-123", teamsContext)
    expect(runAgentFn).toHaveBeenCalled()

    // Check that runAgent was called with options containing toolContext
    const callArgs = runAgentFn.mock.calls[0]
    const options = callArgs[4] // 5th arg is options
    expect(options).toBeDefined()
    expect(options.toolContext).toBeDefined()
    expect(options.toolContext.graphToken).toBe("g-token")
    expect(options.toolContext.adoToken).toBe("a-token")
    expect(typeof options.toolContext.signin).toBe("function")
    // adoOrganizations removed from ToolContext in Unit 1Ha
    expect(options.toolContext.adoOrganizations).toBeUndefined()
  })

  it("handleTeamsMessage works without TeamsMessageContext (backward compat)", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDeps({ runAgentFn })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    // No teamsContext parameter -- should still work
    await teams.handleTeamsMessage("hello", mockStream as any, "conv-123")
    expect(runAgentFn).toHaveBeenCalled()
  })

  it("creates and passes a traceId option to runAgent at Teams turn entry", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDeps({ runAgentFn })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-123")
    expect(runAgentFn).toHaveBeenCalled()
    expect(runAgentFn.mock.calls[0][4]).toEqual(expect.objectContaining({ traceId: expect.any(String) }))
  })

  it("skipConfirmation=true in teamsChannel config sets skipConfirmation in agent options", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    // Use mockTeamsDeps first (sets base config mock), then override getTeamsChannelConfig
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: runAgentFn,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/teams-session.json"),
      getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "" }),
      getAdoConfig: vi.fn().mockReturnValue({ organizations: [] }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: true, port: 3978 }),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),

      postTurn: vi.fn(),
    }))
    vi.doMock("../../senses/commands", () => ({
      createCommandRegistry: vi.fn().mockReturnValue({
        register: vi.fn(),
        get: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        dispatch: vi.fn().mockReturnValue({ handled: false }),
      }),
      registerDefaultCommands: vi.fn(),
      parseSlashCommand: vi.fn().mockReturnValue(null),
    }))
    vi.doMock("../../mind/friends/store-file", () => ({
      FileFriendStore: vi.fn(function (this: any) {
        this.get = vi.fn(); this.put = vi.fn(); this.delete = vi.fn(); this.findByExternalId = vi.fn()
      }),
    }))
    vi.doMock("../../mind/friends/resolver", () => ({
      FriendResolver: vi.fn(function (this: any) {
        this.resolve = vi.fn().mockResolvedValue({
          friend: { id: "m", name: "U", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01", schemaVersion: 1 },
          channel: { channel: "teams", availableIntegrations: ["graph", "ado"], supportsMarkdown: true, supportsStreaming: true, supportsRichCards: true, maxMessageLength: 28000 },
        })
      }),
    }))
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-123", { graphToken: "t", adoToken: "t", signin: vi.fn() })
    expect(runAgentFn).toHaveBeenCalled()
    const options = runAgentFn.mock.calls[0][4]
    expect(options.skipConfirmation).toBe(true)
  })

  it("skipConfirmation not set when teamsChannel.skipConfirmation is false (default)", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDeps({ runAgentFn })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-123", { graphToken: "t", adoToken: "t", signin: vi.fn() })
    expect(runAgentFn).toHaveBeenCalled()
    const options = runAgentFn.mock.calls[0][4]
    expect(options.skipConfirmation).toBeUndefined()
  })

  it("triggers signin for AUTH_REQUIRED:graph after agent loop", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockImplementation(async (msgs: any[]) => {
      msgs.push({ role: "assistant", content: "AUTH_REQUIRED:graph" })
      return { usage: undefined }
    })
    mockTeamsDeps({ runAgentFn })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    const signinFn = vi.fn()

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-auth", {
      graphToken: undefined,
      adoToken: undefined,
      signin: signinFn,
      graphConnectionName: "graph",
      adoConnectionName: "ado",
    })

    expect(signinFn).toHaveBeenCalledWith("graph")
  })

  it("triggers signin for AUTH_REQUIRED:ado after agent loop", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockImplementation(async (msgs: any[]) => {
      msgs.push({ role: "assistant", content: "AUTH_REQUIRED:ado" })
      return { usage: undefined }
    })
    mockTeamsDeps({ runAgentFn })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    const signinFn = vi.fn()

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-auth-ado", {
      graphToken: undefined,
      adoToken: undefined,
      signin: signinFn,
      graphConnectionName: "graph",
      adoConnectionName: "ado",
    })

    expect(signinFn).toHaveBeenCalledWith("ado")
  })

  it("does not trigger signin when no AUTH_REQUIRED in messages", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockImplementation(async (msgs: any[]) => {
      msgs.push({ role: "assistant", content: "all good" })
      return { usage: undefined }
    })
    mockTeamsDeps({ runAgentFn })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    const signinFn = vi.fn()

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-no-auth", {
      graphToken: "token",
      adoToken: "token",
      signin: signinFn,
    })

    expect(signinFn).not.toHaveBeenCalled()
  })

  it("handles non-string message content in AUTH_REQUIRED check", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockImplementation(async (msgs: any[]) => {
      msgs.push({ role: "assistant", content: [{ type: "text", text: "complex" }] })
      return { usage: undefined }
    })
    mockTeamsDeps({ runAgentFn })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    const signinFn = vi.fn()

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-complex", {
      graphToken: undefined,
      adoToken: undefined,
      signin: signinFn,
    })

    // Non-string content should be treated as empty, not crash
    expect(signinFn).not.toHaveBeenCalled()
  })
})

describe("Teams adapter - unified chunked streaming (no disableStreaming)", () => {
  let mockStream: { emit: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  let controller: AbortController

  beforeEach(() => {
    mockStream = {
      emit: vi.fn(),
      update: vi.fn(),
      close: vi.fn(),
    }
    controller = new AbortController()
  })

  it("TeamsCallbackOptions does not accept disableStreaming (accepts flushIntervalMs)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    // This should work with flushIntervalMs instead of disableStreaming
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage, { flushIntervalMs: 2000 })
    callbacks.onTextChunk("Hello")
    // Text is always accumulated, never emitted per-token
    expect(mockStream.emit).not.toHaveBeenCalled()
  })

  it("safeSend catch: when sendMessage throws synchronously, controller is aborted", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockImplementation(() => { throw new Error("sync failure") })
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    // Trigger safeSend via terminal onError
    callbacks.onError(new Error("boom"), "terminal")
    expect(controller.signal.aborted).toBe(true)
  })

  it("onToolStart flushes text to safeEmit when stream already has content", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    // First: emit text to stream (sets streamHasContent)
    callbacks.onTextChunk("first response")
    await callbacks.flush()
    expect(mockStream.emit).toHaveBeenCalledWith("first response")
    mockStream.emit.mockClear()
    // Second: accumulate more text, then onToolStart flushes via safeEmit (cumulative stream)
    callbacks.onTextChunk("second text")
    callbacks.onToolStart("read_file", { path: "test.txt" })
    expect(mockStream.emit).toHaveBeenCalledWith("second text")
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("flush() with no prior stream content: first text goes to stream.emit", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("Hello")
    callbacks.onTextChunk(" world")
    callbacks.onTextChunk("!")
    expect(mockStream.emit).not.toHaveBeenCalled()
    await callbacks.flush()
    expect(mockStream.emit).toHaveBeenCalledTimes(1)
    expect(mockStream.emit).toHaveBeenCalledWith("Hello world!")
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("flush() with prior stream content: subsequent text still goes to safeEmit (cumulative)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    // First iteration: text goes to emit
    callbacks.onTextChunk("first response")
    await callbacks.flush()
    mockStream.emit.mockClear()
    // Second iteration: also goes to emit (SDK accumulates cumulatively)
    callbacks.onTextChunk("second response")
    await callbacks.flush()
    expect(mockStream.emit).toHaveBeenCalledWith("second response")
  })

  it("flush() with prior stream content: subsequent text goes to safeEmit not sendMessage", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    // First iteration: text goes to emit
    callbacks.onTextChunk("first response")
    await callbacks.flush()
    mockStream.emit.mockClear()
    // Second iteration: also goes to emit (cumulative stream), not sendMessage
    callbacks.onTextChunk("second response")
    await callbacks.flush()
    expect(mockStream.emit).toHaveBeenCalledWith("second response")
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("flush() with no text and no prior stream content: emits fallback message", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    // No text chunks at all
    await callbacks.flush()
    expect(mockStream.emit).toHaveBeenCalledWith("(completed with tool calls only \u2014 no text response)")
  })

  it("flush() with subsequent text uses safeEmit (sync, no await needed)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    // First flush
    callbacks.onTextChunk("first")
    await callbacks.flush()
    mockStream.emit.mockClear()
    // Second flush — goes to safeEmit, not sendMessage
    callbacks.onTextChunk("second")
    await callbacks.flush()
    expect(mockStream.emit).toHaveBeenCalledWith("second")
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("flush() with empty buffer after prior content is a no-op (does not send empty)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("text")
    await callbacks.flush()
    mockStream.emit.mockClear()
    sendMessage.mockClear()
    // Second flush with no new text
    await callbacks.flush()
    expect(mockStream.emit).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("flush() sends full text without preemptive splitting (first flush to emit)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    // Text exceeds old 4000-char limit -- should still be sent as one piece
    const longText = "a".repeat(3000) + "\n\n" + "b".repeat(3000)
    callbacks.onTextChunk(longText)
    await callbacks.flush()
    // Full text to emit (no splitting)
    expect(mockStream.emit).toHaveBeenCalledTimes(1)
    expect(mockStream.emit).toHaveBeenCalledWith(longText)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("flush() sends full text via safeEmit after prior content (no preemptive splitting)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    // First flush sets streamHasContent
    callbacks.onTextChunk("first")
    await callbacks.flush()
    mockStream.emit.mockClear()
    sendMessage.mockClear()
    // Second flush with long text -- sent via safeEmit (cumulative), not sendMessage
    const longText = "x".repeat(3000) + "\n\n" + "y".repeat(3000)
    callbacks.onTextChunk(longText)
    await callbacks.flush()
    expect(mockStream.emit).toHaveBeenCalledTimes(1)
    expect(mockStream.emit).toHaveBeenCalledWith(longText)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("flush() splits and retries when sendMessage fails on dead stream (error recovery)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn()
    const longText = "a".repeat(3000) + "\n\n" + "b".repeat(3000)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    // Buffer long text while stream is alive, then kill the stream
    callbacks.onTextChunk(longText)
    mockStream.emit.mockImplementation(() => { throw new Error("403") })
    // Full-text sendMessage rejects (e.g. 413), subsequent chunk sends succeed
    sendMessage.mockRejectedValueOnce(new Error("413 Request Entity Too Large"))
    sendMessage.mockResolvedValue(undefined)
    // flush() tries safeEmit → 403 → markStopped → falls through to sendMessage
    await callbacks.flush()
    // First call was the full text (rejected), then two split chunks
    expect(sendMessage).toHaveBeenCalledTimes(3)
    expect(sendMessage).toHaveBeenNthCalledWith(1, longText)
    expect(sendMessage).toHaveBeenNthCalledWith(2, "a".repeat(3000))
    expect(sendMessage).toHaveBeenNthCalledWith(3, "b".repeat(3000))
  })

  it("flush() recovers when stream.emit rejects asynchronously (e.g. 413)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    // Buffer text while stream is alive
    callbacks.onTextChunk("hello world")
    // Make emit return a rejected promise (async 413) instead of throwing synchronously
    mockStream.emit.mockReturnValue(Promise.reject(new Error("413")))
    // flush() awaits tryEmit → async rejection → markStopped → falls through to sendMessage
    await callbacks.flush()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith("hello world")
  })

  it("flushTextBuffer sends full text without splitting", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    // Accumulate long text
    const longText = "a".repeat(3000) + "\n\n" + "b".repeat(3000)
    callbacks.onTextChunk(longText)
    // onToolStart triggers flushTextBuffer
    callbacks.onToolStart("test_tool", { arg: "val" })
    // Full text sent to emit (no splitting)
    expect(mockStream.emit).toHaveBeenCalledTimes(1)
    expect(mockStream.emit).toHaveBeenCalledWith(longText)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("stop-streaming (403) via emit during flush aborts controller", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("data")
    mockStream.emit.mockImplementation(() => { throw new Error("403 Forbidden") })
    await callbacks.flush()
    expect(controller.signal.aborted).toBe(true)
  })

  it("flush() falls back to sendMessage when stream is dead (stopped)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("important content")
    // Kill the stream (e.g. platform error during generation)
    mockStream.update.mockImplementation(() => { throw new Error("403 Forbidden") })
    callbacks.onModelStart() // triggers safeUpdate -> markStopped
    // Stream is now dead. flush() should fall back to sendMessage instead of safeEmit.
    await callbacks.flush()
    expect(mockStream.emit).not.toHaveBeenCalledWith("important content")
    expect(sendMessage).toHaveBeenCalledWith("important content")
  })
})

describe("Teams adapter - safeSend serialization (Bug 2)", () => {
  let mockStream: { emit: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  let controller: AbortController

  beforeEach(() => {
    mockStream = {
      emit: vi.fn(),
      update: vi.fn(),
      close: vi.fn(),
    }
    controller = new AbortController()
  })

  it("concurrent safeSend calls execute sends sequentially (not concurrently)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")

    // Track the execution order: each sendMessage records when it starts and
    // resolves only after we explicitly resolve its deferred.
    const order: string[] = []
    let resolve1!: () => void
    let resolve2!: () => void
    const promise1 = new Promise<void>(r => { resolve1 = r })
    const promise2 = new Promise<void>(r => { resolve2 = r })

    const sendMessage = vi.fn()
      .mockImplementationOnce(() => {
        order.push("send1-start")
        return promise1.then(() => { order.push("send1-end") })
      })
      .mockImplementationOnce(() => {
        order.push("send2-start")
        return promise2.then(() => { order.push("send2-end") })
      })

    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)

    // Trigger two safeSend calls via terminal onError
    callbacks.onError(new Error("err1"), "terminal")
    callbacks.onError(new Error("err2"), "terminal")

    // With serialization, send2 should NOT start until send1 completes.
    // With fire-and-forget, both start immediately.
    expect(order).toContain("send1-start")

    // If serialized, send2-start should NOT be in order yet (send1 hasn't completed)
    expect(order).not.toContain("send2-start")

    // Complete the first send
    resolve1()
    await promise1
    // Allow microtasks to flush so the chain continuation runs
    await new Promise(r => setTimeout(r, 0))

    // Now send2 should have started (chain continuation)
    expect(order).toContain("send2-start")

    // Complete the second send
    resolve2()
    await promise2
    await new Promise(r => setTimeout(r, 0))

    expect(order).toEqual(["send1-start", "send1-end", "send2-start", "send2-end"])
  })

  it("failed send in chain halts subsequent sends via markStopped()", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")

    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce(undefined)

    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)

    // First send will reject (triggers markStopped via chain .catch)
    callbacks.onError(new Error("err1"), "terminal")
    // Second send should be suppressed because stopped=true after chain failure
    callbacks.onError(new Error("err2"), "terminal")

    // Wait for the rejection to propagate through the chain
    await new Promise(r => setTimeout(r, 50))

    // With serialized chain: first send rejects -> markStopped() -> second send never fires.
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(controller.signal.aborted).toBe(true)
  })

  it("chained send rejection halts the chain via markStopped()", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")

    let resolve1!: () => void
    const promise1 = new Promise<void>(r => { resolve1 = r })

    const sendMessage = vi.fn()
      .mockImplementationOnce(() => promise1) // first send: succeeds when resolved
      .mockRejectedValueOnce(new Error("second send failed")) // second send: rejects

    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)

    // First send starts synchronously (chain idle)
    callbacks.onError(new Error("err1"), "terminal")
    // Second send chains (chain busy)
    callbacks.onError(new Error("err2"), "terminal")

    expect(sendMessage).toHaveBeenCalledTimes(1) // only first started so far

    // Complete the first send successfully
    resolve1()
    await promise1
    // Wait for the chain continuation
    await new Promise(r => setTimeout(r, 50))

    // Second send fired and rejected -- markStopped() should have been called
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(controller.signal.aborted).toBe(true)
  })
})

describe("Teams adapter - handleTeamsMessage unified chunked streaming", () => {
  beforeEach(() => {
    // no env vars to clear
  })

  function mockTeamsDeps2(overrides: {
    runAgentFn?: any
    loadSessionReturn?: any
    postTurnCalls?: any[][]
    deleteSessionCalls?: string[]
    parseSlashCommandFn?: any
    dispatchFn?: any
  } = {}) {
    const {
      runAgentFn = vi.fn().mockResolvedValue({ usage: undefined }),
      loadSessionReturn = null,
      postTurnCalls = [],
      deleteSessionCalls = [],
      parseSlashCommandFn = (() => null),
      dispatchFn = (() => ({ handled: false })),
    } = overrides

    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: runAgentFn,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/teams-session.json"),
      getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "" }),
      getAdoConfig: vi.fn().mockReturnValue({ organizations: [] }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: false, port: 3978 }),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(loadSessionReturn),
      saveSession: vi.fn(),
      deleteSession: vi.fn().mockImplementation((...args: any[]) => { deleteSessionCalls.push(args[0]) }),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),

      postTurn: vi.fn().mockImplementation((...args: any[]) => { postTurnCalls.push(args) }),
    }))
    vi.doMock("../../senses/commands", () => ({
      createCommandRegistry: vi.fn().mockReturnValue({
        register: vi.fn(),
        get: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        dispatch: vi.fn().mockImplementation(dispatchFn),
      }),
      registerDefaultCommands: vi.fn(),
      parseSlashCommand: vi.fn().mockImplementation(parseSlashCommandFn),
    }))
    const MockFileFriendStore = vi.fn(function (this: any) {
      this.get = vi.fn()
      this.put = vi.fn()
      this.delete = vi.fn()
      this.findByExternalId = vi.fn()
    })
    vi.doMock("../../mind/friends/store-file", () => ({
      FileFriendStore: MockFileFriendStore,
    }))
    const mockResolve = vi.fn().mockResolvedValue({
      friend: {
        id: "mock-uuid",
        name: "Test User",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams",
        availableIntegrations: ["graph", "ado"],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    })
    const MockFriendResolver = vi.fn(function (this: any) {
      this.resolve = mockResolve
    })
    vi.doMock("../../mind/friends/resolver", () => ({
      FriendResolver: MockFriendResolver,
    }))
  }

  it("handleTeamsMessage does not accept disableStreaming parameter -- text always accumulated", async () => {
    vi.resetModules()
    const mockRunAgent = vi.fn().mockImplementation(async (_msgs: any, callbacks: any) => {
      callbacks.onTextChunk("Hello")
      callbacks.onTextChunk(" world")
      return { usage: undefined }
    })
    mockTeamsDeps2({ runAgentFn: mockRunAgent })

    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    // handleTeamsMessage no longer accepts disableStreaming parameter (5th arg)
    // Text is always accumulated and flushed
    await teams.handleTeamsMessage("test", mockStream as any, "conv-123")

    // Text should have been emitted once via flush() after runAgent completes
    const emitCalls = mockStream.emit.mock.calls.filter((c: any) => !c[0].startsWith("Error"))
    expect(emitCalls).toHaveLength(1)
    expect(emitCalls[0][0]).toBe("Hello world")
  })

  it("flush() is called after runAgent completes", async () => {
    vi.resetModules()
    const mockRunAgent = vi.fn().mockImplementation(async (_msgs: any, callbacks: any) => {
      callbacks.onTextChunk("buffered text")
      return { usage: undefined }
    })
    mockTeamsDeps2({ runAgentFn: mockRunAgent })

    const teams = await import("../../senses/teams")
    const mockStream = {
      emit: vi.fn(),
      update: vi.fn(),
      close: vi.fn(),
    }
    await teams.handleTeamsMessage("test", mockStream as any, "conv-123")

    // The emit should have been called (by flush after runAgent)
    expect(mockStream.emit).toHaveBeenCalledWith("buffered text")
  })

  it("RunAgentOptions does not include disableStreaming", async () => {
    vi.resetModules()
    let capturedOptions: any = null
    const mockRunAgent = vi.fn().mockImplementation(async (_msgs: any, _callbacks: any, _channel: any, _signal: any, options: any) => {
      capturedOptions = options
      return { usage: undefined }
    })
    mockTeamsDeps2({ runAgentFn: mockRunAgent })

    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await teams.handleTeamsMessage("test", mockStream as any, "conv-123")

    // The options passed to runAgent should NOT contain disableStreaming
    expect(capturedOptions).not.toHaveProperty("disableStreaming")
  })
})

describe("Teams adapter - startTeamsApp no --disable-streaming flag", () => {
  it("startTeamsApp does not read --disable-streaming from argv", async () => {
    vi.resetModules()
    process.argv = ["node", "teams-entry.ts", "--disable-streaming"]

    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn()
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    // Startup log should NOT mention "streaming: disabled" even with --disable-streaming in argv
    const logCalls = consoleSpy.mock.calls.map((c: any) => c[0])
    expect(logCalls.some((msg: string) => msg.includes("streaming: disabled"))).toBe(false)

    consoleSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it("startup log does not mention streaming mode (no dual-mode)", async () => {
    vi.resetModules()
    process.argv = ["node", "teams-entry.ts"]

    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn()
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: vi.fn(),
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/teams-session.json"),
      getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "" }),
      getAdoConfig: vi.fn().mockReturnValue({ organizations: [] }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: false, port: 3978 }),
    }))

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    // No dual-mode streaming log (no "streaming: enabled" or "streaming: disabled")
    const logCalls = consoleSpy.mock.calls.map((c: any) => c[0])
    expect(logCalls.some((msg: string) => msg.includes("streaming: disabled"))).toBe(false)
    expect(logCalls.some((msg: string) => msg.includes("streaming: enabled"))).toBe(false)

    consoleSpy.mockRestore()
    vi.restoreAllMocks()
  })
})

describe("Teams adapter - confirmation callback", () => {
  beforeEach(() => {
    // no env vars to clear
  })

  function mockTeamsDepsForConfirmation(overrides: {
    runAgentFn?: any
    loadSessionReturn?: any
  } = {}) {
    const {
      runAgentFn = vi.fn().mockResolvedValue({ usage: undefined }),
      loadSessionReturn = null,
    } = overrides

    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: runAgentFn,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/teams-session.json"),
      getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "" }),
      getAdoConfig: vi.fn().mockReturnValue({ organizations: [] }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: false, port: 3978 }),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(loadSessionReturn),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),

      postTurn: vi.fn(),
    }))
    vi.doMock("../../senses/commands", () => ({
      createCommandRegistry: vi.fn().mockReturnValue({
        register: vi.fn(),
        get: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        dispatch: vi.fn().mockReturnValue({ handled: false }),
      }),
      registerDefaultCommands: vi.fn(),
      parseSlashCommand: vi.fn().mockReturnValue(null),
    }))
    const MockFileFriendStore = vi.fn(function (this: any) {
      this.get = vi.fn()
      this.put = vi.fn()
      this.delete = vi.fn()
      this.findByExternalId = vi.fn()
    })
    vi.doMock("../../mind/friends/store-file", () => ({
      FileFriendStore: MockFileFriendStore,
    }))
    const mockResolve = vi.fn().mockResolvedValue({
      friend: {
        id: "mock-uuid",
        name: "Test User",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams",
        availableIntegrations: ["graph", "ado"],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    })
    const MockFriendResolver = vi.fn(function (this: any) {
      this.resolve = mockResolve
    })
    vi.doMock("../../mind/friends/resolver", () => ({
      FriendResolver: MockFriendResolver,
    }))
  }

  it("onConfirmAction sends descriptive message via stream.update", async () => {
    vi.resetModules()

    const mockRunAgent = vi.fn().mockImplementation(async (_msgs: any, callbacks: any) => {
      if (callbacks.onConfirmAction) {
        // Start confirmation but don't await -- we'll resolve it after checking the update
        const confirmPromise = callbacks.onConfirmAction("graph_mutate", { method: "POST", path: "/me/sendMail" })
        // Resolve it immediately so the test can finish
        // Use resolvePendingConfirmation to resolve it
        const teams = await import("../../senses/teams")
        teams.resolvePendingConfirmation("conv-desc-1", "no")
        await confirmPromise
      }
      return { usage: undefined }
    })

    mockTeamsDepsForConfirmation({ runAgentFn: mockRunAgent })

    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    await teams.handleTeamsMessage("do something", mockStream as any, "conv-desc-1", {
      graphToken: "token",
      adoToken: undefined,
      signin: vi.fn(),
    })

    // The confirmation prompt should have been sent via stream.update
    const updateCalls = mockStream.update.mock.calls.map((c: any) => c[0] as string)
    const confirmMsg = updateCalls.find((msg: string) => msg.includes("graph_mutate") || msg.includes("Confirm"))
    expect(confirmMsg).toBeDefined()
  })

  it("'yes' response resolves confirmed", async () => {
    vi.resetModules()

    let confirmPromise: Promise<"confirmed" | "denied"> | null = null

    const mockRunAgent = vi.fn().mockImplementation(async (_msgs: any, callbacks: any) => {
      if (callbacks.onConfirmAction) {
        confirmPromise = callbacks.onConfirmAction("graph_mutate", { method: "POST", path: "/me/sendMail" })
      }
      return { usage: undefined }
    })

    mockTeamsDepsForConfirmation({ runAgentFn: mockRunAgent })

    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    // Start the first message (which triggers the confirmation)
    const firstMsg = teams.handleTeamsMessage("do something", mockStream as any, "conv-confirm-yes", {
      graphToken: "token",
      adoToken: undefined,
      signin: vi.fn(),
    })

    // Wait a tick for the first message to start running
    await new Promise(r => setTimeout(r, 50))

    // Resolve confirmation directly (as the app.on handler would)
    teams.resolvePendingConfirmation("conv-confirm-yes", "yes")

    await firstMsg

    expect(confirmPromise).not.toBeNull()
    const result = await confirmPromise!
    expect(result).toBe("confirmed")
  })

  it("'no' response resolves denied", async () => {
    vi.resetModules()

    let confirmPromise: Promise<"confirmed" | "denied"> | null = null

    const mockRunAgent = vi.fn().mockImplementation(async (_msgs: any, callbacks: any) => {
      if (callbacks.onConfirmAction) {
        confirmPromise = callbacks.onConfirmAction("graph_mutate", { method: "DELETE", path: "/me/messages/1" })
      }
      return { usage: undefined }
    })

    mockTeamsDepsForConfirmation({ runAgentFn: mockRunAgent })

    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    const firstMsg = teams.handleTeamsMessage("delete my email", mockStream as any, "conv-confirm-no", {
      graphToken: "token",
      adoToken: undefined,
      signin: vi.fn(),
    })

    await new Promise(r => setTimeout(r, 50))

    // Resolve confirmation directly (as the app.on handler would)
    teams.resolvePendingConfirmation("conv-confirm-no", "no")

    await firstMsg

    expect(confirmPromise).not.toBeNull()
    const result = await confirmPromise!
    expect(result).toBe("denied")
  })

  it("unrelated message resolves denied", async () => {
    vi.resetModules()

    let confirmPromise: Promise<"confirmed" | "denied"> | null = null

    const mockRunAgent = vi.fn().mockImplementation(async (_msgs: any, callbacks: any) => {
      if (callbacks.onConfirmAction) {
        confirmPromise = callbacks.onConfirmAction("ado_mutate", { method: "PATCH", organization: "myorg", path: "/_apis/wit/workitems/1" })
      }
      return { usage: undefined }
    })

    mockTeamsDepsForConfirmation({ runAgentFn: mockRunAgent })

    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    const firstMsg = teams.handleTeamsMessage("update work item", mockStream as any, "conv-confirm-other", {
      graphToken: undefined,
      adoToken: "token",
      signin: vi.fn(),
    })

    await new Promise(r => setTimeout(r, 50))

    // Resolve confirmation directly (as the app.on handler would)
    teams.resolvePendingConfirmation("conv-confirm-other", "something else entirely")

    await firstMsg

    expect(confirmPromise).not.toBeNull()
    const result = await confirmPromise!
    expect(result).toBe("denied")
  })

  it("confirmation auto-denies after timeout (120s)", async () => {
    vi.useFakeTimers()
    vi.resetModules()

    let confirmPromise: Promise<"confirmed" | "denied"> | null = null

    const mockRunAgent = vi.fn().mockImplementation(async (_msgs: any, callbacks: any) => {
      if (callbacks.onConfirmAction) {
        confirmPromise = callbacks.onConfirmAction("ado_mutate", { method: "POST", organization: "myorg", path: "/_apis/wit/workitems" })
      }
      return { usage: undefined }
    })

    mockTeamsDepsForConfirmation({ runAgentFn: mockRunAgent })

    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    const msgPromise = teams.handleTeamsMessage("create work item", mockStream as any, "conv-timeout", {
      graphToken: undefined,
      adoToken: "token",
      signin: vi.fn(),
    })

    // Let the handler start and set up the confirmation
    await vi.advanceTimersByTimeAsync(50)

    expect(confirmPromise).not.toBeNull()

    // Advance past the 120s timeout
    await vi.advanceTimersByTimeAsync(120_000)

    await msgPromise

    const result = await confirmPromise!
    expect(result).toBe("denied")

    vi.useRealTimers()
  })

  it("confirmation timeout is a no-op when already resolved", async () => {
    vi.useFakeTimers()
    vi.resetModules()

    let confirmPromise: Promise<"confirmed" | "denied"> | null = null

    const mockRunAgent = vi.fn().mockImplementation(async (_msgs: any, callbacks: any) => {
      if (callbacks.onConfirmAction) {
        confirmPromise = callbacks.onConfirmAction("ado_mutate", { method: "POST", organization: "myorg", path: "/_apis/wit/workitems" })
      }
      return { usage: undefined }
    })

    mockTeamsDepsForConfirmation({ runAgentFn: mockRunAgent })

    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    const msgPromise = teams.handleTeamsMessage("create item", mockStream as any, "conv-timeout-noop", {
      graphToken: undefined,
      adoToken: "token",
      signin: vi.fn(),
    })

    await vi.advanceTimersByTimeAsync(50)

    // Resolve BEFORE the timeout fires
    teams.resolvePendingConfirmation("conv-timeout-noop", "yes")

    await vi.advanceTimersByTimeAsync(0)
    await msgPromise

    const result = await confirmPromise!
    expect(result).toBe("confirmed")

    // Advance past the 120s timeout — should be a no-op (no double-resolve)
    await vi.advanceTimersByTimeAsync(120_000)
    // Still confirmed — not overwritten to denied
    expect(await confirmPromise!).toBe("confirmed")

    vi.useRealTimers()
  })

  it("pre-lock confirmation resolves before conversation lock (no deadlock)", async () => {
    vi.resetModules()
    // no env vars to clear

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))

    let confirmPromise: Promise<"confirmed" | "denied"> | null = null
    const mockRunAgent = vi.fn().mockImplementation(async (_msgs: any, callbacks: any) => {
      if (callbacks.onConfirmAction) {
        confirmPromise = callbacks.onConfirmAction("graph_mutate", { method: "POST", path: "/me/sendMail" })
        // The agent loop would await this promise, so we do too
        await confirmPromise
      }
      return { usage: undefined }
    })

    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: mockRunAgent,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/teams-session.json"),
      getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "" }),
      getAdoConfig: vi.fn().mockReturnValue({ organizations: [] }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: false, port: 3978 }),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),

      postTurn: vi.fn(),
    }))
    vi.doMock("../../senses/commands", () => ({
      createCommandRegistry: vi.fn().mockReturnValue({
        register: vi.fn(),
        get: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        dispatch: vi.fn().mockReturnValue({ handled: false }),
      }),
      registerDefaultCommands: vi.fn(),
      parseSlashCommand: vi.fn().mockReturnValue(null),
    }))

    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()
    expect(capturedHandler).not.toBeNull()

    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    const convId = "conv-prelock-confirm"

    // First message triggers the agent which triggers confirmation
    const firstMsg = capturedHandler!({
      stream: mockStream,
      activity: { text: "send email", conversation: { id: convId }, from: { id: "user1" }, channelId: "msteams" },
      api: { users: { token: { get: vi.fn().mockResolvedValue({ token: "graph-tok" }) } } },
      signin: vi.fn(),
    })

    // Wait for the confirmation to be set
    await new Promise(r => setTimeout(r, 50))

    // Second message "yes" resolves the confirmation via pre-lock path
    const secondMsg = capturedHandler!({
      stream: mockStream,
      activity: { text: "yes", conversation: { id: convId }, from: { id: "user1" }, channelId: "msteams" },
      api: { users: { token: { get: vi.fn().mockResolvedValue(null) } } },
      signin: vi.fn(),
    })

    await Promise.all([firstMsg, secondMsg])

    // The confirmation should have resolved as "confirmed"
    expect(confirmPromise).not.toBeNull()
    const result = await confirmPromise!
    expect(result).toBe("confirmed")

    vi.restoreAllMocks()
  })
})

describe("Teams adapter - handleTeamsMessage with sendMessage", () => {
  function mockTeamsDepsForSendMessage(overrides: {
    runAgentFn?: any
    loadSessionReturn?: any
  } = {}) {
    const {
      runAgentFn = vi.fn().mockResolvedValue({ usage: undefined }),
      loadSessionReturn = null,
    } = overrides

    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: runAgentFn,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/teams-session.json"),
      getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "" }),
      getAdoConfig: vi.fn().mockReturnValue({ organizations: [] }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: false, port: 3978 }),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(loadSessionReturn),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),

      postTurn: vi.fn(),
    }))
    vi.doMock("../../senses/commands", () => ({
      createCommandRegistry: vi.fn().mockReturnValue({
        register: vi.fn(),
        get: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        dispatch: vi.fn().mockReturnValue({ handled: false }),
      }),
      registerDefaultCommands: vi.fn(),
      parseSlashCommand: vi.fn().mockReturnValue(null),
    }))
    const MockFileFriendStore = vi.fn(function (this: any) {
      this.get = vi.fn()
      this.put = vi.fn()
      this.delete = vi.fn()
      this.findByExternalId = vi.fn()
    })
    vi.doMock("../../mind/friends/store-file", () => ({
      FileFriendStore: MockFileFriendStore,
    }))
    const mockResolve = vi.fn().mockResolvedValue({
      friend: {
        id: "mock-uuid",
        name: "Test User",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams",
        availableIntegrations: ["graph", "ado"],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    })
    const MockFriendResolver = vi.fn(function (this: any) {
      this.resolve = mockResolve
    })
    vi.doMock("../../mind/friends/resolver", () => ({
      FriendResolver: MockFriendResolver,
    }))
  }

  it("handleTeamsMessage accepts sendMessage parameter and passes it to createTeamsCallbacks", async () => {
    vi.resetModules()
    const mockRunAgent = vi.fn().mockImplementation(async (_msgs: any, callbacks: any) => {
      // Simulate buffered mode: tool run then text
      callbacks.onToolEnd("read_file", "package.json", true)
      callbacks.onTextChunk("Here is the file content.")
      return { usage: undefined }
    })
    mockTeamsDepsForSendMessage({ runAgentFn: mockRunAgent })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)

    await teams.handleTeamsMessage("show file", mockStream as any, "conv-send-1", undefined, true, sendMessage)

    // onToolEnd now uses safeUpdate (stream.update) not safeSend in buffered mode
    expect(mockStream.update).toHaveBeenCalledWith("\u2713 read_file (package.json)")
    expect(sendMessage).not.toHaveBeenCalledWith("\u2713 read_file (package.json)")
  })

  it("handleTeamsMessage awaits flush() (which is now async)", async () => {
    vi.resetModules()
    const mockRunAgent = vi.fn().mockImplementation(async (_msgs: any, callbacks: any) => {
      callbacks.onTextChunk("response text")
      return { usage: undefined }
    })
    mockTeamsDepsForSendMessage({ runAgentFn: mockRunAgent })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)

    // Should not throw even though flush() is now async
    await teams.handleTeamsMessage("test", mockStream as any, "conv-send-2", undefined, true, sendMessage)

    // Text should have been flushed to emit (first content)
    expect(mockStream.emit).toHaveBeenCalledWith("response text")
  })

  it("startTeamsApp passes sendMessage wrapping ctx.send to handleTeamsMessage", async () => {
    vi.resetModules()

    let capturedHandler: ((args: any) => Promise<void>) | null = null
    vi.doMock("@microsoft/teams.apps", () => ({
      App: class MockApp {
        constructor(_opts: any) {}
        on = vi.fn().mockImplementation((_event: string, handler: any) => {
          capturedHandler = handler
        })
        event = vi.fn()
        start = vi.fn()
      },
    }))
    vi.doMock("@microsoft/teams.dev", () => ({
      DevtoolsPlugin: class MockDevtoolsPlugin {},
    }))

    const mockRunAgent = vi.fn().mockImplementation(async (_msgs: any, callbacks: any) => {
      // Simulate onKick -- in buffered mode this should call sendMessage
      if (callbacks.onKick) callbacks.onKick()
      callbacks.onTextChunk("answer")
      return { usage: undefined }
    })
    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: mockRunAgent,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      summarizeArgs: vi.fn().mockReturnValue(""),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/teams-session.json"),
      getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "" }),
      getAdoConfig: vi.fn().mockReturnValue({ organizations: [] }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: false, port: 3978 }),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),

      postTurn: vi.fn(),
    }))

    vi.spyOn(console, "log").mockImplementation(() => {})

    const teams = await import("../../senses/teams")
    teams.startTeamsApp()

    expect(capturedHandler).not.toBeNull()
    const mockSend = vi.fn().mockResolvedValue(undefined)
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    await capturedHandler!({
      stream: mockStream,
      activity: { text: "hello", conversation: { id: "conv-ctx-send" }, from: { id: "user1" }, channelId: "msteams" },
      api: { users: { token: { get: vi.fn().mockResolvedValue(null) } } },
      signin: vi.fn(),
      send: mockSend,
    })

    // In buffered mode, onKick now uses safeUpdate (stream.update) not safeSend (ctx.send)
    expect(mockStream.update).toHaveBeenCalledWith("\u21BB kick")

    vi.restoreAllMocks()
  })
})

describe("Teams adapter - context kernel wiring (Unit 1Hc)", () => {
  function mockTeamsDepsForContext(overrides: {
    runAgentFn?: any
  } = {}) {
    const {
      runAgentFn = vi.fn().mockResolvedValue({ usage: undefined }),
    } = overrides

    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: runAgentFn,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/teams-session.json"),
      getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "" }),
      getTeamsChannelConfig: vi.fn().mockReturnValue({ skipConfirmation: false, port: 3978 }),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),
      postTurn: vi.fn(),
    }))
    vi.doMock("../../senses/commands", () => ({
      createCommandRegistry: vi.fn().mockReturnValue({
        register: vi.fn(),
        get: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        dispatch: vi.fn().mockReturnValue({ handled: false }),
      }),
      registerDefaultCommands: vi.fn(),
      parseSlashCommand: vi.fn().mockReturnValue(null),
    }))

    const mockResolve = vi.fn().mockResolvedValue({
      friend: {
        id: "mock-uuid",
        name: "Test User",
        externalIds: [{ provider: "aad", externalId: "aad-user-123", tenantId: "tenant-abc", linkedAt: "2026-01-01" }],
        tenantMemberships: ["tenant-abc"],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams",
        availableIntegrations: ["graph", "ado"],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    })

    const MockFileFriendStore = vi.fn(function (this: any) {
      this.get = vi.fn()
      this.put = vi.fn()
      this.delete = vi.fn()
      this.findByExternalId = vi.fn()
    })
    vi.doMock("../../mind/friends/store-file", () => ({
      FileFriendStore: MockFileFriendStore,
    }))
    const MockFriendResolver = vi.fn(function (this: any) {
      this.resolve = mockResolve
    })
    vi.doMock("../../mind/friends/resolver", () => ({
      FriendResolver: MockFriendResolver,
    }))

    return { runAgentFn, mockResolve }
  }

  it("creates FriendResolver with AAD external ID from TeamsMessageContext and attaches to ToolContext", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    const { mockResolve } = mockTeamsDepsForContext({ runAgentFn })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    const teamsContext = {
      graphToken: "g-token",
      adoToken: "a-token",
      signin: vi.fn(),
      aadObjectId: "aad-user-123",
      tenantId: "tenant-abc",
      displayName: "Test User",
    }

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-123", teamsContext)
    expect(runAgentFn).toHaveBeenCalled()

    // Check that runAgent was called with toolContext.context (resolved context)
    const callArgs = runAgentFn.mock.calls[0]
    const options = callArgs[4]
    expect(options).toBeDefined()
    expect(options.toolContext).toBeDefined()
    expect(options.toolContext.context).toBeDefined()
    expect(options.toolContext.context.friend.name).toBe("Test User")
    expect(options.toolContext.context.channel.channel).toBe("teams")
    expect(options.toolContext.context.channel.availableIntegrations).toContain("graph")
  })

  it("FriendResolver is created with aad provider, externalId, tenantId, and displayName", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDepsForContext({ runAgentFn })
    const FriendResolver = (await import("../../mind/friends/resolver")).FriendResolver
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    const teamsContext = {
      graphToken: "g-token",
      adoToken: "a-token",
      signin: vi.fn(),
      aadObjectId: "aad-user-456",
      tenantId: "tenant-xyz",
      displayName: "Jane Doe",
    }

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-456", teamsContext)

    // FriendResolver constructor should have been called with params including aad provider
    expect(FriendResolver).toHaveBeenCalledWith(
      expect.anything(), // store
      expect.objectContaining({
        provider: "aad",
        externalId: "aad-user-456",
        tenantId: "tenant-xyz",
        displayName: "Jane Doe",
        channel: "teams",
      }),
    )
  })

  it("uses 'Unknown' displayName when teamsContext.displayName is falsy", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDepsForContext({ runAgentFn })
    const FriendResolver = (await import("../../mind/friends/resolver")).FriendResolver
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    const teamsContext = {
      graphToken: "g-token",
      adoToken: "a-token",
      signin: vi.fn(),
      aadObjectId: "aad-user-789",
      tenantId: "tenant-xyz",
      displayName: "",  // falsy -- should fall back to "Unknown"
    }

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-999", teamsContext)

    expect(FriendResolver).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        displayName: "Unknown",
      }),
    )
  })

  it("handles TeamsMessageContext without AAD fields (uses teams-conversation fallback)", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDepsForContext({ runAgentFn })
    const FriendResolver = (await import("../../mind/friends/resolver")).FriendResolver
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    // No aadObjectId -- uses teams-conversation fallback with conversationId
    const teamsContext = {
      graphToken: "g-token",
      adoToken: "a-token",
      signin: vi.fn(),
    }

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-789", teamsContext)
    expect(runAgentFn).toHaveBeenCalled()

    // FriendResolver should be created with teams-conversation provider and conversationId as externalId
    expect(FriendResolver).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "teams-conversation",
        externalId: "conv-789",
        displayName: "Unknown",
        channel: "teams",
      }),
    )

    // toolContext should exist with resolved context
    const callArgs = runAgentFn.mock.calls[0]
    const options = callArgs[4]
    expect(options.toolContext).toBeDefined()
    expect(options.toolContext.context).toBeDefined()
  })

  it("FileFriendStore is created once and shared across multiple handleTeamsMessage calls", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDepsForContext({ runAgentFn })
    const FileFriendStore = (await import("../../mind/friends/store-file")).FileFriendStore
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    const teamsContext = {
      graphToken: "g-token",
      adoToken: "a-token",
      signin: vi.fn(),
      aadObjectId: "aad-user-123",
      tenantId: "tenant-abc",
      displayName: "Test User",
    }

    await teams.handleTeamsMessage("msg1", mockStream as any, "conv-1", teamsContext)
    await teams.handleTeamsMessage("msg2", mockStream as any, "conv-2", teamsContext)

    // FileFriendStore is created per request (not a singleton) so mkdirSync
    // re-runs if directories are deleted while the process is alive.
    expect(FileFriendStore).toHaveBeenCalledTimes(2)
  })

  it("buildSystem is called with resolved context as third argument", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDepsForContext({ runAgentFn })
    const { buildSystem } = await import("../../mind/prompt")
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    const teamsContext = {
      graphToken: "g-token",
      adoToken: "a-token",
      signin: vi.fn(),
      aadObjectId: "aad-user-123",
      tenantId: "tenant-abc",
      displayName: "Test User",
    }

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-123", teamsContext)

    // buildSystem should be called with channel, options, and resolved context
    expect(buildSystem).toHaveBeenCalledWith(
      "teams",
      undefined,
      expect.objectContaining({
        friend: expect.objectContaining({ name: "Test User" }),
        channel: expect.objectContaining({ channel: "teams" }),
      }),
    )
  })

  it("toolContext.friendStore is set from the shared store", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDepsForContext({ runAgentFn })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    const teamsContext = {
      graphToken: "g-token",
      adoToken: "a-token",
      signin: vi.fn(),
      aadObjectId: "aad-user-123",
      tenantId: "tenant-abc",
      displayName: "Test User",
    }

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-123", teamsContext)

    const callArgs = runAgentFn.mock.calls[0]
    const options = callArgs[4]
    expect(options.toolContext.friendStore).toBeDefined()
  })

  it("session path uses friend UUID instead of default", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDepsForContext({ runAgentFn })
    const { sessionPath } = await import("../../heart/config")
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    const teamsContext = {
      graphToken: "g-token",
      adoToken: "a-token",
      signin: vi.fn(),
      aadObjectId: "aad-user-123",
      tenantId: "tenant-abc",
      displayName: "Test User",
    }

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-123", teamsContext)

    // sessionPath should be called with the friend UUID ("mock-uuid"), not "default"
    expect(sessionPath).toHaveBeenCalledWith("mock-uuid", "teams", "conv-123")
  })
})

describe("Teams adapter - TeamsCallbacksWithFlush type", () => {
  it("flush() returns a promise (async)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    const controller = new AbortController()
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("text")
    // First flush goes to emit, second would go to sendMessage
    const result = callbacks.flush()
    // flush() should return a promise (or void-compatible)
    expect(result === undefined || result instanceof Promise).toBe(true)
    if (result instanceof Promise) await result
  })
})

describe("Teams adapter - periodic flush timer", () => {
  let mockStream: { emit: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  let controller: AbortController
  let sendMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockStream = {
      emit: vi.fn(),
      update: vi.fn(),
      close: vi.fn(),
    }
    controller = new AbortController()
    sendMessage = vi.fn().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("periodic flush fires after flush interval -- first flush goes to safeEmit", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("hello ")
    // Text should be buffered, not emitted yet
    expect(mockStream.emit).not.toHaveBeenCalled()
    // Advance past the flush interval (DEFAULT_FLUSH_INTERVAL_MS = 1000)
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS)
    // After the timer fires, accumulated text should be flushed via safeEmit (first flush)
    expect(mockStream.emit).toHaveBeenCalledWith("hello ")
  })

  it("multiple flushes across intervals -- all go to safeEmit (cumulative stream)", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    // First interval: accumulate and flush
    callbacks.onTextChunk("chunk1 ")
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS)
    expect(mockStream.emit).toHaveBeenCalledWith("chunk1 ")
    // Second interval: more text accumulates, also goes to safeEmit (SDK accumulates cumulatively)
    callbacks.onTextChunk("chunk2 ")
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS)
    expect(mockStream.emit).toHaveBeenCalledWith("chunk2 ")
    expect(mockStream.emit).toHaveBeenCalledTimes(2)
    // No separate messages -- all via the stream
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("no flush when buffer is empty -- timer tick is a no-op", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("start")
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS)
    // First flush happened
    expect(mockStream.emit).toHaveBeenCalledTimes(1)
    // No more text added -- next tick should be a no-op
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS)
    expect(mockStream.emit).toHaveBeenCalledTimes(1) // still 1
    expect(sendMessage).not.toHaveBeenCalled() // no safeSend either
  })

  it("timer starts on first onTextChunk -- not before", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    // Before any text chunk, advancing time should not cause any flush
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS * 3)
    expect(mockStream.emit).not.toHaveBeenCalled()
    // Now send a text chunk -- timer should start
    callbacks.onTextChunk("delayed start")
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS)
    expect(mockStream.emit).toHaveBeenCalledWith("delayed start")
  })

  it("timer cleared on controller abort -- no leaked intervals", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("before abort")
    // Abort the controller
    controller.abort()
    // Advance past several intervals -- nothing should flush
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS * 5)
    // The text before abort should NOT have been flushed by the timer
    // (abort clears the timer before it fires)
    expect(mockStream.emit).not.toHaveBeenCalled()
  })

  it("timer cleared on flush() -- end of turn stops periodic timer", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("turn text")
    // Call flush() (end of turn) before timer fires
    await callbacks.flush()
    expect(mockStream.emit).toHaveBeenCalledWith("turn text")
    // Advance time -- periodic timer was stopped by flush(), no spurious flushes
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS * 3)
    expect(mockStream.emit).toHaveBeenCalledTimes(1) // only the flush() call
  })

  it("timer cleared on markStopped (dead stream) -- no more flushes", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("before death")
    // Trigger markStopped by making stream.emit throw
    mockStream.emit.mockImplementationOnce(() => { throw new Error("403 stream dead") })
    // flushTextBuffer calls safeEmit which will throw, triggering markStopped
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS)
    // Stream is now stopped -- add more text and advance
    callbacks.onTextChunk("after death")
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS * 3)
    // No more flushes should happen (safeSend checks stopped flag)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("first flush happens well within 15s -- at flush interval after first token", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    // Verify the default interval is reasonable (well under 15s)
    expect(teams.DEFAULT_FLUSH_INTERVAL_MS).toBeLessThanOrEqual(2000)
    expect(teams.DEFAULT_FLUSH_INTERVAL_MS).toBeGreaterThan(0)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("first token ")
    // Advance exactly to the flush interval
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS)
    // First content should arrive at flush interval (e.g. 1000ms) -- well within 15s
    expect(mockStream.emit).toHaveBeenCalledTimes(1)
  })

  it("reasoning phase starts flush timer and pushes reasoning via update", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    // Reasoning chunks start the flush timer
    callbacks.onReasoningChunk("thinking about it...")
    callbacks.onReasoningChunk("more reasoning...")
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS)
    // Reasoning flushed via update, not emit or sendMessage
    expect(mockStream.update).toHaveBeenCalledWith("thinking about it...more reasoning...")
    expect(mockStream.emit).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    // Now text starts -- next tick flushes text via emit
    callbacks.onTextChunk("answer: ")
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS)
    expect(mockStream.emit).toHaveBeenCalledWith("answer: ")
  })

  it("flush() at end of turn flushes remaining buffer via correct channel", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    // First interval flush
    callbacks.onTextChunk("first ")
    vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS)
    expect(mockStream.emit).toHaveBeenCalledWith("first ")
    // More text arrives after first flush
    callbacks.onTextChunk("remaining ")
    // End of turn -- flush() sends remaining via safeEmit (cumulative stream)
    await callbacks.flush()
    expect(mockStream.emit).toHaveBeenCalledWith("remaining ")
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("flushIntervalMs option overrides default", async () => {
    vi.resetModules()
    const teams = await import("../../senses/teams")
    const customInterval = 500
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage, { flushIntervalMs: customInterval })
    callbacks.onTextChunk("custom interval")
    // Default interval should NOT have flushed yet
    vi.advanceTimersByTime(customInterval - 1)
    expect(mockStream.emit).not.toHaveBeenCalled()
    // Custom interval should flush
    vi.advanceTimersByTime(1)
    expect(mockStream.emit).toHaveBeenCalledWith("custom interval")
  })
})

describe("Teams adapter - GitHub token handling", () => {
  function mockTeamsDepsGH(overrides: {
    runAgentFn?: any
    teamsChannelConfig?: any
  } = {}) {
    const {
      runAgentFn = vi.fn().mockResolvedValue({ usage: undefined }),
      teamsChannelConfig = { skipConfirmation: false, port: 3978 },
    } = overrides

    vi.doMock("../../heart/core", () => ({
      createSummarize: vi.fn(() => vi.fn()),
      runAgent: runAgentFn,
      buildSystem: vi.fn().mockReturnValue("system prompt"),
      repairOrphanedToolCalls: vi.fn(),
    }))
    vi.doMock("../../heart/config", () => ({
      sessionPath: vi.fn().mockReturnValue("/tmp/teams-session.json"),
      getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
      getTeamsConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "" }),
      getTeamsSecondaryConfig: vi.fn().mockReturnValue({ clientId: "", clientSecret: "", tenantId: "", managedIdentityClientId: "" }),
      getOAuthConfig: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "github" }),
      resolveOAuthForTenant: vi.fn().mockReturnValue({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "github" }),
      getTeamsChannelConfig: vi.fn().mockReturnValue(teamsChannelConfig),
    }))
    vi.doMock("../../mind/prompt", () => ({
      buildSystem: vi.fn().mockResolvedValue("system prompt"),
      contextSection: vi.fn().mockReturnValue(""),
    }))
    vi.doMock("../../mind/context", () => ({
      loadSession: vi.fn().mockReturnValue(null),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),
      postTurn: vi.fn(),
    }))
    vi.doMock("../../senses/commands", () => ({
      createCommandRegistry: vi.fn().mockReturnValue({
        register: vi.fn(),
        get: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        dispatch: vi.fn().mockReturnValue({ handled: false }),
      }),
      registerDefaultCommands: vi.fn(),
      parseSlashCommand: vi.fn().mockReturnValue(null),
    }))
    const MockFileFriendStore = vi.fn(function (this: any) {
      this.get = vi.fn()
      this.put = vi.fn()
      this.delete = vi.fn()
      this.findByExternalId = vi.fn()
    })
    vi.doMock("../../mind/friends/store-file", () => ({
      FileFriendStore: MockFileFriendStore,
    }))
    vi.doMock("../../mind/friends/resolver", () => ({
      FriendResolver: vi.fn(function (this: any) {
        this.resolve = vi.fn().mockResolvedValue({
          friend: { id: "mock-uuid", name: "Test", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01", schemaVersion: 1 },
          channel: { channel: "teams", availableIntegrations: ["graph", "ado", "github"], supportsMarkdown: true, supportsStreaming: true, supportsRichCards: true, maxMessageLength: 28000 },
        })
      }),
    }))
    vi.doMock("../../mind/friends/tokens", () => ({
      accumulateFriendTokens: vi.fn(),
    }))
    vi.doMock("../../nerves", async () => {
      const actual = await vi.importActual<typeof import("../../nerves")>("../../nerves")
      return { ...actual, createTraceId: vi.fn().mockReturnValue("trace-gh") }
    })
    vi.doMock("../../heart/turn-coordinator", () => ({
      createTurnCoordinator: vi.fn().mockReturnValue({
        withTurnLock: vi.fn().mockImplementation((_key: string, fn: () => Promise<void>) => fn()),
        tryBeginTurn: vi.fn().mockReturnValue(true),
        endTurn: vi.fn(),
        drainFollowUps: vi.fn().mockReturnValue([]),
        enqueueFollowUp: vi.fn(),
      }),
    }))
  }

  it("handleTeamsMessage passes githubToken in ToolContext", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockResolvedValue({ usage: undefined })
    mockTeamsDepsGH({ runAgentFn })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }

    const teamsContext = {
      graphToken: "g-token",
      adoToken: "a-token",
      githubToken: "gh-token-123",
      signin: vi.fn(),
    }

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-gh", teamsContext)
    expect(runAgentFn).toHaveBeenCalled()

    const options = runAgentFn.mock.calls[0][4]
    expect(options.toolContext.githubToken).toBe("gh-token-123")
  })

  it("triggers signin for AUTH_REQUIRED:github after agent loop", async () => {
    vi.resetModules()
    const runAgentFn = vi.fn().mockImplementation(async (msgs: any[]) => {
      msgs.push({ role: "assistant", content: "AUTH_REQUIRED:github" })
      return { usage: undefined }
    })
    mockTeamsDepsGH({ runAgentFn })
    const teams = await import("../../senses/teams")
    const mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    const signinFn = vi.fn()

    await teams.handleTeamsMessage("hello", mockStream as any, "conv-auth-gh", {
      graphToken: undefined,
      adoToken: undefined,
      githubToken: undefined,
      signin: signinFn,
      graphConnectionName: "graph",
      adoConnectionName: "ado",
      githubConnectionName: "github",
    })

    expect(signinFn).toHaveBeenCalledWith("github")
  })

  it("TeamsMessageContext includes githubToken field", () => {
    // Type-level test: verify the interface accepts githubToken
    const ctx: import("../../senses/teams").TeamsMessageContext = {
      graphToken: "g",
      adoToken: "a",
      githubToken: "gh",
      signin: async () => undefined,
    }
    expect(ctx.githubToken).toBe("gh")
  })
})
