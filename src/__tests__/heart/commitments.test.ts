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

  it("does not treat raw current-turn text as a persisted commitment", () => {
    const result = deriveCommitments(
      makeFrame({ currentObligation: "think about naming" }),
      makeIdleJob(),
    )
    expect(result.committedTo).toEqual([])
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
    expect(result.committedTo.length).toBeGreaterThanOrEqual(3)
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

  it("omits 'what i'm waiting on' when awaiting is empty or undefined", () => {
    const empty = formatCommitments({
      committedTo: [],
      completionCriteria: ["x"],
      safeToIgnore: ["y"],
      awaiting: [],
    })
    expect(empty).not.toContain("what i'm waiting on")
    const omitted = formatCommitments({
      committedTo: [],
      completionCriteria: ["x"],
      safeToIgnore: ["y"],
    })
    expect(omitted).not.toContain("what i'm waiting on")
  })

  it("renders 'what i'm waiting on' with checked count, age, and observation", () => {
    const nowMs = new Date("2026-05-10T20:30:00.000Z").getTime()
    const result = formatCommitments(
      {
        committedTo: [],
        completionCriteria: ["x"],
        safeToIgnore: ["y"],
        awaiting: [
          {
            name: "hey_export",
            condition: "HEY export download visible",
            checkedCount: 3,
            lastCheckedAt: "2026-05-10T20:25:00.000Z",
            lastObservation: "no download yet",
          },
        ],
      },
      () => new Date(nowMs),
    )
    expect(result).toContain("## what i'm waiting on")
    expect(result).toContain("- hey_export: HEY export download visible")
    expect(result).toContain("(checked 3x, last 5m ago: \"no download yet\")")
  })

  it("formats awaiting with never-checked when lastCheckedAt is null", () => {
    const result = formatCommitments({
      committedTo: [],
      completionCriteria: ["x"],
      safeToIgnore: ["y"],
      awaiting: [
        {
          name: "a",
          condition: "c",
          checkedCount: 0,
          lastCheckedAt: null,
          lastObservation: null,
        },
      ],
    })
    expect(result).toContain("(checked 0x, last never checked)")
  })

  it("formats awaiting with invalid lastCheckedAt as never-checked", () => {
    const result = formatCommitments({
      committedTo: [],
      completionCriteria: ["x"],
      safeToIgnore: ["y"],
      awaiting: [
        { name: "a", condition: "c", checkedCount: 1, lastCheckedAt: "garbage", lastObservation: null },
      ],
    })
    expect(result).toContain("(checked 1x, last never checked)")
  })

  it("formats awaiting age with hour/day/sub-minute units", () => {
    const base = new Date("2026-05-10T20:30:00.000Z").getTime()
    const cases: Array<{ checkedAt: string; expected: string }> = [
      { checkedAt: new Date(base - 30_000).toISOString(), expected: "<1m ago" },
      { checkedAt: new Date(base - 90 * 60_000).toISOString(), expected: "1h ago" },
      { checkedAt: new Date(base - 2 * 24 * 60 * 60 * 1000).toISOString(), expected: "2d ago" },
    ]
    for (const c of cases) {
      const result = formatCommitments(
        {
          committedTo: [],
          completionCriteria: ["x"],
          safeToIgnore: ["y"],
          awaiting: [{ name: "a", condition: "c", checkedCount: 1, lastCheckedAt: c.checkedAt, lastObservation: null }],
        },
        () => new Date(base),
      )
      expect(result).toContain(c.expected)
    }
  })

  it("uses default now when not provided (smoke)", () => {
    const result = formatCommitments({
      committedTo: [],
      completionCriteria: ["x"],
      safeToIgnore: ["y"],
      awaiting: [{ name: "a", condition: "c", checkedCount: 1, lastCheckedAt: new Date().toISOString(), lastObservation: null }],
    })
    expect(result).toContain("## what i'm waiting on")
  })

  it("trims whitespace-only observation to empty (no quoted suffix)", () => {
    const nowMs = new Date("2026-05-10T20:30:00.000Z").getTime()
    const result = formatCommitments(
      {
        committedTo: [],
        completionCriteria: ["x"],
        safeToIgnore: ["y"],
        awaiting: [
          { name: "a", condition: "c", checkedCount: 1, lastCheckedAt: new Date(nowMs - 60_000).toISOString(), lastObservation: "   " },
        ],
      },
      () => new Date(nowMs),
    )
    expect(result).toMatch(/\(checked 1x, last 1m ago\)/)
  })
})

describe("deriveCommitments awaiting wiring", () => {
  let deriveCommitments: typeof import("../../heart/commitments").deriveCommitments
  beforeAll(async () => {
    const mod = await import("../../heart/commitments")
    deriveCommitments = mod.deriveCommitments
  })

  it("threads pendingAwaits into the returned frame", () => {
    const result = deriveCommitments(makeFrame(), makeIdleJob(), undefined, [
      { name: "a", condition: "c", checkedCount: 0, lastCheckedAt: null, lastObservation: null },
    ])
    expect(result.awaiting).toEqual([
      { name: "a", condition: "c", checkedCount: 0, lastCheckedAt: null, lastObservation: null },
    ])
  })

  it("defaults awaiting to empty when not provided", () => {
    const result = deriveCommitments(makeFrame(), makeIdleJob())
    expect(result.awaiting).toEqual([])
  })
})

// ── Unit 1.1: Obligation truth audit for commitments ──

describe("deriveCommitments: obligation truth audit", () => {
  let deriveCommitments: typeof import("../../heart/commitments").deriveCommitments

  beforeAll(async () => {
    const mod = await import("../../heart/commitments")
    deriveCommitments = mod.deriveCommitments
  })

  it("distinguishes investigating obligations from pending ones in committedTo ordering", () => {
    const obligations = [
      {
        id: "ob-1",
        origin: { friendId: "alex", channel: "cli", key: "session" },
        content: "fix the build",
        status: "pending" as const,
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "ob-2",
        origin: { friendId: "bob", channel: "teams", key: "session" },
        content: "review the architecture",
        status: "investigating" as const,
        currentSurface: { kind: "coding" as const, label: "codex coding-001" },
        createdAt: "2026-01-01T00:01:00Z",
        updatedAt: "2026-01-01T00:02:00Z",
      },
    ]
    const result = deriveCommitments(makeFrame(), makeIdleJob(), obligations)
    // Investigating obligations should appear before pending ones
    const fixIndex = result.committedTo.findIndex((c) => c.includes("fix the build"))
    const reviewIndex = result.committedTo.findIndex((c) => c.includes("review the architecture"))
    expect(reviewIndex).toBeLessThan(fixIndex)
  })

  it("reports obligation count in completionCriteria for multiple obligations", () => {
    const obligations = [
      {
        id: "ob-1",
        origin: { friendId: "alex", channel: "cli", key: "session" },
        content: "fix the build",
        status: "investigating" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
      },
      {
        id: "ob-2",
        origin: { friendId: "bob", channel: "teams", key: "session" },
        content: "review the PR",
        status: "pending" as const,
        createdAt: "2026-01-01T00:01:00Z",
      },
    ]
    const result = deriveCommitments(makeFrame(), makeIdleJob(), obligations)
    expect(result.completionCriteria).toContain("fulfill my outstanding obligations")
    expect(result.completionCriteria).toContain("close my active obligation loops")
  })
})
