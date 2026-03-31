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
    expect(result).toContain("## live world-state checkpoint")
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
