import { describe, it, expect, vi, beforeAll } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { emitNervesEvent } from "../../nerves/runtime"

describe("isExternalStateQuery", () => {
  let isExternalStateQuery: typeof import("../../heart/core").isExternalStateQuery

  beforeAll(async () => {
    const core = await import("../../heart/core")
    isExternalStateQuery = core.isExternalStateQuery
  })

  it("returns true for gh pr view commands", () => {
    expect(isExternalStateQuery("shell", { command: "gh pr view 157 --json state" })).toBe(true)
  })

  it("returns true for gh run view commands", () => {
    expect(isExternalStateQuery("shell", { command: "gh run view 123 --json conclusion" })).toBe(true)
  })

  it("returns true for gh api calls", () => {
    expect(isExternalStateQuery("shell", { command: "gh api repos/org/repo/pulls/1" })).toBe(true)
  })

  it("returns true for npm view commands", () => {
    expect(isExternalStateQuery("shell", { command: "npm view @ouro.bot/cli@0.1.0-alpha.92 version" })).toBe(true)
  })

  it("returns true for npm info commands", () => {
    expect(isExternalStateQuery("shell", { command: "npm info @ouro.bot/cli version" })).toBe(true)
  })

  it("returns false for non-shell tools", () => {
    expect(isExternalStateQuery("send_message", { command: "gh pr view 1" })).toBe(false)
  })

  it("returns false for shell commands without external queries", () => {
    expect(isExternalStateQuery("shell", { command: "ls -la" })).toBe(false)
  })

  it("returns false for git-only commands", () => {
    expect(isExternalStateQuery("shell", { command: "git log --oneline -5" })).toBe(false)
  })

  it("returns false when command is missing", () => {
    expect(isExternalStateQuery("shell", {})).toBe(false)
  })
})

describe("getSettleRetryError with obligation and truth checks", () => {
  let getSettleRetryError: typeof import("../../heart/core").getSettleRetryError

  beforeAll(async () => {
    const core = await import("../../heart/core")
    getSettleRetryError = core.getSettleRetryError
  })

  const SELFHOOD_INWARD_MSG = "you're reaching for a final answer, but part of you knows this needs more thought. take it inward -- ponder will let you think privately, or send_message(self) if you just want to leave yourself a note."
  const OBLIGATION_MSG = "you're still holding something from an earlier conversation -- someone is waiting for your answer. finish the thought first, or ponder to keep working on it privately."

  it("no longer rejects delegate-inward (delegation is a suggestion, not a gate)", () => {
    const result = getSettleRetryError(
      false,
      undefined,
      false,
      { target: "delegate-inward", reasons: ["explicit_reflection"], outwardClosureRequired: false },
      false, // sawSendMessageSelf
      false, // sawPonder
      false, // sawQuerySession
    )
    expect(result).toBeNull()
  })

  it("allows delegate-inward when sawSendMessageSelf (backward compat)", () => {
    const result = getSettleRetryError(
      false,
      undefined,
      false,
      { target: "delegate-inward", reasons: ["explicit_reflection"], outwardClosureRequired: false },
      true, // sawSendMessageSelf
      false,
      false,
    )
    expect(result).toBeNull()
  })

  it("allows delegate-inward when sawPonder", () => {
    const result = getSettleRetryError(
      false,
      undefined,
      false,
      { target: "delegate-inward", reasons: ["explicit_reflection"], outwardClosureRequired: false },
      false,
      true, // sawPonder
      false,
    )
    expect(result).toBeNull()
  })

  it("allows delegate-inward when sawQuerySession", () => {
    const result = getSettleRetryError(
      false,
      undefined,
      false,
      { target: "delegate-inward", reasons: ["explicit_reflection"], outwardClosureRequired: false },
      false,
      false,
      true, // sawQuerySession
    )
    expect(result).toBeNull()
  })

  it("rejects pending obligation with no evidence", () => {
    const innerJob = {
      status: "queued" as const,
      content: null,
      origin: null,
      mode: "reflect" as const,
      obligationStatus: "pending" as const,
      surfacedResult: null,
      queuedAt: null,
      startedAt: null,
      surfacedAt: null,
    }
    const result = getSettleRetryError(
      false,
      undefined,
      false,
      undefined, // no delegation decision
      false,
      false,
      false,
      undefined,
      innerJob,
    )
    expect(result).toBe(OBLIGATION_MSG)
  })

  it("allows pending obligation when sawPonder", () => {
    const innerJob = {
      status: "queued" as const,
      content: null,
      origin: null,
      mode: "reflect" as const,
      obligationStatus: "pending" as const,
      surfacedResult: null,
      queuedAt: null,
      startedAt: null,
      surfacedAt: null,
    }
    const result = getSettleRetryError(
      false,
      undefined,
      false,
      undefined,
      false,
      true, // sawPonder
      false,
      undefined,
      innerJob,
    )
    expect(result).toBeNull()
  })

  it("allows pending obligation when sawSendMessageSelf", () => {
    const innerJob = {
      status: "queued" as const,
      content: null,
      origin: null,
      mode: "reflect" as const,
      obligationStatus: "pending" as const,
      surfacedResult: null,
      queuedAt: null,
      startedAt: null,
      surfacedAt: null,
    }
    const result = getSettleRetryError(
      false,
      undefined,
      false,
      undefined,
      true, // sawSendMessageSelf
      false,
      false,
      undefined,
      innerJob,
    )
    expect(result).toBeNull()
  })

  it("does not reject when obligation is fulfilled", () => {
    const innerJob = {
      status: "surfaced" as const,
      content: null,
      origin: null,
      mode: "reflect" as const,
      obligationStatus: "fulfilled" as const,
      surfacedResult: null,
      queuedAt: null,
      startedAt: null,
      surfacedAt: null,
    }
    const result = getSettleRetryError(
      false,
      undefined,
      false,
      undefined,
      false,
      false,
      false,
      undefined,
      innerJob,
    )
    expect(result).toBeNull()
  })

  it("does not reject when innerJob is undefined", () => {
    const result = getSettleRetryError(
      false,
      undefined,
      false,
      undefined,
      false,
      false,
      false,
      undefined,
      undefined,
    )
    expect(result).toBeNull()
  })

  it("rejects complete intent when a live return obligation is still active without newer follow-up", () => {
    const result = getSettleRetryError(
      true,
      "complete",
      false,
      undefined,
      false,
      false,
      false,
      "bring the external-state update back here",
      undefined,
    )
    expect(result).toContain("you still owe the live session a visible return")
  })

  it("allows complete intent after newer steering follow-up on the same obligation", () => {
    const result = getSettleRetryError(
      true,
      "complete",
      true,
      undefined,
      false,
      false,
      false,
      "bring the external-state update back here",
      undefined,
    )
    expect(result).toBeNull()
  })

  it("existing check: mustResolveBeforeHandoff + missing intent still works", () => {
    const result = getSettleRetryError(
      true,
      undefined,
      false,
    )
    expect(result).toContain("missing required intent")
  })

  it("existing check: direct_reply without follow-up still works", () => {
    const result = getSettleRetryError(
      true,
      "direct_reply",
      false,
    )
    expect(result).toContain("direct_reply without a newer steering follow-up")
  })

  it("does not emit nerves event since delegation adherence is removed", () => {
    getSettleRetryError(
      false,
      undefined,
      false,
      { target: "delegate-inward", reasons: ["explicit_reflection"], outwardClosureRequired: false },
      false,
      false,
      false,
    )
    expect(emitNervesEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      event: "engine.delegation_adherence_rejected",
    }))
  })
})

describe("external state grounding check", () => {
  let getSettleRetryError: typeof import("../../heart/core").getSettleRetryError

  beforeAll(async () => {
    const core = await import("../../heart/core")
    getSettleRetryError = core.getSettleRetryError
  })

  // Regression: 2026-05-08 06:18 BlueBubbles incident. `currentObligation`
  // is set mechanically from the inbound user text in the senses pipeline, so
  // an ordinary chat turn ("hey, can you grab milk?") would land here with
  // `currentObligation` truthy. The old grounding check then rejected the
  // settle and forced the agent into a retry loop where each pass delivered
  // another near-identical iMessage. The grounding check now only fires when
  // the agent is in a "must resolve before handoff" external-state loop —
  // ordinary inbound chat does not require `gh pr view`.
  it("does not reject complete on an ordinary inbound chat turn (06:18 regression)", () => {
    const result = getSettleRetryError(
      false,        // mustResolveBeforeHandoff — ordinary inbound, no continuity clause
      "complete",
      false,        // sawSteeringFollowUp
      undefined,
      false,
      false,
      false,
      "what's the plan for tonight?", // currentObligation = raw inbound text
      undefined,
      false,        // sawExternalStateQuery
    )
    expect(result).toBeNull()
  })

  it("allows complete when currentObligation exists and external state was verified", () => {
    const result = getSettleRetryError(
      false,
      "complete",
      false,
      undefined,
      false,
      false,
      false,
      "merge the PR and publish",
      undefined,
      true,         // sawExternalStateQuery
    )
    expect(result).toBeNull()
  })

  it("allows complete when steering follow-up provides external grounding", () => {
    const result = getSettleRetryError(
      false,
      "complete",
      true,         // sawSteeringFollowUp — counts as external grounding
      undefined,
      false,
      false,
      false,
      "merge the PR and publish",
      undefined,
      false,        // no sawExternalStateQuery needed
    )
    expect(result).toBeNull()
  })

  it("does not require external verification when there is no currentObligation", () => {
    const result = getSettleRetryError(
      false,
      "complete",
      false,
      undefined,
      false,
      false,
      false,
      null,         // no currentObligation
      undefined,
      false,        // no external verification
    )
    expect(result).toBeNull()
  })

  it("does not require external verification for non-complete intents", () => {
    const result = getSettleRetryError(
      false,
      "blocked",
      false,
      undefined,
      false,
      false,
      false,
      "merge the PR and publish",
      undefined,
      false,
    )
    expect(result).toBeNull()
  })

  it("return-loop check fires before grounding check when mustResolve and no steering follow-up", () => {
    const result = getSettleRetryError(
      true,
      "complete",
      false,        // no steering follow-up
      undefined,
      false,
      false,
      false,
      "merge the PR and publish",
      undefined,
      false,        // no external verification
    )
    // Check #5 (return-loop) fires first since mustResolve + !steering
    expect(result).toContain("you still owe the live session")
  })
})
