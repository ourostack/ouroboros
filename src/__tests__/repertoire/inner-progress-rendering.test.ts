import { describe, it, expect, vi, beforeAll } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { emitNervesEvent } from "../../nerves/runtime"
import type { InnerDialogStatus } from "../../heart/daemon/thoughts"

describe("renderInnerProgressStatus (selfhood framing)", () => {
  let renderInnerProgressStatus: (status: InnerDialogStatus) => string

  beforeAll(async () => {
    const mod = await import("../../repertoire/tools-base")
    renderInnerProgressStatus = mod.renderInnerProgressStatus
  })

  it("returns queued message for pending processing", () => {
    const result = renderInnerProgressStatus({
      queue: "queued to inner/dialog",
      wake: "awaiting inner session",
      processing: "pending",
      surfaced: "nothing yet",
    })
    expect(result).toContain("queued this thought for private attention")
  })

  it("returns working message for started processing", () => {
    const result = renderInnerProgressStatus({
      queue: "clear",
      wake: "in progress",
      processing: "started",
      surfaced: "nothing yet",
    })
    expect(result).toContain("working through this privately right now")
  })

  it("returns completed with surfaced value", () => {
    const result = renderInnerProgressStatus({
      queue: "clear",
      wake: "completed",
      processing: "processed",
      surfaced: '"naming should be consistent"',
    })
    expect(result).toContain("thought about this privately and came to something")
    expect(result).toContain("naming should be consistent")
  })

  it("returns completed generic when no surfaced value", () => {
    const result = renderInnerProgressStatus({
      queue: "clear",
      wake: "completed",
      processing: "processed",
      surfaced: "nothing recent",
    })
    expect(result).toContain("thought about this privately")
    expect(result).toContain("bring it back when the time is right")
  })

  it("emits nerves event reference", () => {
    expect(emitNervesEvent).toBeDefined()
  })
})

describe("delegationHintSection (selfhood framing)", () => {
  let delegationHintSection: (options?: any) => string

  beforeAll(async () => {
    const mod = await import("../../mind/prompt")
    delegationHintSection = (mod as any).delegationHintSection
  })

  it("returns empty string when no delegation decision", () => {
    const result = delegationHintSection({})
    expect(result).toBe("")
  })

  it("returns empty string for fast-path target", () => {
    const result = delegationHintSection({
      delegationDecision: { target: "fast-path", reasons: [], outwardClosureRequired: false },
    })
    expect(result).toBe("")
  })

  it("returns empty string when there are no surviving reasons", () => {
    const result = delegationHintSection({
      delegationDecision: { target: "delegate-inward", reasons: [], outwardClosureRequired: false },
    })
    expect(result).toBe("")
  })

  it("returns prose for delegate-inward with single reason", () => {
    const result = delegationHintSection({
      delegationDecision: {
        target: "delegate-inward",
        reasons: ["explicit_reflection"],
        outwardClosureRequired: false,
      },
    })
    expect(result).toContain("## what i'm sensing about this conversation")
    expect(result).toContain("Something here calls for reflection")
  })

  it("returns joined prose for multiple reasons", () => {
    const result = delegationHintSection({
      delegationDecision: {
        target: "delegate-inward",
        reasons: ["explicit_reflection", "cross_session"],
        outwardClosureRequired: false,
      },
    })
    expect(result).toContain("Something here calls for reflection")
    expect(result).toContain("This touches other conversations")
  })

  it("appends closure line when outward closure required", () => {
    const result = delegationHintSection({
      delegationDecision: {
        target: "delegate-inward",
        reasons: ["explicit_reflection"],
        outwardClosureRequired: true,
      },
    })
    expect(result).toContain("say something outward before going inward")
  })

  it("omits closure line when outward closure not required", () => {
    const result = delegationHintSection({
      delegationDecision: {
        target: "delegate-inward",
        reasons: ["explicit_reflection"],
        outwardClosureRequired: false,
      },
    })
    expect(result).not.toContain("say something outward")
  })

  it("emits nerves event reference", () => {
    expect(emitNervesEvent).toBeDefined()
  })
})
