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

  it("renders all three sections from formatCommitments", () => {
    const result = commitmentsSection({
      activeWorkFrame: makeFrame({
        pendingObligations: [
          {
            id: "ob-naming",
            origin: { friendId: "ari", channel: "cli", key: "session" },
            content: "naming",
            status: "pending",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    })
    expect(result).toContain("## my commitments")
    expect(result).toContain("## what i'm holding right now")
    expect(result).toContain("- i owe ari: naming")
    expect(result).toContain('## what "done" looks like')
    expect(result).toContain("- fulfill my outstanding obligations")
    expect(result).toContain("## what i can let go of")
    expect(result).toContain("- no shared work to coordinate")
    expect(result).toContain("- no active tasks to track")
  })

  it("surfaces obligation with status, surface, and derived completion criteria", () => {
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
    expect(result).toContain("## what i'm holding right now")
    expect(result).toContain("i owe alex: make the loop visible (investigating in codex coding-001)")
    expect(result).toContain('## what "done" looks like')
    expect(result).toContain("- fulfill my outstanding obligations")
    expect(result).toContain("- close my active obligation loops")
    expect(result).toContain("## what i can let go of")
  })

  it("includes bridge and task commitments with their completion criteria", () => {
    const result = commitmentsSection({
      activeWorkFrame: makeFrame({
        bridges: [{ id: "b-1", summary: "align on naming", objective: "naming obj", sessions: [], createdAt: "" }] as any,
        taskPressure: { compactBoard: "", liveTaskNames: ["deploy auth service"], activeBridges: [] },
      }),
    })
    expect(result).toContain("- i have shared work: align on naming")
    expect(result).toContain("- i'm tracking: deploy auth service")
    expect(result).toContain("- keep shared work aligned across sessions")
  })

  it("includes mustResolveBeforeHandoff in holding and criteria sections", () => {
    const result = commitmentsSection({
      activeWorkFrame: makeFrame({
        currentObligation: "finish the refactor",
        mustResolveBeforeHandoff: true,
      }),
    })
    expect(result).toContain("- i need to finish what i started before moving on")
    expect(result).toContain("- resolve the current thread before moving on")
  })

  it("emits nerves event reference", () => {
    expect(emitNervesEvent).toBeDefined()
  })

  it("renders 'what i'm waiting on' when pendingAwaits is provided", () => {
    const nowMs = new Date("2026-05-10T20:30:00.000Z").getTime()
    const _ = nowMs
    const result = commitmentsSection({
      activeWorkFrame: makeFrame(),
      pendingAwaits: [
        {
          name: "hey_export",
          condition: "HEY export download visible",
          checkedCount: 2,
          lastCheckedAt: null,
          lastObservation: null,
        },
      ],
    })
    expect(result).toContain("## my commitments")
    expect(result).toContain("## what i'm waiting on")
    expect(result).toContain("- hey_export: HEY export download visible")
  })

  it("returns empty string when no commitments and pendingAwaits is empty array", () => {
    const result = commitmentsSection({
      activeWorkFrame: makeFrame(),
      pendingAwaits: [],
    })
    expect(result).toBe("")
  })
})
