import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/tmp/AgentBundles/testagent.ouro"),
}))

describe("BlueBubbles tool callbacks via createToolActivityCallbacks", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  async function loadModule() {
    const { createToolActivityCallbacks } = await import("../../../heart/tool-activity-callbacks")
    return createToolActivityCallbacks
  }

  describe("default mode (non-debug)", () => {
    it("onToolStart sends ONE human-readable iMessage via onDescription", async () => {
      const createToolActivityCallbacks = await loadModule()
      const sendText = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription: sendText,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: () => false,
      })

      onToolStart("read_file", { file_path: "/foo/bar/mcp-server.ts" })
      expect(sendText).toHaveBeenCalledTimes(1)
      expect(sendText).toHaveBeenCalledWith("reading mcp-server.ts...")
    })

    it("onToolEnd does NOT send in default mode (success=true)", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onResult = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult,
        onFailure: vi.fn(),
        isDebug: () => false,
      })

      onToolEnd("shell", "exit code 0", true)
      expect(onResult).not.toHaveBeenCalled()
    })

    it("onToolEnd sends failure message when success=false", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onFailure = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult: vi.fn(),
        onFailure,
        isDebug: () => false,
      })

      onToolEnd("shell", "exit code 1", false)
      expect(onFailure).toHaveBeenCalledWith("✗ shell — exit code 1")
    })

    it("settle: NO message sent (hidden)", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: () => false,
      })

      onToolStart("settle", {})
      expect(onDescription).not.toHaveBeenCalled()
    })
  })

  describe("debug mode", () => {
    it("onToolStart sends description", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: () => true,
      })

      onToolStart("shell", { command: "npm test" })
      expect(onDescription).toHaveBeenCalledWith("running npm test...")
    })

    it("onToolEnd sends result summary", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onResult = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult,
        onFailure: vi.fn(),
        isDebug: () => true,
      })

      onToolEnd("read_file", "200 lines", true)
      expect(onResult).toHaveBeenCalledWith("✓ read_file")
    })
  })

  describe("integration: BB-style queue serialization", () => {
    it("multiple tool starts are serialized correctly", async () => {
      const createToolActivityCallbacks = await loadModule()
      const calls: string[] = []
      const onDescription = vi.fn((text: string) => calls.push(text))

      const { onToolStart } = createToolActivityCallbacks({
        onDescription,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: () => false,
      })

      onToolStart("read_file", { file_path: "/a/b.ts" })
      onToolStart("shell", { command: "npm test" })
      onToolStart("settle", {})

      expect(calls).toEqual([
        "reading b.ts...",
        "running npm test...",
        // settle is hidden, not in the list
      ])
    })
  })
})

describe("BlueBubbles createBlueBubblesCallbacks - flushNow (speak tool)", () => {
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

  it("sends a visible still-working status only after a silent live turn stays quiet past the watchdog window", async () => {
    vi.useFakeTimers()
    try {
      const { callbacks, sendText } = await setup()
      callbacks.onModelStart()
      callbacks.onModelStart()
      await vi.advanceTimersByTimeAsync(10_000)
      callbacks.onTextChunk("first visible reply")
      await (callbacks as any).flushNow()
      expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ text: "first visible reply" }))

      await vi.advanceTimersByTimeAsync(65_000)
      expect(sendText).not.toHaveBeenCalledWith(expect.objectContaining({ text: "still working on this..." }))

      await vi.advanceTimersByTimeAsync(75_000)
      expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ text: "still working on this..." }))
      await (callbacks as any).finish()
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

  it("flush() still delivers normal prose that mentions inner-dialog concepts in plain text", async () => {
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

    callbacks.onTextChunk("had a thought from my inner dialog about your question")
    await (callbacks as any).flush()

    expect(sendText).toHaveBeenCalledTimes(1)
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: "had a thought from my inner dialog about your question",
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
