import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("proactive content guard", () => {
  let getProactiveInternalContentBlockReason: typeof import("../../senses/proactive-content-guard").getProactiveInternalContentBlockReason
  let emitProactiveInternalContentBlocked: typeof import("../../senses/proactive-content-guard").emitProactiveInternalContentBlocked
  let emitNervesEvent: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../senses/proactive-content-guard")
    getProactiveInternalContentBlockReason = mod.getProactiveInternalContentBlockReason
    emitProactiveInternalContentBlocked = mod.emitProactiveInternalContentBlocked
    const nerves = await import("../../nerves/runtime")
    emitNervesEvent = nerves.emitNervesEvent as ReturnType<typeof vi.fn>
  })

  describe("getProactiveInternalContentBlockReason", () => {
    // PR 447 patterns
    it("blocks raw XML meta markers like <think>", () => {
      expect(getProactiveInternalContentBlockReason("<think>some reasoning</think>")).not.toBeNull()
    })

    it("blocks [surfaced from inner dialog] prefix", () => {
      expect(getProactiveInternalContentBlockReason("[surfaced from inner dialog] check-in")).not.toBeNull()
    })

    it("blocks inner dialog references", () => {
      expect(getProactiveInternalContentBlockReason("my inner dialog has a thought")).not.toBeNull()
    })

    it("blocks attention queue references", () => {
      expect(getProactiveInternalContentBlockReason("checking my attention queue")).not.toBeNull()
    })

    it("blocks return obligation references", () => {
      expect(getProactiveInternalContentBlockReason("I have a return obligation to fulfill")).not.toBeNull()
    })

    it("blocks surfacing mechanics references", () => {
      expect(getProactiveInternalContentBlockReason("using the surface tool to deliver")).not.toBeNull()
    })

    it("blocks prompt references", () => {
      expect(getProactiveInternalContentBlockReason("my system prompt says to")).not.toBeNull()
    })

    it("blocks routing references", () => {
      expect(getProactiveInternalContentBlockReason("routing target is bluebubbles")).not.toBeNull()
    })

    // New heartbeat/status patterns
    it("blocks heartbeat check-in text", () => {
      expect(getProactiveInternalContentBlockReason("heartbeat check-in: same state")).not.toBeNull()
    })

    it("blocks task board references", () => {
      expect(getProactiveInternalContentBlockReason("task board shows maintenance in progress")).not.toBeNull()
    })

    it("blocks 'all else settled' status phrases", () => {
      expect(getProactiveInternalContentBlockReason("all else settled")).not.toBeNull()
    })

    it("blocks obligations showing stale", () => {
      expect(getProactiveInternalContentBlockReason("obligations showing stale")).not.toBeNull()
    })

    it("blocks 'same state' status reporting", () => {
      expect(getProactiveInternalContentBlockReason("same state, nothing new")).not.toBeNull()
    })

    // Clean content should pass
    it("allows normal interpersonal messages", () => {
      expect(getProactiveInternalContentBlockReason("hey, wanted to check in about that thing you mentioned")).toBeNull()
    })

    it("allows questions", () => {
      expect(getProactiveInternalContentBlockReason("did you get a chance to review the doc?")).toBeNull()
    })

    it("allows substantive updates", () => {
      expect(getProactiveInternalContentBlockReason("finished the PR — tests pass, ready for your review")).toBeNull()
    })
  })

  describe("emitProactiveInternalContentBlocked", () => {
    it("emits a nerves event with correct structure", () => {
      emitProactiveInternalContentBlocked({
        friendId: "friend-1",
        reason: "raw_meta_marker",
        source: "session_send",
      })

      expect(emitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          component: "senses",
          event: "senses.proactive_internal_content_blocked",
          meta: expect.objectContaining({
            friendId: "friend-1",
            reason: "raw_meta_marker",
            source: "session_send",
          }),
        }),
      )
    })

    it("includes optional sessionKey and intent in meta", () => {
      emitProactiveInternalContentBlocked({
        friendId: "friend-1",
        sessionKey: "sess-1",
        reason: "heartbeat_status",
        source: "pending_drain",
        intent: "generic_outreach",
      })

      expect(emitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          meta: expect.objectContaining({
            sessionKey: "sess-1",
            intent: "generic_outreach",
          }),
        }),
      )
    })
  })
})
