import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock("child_process", () => ({ execFileSync }))

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
      expect(getProactiveInternalContentBlockReason(incident)).toBe("not_theirs_to_do")
    })

    it("holds an untested result offered as the news, with no ask", () => {
      expect(getProactiveInternalContentBlockReason("The images were re-attached. This hasn't been verified in the app yet.")).toBe("untested_delivery_claim")
      expect(getProactiveInternalContentBlockReason("The fix should now load on mobile.")).toBe("untested_delivery_claim")
    })

    it("holds other phrasings of the same ask", () => {
      expect(getProactiveInternalContentBlockReason("Please check the dashboard and let me know whether it loads.")).toBe("not_theirs_to_do")
      expect(getProactiveInternalContentBlockReason("Let me know if the page renders for you after the deploy.")).toBe("not_theirs_to_do")
    })

    it("passes a verified done with proof", () => {
      expect(getProactiveInternalContentBlockReason("Done: I verified the images load in a mobile-web browser (screenshot attached). The native app was not checked.")).toBeNull()
      expect(getProactiveInternalContentBlockReason("I tested it and the page should load for everyone now; screenshot attached.")).toBeNull()
    })

    it("passes an ask only their body can do: a phone approval, a payment, an irreversible call", () => {
      expect(getProactiveInternalContentBlockReason("Tap 47 in GitHub Mobile to approve the sign-in.")).toBeNull()
      expect(getProactiveInternalContentBlockReason("Please approve the MFA prompt on your phone and let me know when it's done.")).toBeNull()
      expect(getProactiveInternalContentBlockReason("You can now sign in to Spoonjoy with your passkey.")).toBeNull()
      expect(getProactiveInternalContentBlockReason("The flight is $412; can you pay with your card? It's held until 6pm.")).toBeNull()
      expect(getProactiveInternalContentBlockReason("Deleting the old bucket can't be undone. Do you want it gone?")).toBeNull()
      expect(getProactiveInternalContentBlockReason("Can you plug in the printer and tell me whether the light turns green?")).toBeNull()
      expect(getProactiveInternalContentBlockReason("Next I'll run `npm test` and send the result.")).toBeNull()
    })

    // Every ask that reached Ari's phone 2026-11-23..26 and wasn't his.
    const notTheirs = [
      "The lane needs you to run `gh auth login` in a terminal so it can push.",
      "Could you run gh auth login again? The push still fails.",
      "Please run `ouro up --latest` from Heeler so the daemon picks up the fix.",
      "Orca is asking \"proceed?\" in the mailbox lane. Can you press 2?",
      "Claude wants a login code. Can you paste the 6-digit code from your email?",
      "Please sign in to GitHub in Edge on ouroboros-host so the browser lane can continue.",
      "The owner needs to accept the GitHub Packages agreement in their account.",
      "Can you make the package public by hand in the GitHub settings?",
    ]

    it.each(notTheirs)("sends back an ask that isn't theirs: %s", (ask) => {
      execFileSync.mockImplementation(() => { throw new Error("not signed in") })
      expect(getProactiveInternalContentBlockReason(ask)).toBe("not_theirs_to_do")
    })

    it("drops a sign-in ask whose claim is false, checked with the claim's own status command", () => {
      execFileSync.mockReturnValue(Buffer.from(""))
      expect(getProactiveInternalContentBlockReason(notTheirs[0]!)).toBe("false_sign_in_claim")
      expect(execFileSync).toHaveBeenCalledWith("gh", ["auth", "status"], expect.objectContaining({ timeout: 10_000 }))
      expect(getProactiveInternalContentBlockReason("Can you sign in to the GitHub CLI?")).toBe("false_sign_in_claim")
      execFileSync.mockClear()
      expect(getProactiveInternalContentBlockReason(notTheirs[2]!)).toBe("not_theirs_to_do")
      expect(execFileSync).not.toHaveBeenCalled()
    })

    it("tells the sender to do it itself, and what may still reach them", () => {
      const guidance = proactiveContentBlockGuidance("not_theirs_to_do")
      expect(guidance).toContain("do it yourself; you have standing authority")
      expect(guidance).toContain("send only the number to approve")
      expect(proactiveContentBlockGuidance("false_sign_in_claim")).toContain("already done")
      expect(isReturnToSenderReason("false_sign_in_claim")).toBe(true)
    })

    it("passes a status update the person asked for, honestly marked unverified", () => {
      expect(getProactiveInternalContentBlockReason("As you asked, here's where it stands: the images are re-attached, but this is unverified in the native app.")).toBeNull()
    })

    it("tells the sending lane to verify and what a mobile-web render proves", () => {
      const guidance = proactiveContentBlockGuidance("untested_delivery_claim")
      expect(guidance).toContain("Verify it yourself")
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
      await returnHeldProactiveMessage({ agentName: "ouro", friendId: "f1", text: incident, reason: "not_theirs_to_do" })
      expect(queuePendingMessage).toHaveBeenCalledWith("/root/ouro/pending", expect.objectContaining({
        from: "ouro",
        channel: "inner",
        mode: "reflect",
        content: expect.stringContaining("do it yourself"),
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
