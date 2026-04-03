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
    currentSession: { friendId: "friend-1", channel: "cli" as any, key: "session", sessionPath: "/tmp/s.json" },
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

describe("formatActiveWorkFrame (selfhood framing)", () => {
  let formatActiveWorkFrame: (frame: ActiveWorkFrame) => string
  let formatLiveWorldStateCheckpoint: (frame: ActiveWorkFrame) => string

  beforeAll(async () => {
    const mod = await import("../../heart/active-work")
    formatActiveWorkFrame = mod.formatActiveWorkFrame
    formatLiveWorldStateCheckpoint = mod.formatLiveWorldStateCheckpoint
  })

  it("renders minimal frame with session line only", () => {
    const result = formatActiveWorkFrame(makeFrame())
    expect(result).toContain("## what i'm holding")
    expect(result).toContain("this is my top-level live world-state right now.")
    expect(result).toContain("if older checkpoints elsewhere in the transcript disagree with this picture, this picture wins.")
    expect(result).toContain("i'm in a conversation on cli/session.")
    expect(result).not.toContain("i still owe")
  })

  it("renders obligation appended to session line", () => {
    const result = formatActiveWorkFrame(makeFrame({
      pendingObligations: [
        {
          id: "ob-session",
          origin: { friendId: "friend-1", channel: "cli", key: "session" },
          content: "think about naming",
          status: "investigating",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:01:00Z",
        },
      ],
    }))
    expect(result).toContain("i still owe them: think about naming.")
  })

  it("renders running inner job with origin and obligation", () => {
    const result = formatActiveWorkFrame(makeFrame({
      inner: {
        status: "running",
        hasPending: false,
        origin: { friendId: "alex", channel: "teams", key: "session1" },
        contentSnippet: "naming conventions",
        obligationPending: true,
        job: makeIdleJob({
          status: "running",
          origin: { friendId: "alex", channel: "teams", key: "session1", friendName: "Alex" },
          obligationStatus: "pending",
        }),
      },
    }))
    expect(result).toContain("thinking through something privately")
    expect(result).toContain("Alex asked about something")
    expect(result).toContain("i still owe them an answer")
  })

  it("renders running inner job without origin", () => {
    const result = formatActiveWorkFrame(makeFrame({
      inner: {
        status: "running",
        hasPending: false,
        job: makeIdleJob({
          status: "running",
          origin: null,
        }),
      },
    }))
    expect(result).toContain("thinking through something privately right now.")
    expect(result).not.toContain("asked about something")
  })

  it("renders surfaced inner job without surfacedResult", () => {
    const result = formatActiveWorkFrame(makeFrame({
      inner: {
        status: "idle",
        hasPending: false,
        job: makeIdleJob({
          status: "surfaced",
          surfacedResult: null,
        }),
      },
    }))
    expect(result).toContain("finished thinking about something privately")
    expect(result).not.toContain("what i came to:")
  })

  it("renders queued inner job without content snippet", () => {
    const result = formatActiveWorkFrame(makeFrame({
      inner: {
        status: "idle",
        hasPending: true,
        job: makeIdleJob({ status: "queued" }),
      },
    }))
    expect(result).toContain("thought queued up for private attention")
    expect(result).not.toContain("it's about:")
  })

  it("renders surfaced inner job with long surfacedResult (truncated)", () => {
    const longResult = "a".repeat(150)
    const result = formatActiveWorkFrame(makeFrame({
      inner: {
        status: "idle",
        hasPending: false,
        job: makeIdleJob({
          status: "surfaced",
          surfacedResult: longResult,
        }),
      },
    }))
    expect(result).toContain("what i came to:")
    expect(result).toContain("...")
    expect(result).not.toContain(longResult)
  })

  it("renders queued inner job with content snippet", () => {
    const result = formatActiveWorkFrame(makeFrame({
      inner: {
        status: "idle",
        hasPending: true,
        contentSnippet: "naming conventions",
        job: makeIdleJob({
          status: "queued",
          content: "naming conventions",
        }),
      },
    }))
    expect(result).toContain("thought queued up for private attention")
    expect(result).toContain('it\'s about: "naming conventions"')
  })

  it("renders surfaced inner job", () => {
    const result = formatActiveWorkFrame(makeFrame({
      inner: {
        status: "idle",
        hasPending: false,
        job: makeIdleJob({
          status: "surfaced",
          surfacedResult: "naming should be consistent across modules",
        }),
      },
    }))
    expect(result).toContain("finished thinking about something privately")
    expect(result).toContain("bring my answer back")
    expect(result).toContain("what i came to:")
  })

  it("renders bridges", () => {
    const result = formatActiveWorkFrame(makeFrame({
      bridges: [{
        id: "bridge-1",
        objective: "keep aligned",
        summary: "same work",
        lifecycle: "active",
        runtime: "idle",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        attachedSessions: [],
      }],
    }))
    expect(result).toContain("shared work spanning sessions")
    expect(result).toContain("bridge-1")
  })

  it("renders bridge suggestion begin-new", () => {
    const result = formatActiveWorkFrame(makeFrame({
      bridgeSuggestion: {
        kind: "begin-new",
        targetSession: {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/s.json",
          snapshot: "",
          trust: { level: "friend", basis: "direct", summary: "", why: "", permits: [], constraints: [] },
          delivery: { mode: "direct", reason: "" },
          lastActivityAt: "",
          lastActivityMs: 0,
          activitySource: "friend-facing",
        },
        objectiveHint: "keep aligned",
        reason: "shared-work-candidate",
      },
    }))
    expect(result).toContain("should connect these threads")
  })

  it("renders bridge suggestion attach-existing", () => {
    const result = formatActiveWorkFrame(makeFrame({
      bridgeSuggestion: {
        kind: "attach-existing",
        bridgeId: "bridge-1",
        targetSession: {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/s.json",
          snapshot: "",
          trust: { level: "friend", basis: "direct", summary: "", why: "", permits: [], constraints: [] },
          delivery: { mode: "direct", reason: "" },
          lastActivityAt: "",
          lastActivityMs: 0,
          activitySource: "friend-facing",
        },
        reason: "shared-work-candidate",
      },
    }))
    expect(result).toContain("relates to bridge bridge-1")
  })

  it("renders live tasks", () => {
    const result = formatActiveWorkFrame(makeFrame({
      taskPressure: { compactBoard: "", liveTaskNames: ["shared-relay", "daily-standup"], activeBridges: [] },
    }))
    expect(result).toContain("also tracking: shared-relay, daily-standup")
  })

  it("renders 'not in a conversation' when no currentSession", () => {
    const result = formatActiveWorkFrame(makeFrame({
      currentSession: null,
    }))
    expect(result).toContain("not in a conversation right now")
  })

  it("renders a compact live world-state checkpoint with fallbacks when no current session is active", () => {
    const result = formatLiveWorldStateCheckpoint(makeFrame({
      currentSession: null,
    }))
    expect(result).toContain("## live world-state")
    expect(result).toContain("- live conversation: not in a live conversation")
    expect(result).toContain("- active lane: no explicit live lane")
    expect(result).toContain("- current artifact: no artifact yet")
    expect(result).toContain("- next action: continue from the live world-state")
    expect(result).not.toContain("other active sessions:")
  })

  it("renders other active sessions in the compact live world-state checkpoint", () => {
    const result = formatLiveWorldStateCheckpoint(makeFrame({
      friendActivity: {
        freshestForCurrentFriend: null,
        otherLiveSessionsForCurrentFriend: [],
        allOtherLiveSessions: [
          {
            friendId: "friend-1",
            friendName: "Ari",
            channel: "bluebubbles",
            key: "chat:any;-;ari@mendelow.me",
            sessionPath: "/tmp/ari-bb.json",
            lastActivityAt: "2026-03-21T09:00:00.000Z",
            lastActivityMs: Date.parse("2026-03-21T09:00:00.000Z"),
            activitySource: "friend-facing",
          },
        ],
      } as any,
    }))
    expect(result).toContain("other active sessions:")
    expect(result).toContain("Ari/bluebubbles/chat:any;-;ari@mendelow.me")
  })

  it("keeps the compact checkpoint aligned with the full active-work render for live coding state", () => {
    const frame = makeFrame({
      centerOfGravity: "inward-work",
      currentSession: {
        friendId: "friend-1",
        channel: "teams" as any,
        key: "thread-9",
        sessionPath: "/tmp/teams-thread-9.json",
      },
      currentObligation: "bring the patch back here",
      mustResolveBeforeHandoff: true,
      codingSessions: [
        {
          id: "coding-101",
          runner: "codex",
          workdir: "/tmp/workspaces/ouroboros",
          taskRef: "task-101",
          checkpoint: "tightening the active-work trust pass",
          artifactPath: "/tmp/artifacts/coding-101.md",
          status: "running",
          stdoutTail: "working",
          stderrTail: "",
          pid: 101,
          startedAt: "2026-03-21T10:00:00.000Z",
          lastActivityAt: "2026-03-21T10:05:00.000Z",
          endedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastSignal: null,
          failure: null,
          originSession: { friendId: "friend-1", channel: "teams", key: "thread-9" },
        },
      ],
    } as ActiveWorkFrame)

    const full = formatActiveWorkFrame(frame)
    const checkpoint = formatLiveWorldStateCheckpoint(frame)

    expect(full).toContain("- live conversation: teams/thread-9")
    expect(full).toContain("- active lane: codex coding-101 for this thread")
    expect(full).toContain("- current artifact: /tmp/artifacts/coding-101.md")
    expect(full).toContain("- next action: finish the coding pass and bring the result back here")

    expect(checkpoint).toContain("- live conversation: teams/thread-9")
    expect(checkpoint).toContain("- active lane: codex coding-101 for this thread")
    expect(checkpoint).toContain("- current artifact: /tmp/artifacts/coding-101.md")
    expect(checkpoint).toContain("- next action: finish the coding pass and bring the result back here")
  })

  it("emits nerves event reference", () => {
    expect(emitNervesEvent).toBeDefined()
  })
})

// ── Unit 1.2: Resume handle contract ──

describe("resume handle contract", () => {
  let buildActiveWorkFrame: typeof import("../../heart/active-work").buildActiveWorkFrame
  let formatActiveWorkFrame: typeof import("../../heart/active-work").formatActiveWorkFrame
  let formatLiveWorldStateCheckpoint: typeof import("../../heart/active-work").formatLiveWorldStateCheckpoint

  beforeAll(async () => {
    const mod = await import("../../heart/active-work")
    buildActiveWorkFrame = mod.buildActiveWorkFrame
    formatActiveWorkFrame = mod.formatActiveWorkFrame
    formatLiveWorldStateCheckpoint = mod.formatLiveWorldStateCheckpoint
  })

  function recentIso(minutesAgo: number): string {
    return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString()
  }

  it("produces a resume handle with all fields for a full active work state", () => {
    const frame = buildActiveWorkFrame({
      currentSession: { friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/s.json" },
      mustResolveBeforeHandoff: true,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      codingSessions: [{
        id: "coding-001",
        runner: "codex",
        status: "running",
        startedAt: recentIso(15),
        originSession: { friendId: "friend-1", channel: "cli", key: "session" },
        artifactPath: "/tmp/pr-789",
        checkpoint: "tests passing, awaiting review",
        lastActivityAt: recentIso(2),
        failure: null,
      }],
      taskBoard: {
        compact: "",
        activeBridges: [],
        byStatus: { drafting: [], processing: [], validating: [], collaborating: [], paused: [], blocked: [], done: [], cancelled: [] },
      },
      friendActivity: [],
      pendingObligations: [{
        id: "ob-1",
        origin: { friendId: "friend-1", channel: "cli", key: "session" },
        content: "fix the build system",
        status: "investigating",
        createdAt: recentIso(20),
        updatedAt: recentIso(5),
        currentArtifact: "/tmp/pr-789",
        nextAction: "review PR and merge",
        currentSurface: { kind: "coding", label: "codex coding-001" },
      }],
    })

    expect(frame.resumeHandle).toBeDefined()
    expect(frame.resumeHandle?.sessionLabel).toBe("cli/session")
    expect(frame.resumeHandle?.lane).toContain("codex coding-001")
    expect(frame.resumeHandle?.artifact).toBe("/tmp/pr-789")
    expect(frame.resumeHandle?.nextAction).toBe("review PR and merge")
    expect(frame.resumeHandle?.confidence).toBeDefined()
    // Coding identity hook should be populated from coding session
    expect(frame.resumeHandle?.codingIdentity).toBeDefined()
  })

  it("produces an empty resume handle for a minimal idle frame", () => {
    const frame = buildActiveWorkFrame({
      currentSession: { friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/s.json" },
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      taskBoard: {
        compact: "",
        activeBridges: [],
        byStatus: { drafting: [], processing: [], validating: [], collaborating: [], paused: [], blocked: [], done: [], cancelled: [] },
      },
      friendActivity: [],
    })

    // For idle state, resumeHandle should still exist but with null/empty fields
    expect(frame.resumeHandle).toBeDefined()
    expect(frame.resumeHandle?.sessionLabel).toBe("cli/session")
    expect(frame.resumeHandle?.lane).toBeNull()
    expect(frame.resumeHandle?.artifact).toBeNull()
    expect(frame.resumeHandle?.nextAction).toBeNull()
  })

  it("produces a partial resume handle when only obligation exists without coding", () => {
    const frame = buildActiveWorkFrame({
      currentSession: { friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/s.json" },
      mustResolveBeforeHandoff: true,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      taskBoard: {
        compact: "",
        activeBridges: [],
        byStatus: { drafting: [], processing: [], validating: [], collaborating: [], paused: [], blocked: [], done: [], cancelled: [] },
      },
      friendActivity: [],
      pendingObligations: [{
        id: "ob-1",
        origin: { friendId: "friend-1", channel: "cli", key: "session" },
        content: "review the design doc",
        status: "pending",
        createdAt: recentIso(10),
        updatedAt: recentIso(10),
      }],
    })

    expect(frame.resumeHandle).toBeDefined()
    expect(frame.resumeHandle?.sessionLabel).toBe("cli/session")
    expect(frame.resumeHandle?.lane).toBeNull()
    expect(frame.resumeHandle?.codingIdentity).toBeNull()
    // nextAction should derive from the obligation content
    expect(frame.resumeHandle?.nextAction).toBeDefined()
  })

  it("renders resume handle fields in formatted active work output", () => {
    const frame = buildActiveWorkFrame({
      currentSession: { friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/s.json" },
      mustResolveBeforeHandoff: true,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      codingSessions: [{
        id: "coding-001",
        runner: "codex",
        status: "running",
        startedAt: recentIso(15),
        originSession: { friendId: "friend-1", channel: "cli", key: "session" },
        artifactPath: "/tmp/pr-789",
        checkpoint: "tests passing",
        lastActivityAt: recentIso(2),
        failure: null,
      }],
      taskBoard: {
        compact: "",
        activeBridges: [],
        byStatus: { drafting: [], processing: [], validating: [], collaborating: [], paused: [], blocked: [], done: [], cancelled: [] },
      },
      friendActivity: [],
      pendingObligations: [{
        id: "ob-1",
        origin: { friendId: "friend-1", channel: "cli", key: "session" },
        content: "fix the build",
        status: "investigating",
        createdAt: recentIso(20),
        updatedAt: recentIso(5),
        currentArtifact: "/tmp/pr-789",
        nextAction: "review PR and merge",
        currentSurface: { kind: "coding", label: "codex coding-001" },
      }],
    })

    const formatted = formatActiveWorkFrame(frame)
    // The resume handle fields should appear in the concrete state section
    expect(formatted).toContain("## current concrete state")
    expect(formatted).toContain("active lane:")
    expect(formatted).toContain("current artifact:")
    expect(formatted).toContain("next action:")
    // Last verified checkpoint from coding session
    expect(formatted).toContain("last checkpoint: tests passing")
  })

  it("includes last verified checkpoint in live world-state checkpoint", () => {
    const frame = buildActiveWorkFrame({
      currentSession: { friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/s.json" },
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      codingSessions: [{
        id: "coding-001",
        runner: "codex",
        status: "running",
        startedAt: recentIso(15),
        originSession: { friendId: "friend-1", channel: "cli", key: "session" },
        artifactPath: null,
        checkpoint: "compiles but 2 tests failing",
        lastActivityAt: recentIso(2),
        failure: null,
      }],
      taskBoard: {
        compact: "",
        activeBridges: [],
        byStatus: { drafting: [], processing: [], validating: [], collaborating: [], paused: [], blocked: [], done: [], cancelled: [] },
      },
      friendActivity: [],
    })

    const checkpoint = formatLiveWorldStateCheckpoint(frame)
    expect(checkpoint).toContain("last checkpoint: compiles but 2 tests failing")
  })
})

// ── Unit 1.4: Cross-session change detection ──

describe("cross-session change detection", () => {
  let detectActiveWorkChanges: typeof import("../../heart/active-work").detectActiveWorkChanges

  beforeAll(async () => {
    const mod = await import("../../heart/active-work")
    detectActiveWorkChanges = mod.detectActiveWorkChanges
  })

  function recentIso(minutesAgo: number): string {
    return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString()
  }

  it("detects obligation status transition from investigating to fulfilled", () => {
    const previous: import("../../heart/active-work").ActiveWorkSnapshot = {
      obligationSnapshots: [
        { id: "ob-1", status: "investigating", artifact: "/tmp/pr-1", nextAction: "merge the PR" },
      ],
      codingSnapshots: [],
      timestamp: recentIso(10),
    }
    const current: import("../../heart/active-work").ActiveWorkSnapshot = {
      obligationSnapshots: [
        { id: "ob-1", status: "fulfilled", artifact: "/tmp/pr-1", nextAction: null },
      ],
      codingSnapshots: [],
      timestamp: recentIso(0),
    }

    const changes = detectActiveWorkChanges(previous, current)
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.some((c) => c.kind === "obligation_status_changed" && c.id === "ob-1")).toBe(true)
  })

  it("detects coding session artifact change", () => {
    const previous: import("../../heart/active-work").ActiveWorkSnapshot = {
      obligationSnapshots: [],
      codingSnapshots: [
        { id: "coding-001", status: "running", artifact: null, checkpoint: "compiling" },
      ],
      timestamp: recentIso(10),
    }
    const current: import("../../heart/active-work").ActiveWorkSnapshot = {
      obligationSnapshots: [],
      codingSnapshots: [
        { id: "coding-001", status: "running", artifact: "/tmp/pr-new", checkpoint: "tests passing" },
      ],
      timestamp: recentIso(0),
    }

    const changes = detectActiveWorkChanges(previous, current)
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.some((c) => c.kind === "coding_artifact_changed" && c.id === "coding-001")).toBe(true)
  })

  it("detects new obligation appearing", () => {
    const previous: import("../../heart/active-work").ActiveWorkSnapshot = {
      obligationSnapshots: [],
      codingSnapshots: [],
      timestamp: recentIso(10),
    }
    const current: import("../../heart/active-work").ActiveWorkSnapshot = {
      obligationSnapshots: [
        { id: "ob-new", status: "pending", artifact: null, nextAction: "investigate" },
      ],
      codingSnapshots: [],
      timestamp: recentIso(0),
    }

    const changes = detectActiveWorkChanges(previous, current)
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.some((c) => c.kind === "obligation_appeared" && c.id === "ob-new")).toBe(true)
  })

  it("returns empty changes array when nothing changed", () => {
    const snapshot: import("../../heart/active-work").ActiveWorkSnapshot = {
      obligationSnapshots: [
        { id: "ob-1", status: "investigating", artifact: "/tmp/pr-1", nextAction: "merge" },
      ],
      codingSnapshots: [],
      timestamp: recentIso(5),
    }

    const changes = detectActiveWorkChanges(snapshot, snapshot)
    expect(changes).toEqual([])
  })

  it("formats changes into concise human-readable summary", async () => {
    const { formatActiveWorkChanges } = await import("../../heart/active-work")

    const changes: import("../../heart/active-work").ActiveWorkChange[] = [
      { kind: "obligation_status_changed", id: "ob-1", from: "investigating", to: "fulfilled", summary: "obligation fulfilled" },
      { kind: "coding_artifact_changed", id: "coding-001", from: null, to: "/tmp/pr-new", summary: "PR created" },
    ]

    const formatted = formatActiveWorkChanges(changes)
    expect(formatted).toContain("obligation fulfilled")
    expect(formatted).toContain("PR created")
    expect(formatted.split("\n").length).toBeLessThanOrEqual(changes.length + 2) // concise
  })
})
