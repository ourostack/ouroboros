import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/tmp/AgentBundles/testagent.ouro"),
  resetAgentConfigCache: vi.fn(),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "minimax",
    phrases: {
      thinking: ["thinking..."],
      tool: ["working..."],
      followup: ["one moment..."],
    },
  })),
}))

vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

describe("Teams tool callbacks via createToolActivityCallbacks", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  async function loadModule() {
    const { createToolActivityCallbacks } = await import("../../heart/tool-activity-callbacks")
    return createToolActivityCallbacks
  }

  describe("default mode", () => {
    it("safeUpdate called with human-readable text on tool START", async () => {
      const createToolActivityCallbacks = await loadModule()
      const safeUpdate = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription: safeUpdate,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: () => false,
      })

      onToolStart("shell", { command: "npm test" })
      expect(safeUpdate).toHaveBeenCalledWith("running npm test...")
    })

    it("no safeUpdate on tool END in default mode", async () => {
      const createToolActivityCallbacks = await loadModule()
      const safeUpdate = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult: safeUpdate,
        onFailure: vi.fn(),
        isDebug: () => false,
      })

      onToolEnd("read_file", "200 lines", true)
      expect(safeUpdate).not.toHaveBeenCalled()
    })

    it("no 'shared work: processing' text anywhere", async () => {
      const createToolActivityCallbacks = await loadModule()
      const allCalls: string[] = []
      const capture = vi.fn((text: string) => allCalls.push(text))

      const { onToolStart, onToolEnd } = createToolActivityCallbacks({
        onDescription: capture,
        onResult: capture,
        onFailure: capture,
        isDebug: () => false,
      })

      onToolStart("read_file", { path: "/a/b.ts" })
      onToolEnd("read_file", "done", true)
      onToolStart("shell", { command: "npm test" })
      onToolEnd("shell", "exit 0", true)

      for (const text of allCalls) {
        expect(text).not.toContain("shared work")
      }
    })
  })

  describe("debug mode", () => {
    it("safeUpdate includes result on tool END", async () => {
      const createToolActivityCallbacks = await loadModule()
      const safeUpdate = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult: safeUpdate,
        onFailure: vi.fn(),
        isDebug: () => true,
      })

      onToolEnd("read_file", "200 lines", true)
      expect(safeUpdate).toHaveBeenCalledWith("✓ read_file")
    })

    it("onFailure called with x mark prefix on failure", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onFailure = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult: vi.fn(),
        onFailure,
        isDebug: () => true,
      })

      onToolEnd("shell", "exit code 1", false)
      expect(onFailure).toHaveBeenCalledWith("✗ shell — exit code 1")
    })
  })
})

describe("Teams createTeamsCallbacks - flushNow (speak tool)", () => {
  let mockStream: { emit: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  let controller: AbortController

  beforeEach(() => {
    vi.resetModules()
    mockStream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() }
    controller = new AbortController()
  })

  it("exposes flushNow on the callbacks object", async () => {
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    expect(typeof (callbacks as any).flushNow).toBe("function")
  })

  it("flushNow after onTextChunk emits buffered text via stream.emit exactly once", async () => {
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onTextChunk("hello world this is enough chars")
    await (callbacks as any).flushNow()
    expect(mockStream.emit).toHaveBeenCalledTimes(1)
    expect(mockStream.emit.mock.calls[0][0]).toEqual(expect.objectContaining({
      text: "hello world this is enough chars",
    }))
  })

  it("falls back to sendMessage when stream.emit throws", async () => {
    const teams = await import("../../senses/teams")
    mockStream.emit = vi.fn(() => { throw new Error("stream dead") })
    const sendMessage = vi.fn(async () => {})
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("hello fallback")
    await (callbacks as any).flushNow()
    expect(sendMessage).toHaveBeenCalledWith("hello fallback")
  })

  it("clears the internal textBuffer after flushNow (subsequent flush does not re-send)", async () => {
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onTextChunk("once")
    await (callbacks as any).flushNow()
    expect(mockStream.emit).toHaveBeenCalledTimes(1)
    // End-of-turn flush() should not resend the text — buffer is empty so it falls
    // through to the empty-stream fallback ("(completed with tool calls only ...)") path.
    mockStream.emit.mockClear()
    await callbacks.flush()
    // Either no call (if already had content emitted) or the fallback message — never the original text
    const emittedTexts = mockStream.emit.mock.calls.map((c: any) => c[0]?.text ?? "")
    expect(emittedTexts).not.toContain("once")
  })

  it("cancels any pending periodic flush timer after flushNow", async () => {
    vi.useFakeTimers()
    try {
      const teams = await import("../../senses/teams")
      const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
      callbacks.onTextChunk("hello world this is enough chars to emit")
      // Pending timer is now set. flushNow should clear it so the next timer tick
      // doesn't re-emit anything (because the buffer is also drained).
      await (callbacks as any).flushNow()
      expect(mockStream.emit).toHaveBeenCalledTimes(1)
      mockStream.emit.mockClear()
      vi.advanceTimersByTime(teams.DEFAULT_FLUSH_INTERVAL_MS * 3)
      expect(mockStream.emit).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("flushNow with empty buffer is a safe noop — no emit, no error", async () => {
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    await expect((callbacks as any).flushNow()).resolves.not.toThrow()
    expect(mockStream.emit).not.toHaveBeenCalled()
  })

  it("onToolStart('speak', ...) is INVISIBLE — does NOT stop phrase rotation, does NOT emit ⏳ placeholder, does NOT emit tool-activity status", async () => {
    vi.useFakeTimers()
    try {
      const teams = await import("../../senses/teams")
      const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
      // Trigger phrase rotation by calling onModelStart (it sets up phraseTimer + initial update).
      callbacks.onModelStart()
      // baseline updates from onModelStart (phrase placeholder)
      const baselineUpdateCount = mockStream.update.mock.calls.length
      const baselineEmitCount = mockStream.emit.mock.calls.length

      callbacks.onToolStart("speak", { message: "hi" })

      // No NEW update or emit triggered by onToolStart for speak — phrase rotation
      // continues, no ⏳ placeholder, no tool-activity status text written.
      expect(mockStream.update.mock.calls.length).toBe(baselineUpdateCount)
      expect(mockStream.emit.mock.calls.length).toBe(baselineEmitCount)

      // Advance timers a tick to confirm phrase rotation is still active (it would
      // have been killed if onToolStart had called stopPhraseRotation).
      vi.advanceTimersByTime(1500)
      expect(mockStream.update.mock.calls.length).toBeGreaterThan(baselineUpdateCount)
    } finally {
      vi.useRealTimers()
    }
  })

  it("onToolEnd('speak', ...) is INVISIBLE — does NOT post tool-activity status", async () => {
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    const baselineUpdateCount = mockStream.update.mock.calls.length
    callbacks.onToolEnd("speak", "message=hi", true)
    // No new update for the speak tool end.
    expect(mockStream.update.mock.calls.length).toBe(baselineUpdateCount)
  })

  it("flushNow THROWS when stream.emit fails AND sendMessage also fails (hard delivery failure)", async () => {
    const teams = await import("../../senses/teams")
    mockStream.emit = vi.fn(() => { throw new Error("stream dead") })
    const sendMessage = vi.fn(async () => { throw new Error("sendMessage dead") })
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("hello will fail")
    await expect((callbacks as any).flushNow()).rejects.toThrow(/teams.*delivery failed|sendMessage|stream/i)
  })

  it("flushNow THROWS when stream.emit fails AND no sendMessage fallback is wired", async () => {
    const teams = await import("../../senses/teams")
    mockStream.emit = vi.fn(() => { throw new Error("stream dead") })
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onTextChunk("hello no fallback")
    await expect((callbacks as any).flushNow()).rejects.toThrow(/teams.*delivery failed|stream/i)
  })

  it("flushNow throws 'no fallback available' when stopped flag is set out-of-band before flushNow runs", async () => {
    // Goal: hit branch line 422 (!stopped===false branch) AND line 444 (lastError??"no fallback available" right side).
    // Setup: queue text in buffer (while stopped=false), then trigger markStopped() via a
    // SEPARATE path (safeUpdate's catch block fires markStopped when stream.update throws),
    // then call flushNow with no sendMessage fallback wired.
    const teams = await import("../../senses/teams")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onTextChunk("payload to deliver")
    // Reassign stream.update to throw — this triggers markStopped() inside safeUpdate's catch.
    mockStream.update = vi.fn(() => { throw new Error("forced update fail") })
    callbacks.onError(new Error("synthetic"), "transient") // -> safeUpdate -> throws -> markStopped()
    // Now stopped=true, buffer still has "payload to deliver", no sendMessage wired.
    await expect((callbacks as any).flushNow()).rejects.toThrow(/no fallback available/i)
  })

  it("REGRESSION (Blocker C): stream emit failure + sendMessage success does NOT abort the controller", async () => {
    // Bug: flushNow → tryEmit → markStopped() → controller.abort() before falling
    // back to sendMessage. If sendMessage succeeded, flushNow returned normally and
    // core marked speak as delivered, but the turn was already aborted, killing the
    // next model/tool step. Successful fallback delivery must NOT poison the turn.
    const teams = await import("../../senses/teams")
    const { emitNervesEvent } = await import("../../nerves/runtime")
    ;(emitNervesEvent as any).mockClear?.()
    mockStream.emit = vi.fn(() => { throw new Error("stream dead") })
    const sendMessage = vi.fn(async () => {})
    const abortSpy = vi.spyOn(controller, "abort")
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("hi friend")

    await expect((callbacks as any).flushNow()).resolves.toBeUndefined()

    // sendMessage was called with the buffered text — fallback delivery happened.
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith("hi friend")
    // controller.abort MUST NOT have been called — the turn must continue.
    expect(abortSpy).not.toHaveBeenCalled()
    expect(controller.signal.aborted).toBe(false)
    // Nerves event reflects delivered=true.
    const speakFlushCalls = (emitNervesEvent as any).mock.calls.filter(
      (c: any[]) => c[0]?.event === "teams.speak_flush",
    )
    expect(speakFlushCalls.length).toBe(1)
    expect(speakFlushCalls[0][0].meta.delivered).toBe(true)
  })

  it("tryEmitNoAbort awaits stream.emit when it returns a Promise (Teams SDK async path)", async () => {
    // The Teams SDK's stream.emit() is typed as void but actually returns a Promise
    // for the async HTTP under the hood. tryEmitNoAbort must await that Promise so
    // an async failure (e.g. rejected 413) propagates back to flushNow as
    // ok=false rather than swallowing it. Hits the `result.then` branch (line 294
    // in src/senses/teams.ts).
    const teams = await import("../../senses/teams")
    let resolveEmit!: () => void
    const emitPromise = new Promise<void>((resolve) => { resolveEmit = resolve })
    mockStream.emit = vi.fn(() => emitPromise as unknown as void)
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller)
    callbacks.onTextChunk("async path")
    const flushPromise = (callbacks as any).flushNow()
    // Resolve the Teams SDK's async emit; flushNow's await must complete before resolving.
    resolveEmit()
    await expect(flushPromise).resolves.toBeUndefined()
    expect(mockStream.emit).toHaveBeenCalledTimes(1)
  })

  it("flushNow wraps non-Error throws from sendMessage in Error (lastError coercion)", async () => {
    // Stream emit fails, and sendMessage throws a NON-Error value (string).
    // The catch on line 432 must coerce it via `err instanceof Error ? err : new Error(String(err))`.
    const teams = await import("../../senses/teams")
    mockStream.emit = vi.fn(() => { throw new Error("stream dead") })
    const sendMessage = vi.fn(async () => { throw "string-not-error-thrown-from-sendMessage" })
    const callbacks = teams.createTeamsCallbacks(mockStream as any, controller, sendMessage)
    callbacks.onTextChunk("payload")
    await expect((callbacks as any).flushNow()).rejects.toThrow(/string-not-error-thrown-from-sendMessage/)
  })
})
