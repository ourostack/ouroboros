import { describe, it, expect, vi, beforeAll } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { emitNervesEvent } from "../../nerves/runtime"

describe("getFinalAnswerRetryError with obligation and truth checks", () => {
  let getFinalAnswerRetryError: typeof import("../../heart/core").getFinalAnswerRetryError

  beforeAll(async () => {
    const core = await import("../../heart/core")
    getFinalAnswerRetryError = core.getFinalAnswerRetryError
  })

  const SELFHOOD_INWARD_MSG = "you're reaching for a final answer, but part of you knows this needs more thought. take it inward -- go_inward will let you think privately, or send_message(self) if you just want to leave yourself a note."
  const OBLIGATION_MSG = "you're still holding something from an earlier conversation -- someone is waiting for your answer. finish the thought first, or go_inward to keep working on it privately."

  it("rejects delegate-inward with no evidence using selfhood message", () => {
    const result = getFinalAnswerRetryError(
      false,
      undefined,
      false,
      { target: "delegate-inward", reasons: ["explicit_reflection"], outwardClosureRequired: false },
      false, // sawSendMessageSelf
      false, // sawGoInward
      false, // sawQuerySession
    )
    expect(result).toBe(SELFHOOD_INWARD_MSG)
  })

  it("allows delegate-inward when sawSendMessageSelf (backward compat)", () => {
    const result = getFinalAnswerRetryError(
      false,
      undefined,
      false,
      { target: "delegate-inward", reasons: ["explicit_reflection"], outwardClosureRequired: false },
      true, // sawSendMessageSelf
      false,
      false,
    )
    // Should NOT be the selfhood message
    expect(result).not.toBe(SELFHOOD_INWARD_MSG)
  })

  it("allows delegate-inward when sawGoInward", () => {
    const result = getFinalAnswerRetryError(
      false,
      undefined,
      false,
      { target: "delegate-inward", reasons: ["explicit_reflection"], outwardClosureRequired: false },
      false,
      true, // sawGoInward
      false,
    )
    expect(result).not.toBe(SELFHOOD_INWARD_MSG)
  })

  it("allows delegate-inward when sawQuerySession", () => {
    const result = getFinalAnswerRetryError(
      false,
      undefined,
      false,
      { target: "delegate-inward", reasons: ["explicit_reflection"], outwardClosureRequired: false },
      false,
      false,
      true, // sawQuerySession
    )
    expect(result).not.toBe(SELFHOOD_INWARD_MSG)
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
    const result = getFinalAnswerRetryError(
      false,
      undefined,
      false,
      undefined, // no delegation decision
      false,
      false,
      false,
      innerJob,
    )
    expect(result).toBe(OBLIGATION_MSG)
  })

  it("allows pending obligation when sawGoInward", () => {
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
    const result = getFinalAnswerRetryError(
      false,
      undefined,
      false,
      undefined,
      false,
      true, // sawGoInward
      false,
      innerJob,
    )
    expect(result).not.toBe(OBLIGATION_MSG)
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
    const result = getFinalAnswerRetryError(
      false,
      undefined,
      false,
      undefined,
      true, // sawSendMessageSelf
      false,
      false,
      innerJob,
    )
    expect(result).not.toBe(OBLIGATION_MSG)
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
    const result = getFinalAnswerRetryError(
      false,
      undefined,
      false,
      undefined,
      false,
      false,
      false,
      innerJob,
    )
    expect(result).not.toBe(OBLIGATION_MSG)
  })

  it("does not reject when innerJob is undefined", () => {
    const result = getFinalAnswerRetryError(
      false,
      undefined,
      false,
      undefined,
      false,
      false,
      false,
      undefined,
    )
    expect(result).not.toBe(OBLIGATION_MSG)
  })

  it("existing check: mustResolveBeforeHandoff + missing intent still works", () => {
    const result = getFinalAnswerRetryError(
      true,
      undefined,
      false,
    )
    expect(result).toContain("missing required intent")
  })

  it("existing check: direct_reply without follow-up still works", () => {
    const result = getFinalAnswerRetryError(
      true,
      "direct_reply",
      false,
    )
    expect(result).toContain("direct_reply without a newer steering follow-up")
  })

  it("emits nerves event on delegation adherence rejection", () => {
    getFinalAnswerRetryError(
      false,
      undefined,
      false,
      { target: "delegate-inward", reasons: ["explicit_reflection"], outwardClosureRequired: false },
      false,
      false,
      false,
    )
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "engine.delegation_adherence_rejected",
    }))
  })
})
