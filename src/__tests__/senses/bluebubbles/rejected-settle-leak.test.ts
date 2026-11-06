import { describe, it, expect, vi, beforeEach } from "vitest"

// Regression test for Blocker D from PR #642 live demo:
// When the agent's settle call is rejected (sole-call check, mustResolveBeforeHandoff
// gate, or inner-dialog attention-queue gate), core.ts calls
// `callbacks.onToolEnd("settle", summarizeArgs("settle", settleArgs), false)`. The
// previous BB sense forwarded that to the shared tool-activity callbacks, which
// rendered "✗ <previous visible tool's description> — answer=... intent=..." and
// posted it as a visible iMessage status line — leaking the agent's
// intended-but-rejected settle answer into the user-visible chat.
//
// The fix is in src/heart/tool-activity-callbacks.ts: hidden tools (settle,
// rest, observe, descend, speak — the ones whose humanReadableToolDescription
// returns null) now have their onToolEnd suppressed symmetrically with their
// onToolStart. These tests assert the BB sense observes that contract end-to-end
// via createBlueBubblesCallbacks.

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/tmp/AgentBundles/testagent.ouro"),
}))

describe("BlueBubbles: rejected settle args do NOT leak into visible chat", () => {
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
    const repairEvent = vi.fn(async (e: unknown) => e)
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
    const chat = { chatGuid: "chat-1", participants: [] } as unknown
    const replyTarget = {
      getReplyToMessageGuid: vi.fn(() => "reply-guid"),
      setSelection: vi.fn(() => "ok"),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test setup mirrors tool-callbacks.test.ts
    const callbacks = createBlueBubblesCallbacks(client as any, chat as any, replyTarget as any, false)
    return { callbacks, sendText, setTyping }
  }

  // Drain the BB sense's internal status batcher (500ms debounce) plus the
  // promise queue. Tests use real timers so the batcher's setTimeout actually
  // fires and the queued sendStatus chain completes.
  async function drainStatusBatcher(): Promise<void> {
    await new Promise((r) => setTimeout(r, 600))
  }

  function leakSubstrings(): string[] {
    // The exact substrings that would betray a rejected settle answer leaking
    // into the visible chat. The summary built by summarizeArgs for settle is
    // "answer=... intent=..." (or just "answer=..."), and the answer text
    // itself is also a smoking gun.
    return ["answer=", "intent=", "found it secret answer"]
  }

  it("rejected sole-call settle (after a prior visible read_file) does NOT call client.sendText with settle's args", async () => {
    // Repro of the PR #642 demo path: read_file ran earlier in the turn (status
    // batched + sent), then a sole-call settle was rejected by mustResolveBeforeHandoff.
    const { callbacks, sendText } = await setup()

    // Prior visible tool primes lastDescription and sends a legitimate status.
    callbacks.onToolStart("read_file", { path: "audit.ts" })
    await drainStatusBatcher()
    sendText.mockClear()

    // Rejected settle — exactly what core.ts does on the rejection paths.
    callbacks.onToolStart("settle", {
      answer: "found it secret answer here that should never appear in chat",
      intent: "complete",
    })
    callbacks.onToolEnd(
      "settle",
      "answer=found it secret answer here that should never appear in chat intent=complete",
      false,
    )
    await drainStatusBatcher()

    // No new sendText after we cleared the mock. The hidden-tool END is suppressed.
    expect(sendText).not.toHaveBeenCalled()
  })

  it("rejected settle from the inner-dialog attention-queue gate does NOT leak args via client.sendText", async () => {
    // Same shape as above — core.ts calls callbacks.onToolEnd("settle", summary, false)
    // with the summary built from settleArgs regardless of which gate rejected
    // the settle. We exercise the same surface.
    const { callbacks, sendText } = await setup()

    callbacks.onToolStart("read_file", { path: "audit.ts" })
    await drainStatusBatcher()
    sendText.mockClear()

    callbacks.onToolStart("settle", {
      answer: "draft answer the user must not see yet",
      intent: "complete",
    })
    callbacks.onToolEnd("settle", "answer=draft answer the user must not see yet intent=complete", false)
    await drainStatusBatcher()

    const allSentTexts = sendText.mock.calls.map((c) => (c[0] as { text?: string }).text ?? "")
    for (const text of allSentTexts) {
      for (const leak of leakSubstrings()) {
        expect(text).not.toContain(leak)
      }
    }
    // And specifically, no draft answer text leaked.
    for (const text of allSentTexts) {
      expect(text).not.toContain("draft answer")
    }
  })

  it("rejected settle from a SOLE_CALL_REJECTION-style mixed-call rejection does NOT leak via client.sendText", async () => {
    // SOLE_CALL_REJECTION inside core.ts is currently the inline rejection of
    // settle when it appears alongside other tools in the same model response.
    // That path does not currently invoke callbacks.onToolEnd at all (it just
    // pushes a tool-result message). We assert the broader invariant: any
    // rejected settle that does flow through onToolStart+onToolEnd at the
    // sense layer does NOT leak. This is the most defensive shape and covers
    // any future engine refactor that routes rejection through the callback.
    const { callbacks, sendText } = await setup()

    callbacks.onToolStart("read_file", { path: "audit.ts" })
    await drainStatusBatcher()
    sendText.mockClear()

    callbacks.onToolStart("settle", { answer: "yet another secret answer", intent: "blocked" })
    callbacks.onToolEnd("settle", "answer=yet another secret answer intent=blocked", false)
    await drainStatusBatcher()

    expect(sendText).not.toHaveBeenCalled()
  })

  it("a successful settle (engine fast path, success=true) is also NOT surfaced as a tool-activity status", async () => {
    // Sanity: ensures the suppression is symmetric for success too. The actual
    // delivered settle answer goes through onTextChunk + flush, NOT the
    // tool-activity status surface, so the hidden-tool END suppression should
    // never produce a "✓ ... " status line either.
    const { callbacks, sendText } = await setup()

    callbacks.onToolStart("read_file", { path: "audit.ts" })
    await drainStatusBatcher()
    sendText.mockClear()

    callbacks.onToolStart("settle", { answer: "delivered answer text", intent: "complete" })
    callbacks.onToolEnd("settle", "answer=delivered answer text intent=complete", true)
    await drainStatusBatcher()

    expect(sendText).not.toHaveBeenCalled()
  })
})
