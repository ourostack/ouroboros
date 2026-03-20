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

describe("deriveCommitments", () => {
  let deriveCommitments: typeof import("../../heart/commitments").deriveCommitments

  beforeAll(async () => {
    const mod = await import("../../heart/commitments")
    deriveCommitments = mod.deriveCommitments
  })

  it("returns empty committedTo for minimal frame", () => {
    const result = deriveCommitments(makeFrame(), makeIdleJob())
    expect(result.committedTo).toEqual([])
    expect(result.completionCriteria).toEqual(["just be present in this conversation"])
    expect(result.safeToIgnore).toContain("no private thinking in progress")
    expect(result.safeToIgnore).toContain("no shared work to coordinate")
    expect(result.safeToIgnore).toContain("no active tasks to track")
  })

  it("includes obligation in committedTo", () => {
    const result = deriveCommitments(
      makeFrame({ currentObligation: "think about naming" }),
      makeIdleJob(),
    )
    expect(result.committedTo).toContain("i told them i'd think about naming")
  })

  it("includes running inner job in committedTo", () => {
    const result = deriveCommitments(
      makeFrame(),
      makeIdleJob({ status: "running", content: "naming conventions" }),
    )
    expect(result.committedTo).toContain("i'm thinking through something privately -- naming conventions")
  })

  it("includes surfaced inner job in committedTo", () => {
    const result = deriveCommitments(
      makeFrame(),
      makeIdleJob({ status: "surfaced" }),
    )
    expect(result.committedTo).toContain("i finished thinking about something and need to bring it back")
  })

  it("includes mustResolveBeforeHandoff in committedTo and completionCriteria", () => {
    const result = deriveCommitments(
      makeFrame({ mustResolveBeforeHandoff: true }),
      makeIdleJob(),
    )
    expect(result.committedTo).toContain("i need to finish what i started before moving on")
    expect(result.completionCriteria).toContain("resolve the current thread before moving on")
  })

  it("includes bridges in committedTo", () => {
    const result = deriveCommitments(
      makeFrame({
        bridges: [{
          id: "bridge-1",
          objective: "keep aligned",
          summary: "same work",
          lifecycle: "active",
          runtime: "idle",
          createdAt: "",
          updatedAt: "",
          attachedSessions: [],
        }],
      }),
      makeIdleJob(),
    )
    expect(result.committedTo).toContain("i have shared work: same work")
    expect(result.completionCriteria).toContain("keep shared work aligned across sessions")
  })

  it("includes live tasks in committedTo", () => {
    const result = deriveCommitments(
      makeFrame({ taskPressure: { compactBoard: "", liveTaskNames: ["daily-standup"], activeBridges: [] } }),
      makeIdleJob(),
    )
    expect(result.committedTo).toContain("i'm tracking: daily-standup")
  })

  it("includes pending obligation in completionCriteria with origin name", () => {
    const result = deriveCommitments(
      makeFrame(),
      makeIdleJob({ obligationStatus: "pending", origin: { friendId: "alex", channel: "teams", key: "s1", friendName: "Alex" } }),
    )
    expect(result.completionCriteria).toContain("bring my answer back to Alex")
  })

  it("combined: all entries present", () => {
    const result = deriveCommitments(
      makeFrame({
        currentObligation: "naming",
        mustResolveBeforeHandoff: true,
        bridges: [{
          id: "b1",
          objective: "aligned",
          summary: "shared",
          lifecycle: "active",
          runtime: "idle",
          createdAt: "",
          updatedAt: "",
          attachedSessions: [],
        }],
        taskPressure: { compactBoard: "", liveTaskNames: ["task-1"], activeBridges: [] },
      }),
      makeIdleJob({ status: "running", content: "thinking" }),
    )
    expect(result.committedTo.length).toBeGreaterThanOrEqual(4)
    expect(result.completionCriteria.length).toBeGreaterThanOrEqual(2)
  })

  it("running inner job without content omits content suffix", () => {
    const result = deriveCommitments(makeFrame(), makeIdleJob({ status: "running", content: null }))
    const entry = result.committedTo.find(c => c.includes("thinking through"))
    expect(entry).toBe("i'm thinking through something privately")
  })

  it("bridge without summary uses objective", () => {
    const result = deriveCommitments(
      makeFrame({
        bridges: [{
          id: "b1", objective: "the-objective", summary: "", lifecycle: "active", runtime: "idle",
          createdAt: "", updatedAt: "", attachedSessions: [],
        }],
      }),
      makeIdleJob(),
    )
    expect(result.committedTo).toContain("i have shared work: the-objective")
  })

  it("pending obligation with friendId only (no friendName)", () => {
    const result = deriveCommitments(
      makeFrame(),
      makeIdleJob({ obligationStatus: "pending", origin: { friendId: "uuid-123", channel: "cli", key: "s1" } }),
    )
    expect(result.completionCriteria).toContain("bring my answer back to uuid-123")
  })

  it("pending obligation with no origin at all", () => {
    const result = deriveCommitments(
      makeFrame(),
      makeIdleJob({ obligationStatus: "pending", origin: null }),
    )
    expect(result.completionCriteria).toContain("bring my answer back to them")
  })

  it("no taskPressure property uses empty fallback", () => {
    const frame = makeFrame()
    delete (frame as any).taskPressure
    const result = deriveCommitments(frame, makeIdleJob())
    expect(result.safeToIgnore).toContain("no active tasks to track")
  })

  it("emits nerves event reference", () => {
    expect(emitNervesEvent).toBeDefined()
  })

  it("includes persistent obligations in committedTo", () => {
    const obligations = [
      {
        id: "ob-1",
        origin: { friendId: "alex", channel: "cli", key: "session" },
        content: "think about naming conventions",
        status: "pending" as const,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]
    const result = deriveCommitments(makeFrame(), makeIdleJob(), obligations)
    expect(result.committedTo).toContain("i owe alex: think about naming conventions")
    expect(result.completionCriteria).toContain("fulfill my outstanding obligations")
  })

  it("includes multiple persistent obligations in committedTo", () => {
    const obligations = [
      {
        id: "ob-1",
        origin: { friendId: "alex", channel: "cli", key: "session" },
        content: "naming conventions",
        status: "pending" as const,
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "ob-2",
        origin: { friendId: "bob", channel: "teams", key: "session" },
        content: "architecture review",
        status: "pending" as const,
        createdAt: "2026-01-01T00:01:00Z",
      },
    ]
    const result = deriveCommitments(makeFrame(), makeIdleJob(), obligations)
    expect(result.committedTo).toContain("i owe alex: naming conventions")
    expect(result.committedTo).toContain("i owe bob: architecture review")
  })

  it("includes active obligation status and work surface in committedTo", () => {
    const obligations = [
      {
        id: "ob-1",
        origin: { friendId: "alex", channel: "cli", key: "session" },
        content: "visible ooda loop",
        status: "investigating" as const,
        currentSurface: { kind: "coding", label: "codex coding-001" },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
      },
    ]
    const result = deriveCommitments(makeFrame(), makeIdleJob(), obligations)
    expect(result.committedTo).toContain("i owe alex: visible ooda loop (investigating in codex coding-001)")
    expect(result.completionCriteria).toContain("close my active obligation loops")
  })

  it("includes advanced obligation status even when no work surface is known", () => {
    const obligations = [
      {
        id: "ob-1",
        origin: { friendId: "alex", channel: "cli", key: "session" },
        content: "land the visible fix",
        status: "waiting_for_merge" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
      },
    ]
    const result = deriveCommitments(makeFrame(), makeIdleJob(), obligations)
    expect(result.committedTo).toContain("i owe alex: land the visible fix (waiting for merge)")
  })

  it("skips fulfilled persistent obligations", () => {
    const obligations = [
      {
        id: "ob-1",
        origin: { friendId: "alex", channel: "cli", key: "session" },
        content: "already closed",
        status: "fulfilled" as const,
        createdAt: "2026-01-01T00:00:00Z",
        fulfilledAt: "2026-01-01T00:01:00Z",
      },
    ]
    const result = deriveCommitments(makeFrame(), makeIdleJob(), obligations)
    expect(result.committedTo).toEqual([])
    expect(result.completionCriteria).toEqual(["fulfill my outstanding obligations"])
  })

  it("omits obligation section when pendingObligations is empty", () => {
    const result = deriveCommitments(makeFrame(), makeIdleJob(), [])
    expect(result.committedTo).not.toContainEqual(expect.stringContaining("i owe"))
    expect(result.completionCriteria).not.toContain("fulfill my outstanding obligations")
  })

  it("omits obligation section when pendingObligations is undefined", () => {
    const result = deriveCommitments(makeFrame(), makeIdleJob())
    expect(result.committedTo).not.toContainEqual(expect.stringContaining("i owe"))
    expect(result.completionCriteria).not.toContain("fulfill my outstanding obligations")
  })
})

describe("formatCommitments", () => {
  let formatCommitments: typeof import("../../heart/commitments").formatCommitments

  beforeAll(async () => {
    const mod = await import("../../heart/commitments")
    formatCommitments = mod.formatCommitments
  })

  it("formats non-empty committedTo with headers", () => {
    const result = formatCommitments({
      committedTo: ["i told them i'd think about naming"],
      completionCriteria: ["resolve the current thread"],
      safeToIgnore: ["no active tasks to track"],
    })
    expect(result).toContain("## what i'm holding right now")
    expect(result).toContain("- i told them i'd think about naming")
    expect(result).toContain("## what \"done\" looks like")
    expect(result).toContain("## what i can let go of")
  })

  it("formats empty committedTo with free-to-be-present message", () => {
    const result = formatCommitments({
      committedTo: [],
      completionCriteria: ["just be present"],
      safeToIgnore: ["no private thinking"],
    })
    expect(result).toContain("free to be present")
    expect(result).not.toContain("## what i'm holding right now")
    expect(result).toContain("## what \"done\" looks like")
  })
})
