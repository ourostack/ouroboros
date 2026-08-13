import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/tmp/AgentBundles/testagent.ouro"),
}))

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("BlueBubbles createBlueBubblesCallbacks", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  async function setup() {
    const indexModule = await import("../../../senses/bluebubbles")
    const { createBlueBubblesCallbacks } = indexModule
    const sendText = vi.fn(async () => ({ messageGuid: "sent-guid" }))
    const setTyping = vi.fn(async () => {})
    const markChatRead = vi.fn(async () => {})
    const editMessage = vi.fn(async () => {})
    const checkHealth = vi.fn(async () => {})
    const repairEvent = vi.fn(async (e: any) => e)
    const getMessageText = vi.fn(async () => null)
    const client = {
      sendText,
      editMessage,
      setTyping,
      markChatRead,
      checkHealth,
      repairEvent,
      getMessageText,
    }
    const chat = { chatGuid: "chat-1", participants: [] } as any
    const replyTarget = {
      getReplyToMessageGuid: vi.fn(() => "reply-guid-xyz"),
      setSelection: vi.fn(() => "ok"),
    }
    const callbacks = createBlueBubblesCallbacks(client as any, chat, replyTarget as any, false)
    return { callbacks, sendText, setTyping, markChatRead, replyTarget }
  }

  it("exposes flushNow on the callbacks object", async () => {
    const { callbacks } = await setup()
    expect(typeof (callbacks as any).flushNow).toBe("function")
  })

  it("declares settle output as retractable before transport flush", async () => {
    const { callbacks } = await setup()
    expect((callbacks as any).settleOutputMode).toBe("retractable_buffer")
  })

  it("flushNow after onTextChunk sends accumulated buffer via client.sendText with replyToMessageGuid", async () => {
    const { callbacks, sendText } = await setup()
    callbacks.onTextChunk("hello")
    await (callbacks as any).flushNow()
    expect(sendText).toHaveBeenCalledTimes(1)
    expect(sendText).toHaveBeenCalledWith({
      chat: expect.objectContaining({ chatGuid: "chat-1" }),
      text: "hello",
      replyToMessageGuid: "reply-guid-xyz",
    })
  })

  it("flushNow returns a Promise that resolves after sendText completes", async () => {
    const { callbacks, sendText } = await setup()
    callbacks.onTextChunk("hi there")
    const p = (callbacks as any).flushNow()
    expect(p).toBeInstanceOf(Promise)
    await p
    expect(sendText).toHaveBeenCalled()
  })

  it("after flushNow, the next end-of-turn flush() does NOT re-send the same text", async () => {
    const { callbacks, sendText } = await setup()
    callbacks.onTextChunk("once only")
    await (callbacks as any).flushNow()
    expect(sendText).toHaveBeenCalledTimes(1)
    // After flushNow drained the buffer, end-of-turn flush() should not resend
    await (callbacks as any).flush()
    expect(sendText).toHaveBeenCalledTimes(1)
  })

  it("keeps an arbitrarily long silent live turn transport-quiet while typing remains active", async () => {
    vi.useFakeTimers()
    try {
      const { callbacks, sendText, setTyping } = await setup()
      callbacks.onModelStart()
      callbacks.onModelStart()
      await vi.advanceTimersByTimeAsync(10 * 60_000)

      expect(sendText).not.toHaveBeenCalled()
      expect(setTyping).toHaveBeenCalledWith(expect.anything(), true, expect.any(AbortSignal))
      await (callbacks as any).finish()
      expect(setTyping).toHaveBeenCalledWith(expect.anything(), false, expect.any(AbortSignal))
    } finally {
      vi.useRealTimers()
    }
  })

  it("after flushNow, client.setTyping(chat, false) is NOT called — typing stays active", async () => {
    const { callbacks, setTyping } = await setup()
    // Trigger typing start by calling onModelStart (1:1 path)
    callbacks.onModelStart()
    callbacks.onTextChunk("status")
    await (callbacks as any).flushNow()
    // Verify setTyping was never called with `false` during flushNow
    const stopCalls = setTyping.mock.calls.filter(([_, on]) => on === false)
    expect(stopCalls).toHaveLength(0)
  })

  it("surfaces a raw string failure from queued read/typing activity", async () => {
    const indexModule = await import("../../../senses/bluebubbles")
    const nerves = await import("../../../nerves/runtime")
    const emitNervesEvent = vi.mocked(nerves.emitNervesEvent)
    emitNervesEvent.mockClear()
    const chat = { chatGuid: "chat-1", participants: [] } as any
    const callbacks = indexModule.createBlueBubblesCallbacks(
      {
        sendText: vi.fn(async () => ({ messageGuid: "sent-guid" })),
        editMessage: vi.fn(),
        setTyping: vi.fn(async () => {
          throw "raw typing transport failure"
        }),
        markChatRead: vi.fn(async () => {}),
        checkHealth: vi.fn(),
        repairEvent: vi.fn(),
        getMessageText: vi.fn(),
      } as any,
      chat,
      { getReplyToMessageGuid: vi.fn(), setSelection: vi.fn() } as any,
      false,
    )

    callbacks.onModelStart()
    await callbacks.finish()

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_activity_error",
      meta: expect.objectContaining({
        operation: "typing_start",
        reason: "raw typing transport failure",
      }),
    }))
  })

  it("rechecks cancellation after queued admission before starting read or typing transports", async () => {
    const indexModule = await import("../../../senses/bluebubbles")
    const admission = createDeferred<boolean>()
    const markChatRead = vi.fn(async () => {})
    const setTyping = vi.fn(async () => {})
    const callbacks = indexModule.createBlueBubblesCallbacks(
      {
        sendText: vi.fn(async () => ({ messageGuid: "sent-guid" })),
        editMessage: vi.fn(),
        setTyping,
        markChatRead,
        checkHealth: vi.fn(),
        repairEvent: vi.fn(),
        getMessageText: vi.fn(),
      } as any,
      { chatGuid: "chat-1", participants: [] } as any,
      { getReplyToMessageGuid: vi.fn(), setSelection: vi.fn() } as any,
      false,
      undefined,
      {
        admitOutbound: () => admission.promise,
        isOutboundCurrent: () => true,
      },
    )

    callbacks.onModelStart()
    await Promise.resolve()
    callbacks.cancelOutbound("turn_timeout")
    admission.resolve(true)
    await callbacks.finish()

    expect(markChatRead).not.toHaveBeenCalled()
    expect(setTyping).not.toHaveBeenCalledWith(expect.anything(), true)
  })

  it("rechecks currentness after pending-observation admission settles", async () => {
    const indexModule = await import("../../../senses/bluebubbles")
    const admission = createDeferred<boolean>()
    let current = true
    const markChatRead = vi.fn(async () => {})
    const setTyping = vi.fn(async () => {})
    const callbacks = indexModule.createBlueBubblesCallbacks(
      {
        sendText: vi.fn(async () => ({ messageGuid: "sent-guid" })),
        editMessage: vi.fn(),
        setTyping,
        markChatRead,
        checkHealth: vi.fn(),
        repairEvent: vi.fn(),
        getMessageText: vi.fn(),
      } as any,
      { chatGuid: "chat-1", participants: [] } as any,
      { getReplyToMessageGuid: vi.fn(), setSelection: vi.fn() } as any,
      false,
      undefined,
      {
        admitOutbound: () => admission.promise,
        isOutboundCurrent: () => current,
      },
    )

    callbacks.onModelStart()
    await Promise.resolve()
    current = false
    admission.resolve(true)
    await callbacks.finish()

    expect(markChatRead).not.toHaveBeenCalled()
    expect(setTyping).not.toHaveBeenCalledWith(expect.anything(), true)
  })

  it("does not send or re-enable typing when cancellation lands during a long silent turn", async () => {
    vi.useFakeTimers()
    try {
      const indexModule = await import("../../../senses/bluebubbles")
      const setTyping = vi.fn(async () => {})
      const sendText = vi.fn(async () => ({ messageGuid: "sent-guid" }))
      const chat = { chatGuid: "chat-1", participants: [] } as any
      const callbacks = indexModule.createBlueBubblesCallbacks(
        {
          sendText,
          editMessage: vi.fn(),
          setTyping,
          markChatRead: vi.fn(async () => {}),
          checkHealth: vi.fn(),
          repairEvent: vi.fn(),
          getMessageText: vi.fn(),
        } as any,
        chat,
        { getReplyToMessageGuid: vi.fn(() => "reply-guid"), setSelection: vi.fn() } as any,
        false,
      )

      callbacks.onModelStart()
      await vi.advanceTimersByTimeAsync(0)
      expect(setTyping).toHaveBeenCalledWith(chat, true, expect.any(AbortSignal))
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(sendText).not.toHaveBeenCalled()

      callbacks.cancelOutbound("turn_timeout")
      await callbacks.finish()

      expect(setTyping.mock.calls.filter(([, active]) => active === true)).toHaveLength(1)
      expect(setTyping.mock.calls.filter(([, active]) => active === false)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("issues a bounded emergency typing stop before releasing an old turn and invalidates its queued stop", async () => {
    vi.useFakeTimers()
    try {
      const indexModule = await import("../../../senses/bluebubbles")
      const read = createDeferred<void>()
      const setTyping = vi.fn(async () => {})
      const chat = { chatGuid: "chat-1", participants: [] } as any
      const callbacks = indexModule.createBlueBubblesCallbacks(
        {
          sendText: vi.fn(async () => ({ messageGuid: "sent-guid" })),
          editMessage: vi.fn(),
          setTyping,
          markChatRead: vi.fn(() => read.promise),
          checkHealth: vi.fn(),
          repairEvent: vi.fn(),
          getMessageText: vi.fn(),
        } as any,
        chat,
        { getReplyToMessageGuid: vi.fn(), setSelection: vi.fn() } as any,
        false,
        undefined,
        {},
      )

      callbacks.onModelStart()
      await vi.advanceTimersByTimeAsync(0)
      expect(setTyping).toHaveBeenCalledWith(chat, true, expect.any(AbortSignal))
      callbacks.cancelOutbound("superseded")
      const cleanup = callbacks.finish({ timeoutMs: 1 })
      await vi.advanceTimersByTimeAsync(1)
      await cleanup

      expect(setTyping.mock.calls).toEqual([
        [chat, true, expect.any(AbortSignal)],
        [chat, false, expect.any(AbortSignal)],
      ])

      // Simulate the next canonical turn starting only after the old turn's
      // bounded cleanup has returned.
      await setTyping(chat, true)
      read.resolve()
      await vi.advanceTimersByTimeAsync(0)

      expect(setTyping.mock.calls.at(-1)).toEqual([chat, true])
      expect(setTyping.mock.calls.filter(([, active]) => active === false)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("aborts and replaces an already-queued stop before a newer turn can start", async () => {
    vi.useFakeTimers()
    try {
      const indexModule = await import("../../../senses/bluebubbles")
      const effects: string[] = []
      let staleStopSignal: AbortSignal | undefined
      let releaseStaleStop = (): void => undefined
      let typingCall = 0
      const setTyping = vi.fn((_chat: unknown, active: boolean, signal?: AbortSignal) => {
        typingCall += 1
        if (typingCall === 1) {
          effects.push("A:true")
          return Promise.resolve()
        }
        if (typingCall === 2) {
          staleStopSignal = signal
          return new Promise<void>((resolve, reject) => {
            releaseStaleStop = () => {
              if (!signal?.aborted) effects.push("A:false:late")
              resolve()
            }
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
          })
        }
        effects.push("A:false:fallback")
        return Promise.resolve()
      })
      const chat = { chatGuid: "chat-1", participants: [] } as any
      const callbacks = indexModule.createBlueBubblesCallbacks(
        {
          sendText: vi.fn(async () => ({ messageGuid: "sent-guid" })),
          editMessage: vi.fn(),
          setTyping,
          markChatRead: vi.fn(async () => {}),
          checkHealth: vi.fn(),
          repairEvent: vi.fn(),
          getMessageText: vi.fn(),
        } as any,
        chat,
        { getReplyToMessageGuid: vi.fn(), setSelection: vi.fn() } as any,
        false,
      )

      callbacks.onModelStart()
      await vi.advanceTimersByTimeAsync(0)
      const flush = callbacks.flush()
      await vi.advanceTimersByTimeAsync(0)
      expect(staleStopSignal).toBeInstanceOf(AbortSignal)

      const cleanup = callbacks.finish({ timeoutMs: 1 })
      await vi.advanceTimersByTimeAsync(1)
      await cleanup
      releaseStaleStop()
      await flush

      expect(staleStopSignal?.aborted).toBe(true)
      expect(effects).toEqual(["A:true", "A:false:fallback"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("invalidates a stop still queued behind a timed-out typing start", async () => {
    vi.useFakeTimers()
    try {
      const indexModule = await import("../../../senses/bluebubbles")
      const chat = { chatIdentifier: "ari@example.test", participants: [] } as any
      const setTyping = vi.fn((_chat: unknown, active: boolean) => (
        active ? new Promise<void>(() => undefined) : Promise.resolve()
      ))
      const callbacks = indexModule.createBlueBubblesCallbacks(
        {
          sendText: vi.fn(async () => ({ messageGuid: "sent-guid" })),
          editMessage: vi.fn(),
          setTyping,
          markChatRead: vi.fn(() => new Promise<void>(() => undefined)),
          checkHealth: vi.fn(),
          repairEvent: vi.fn(),
          getMessageText: vi.fn(),
        } as any,
        chat,
        { getReplyToMessageGuid: vi.fn(), setSelection: vi.fn() } as any,
        false,
      )

      callbacks.onModelStart()
      await vi.advanceTimersByTimeAsync(0)
      const cleanup = callbacks.finish({ timeoutMs: 1 })
      await vi.advanceTimersByTimeAsync(1)
      await cleanup

      expect(setTyping.mock.calls.map(([, active]) => active)).toEqual([true, false])
      expect(setTyping.mock.calls[1]?.[2]).toBeInstanceOf(AbortSignal)
    } finally {
      vi.useRealTimers()
    }
  })

  it("flushNow with empty buffer is a safe noop — no sendText, no error", async () => {
    const { callbacks, sendText } = await setup()
    // No onTextChunk called yet — buffer is empty
    await expect((callbacks as any).flushNow()).resolves.not.toThrow()
    expect(sendText).not.toHaveBeenCalled()
  })

  it("onToolStart('speak', ...) is INVISIBLE — no statusBatcher/sendStatus tool-activity message", async () => {
    const indexModule = await import("../../../senses/bluebubbles")
    const { createBlueBubblesCallbacks } = indexModule
    const sendText = vi.fn(async () => ({ messageGuid: "g" }))
    const setTyping = vi.fn(async () => {})
    const markChatRead = vi.fn(async () => {})
    const editMessage = vi.fn(async () => {})
    const checkHealth = vi.fn(async () => {})
    const repairEvent = vi.fn(async (e: any) => e)
    const getMessageText = vi.fn(async () => null)
    const client = { sendText, editMessage, setTyping, markChatRead, checkHealth, repairEvent, getMessageText }
    const chat = { chatGuid: "chat-1", participants: [] } as any
    const replyTarget = { getReplyToMessageGuid: vi.fn(() => "reply-guid"), setSelection: vi.fn(() => "ok") }
    const callbacks = createBlueBubblesCallbacks(client as any, chat, replyTarget as any, false)

    // Calling onToolStart for "speak" must NOT enqueue any sendText for status.
    // (sendText for the actual speak message goes through flushNow, not onToolStart.)
    callbacks.onToolStart("speak", { message: "hi friend" })
    // Wait briefly to let any micro-task queue settle (sendStatus uses enqueue/queue).
    await new Promise((r) => setTimeout(r, 50))
    expect(sendText).not.toHaveBeenCalled()
  })

  it("onToolEnd('speak', ...) is INVISIBLE — no failure status sent on success", async () => {
    const indexModule = await import("../../../senses/bluebubbles")
    const { createBlueBubblesCallbacks } = indexModule
    const sendText = vi.fn(async () => ({ messageGuid: "g" }))
    const setTyping = vi.fn(async () => {})
    const markChatRead = vi.fn(async () => {})
    const editMessage = vi.fn(async () => {})
    const checkHealth = vi.fn(async () => {})
    const repairEvent = vi.fn(async (e: any) => e)
    const getMessageText = vi.fn(async () => null)
    const client = { sendText, editMessage, setTyping, markChatRead, checkHealth, repairEvent, getMessageText }
    const chat = { chatGuid: "chat-1", participants: [] } as any
    const replyTarget = { getReplyToMessageGuid: vi.fn(() => "reply-guid"), setSelection: vi.fn(() => "ok") }
    const callbacks = createBlueBubblesCallbacks(client as any, chat, replyTarget as any, false)

    callbacks.onToolStart("speak", { message: "hi" })
    callbacks.onToolEnd("speak", "message=hi", true)
    await new Promise((r) => setTimeout(r, 50))
    expect(sendText).not.toHaveBeenCalled()
  })

  it("flush() drops accumulated text containing internal meta markers and does NOT call client.sendText", async () => {
    const indexModule = await import("../../../senses/bluebubbles")
    const { createBlueBubblesCallbacks } = indexModule
    const sendText = vi.fn(async () => ({ messageGuid: "g" }))
    const setTyping = vi.fn(async () => {})
    const markChatRead = vi.fn(async () => {})
    const editMessage = vi.fn(async () => {})
    const checkHealth = vi.fn(async () => {})
    const repairEvent = vi.fn(async (e: any) => e)
    const getMessageText = vi.fn(async () => null)
    const client = { sendText, editMessage, setTyping, markChatRead, checkHealth, repairEvent, getMessageText }
    const chat = { chatGuid: "chat-1", participants: [] } as any
    const replyTarget = { getReplyToMessageGuid: vi.fn(() => "reply-guid"), setSelection: vi.fn(() => "ok") }
    const callbacks = createBlueBubblesCallbacks(client as any, chat, replyTarget as any, false)

    callbacks.onTextChunk("[surfaced from inner dialog] hi friend")
    await (callbacks as any).flush()

    expect(sendText).not.toHaveBeenCalled()

    const { emitNervesEvent } = await import("../../../nerves/runtime")
    const blockedCall = (emitNervesEvent as any).mock.calls.find(
      (call: any[]) => call[0]?.event === "senses.bluebubbles_meta_blocked",
    )
    expect(blockedCall).toBeDefined()
    expect(blockedCall![0].level).toBe("warn")
    expect(blockedCall![0].meta).toEqual(expect.objectContaining({ site: "flush" }))
  })

  it("flush() still delivers normal prose that mentions private-runtime concepts in plain text", async () => {
    const indexModule = await import("../../../senses/bluebubbles")
    const { createBlueBubblesCallbacks } = indexModule
    const sendText = vi.fn(async () => ({ messageGuid: "g" }))
    const setTyping = vi.fn(async () => {})
    const markChatRead = vi.fn(async () => {})
    const editMessage = vi.fn(async () => {})
    const checkHealth = vi.fn(async () => {})
    const repairEvent = vi.fn(async (e: any) => e)
    const getMessageText = vi.fn(async () => null)
    const client = { sendText, editMessage, setTyping, markChatRead, checkHealth, repairEvent, getMessageText }
    const chat = { chatGuid: "chat-1", participants: [] } as any
    const replyTarget = { getReplyToMessageGuid: vi.fn(() => "reply-guid"), setSelection: vi.fn(() => "ok") }
    const callbacks = createBlueBubblesCallbacks(client as any, chat, replyTarget as any, false)

    callbacks.onTextChunk("had a thought from my private runtime about your question")
    await (callbacks as any).flush()

    expect(sendText).toHaveBeenCalledTimes(1)
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: "had a thought from my private runtime about your question",
    }))
  })

  it("flushNow drops speak text containing internal meta markers and does NOT call client.sendText", async () => {
    const indexModule = await import("../../../senses/bluebubbles")
    const { createBlueBubblesCallbacks } = indexModule
    const sendText = vi.fn(async () => ({ messageGuid: "g" }))
    const setTyping = vi.fn(async () => {})
    const markChatRead = vi.fn(async () => {})
    const editMessage = vi.fn(async () => {})
    const checkHealth = vi.fn(async () => {})
    const repairEvent = vi.fn(async (e: any) => e)
    const getMessageText = vi.fn(async () => null)
    const client = { sendText, editMessage, setTyping, markChatRead, checkHealth, repairEvent, getMessageText }
    const chat = { chatGuid: "chat-1", participants: [] } as any
    const replyTarget = { getReplyToMessageGuid: vi.fn(() => "reply-guid"), setSelection: vi.fn(() => "ok") }
    const callbacks = createBlueBubblesCallbacks(client as any, chat, replyTarget as any, false)

    callbacks.onTextChunk("<think>private speak leak</think>")
    await (callbacks as any).flushNow()

    expect(sendText).not.toHaveBeenCalled()

    const { emitNervesEvent } = await import("../../../nerves/runtime")
    const blockedCall = (emitNervesEvent as any).mock.calls.find(
      (call: any[]) => call[0]?.event === "senses.bluebubbles_meta_blocked" && call[0]?.meta?.site === "flushNow",
    )
    expect(blockedCall).toBeDefined()
    expect(blockedCall![0].level).toBe("warn")
  })

  it("flushNow PROPAGATES rejection when client.sendText rejects (hard delivery failure)", async () => {
    const indexModule = await import("../../../senses/bluebubbles")
    const { createBlueBubblesCallbacks } = indexModule
    const sendText = vi.fn(async () => { throw new Error("bb network down") })
    const setTyping = vi.fn(async () => {})
    const markChatRead = vi.fn(async () => {})
    const editMessage = vi.fn(async () => {})
    const checkHealth = vi.fn(async () => {})
    const repairEvent = vi.fn(async (e: any) => e)
    const getMessageText = vi.fn(async () => null)
    const client = { sendText, editMessage, setTyping, markChatRead, checkHealth, repairEvent, getMessageText }
    const chat = { chatGuid: "chat-1", participants: [] } as any
    const replyTarget = { getReplyToMessageGuid: vi.fn(() => "reply-guid"), setSelection: vi.fn(() => "ok") }
    const callbacks = createBlueBubblesCallbacks(client as any, chat, replyTarget as any, false)
    callbacks.onTextChunk("hello will fail")
    await expect((callbacks as any).flushNow()).rejects.toThrow(/bb network down/)
  })
})
