import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))


describe("proactive content guard", () => {
  let getProactiveInternalContentBlockReason: typeof import("../../senses/proactive-content-guard").getProactiveInternalContentBlockReason
  let emitProactiveInternalContentBlocked: typeof import("../../senses/proactive-content-guard").emitProactiveInternalContentBlocked
  let proactiveContentBlockGuidance: typeof import("../../senses/proactive-content-guard").proactiveContentBlockGuidance
  let isReturnToSenderReason: typeof import("../../senses/proactive-content-guard").isReturnToSenderReason
  let returnHeldProactiveMessage: typeof import("../../senses/proactive-content-guard").returnHeldProactiveMessage
  let emitNervesEvent: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../senses/proactive-content-guard")
    getProactiveInternalContentBlockReason = mod.getProactiveInternalContentBlockReason
    emitProactiveInternalContentBlocked = mod.emitProactiveInternalContentBlocked
    proactiveContentBlockGuidance = mod.proactiveContentBlockGuidance
    isReturnToSenderReason = mod.isReturnToSenderReason
    returnHeldProactiveMessage = mod.returnHeldProactiveMessage
    const nerves = await import("../../nerves/runtime")
    emitNervesEvent = nerves.emitNervesEvent as ReturnType<typeof vi.fn>
  })

  describe("routine notices", () => {
    const headsUp = "Heads-up, nothing to do yet: three Microsoft sign-ins on the mini have expired. When one is there, I'll send you a single passkey tap to approve on your phone."
    const reboot = "The mini needed a forced reboot, and it's back. The last save point before the reboot was at 6:21 PT last night, so a few sessions may have lost work done after that. Nothing needed from you."

    it("holds the heads-up that announces a later passkey tap", () => {
      expect(getProactiveInternalContentBlockReason(headsUp)).toBe("routine_notice")
    })

    it("holds a plain routine status that needs no action", () => {
      expect(getProactiveInternalContentBlockReason("The nightly run finished. Nothing needed from you.")).toBe("routine_notice")
    })

    it("sends the forced-reboot notice, a material warning about lost work", () => {
      expect(getProactiveInternalContentBlockReason(reboot)).toBeNull()
    })

    it("sends a mixed text whose future-gate part rides with a real present ask", () => {
      expect(getProactiveInternalContentBlockReason("Nothing to do yet on the sign-in; when it is ready I will send the prompt. Please approve the pending deployment now.")).toBeNull()
      expect(getProactiveInternalContentBlockReason("Nothing to do yet; when it is ready I will send the prompt, but please approve the deployment now.")).toBeNull()
    })

    it("sends the later request for the passkey tap itself", () => {
      expect(getProactiveInternalContentBlockReason("A Microsoft sign-in is ready. Please tap to approve the passkey on your phone.")).toBeNull()
      expect(getProactiveInternalContentBlockReason("Nothing else is needed, but please approve the passkey on your phone now.")).toBeNull()
    })

    it("sends an update the person asked for", () => {
      expect(getProactiveInternalContentBlockReason("As you asked, here's the status: the nightly run finished. Nothing needed from you.")).toBeNull()
    })

    it("sends a correction", () => {
      expect(getProactiveInternalContentBlockReason("Correction: the earlier report was wrong. Nothing needed from you.")).toBeNull()
    })

    it("keeps a held notice out of the return-to-sender path and tells the sender it is held", () => {
      expect(isReturnToSenderReason("routine_notice")).toBe(false)
      expect(proactiveContentBlockGuidance("routine_notice")).toContain("held, not sent")
    })
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

  describe("asks pass; untested delivery claims are held", () => {
    const incident = "The proof images on Tandem #5312 have been re-attached. Whether they show in the GitHub Mobile app hasn't been tested yet."

    it("never holds an ask: what to ask a person for is taught in the prompt, not enforced here", () => {
      for (const ask of [
        "Could you open #5312 on your phone and tell me if the pictures show?",
        "Can you press 2 at the Orca prompt?",
        "Tap 47 in GitHub Mobile to approve the sign-in.",
      ]) expect(getProactiveInternalContentBlockReason(ask), ask).toBeNull()
    })

    it("holds an untested result offered as the news, with no ask", () => {
      expect(getProactiveInternalContentBlockReason("The images were re-attached. This hasn't been verified in the app yet.")).toBe("untested_delivery_claim")
      expect(getProactiveInternalContentBlockReason("The fix should now load on mobile.")).toBe("untested_delivery_claim")
    })

    it("passes a verified done with proof", () => {
      expect(getProactiveInternalContentBlockReason("Done: I verified the images load in a mobile-web browser (screenshot attached). The native app was not checked.")).toBeNull()
      expect(getProactiveInternalContentBlockReason("I tested it and the page should load for everyone now; screenshot attached.")).toBeNull()
    })

    it("passes a status update the person asked for, honestly marked unverified", () => {
      expect(getProactiveInternalContentBlockReason("As you asked, here's where it stands: the images are re-attached, but this is unverified in the native app.")).toBeNull()
    })

    it("tells the sending lane to verify and what a mobile-web render proves", () => {
      const guidance = proactiveContentBlockGuidance("untested_delivery_claim")
      expect(guidance).toContain("Verify it yourself")
      expect(getProactiveInternalContentBlockReason(incident)).toBe("untested_delivery_claim")
      expect(guidance).toContain("mobile-web browser render")
      expect(proactiveContentBlockGuidance("heartbeat_status")).toBe("blocked: this reads as internal status (heartbeat_status), so no chat sends it; rewrite it as plain words for them")
      expect(proactiveContentBlockGuidance(null)).toBe("blocked: this reads as internal status, so no chat sends it; rewrite it as plain words for them")
      expect(isReturnToSenderReason("untested_delivery_claim")).toBe(true)
      expect(isReturnToSenderReason("heartbeat_status")).toBe(false)
    })

    it("returns a held pending message to the agent's own private runtime", async () => {
      const queuePendingMessage = vi.fn()
      vi.doMock("../../mind/pending", () => ({
        queuePendingMessage,
        getPrivateRuntimePendingDir: (agent: string) => `/root/${agent}/pending`,
        PRIVATE_RUNTIME_PENDING: { friendId: "self", channel: "inner", key: "dialog" },
      }))
      await returnHeldProactiveMessage({ agentName: "ouro", friendId: "f1", text: incident, reason: "untested_delivery_claim" })
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
