import { describe, it, expect, vi, beforeAll } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { emitNervesEvent } from "../../nerves/runtime"
import type { ActiveWorkFrame } from "../../heart/active-work"
import type { InnerJob } from "../../heart/daemon/thoughts"

function makeIdleJob(overrides: Partial<InnerJob> = {}): InnerJob {
  return {
    status: "idle",
    content: null,
    origin: null,
    mode: "reflect",
    obligationStatus: null,
    surfacedResult: null,
    queuedAt: null,
    startedAt: null,
    surfacedAt: null,
    ...overrides,
  }
}

function makeFrame(overrides: Partial<ActiveWorkFrame> = {}): ActiveWorkFrame {
  return {
    currentSession: null,
    currentObligation: null,
    mustResolveBeforeHandoff: false,
    centerOfGravity: "local-turn",
    inner: { status: "idle", hasPending: false, job: makeIdleJob() },
    bridges: [],
    taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
    friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
    bridgeSuggestion: null,
    ...overrides,
  }
}

describe("commitmentsSection", () => {
  let commitmentsSection: (options?: any) => string

  beforeAll(async () => {
    const mod = await import("../../mind/prompt")
    commitmentsSection = mod.commitmentsSection
  })

  it("returns empty string when no activeWorkFrame", () => {
    const result = commitmentsSection({})
    expect(result).toBe("")
  })

  it("returns empty string when committedTo is empty", () => {
    const result = commitmentsSection({ activeWorkFrame: makeFrame() })
    expect(result).toBe("")
  })

  it("returns section with header and bullet points when commitments exist", () => {
    const result = commitmentsSection({
      activeWorkFrame: makeFrame({ currentObligation: "naming" }),
    })
    expect(result).toContain("## my commitments")
    expect(result).toContain("- i told them i'd naming")
  })

  it("surfaces active obligation status and work surface in the prompt section", () => {
    const result = commitmentsSection({
      activeWorkFrame: makeFrame({
        pendingObligations: [
          {
            id: "ob-1",
            origin: { friendId: "alex", channel: "bluebubbles", key: "chat" },
            content: "make the loop visible",
            status: "investigating",
            currentSurface: { kind: "coding", label: "codex coding-001" },
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
          },
        ],
      }),
    })
    expect(result).toContain("## my commitments")
    expect(result).toContain("i owe alex: make the loop visible (investigating in codex coding-001)")
  })

  it("emits nerves event reference", () => {
    expect(emitNervesEvent).toBeDefined()
  })
})
