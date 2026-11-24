import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("proactive content guard", () => {
  let getProactiveInternalContentBlockReason: typeof import("../../senses/proactive-content-guard").getProactiveInternalContentBlockReason
  let emitProactiveInternalContentBlocked: typeof import("../../senses/proactive-content-guard").emitProactiveInternalContentBlocked
  let proactiveContentBlockGuidance: typeof import("../../senses/proactive-content-guard").proactiveContentBlockGuidance
  let isVerificationHoldReason: typeof import("../../senses/proactive-content-guard").isVerificationHoldReason
  let returnHeldProactiveMessage: typeof import("../../senses/proactive-content-guard").returnHeldProactiveMessage
  let emitNervesEvent: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../senses/proactive-content-guard")
    getProactiveInternalContentBlockReason = mod.getProactiveInternalContentBlockReason
    emitProactiveInternalContentBlocked = mod.emitProactiveInternalContentBlocked
    proactiveContentBlockGuidance = mod.proactiveContentBlockGuidance
    isVerificationHoldReason = mod.isVerificationHoldReason
    returnHeldProactiveMessage = mod.returnHeldProactiveMessage
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

    it("blocks stale private-runtime vocabulary references", () => {
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

  describe("routine verification chores and untested delivery claims", () => {
    const incident = "The proof images on Tandem #5312, #5127 and #5046 have been re-attached in a way that should load on your phone. Whether they actually show in the GitHub Mobile app hasn't been tested yet. Could you open #5312 on your phone and tell me if the pictures show?"

    it("holds the 2026-11-24 message that asked Ari to open a PR and report whether images show", () => {
      expect(getProactiveInternalContentBlockReason(incident)).toBe("routine_verification_request")
    })

    it("holds an untested result offered as the news, with no ask", () => {
      expect(getProactiveInternalContentBlockReason("The images were re-attached. This hasn't been verified in the app yet.")).toBe("untested_delivery_claim")
      expect(getProactiveInternalContentBlockReason("The fix should now load on mobile.")).toBe("untested_delivery_claim")
    })

    it("holds other phrasings of the same ask", () => {
      expect(getProactiveInternalContentBlockReason("Please check the dashboard and let me know whether it loads.")).toBe("routine_verification_request")
      expect(getProactiveInternalContentBlockReason("Let me know if the page renders for you after the deploy.")).toBe("routine_verification_request")
    })

    it("passes a verified done with proof", () => {
      expect(getProactiveInternalContentBlockReason("Done: I verified the images load in a mobile-web browser (screenshot attached). The native app was not checked.")).toBeNull()
      expect(getProactiveInternalContentBlockReason("I tested it and the page should load for everyone now; screenshot attached.")).toBeNull()
    })

    it("passes a genuine user-only ask", () => {
      expect(getProactiveInternalContentBlockReason("Could you sign in to the vault so I can finish? Tell me when you have.")).toBeNull()
      expect(getProactiveInternalContentBlockReason("Please approve the MFA prompt on your phone and let me know when it's done.")).toBeNull()
      expect(getProactiveInternalContentBlockReason("Can you plug in the printer and tell me whether the light turns green?")).toBeNull()
    })

    it("passes a status update the person asked for, honestly marked unverified", () => {
      expect(getProactiveInternalContentBlockReason("As you asked, here's where it stands: the images are re-attached, but this is unverified in the native app.")).toBeNull()
    })

    it("tells the sending lane to verify and what a mobile-web render proves", () => {
      const guidance = proactiveContentBlockGuidance("routine_verification_request")
      expect(guidance).toContain("Verify it yourself")
      expect(guidance).toContain("mobile-web browser render")
      expect(proactiveContentBlockGuidance("heartbeat_status")).toBe("blocked: this reads as internal status (heartbeat_status), so no chat sends it; rewrite it as plain words for them")
      expect(proactiveContentBlockGuidance(null)).toBe("blocked: this reads as internal status, so no chat sends it; rewrite it as plain words for them")
      expect(isVerificationHoldReason("untested_delivery_claim")).toBe(true)
      expect(isVerificationHoldReason("heartbeat_status")).toBe(false)
    })

    it("returns a held pending message to the agent's own private runtime", async () => {
      const queuePendingMessage = vi.fn()
      vi.doMock("../../mind/pending", () => ({
        queuePendingMessage,
        getPrivateRuntimePendingDir: (agent: string) => `/root/${agent}/pending`,
        PRIVATE_RUNTIME_PENDING: { friendId: "self", channel: "inner", key: "dialog" },
      }))
      await returnHeldProactiveMessage({ agentName: "ouro", friendId: "f1", text: incident, reason: "routine_verification_request" })
      expect(queuePendingMessage).toHaveBeenCalledWith("/root/ouro/pending", expect.objectContaining({
        from: "ouro",
        channel: "inner",
        mode: "reflect",
        content: expect.stringContaining("Verify it yourself"),
      }))
      expect(queuePendingMessage.mock.calls[0]![1].content).toContain(incident)
      vi.doUnmock("../../mind/pending")
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
