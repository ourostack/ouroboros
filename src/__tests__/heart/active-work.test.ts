import { describe, expect, it } from "vitest"

describe("active work frame", () => {
  it("builds one shared center of gravity from active bridge, task pressure, and live same-friend sessions", async () => {
    const { buildActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
      },
      currentObligation: "carry Ari across our live chats",
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [
        {
          id: "bridge-1",
          objective: "carry Ari across cli and bluebubbles",
          summary: "same work, two surfaces",
          lifecycle: "active",
          runtime: "idle",
          createdAt: "2026-03-13T20:00:00.000Z",
          updatedAt: "2026-03-13T20:00:00.000Z",
          attachedSessions: [
            {
              friendId: "friend-1",
              channel: "bluebubbles",
              key: "chat",
              sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
            },
          ],
          task: {
            taskName: "2026-03-13-2000-shared-relay",
            path: "/tmp/tasks/ongoing/2026-03-13-2000-shared-relay.md",
            mode: "bound",
            boundAt: "2026-03-13T20:00:00.000Z",
          },
        },
      ],
      taskBoard: {
        compact: "[Tasks] processing:1 blocked:0",
        activeBridges: ["2026-03-13-2000-shared-relay -> bridge-1"],
        byStatus: {
          drafting: [],
          processing: ["shared-relay"],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
      targetCandidates: [
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          snapshot: "recent focus: keep Ari aligned",
          trust: {
            level: "friend",
            basis: "direct",
            summary: "directly trusted",
            why: "this is Ari's other live chat",
            permits: ["shared coordination"],
            constraints: [],
          },
          delivery: {
            mode: "queue_only",
            reason: "needs explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
    })

    expect(frame.centerOfGravity).toBe("shared-work")
    expect(frame.taskPressure.liveTaskNames).toEqual(["shared-relay"])
    expect(frame.friendActivity.freshestForCurrentFriend?.channel).toBe("cli")
    expect(frame.bridgeSuggestion).toEqual({
      kind: "attach-existing",
      bridgeId: "bridge-1",
      reason: "shared-work-candidate",
      targetSession: expect.objectContaining({
        channel: "cli",
        key: "session",
      }),
    })
  })

  it("falls back to inward-work when there is no active bridge but inner work or handoff pressure is live", async () => {
    const { buildActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "cli",
        key: "session",
        sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
      },
      currentObligation: "finish the active answer",
      mustResolveBeforeHandoff: true,
      inner: { status: "running", hasPending: true },
      bridges: [],
      taskBoard: {
        compact: "[Tasks] processing:0 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [],
    })

    expect(frame.centerOfGravity).toBe("inward-work")
    expect(frame.bridgeSuggestion).toBeNull()
  })

  it("treats active coding work as inward-work and surfaces the live coding lane", async () => {
    const { buildActiveWorkFrame, formatActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
      },
      mustResolveBeforeHandoff: false,
      inner: {
        status: "idle",
        hasPending: false,
        job: {
          status: "idle" as const,
          content: null,
          origin: null,
          mode: "reflect" as const,
          obligationStatus: null,
          surfacedResult: null,
          queuedAt: null,
          startedAt: null,
          surfacedAt: null,
        },
      },
      bridges: [],
      pendingObligations: [],
      codingSessions: [
        {
          id: "coding-013",
          runner: "claude",
          workdir: "/tmp/workspaces/ouroboros",
          taskRef: "harness-maintenance",
          status: "waiting_input" as const,
          stdoutTail: "needs review",
          stderrTail: "",
          pid: 13,
          startedAt: "2026-03-05T23:53:00.000Z",
          lastActivityAt: "2026-03-05T23:59:00.000Z",
          endedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastSignal: null,
          failure: null,
          originSession: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
        },
      ],
      taskBoard: {
        compact: "",
        activeBridges: [],
        byStatus: { drafting: [], processing: [], validating: [], collaborating: [], paused: [], blocked: [], done: [] },
      },
      friendActivity: [],
    })

    expect(frame.centerOfGravity).toBe("inward-work")

    const rendered = formatActiveWorkFrame(frame)
    expect(rendered).toContain("## live coding work")
    expect(rendered).toContain("[waiting_input] claude coding-013")
    expect(rendered).toContain("for this thread")
  })

  it("renders live coding work from another thread with explicit scope", async () => {
    const { buildActiveWorkFrame, formatActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
      },
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      pendingObligations: [],
      codingSessions: [
        {
          id: "coding-014",
          runner: "codex",
          workdir: "/tmp/workspaces/ouroboros",
          taskRef: "session-surfacing",
          status: "running" as const,
          stdoutTail: "",
          stderrTail: "",
          pid: 14,
          startedAt: "2026-03-05T23:53:00.000Z",
          lastActivityAt: "2026-03-05T23:59:00.000Z",
          endedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastSignal: null,
          failure: null,
          originSession: { friendId: "friend-1", channel: "cli", key: "session" },
        },
      ],
      taskBoard: {
        compact: "",
        activeBridges: [],
        byStatus: { drafting: [], processing: [], validating: [], collaborating: [], paused: [], blocked: [], done: [] },
      },
      friendActivity: [],
    })

    const rendered = formatActiveWorkFrame(frame)
    expect(rendered).toContain("[running] codex coding-014")
    expect(rendered).toContain("for cli/session")
  })

  it("renders live coding work without origin metadata without inventing scope", async () => {
    const { buildActiveWorkFrame, formatActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
      },
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      pendingObligations: [],
      codingSessions: [
        {
          id: "coding-015",
          runner: "claude",
          workdir: "/tmp/workspaces/ouroboros",
          taskRef: "orphan-session",
          status: "running" as const,
          stdoutTail: "",
          stderrTail: "",
          pid: 15,
          startedAt: "2026-03-05T23:53:00.000Z",
          lastActivityAt: "2026-03-05T23:59:00.000Z",
          endedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastSignal: null,
          failure: null,
        },
      ],
      taskBoard: {
        compact: "",
        activeBridges: [],
        byStatus: { drafting: [], processing: [], validating: [], collaborating: [], paused: [], blocked: [], done: [] },
      },
      friendActivity: [],
    })

    const rendered = formatActiveWorkFrame(frame)
    expect(rendered).toContain("[running] claude coding-015")
    expect(rendered).not.toContain("for this thread")
    expect(rendered).not.toContain("for cli/session")
  })

  it("prefers friend-facing recency over a newer passive-write fallback when choosing the freshest same-friend session", async () => {
    const { buildActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "teams",
        key: "conv-1",
        sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
      },
      currentObligation: "keep Ari aligned across chats",
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      taskBoard: {
        compact: "[Tasks] processing:0 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
          lastActivityAt: "2026-03-13T20:05:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:05:00.000Z"),
          activitySource: "mtime-fallback",
        },
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
      targetCandidates: [
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          snapshot: "recent focus: keep Ari aligned",
          trust: {
            level: "friend",
            basis: "direct",
            summary: "directly trusted",
            why: "this is Ari's other live chat",
            permits: ["shared coordination"],
            constraints: [],
          },
          delivery: {
            mode: "queue_only",
            reason: "needs explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
    })

    expect(frame.friendActivity.freshestForCurrentFriend).toEqual(
      expect.objectContaining({
        channel: "cli",
        key: "session",
      }),
    )
  })

  it("breaks ties within the same activity source by newer friend-facing recency", async () => {
    const { buildActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "teams",
        key: "conv-1",
        sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
      },
      currentObligation: "keep Ari aligned across chats",
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      taskBoard: {
        compact: "[Tasks] processing:0 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          lastActivityAt: "2026-03-13T20:03:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:03:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
      targetCandidates: [
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          snapshot: "recent focus: keep Ari aligned",
          trust: {
            level: "friend",
            basis: "direct",
            summary: "directly trusted",
            why: "this is Ari's other live chat",
            permits: ["shared coordination"],
            constraints: [],
          },
          delivery: {
            mode: "queue_only",
            reason: "needs explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
    })

    expect(frame.friendActivity.freshestForCurrentFriend).toEqual(
      expect.objectContaining({
        channel: "cli",
        key: "session",
      }),
    )
  })

  it("formats the active-work frame as one scan-friendly center-of-gravity section", async () => {
    const { buildActiveWorkFrame, formatActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "teams",
        key: "conv-1",
        sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
      },
      currentObligation: "keep Ari aligned across chats",
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      taskBoard: {
        compact: "[Tasks] processing:1 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: ["shared-relay"],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
    })

    const rendered = formatActiveWorkFrame(frame)
    expect(rendered).toContain("## what i'm holding")
    expect(rendered).toContain("i'm in a conversation on")
    expect(rendered).toContain("i told them i'd keep Ari aligned across chats.")
  })

  it("falls back gracefully when formatting a sparse frame with optional runtime sections absent", async () => {
    const { formatActiveWorkFrame } = await import("../../heart/active-work")

    const rendered = formatActiveWorkFrame({
      currentSession: null,
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      centerOfGravity: "local-turn",
      bridgeSuggestion: null,
    } as any)

    expect(rendered).toContain("## what i'm holding")
    expect(rendered).toContain("not in a conversation right now")
    expect(rendered).not.toContain("tracking:")
  })

  it("surfaces explicit target-candidate detail when the frame already has candidate truth", async () => {
    const { formatActiveWorkFrame } = await import("../../heart/active-work")

    const rendered = formatActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "bluebubbles",
        key: "chat-any",
        sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat-any.json",
      },
      currentObligation: "carry this across chats",
      mustResolveBeforeHandoff: false,
      centerOfGravity: "shared-work",
      inner: { status: "idle", hasPending: false },
      bridges: [],
      taskPressure: {
        compactBoard: "",
        liveTaskNames: [],
        activeBridges: [],
      },
      friendActivity: {
        freshestForCurrentFriend: null,
        otherLiveSessionsForCurrentFriend: [],
      },
      bridgeSuggestion: null,
      targetCandidates: [
        {
          friendId: "friend-2",
          friendName: "Project Group",
          channel: "bluebubbles",
          key: "chat-group",
          sessionPath: "/tmp/state/sessions/friend-2/bluebubbles/chat-group.json",
          snapshot: "recent focus: waiting on the update",
          trust: {
            level: "acquaintance",
            basis: "shared_group",
            summary: "known through the shared project group",
          },
          delivery: {
            mode: "queue_only",
            reason: "requires explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-14T18:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-14T18:01:00.000Z"),
        },
      ],
    } as any)

    expect(rendered).toContain("candidate target chats")
    expect(rendered).toContain("Project Group")
    expect(rendered).toContain("queue_only")
    expect(rendered).toContain("shared_group")
  })

  it("suggests beginning a new bridge when another live session makes the same work cross-surface even across a different relationship", async () => {
    const { buildActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "teams",
        key: "conv-1",
        sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
      },
      currentObligation: "keep Ari aligned across chats",
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      taskBoard: {
        compact: "[Tasks] processing:0 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [],
      targetCandidates: [
        {
          friendId: "group-1",
          friendName: "Project Group",
          channel: "bluebubbles",
          key: "chat:any;+;project-group-123",
          sessionPath: "/tmp/state/sessions/group-1/bluebubbles/chat:any;+;project-group-123.json",
          snapshot: "recent focus: waiting on Ari",
          trust: {
            level: "acquaintance",
            basis: "shared_group",
            summary: "known through the shared project group",
            why: "this group is a relevant shared context",
            permits: ["group-safe coordination"],
            constraints: ["no direct private trust"],
            relatedGroupId: "group:any;+;project-group-123",
          },
          delivery: {
            mode: "queue_only",
            reason: "requires explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
    })

    expect(frame.bridgeSuggestion).toEqual({
      kind: "begin-new",
      objectiveHint: "keep Ari aligned across chats",
      reason: "shared-work-candidate",
      targetSession: expect.objectContaining({
        friendId: "group-1",
        channel: "bluebubbles",
        key: "chat:any;+;project-group-123",
      }),
    })
  })

  it("falls back to the default bridge objective when shared pressure comes from handoff rather than obligation text", async () => {
    const { buildActiveWorkFrame, formatActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "teams",
        key: "conv-1",
        sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
      },
      currentObligation: "   ",
      mustResolveBeforeHandoff: true,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      taskBoard: {
        compact: "[Tasks] processing:0 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
      targetCandidates: [
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          snapshot: "recent focus: other live surface",
          trust: {
            level: "friend",
            basis: "direct",
            summary: "directly trusted",
            why: "other live same-friend chat",
            permits: ["shared coordination"],
            constraints: [],
          },
          delivery: {
            mode: "queue_only",
            reason: "needs explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
    })

    expect(frame.bridgeSuggestion).toEqual({
      kind: "begin-new",
      objectiveHint: "keep this shared work aligned",
      reason: "shared-work-candidate",
      targetSession: expect.objectContaining({
        channel: "cli",
        key: "session",
      }),
    })

    const rendered = formatActiveWorkFrame(frame)
    expect(rendered).toContain("should connect these threads")
  })

  it("can suggest a bridge from live task pressure even when there is no obligation text", async () => {
    const { buildActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "teams",
        key: "conv-1",
        sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
      },
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      taskBoard: {
        compact: "[Tasks] processing:1 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: ["shared-relay"],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
      targetCandidates: [
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          snapshot: "recent focus: other live surface",
          trust: {
            level: "friend",
            basis: "direct",
            summary: "directly trusted",
            why: "other live same-friend chat",
            permits: ["shared coordination"],
            constraints: [],
          },
          delivery: {
            mode: "queue_only",
            reason: "needs explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
    })

    expect(frame.bridgeSuggestion).toEqual({
      kind: "begin-new",
      objectiveHint: "keep this shared work aligned",
      reason: "shared-work-candidate",
      targetSession: expect.objectContaining({
        channel: "cli",
        key: "session",
      }),
    })
  })

  it("skips re-suggesting an already attached session and formats bridge plus handoff pressure details", async () => {
    const { buildActiveWorkFrame, formatActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "teams",
        key: "conv-1",
        sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
      },
      currentObligation: "keep Ari aligned across chats",
      mustResolveBeforeHandoff: true,
      inner: { status: "idle", hasPending: false },
      bridges: [
        {
          id: "bridge-1",
          objective: "carry Ari across cli and teams",
          summary: "same work, two surfaces",
          lifecycle: "active",
          runtime: "idle",
          createdAt: "2026-03-13T20:00:00.000Z",
          updatedAt: "2026-03-13T20:00:00.000Z",
          attachedSessions: [
            {
              friendId: "friend-1",
              channel: "cli",
              key: "session",
              sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
            },
          ],
          task: null,
        },
      ],
      taskBoard: {
        compact: "[Tasks] processing:0 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
      targetCandidates: [
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          snapshot: "recent focus: already attached surface",
          trust: {
            level: "friend",
            basis: "direct",
            summary: "directly trusted",
            why: "other live same-friend chat",
            permits: ["shared coordination"],
            constraints: [],
          },
          delivery: {
            mode: "queue_only",
            reason: "needs explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
    })

    expect(frame.bridgeSuggestion).toBeNull()

    const rendered = formatActiveWorkFrame(frame)
    expect(rendered).toContain("i told them i'd keep Ari aligned across chats.")
    expect(rendered).toContain("shared work spanning sessions: bridge-1 [active-idle]")
  })

  it("formats sparse inward work without a current session and shows pending inner state cleanly", async () => {
    const { buildActiveWorkFrame, formatActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: null,
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: true },
      bridges: [],
      taskBoard: {
        compact: "[Tasks] processing:0 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [],
    })

    expect(frame.centerOfGravity).toBe("inward-work")
    expect(frame.friendActivity.freshestForCurrentFriend).toBeNull()

    const rendered = formatActiveWorkFrame(frame)
    expect(rendered).toContain("## what i'm holding")
    expect(rendered).toContain("not in a conversation right now")
  })

  it("exports a shared bridge suggestion helper that ignores already-covered sessions and only suggests other live surfaces", async () => {
    const { suggestBridgeForActiveWork, formatActiveWorkFrame } = await import("../../heart/active-work")

    const suggestion = suggestBridgeForActiveWork({
      currentSession: {
        friendId: "friend-1",
        channel: "teams",
        key: "conv-1",
        sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
      },
      currentObligation: "keep Ari aligned across chats",
      mustResolveBeforeHandoff: false,
      bridges: [
        {
          id: "bridge-1",
          objective: "carry Ari across cli and teams",
          summary: "same work, two surfaces",
          lifecycle: "active",
          runtime: "idle",
          createdAt: "2026-03-13T20:00:00.000Z",
          updatedAt: "2026-03-13T20:00:00.000Z",
          attachedSessions: [
            {
              friendId: "friend-1",
              channel: "teams",
              key: "conv-1",
              sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
            },
          ],
          task: null,
        },
      ],
      taskBoard: {
        compact: "[Tasks] processing:0 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      targetCandidates: [
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "teams",
          key: "conv-1",
          sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
          snapshot: "recent focus: current session",
          trust: {
            level: "friend",
            basis: "direct",
            summary: "directly trusted",
            why: "current same-friend live chat",
            permits: ["shared coordination"],
            constraints: [],
          },
          delivery: {
            mode: "queue_only",
            reason: "needs explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-13T20:03:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:03:00.000Z"),
          activitySource: "friend-facing",
        },
        {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          snapshot: "recent focus: other surface",
          trust: {
            level: "friend",
            basis: "direct",
            summary: "directly trusted",
            why: "other live same-friend chat",
            permits: ["shared coordination"],
            constraints: [],
          },
          delivery: {
            mode: "queue_only",
            reason: "needs explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-13T20:02:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:02:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
    })

    expect(suggestion).toEqual({
      kind: "attach-existing",
      bridgeId: "bridge-1",
      reason: "shared-work-candidate",
      targetSession: expect.objectContaining({
        channel: "cli",
        key: "session",
      }),
    })

    expect(formatActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "teams",
        key: "conv-1",
        sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
      },
      currentObligation: "keep Ari aligned across chats",
      mustResolveBeforeHandoff: false,
      centerOfGravity: "shared-work",
      inner: { status: "idle", hasPending: false },
      bridges: [
        {
          id: "bridge-1",
          objective: "carry Ari across cli and teams",
          summary: "same work, two surfaces",
          lifecycle: "active",
          runtime: "idle",
          createdAt: "2026-03-13T20:00:00.000Z",
          updatedAt: "2026-03-13T20:00:00.000Z",
          attachedSessions: [
            {
              friendId: "friend-1",
              channel: "teams",
              key: "conv-1",
              sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
            },
          ],
          task: null,
        },
      ],
      taskPressure: {
        compactBoard: "[Tasks] processing:0 blocked:0",
        liveTaskNames: [],
        activeBridges: [],
      },
      friendActivity: {
        freshestForCurrentFriend: {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
          lastActivityAt: "2026-03-13T20:02:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:02:00.000Z"),
          activitySource: "friend-facing",
        },
        otherLiveSessionsForCurrentFriend: [],
      },
      bridgeSuggestion: suggestion,
    })).toContain("relates to bridge bridge-1")
  })

  it("suggests bridge when multiple non-blocked cross-relationship target candidates are live (picks freshest)", async () => {
    const { buildActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "bluebubbles",
        key: "chat-any",
        sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat-any.json",
      },
      currentObligation: "carry this across the right chat",
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      taskBoard: {
        compact: "[Tasks] processing:0 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [],
      targetCandidates: [
        {
          friendId: "group-1",
          friendName: "Project Group",
          channel: "bluebubbles",
          key: "chat:any;+;project-group-123",
          sessionPath: "/tmp/state/sessions/group-1/bluebubbles/chat:any;+;project-group-123.json",
          snapshot: "recent focus: waiting on Ari",
          trust: {
            level: "acquaintance",
            basis: "shared_group",
            summary: "known through the shared project group",
            why: "this group is a relevant shared context",
            permits: ["group-safe coordination"],
            constraints: ["no direct private trust"],
            relatedGroupId: "group:any;+;project-group-123",
          },
          delivery: {
            mode: "queue_only",
            reason: "requires explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
        {
          friendId: "friend-2",
          friendName: "CLI Copilot",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-2/cli/session.json",
          snapshot: "recent focus: waiting on the same answer",
          trust: {
            level: "friend",
            basis: "direct",
            summary: "directly trusted",
            why: "this is a trusted active session",
            permits: ["shared coordination"],
            constraints: [],
          },
          delivery: {
            mode: "queue_only",
            reason: "live delivery still needs an explicit route decision",
          },
          lastActivityAt: "2026-03-13T20:02:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:02:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
    } as any)

    expect(frame.bridgeSuggestion).not.toBeNull()
    expect(frame.bridgeSuggestion!.kind).toBe("begin-new")
  })

  it("ignores blocked and non-friend-facing candidates when evaluating bridge suggestions", async () => {
    const { suggestBridgeForActiveWork } = await import("../../heart/active-work")

    expect(suggestBridgeForActiveWork({
      currentSession: {
        friendId: "friend-1",
        channel: "teams",
        key: "conv-1",
        sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
      },
      currentObligation: "keep Ari aligned across chats",
      mustResolveBeforeHandoff: false,
      bridges: [],
      taskBoard: {
        compact: "[Tasks] processing:0 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      targetCandidates: [
        {
          friendId: "group-1",
          friendName: "Project Group",
          channel: "bluebubbles",
          key: "chat:any;+;project-group-123",
          sessionPath: "/tmp/state/sessions/group-1/bluebubbles/chat:any;+;project-group-123.json",
          snapshot: "recent focus: waiting on Ari",
          trust: {
            level: "acquaintance",
            basis: "shared_group",
            summary: "known through a shared project group",
            why: "this is a relevant shared context",
            permits: ["group-safe coordination"],
            constraints: ["no direct private trust"],
            relatedGroupId: "group:any;+;project-group-123",
          },
          delivery: {
            mode: "blocked",
            reason: "this channel is unavailable",
          },
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
        {
          friendId: "group-2",
          friendName: "Muted Group",
          channel: "bluebubbles",
          key: "chat:any;+;muted-group-456",
          sessionPath: "/tmp/state/sessions/group-2/bluebubbles/chat:any;+;muted-group-456.json",
          snapshot: "recent focus: archived surface",
          trust: {
            level: "acquaintance",
            basis: "shared_group",
            summary: "known through a shared group",
            why: "this is a related group context",
            permits: ["group-safe coordination"],
            constraints: ["no direct private trust"],
            relatedGroupId: "group:any;+;muted-group-456",
          },
          delivery: {
            mode: "queue_only",
            reason: "needs explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-13T20:02:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:02:00.000Z"),
          activitySource: "mtime-fallback",
        },
      ],
    })).toBeNull()
  })

  it("can suggest shared work even without a current outward session when one clear friend-facing candidate exists", async () => {
    const { suggestBridgeForActiveWork } = await import("../../heart/active-work")

    expect(suggestBridgeForActiveWork({
      currentSession: null,
      currentObligation: "carry this outward when ready",
      mustResolveBeforeHandoff: false,
      bridges: [],
      taskBoard: {
        compact: "[Tasks] processing:0 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      targetCandidates: [
        {
          friendId: "group-1",
          friendName: "Project Group",
          channel: "bluebubbles",
          key: "chat:any;+;project-group-123",
          sessionPath: "/tmp/state/sessions/group-1/bluebubbles/chat:any;+;project-group-123.json",
          snapshot: "recent focus: waiting on Ari",
          trust: {
            level: "acquaintance",
            basis: "shared_group",
            summary: "known through a shared project group",
            why: "this is a relevant shared context",
            permits: ["group-safe coordination"],
            constraints: ["no direct private trust"],
            relatedGroupId: "group:any;+;project-group-123",
          },
          delivery: {
            mode: "queue_only",
            reason: "needs explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-13T20:01:00.000Z",
          lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
          activitySource: "friend-facing",
        },
      ],
    })).toEqual({
      kind: "begin-new",
      objectiveHint: "carry this outward when ready",
      reason: "shared-work-candidate",
      targetSession: expect.objectContaining({
        friendId: "group-1",
        channel: "bluebubbles",
        key: "chat:any;+;project-group-123",
      }),
    })
  })
})

describe("delegation router", () => {
  it("keeps only cheap local replies on the fast path", async () => {
    const { buildActiveWorkFrame } = await import("../../heart/active-work")
    const { decideDelegation } = await import("../../heart/delegation")

    const activeWork = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "cli",
        key: "session",
        sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
      },
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      taskBoard: {
        compact: "[Tasks] processing:0 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [],
    })

    expect(decideDelegation({
      channel: "cli",
      ingressTexts: ["sounds good"],
      activeWork,
      mustResolveBeforeHandoff: false,
      requestedToolNames: ["final_answer"],
    })).toEqual({
      target: "fast-path",
      reasons: [],
      outwardClosureRequired: false,
    })
  })

  it("routes reflective or cross-session work inward with concrete reasons", async () => {
    const { buildActiveWorkFrame } = await import("../../heart/active-work")
    const { decideDelegation } = await import("../../heart/delegation")

    const activeWork = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
      },
      currentObligation: "figure this out across chats",
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      taskBoard: {
        compact: "[Tasks] processing:1 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: ["shared-relay"],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [],
    })

    expect(decideDelegation({
      channel: "bluebubbles",
      ingressTexts: ["think about this and check my other chat too"],
      activeWork,
      mustResolveBeforeHandoff: true,
      requestedToolNames: ["query_session"],
    })).toEqual({
      target: "delegate-inward",
      reasons: expect.arrayContaining([
        "explicit_reflection",
        "cross_session",
        "non_fast_path_tool",
        "task_state",
        "unresolved_obligation",
      ]),
      outwardClosureRequired: true,
    })
  })

  it("routes text-only cross-session pressure inward even without a tool request", async () => {
    const { buildActiveWorkFrame } = await import("../../heart/active-work")
    const { decideDelegation } = await import("../../heart/delegation")

    const activeWork = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "inner",
        key: "dialog",
        sessionPath: "/tmp/state/sessions/friend-1/inner/dialog.json",
      },
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [],
      taskBoard: {
        compact: "[Tasks] processing:0 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [],
    })

    expect(decideDelegation({
      channel: "inner",
      ingressTexts: ["carry this across chats for me"],
      activeWork,
      mustResolveBeforeHandoff: false,
      requestedToolNames: ["final_answer"],
    })).toEqual({
      target: "delegate-inward",
      reasons: ["cross_session"],
      outwardClosureRequired: false,
    })
  })

  it("does not treat suspended bridges alone as shared-work delegation pressure", async () => {
    const { buildActiveWorkFrame } = await import("../../heart/active-work")
    const { decideDelegation } = await import("../../heart/delegation")

    const activeWork = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "cli",
        key: "session",
        sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
      },
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false },
      bridges: [
        {
          id: "bridge-1",
          objective: "paused relay",
          summary: "shared work is dormant",
          lifecycle: "suspended",
          runtime: "idle",
          createdAt: "2026-03-13T20:00:00.000Z",
          updatedAt: "2026-03-13T20:00:00.000Z",
          attachedSessions: [],
          task: null,
        },
      ],
      taskBoard: {
        compact: "[Tasks] processing:0 blocked:0",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [],
    })

    expect(decideDelegation({
      channel: "cli",
      ingressTexts: ["sounds good"],
      activeWork,
      mustResolveBeforeHandoff: false,
      requestedToolNames: ["final_answer"],
    })).toEqual({
      target: "fast-path",
      reasons: [],
      outwardClosureRequired: false,
    })
  })

  it("passes through enriched inner fields (origin, contentSnippet, obligationPending) from input to frame", async () => {
    const { buildActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: null,
      mustResolveBeforeHandoff: false,
      inner: {
        status: "running",
        hasPending: true,
        origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
        contentSnippet: "think about penguins",
        obligationPending: true,
      },
      bridges: [],
      taskBoard: {
        compact: "",
        full: "",
        byStatus: { drafting: [], processing: [], validating: [], collaborating: [], paused: [], blocked: [], done: [] },
        actionRequired: [],
        unresolvedDependencies: [],
        activeSessions: [],
        activeBridges: [],
      },
      friendActivity: [],
    })

    expect(frame.inner.origin).toEqual({ friendId: "friend-1", channel: "bluebubbles", key: "chat" })
    expect(frame.inner.contentSnippet).toBe("think about penguins")
    expect(frame.inner.obligationPending).toBe(true)
  })

  it("renders enriched inner status with origin and obligation in formatActiveWorkFrame", async () => {
    const { formatActiveWorkFrame } = await import("../../heart/active-work")

    const rendered = formatActiveWorkFrame({
      currentSession: null,
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      centerOfGravity: "inward-work",
      inner: {
        status: "running",
        hasPending: true,
        origin: { friendId: "alice", channel: "bluebubbles", key: "session" },
        contentSnippet: "what should I think about this?",
        obligationPending: true,
        job: {
          status: "running" as const,
          content: "what should I think about this?",
          origin: { friendId: "alice", channel: "bluebubbles", key: "session" },
          mode: "reflect" as const,
          obligationStatus: "pending" as const,
          surfacedResult: null,
          queuedAt: null,
          startedAt: null,
          surfacedAt: null,
        },
      },
      bridges: [],
      taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
      friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
      bridgeSuggestion: null,
    } as any)

    expect(rendered).toContain("thinking through something privately right now")
    expect(rendered).toContain("i still owe them an answer")
  })

  it("treats active obligations as inward-work pressure even when inner job is idle", async () => {
    const { buildActiveWorkFrame, formatActiveWorkFrame } = await import("../../heart/active-work")

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
      },
      mustResolveBeforeHandoff: false,
      inner: {
        status: "idle",
        hasPending: false,
        job: {
          status: "idle" as const,
          content: null,
          origin: null,
          mode: "reflect" as const,
          obligationStatus: null,
          surfacedResult: null,
          queuedAt: null,
          startedAt: null,
          surfacedAt: null,
        },
      },
      bridges: [],
      pendingObligations: [
        {
          id: "ob-1",
          origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
          content: "close the loop on the fix",
          status: "investigating" as const,
          currentSurface: { kind: "coding", label: "codex coding-001" },
          createdAt: "2026-03-20T15:00:00.000Z",
          updatedAt: "2026-03-20T15:05:00.000Z",
        },
      ],
      taskBoard: {
        compact: "",
        activeBridges: [],
        byStatus: { drafting: [], processing: [], validating: [], collaborating: [], paused: [], blocked: [], done: [] },
      },
      friendActivity: [],
    })

    expect(frame.centerOfGravity).toBe("inward-work")

    const rendered = formatActiveWorkFrame(frame)
    expect(rendered).toContain("## return obligations")
    expect(rendered).toContain("[investigating] friend-1/bluebubbles/chat: close the loop on the fix")
    expect(rendered).toContain("working in codex coding-001")
  })

  it("renders queued inner thought content when present", async () => {
    const { formatActiveWorkFrame } = await import("../../heart/active-work")

    const rendered = formatActiveWorkFrame({
      currentSession: null,
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      centerOfGravity: "inward-work",
      inner: {
        status: "idle",
        hasPending: true,
        contentSnippet: "trace the return path",
        job: {
          status: "queued" as const,
          content: "trace the return path",
          origin: null,
          mode: "reflect" as const,
          obligationStatus: null,
          surfacedResult: null,
          queuedAt: "2026-03-20T16:00:00.000Z",
          startedAt: null,
          surfacedAt: null,
        },
      },
      bridges: [],
      taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
      friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
      pendingObligations: [],
      bridgeSuggestion: null,
    } as any)

    expect(rendered).toContain("i have a thought queued up for private attention")
    expect(rendered).toContain("it's about: \"trace the return path\"")
  })

  it("renders queued inner thought without content enrichment when no snippet is known", async () => {
    const { formatActiveWorkFrame } = await import("../../heart/active-work")

    const rendered = formatActiveWorkFrame({
      currentSession: null,
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      centerOfGravity: "inward-work",
      inner: {
        status: "idle",
        hasPending: true,
        job: {
          status: "queued" as const,
          content: null,
          origin: null,
          mode: "reflect" as const,
          obligationStatus: null,
          surfacedResult: null,
          queuedAt: "2026-03-20T16:00:00.000Z",
          startedAt: null,
          surfacedAt: null,
        },
      },
      bridges: [],
      taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
      friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
      pendingObligations: [],
      bridgeSuggestion: null,
    } as any)

    expect(rendered).toContain("i have a thought queued up for private attention")
    expect(rendered).not.toContain("it's about:")
  })

  it("renders running inner thought with origin and pending-answer pressure", async () => {
    const { formatActiveWorkFrame } = await import("../../heart/active-work")

    const rendered = formatActiveWorkFrame({
      currentSession: null,
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      centerOfGravity: "inward-work",
      inner: {
        status: "running",
        hasPending: false,
        obligationPending: true,
        job: {
          status: "running" as const,
          content: "trace the loop",
          origin: { friendId: "alex", channel: "bluebubbles", key: "chat", friendName: "Alex" },
          mode: "reflect" as const,
          obligationStatus: "pending",
          surfacedResult: null,
          queuedAt: "2026-03-20T16:00:00.000Z",
          startedAt: "2026-03-20T16:01:00.000Z",
          surfacedAt: null,
        },
      },
      bridges: [],
      taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
      friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
      pendingObligations: [],
      bridgeSuggestion: null,
    } as any)

    expect(rendered).toContain("Alex asked about something and i wanted to give it real thought")
    expect(rendered).toContain("i still owe them an answer")
  })

  it("renders running inner thought without origin-specific enrichment when no origin is known", async () => {
    const { formatActiveWorkFrame } = await import("../../heart/active-work")

    const rendered = formatActiveWorkFrame({
      currentSession: null,
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      centerOfGravity: "inward-work",
      inner: {
        status: "running",
        hasPending: false,
        obligationPending: false,
        job: {
          status: "running" as const,
          content: "trace the loop",
          origin: null,
          mode: "reflect" as const,
          obligationStatus: null,
          surfacedResult: null,
          queuedAt: "2026-03-20T16:00:00.000Z",
          startedAt: "2026-03-20T16:01:00.000Z",
          surfacedAt: null,
        },
      },
      bridges: [],
      taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
      friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
      pendingObligations: [],
      bridgeSuggestion: null,
    } as any)

    expect(rendered).toContain("i'm thinking through something privately right now.")
    expect(rendered).not.toContain("asked about something")
    expect(rendered).not.toContain("i still owe them an answer")
  })

  it("renders surfaced inner result without an attached summary when nothing surfaced yet", async () => {
    const { formatActiveWorkFrame } = await import("../../heart/active-work")

    const rendered = formatActiveWorkFrame({
      currentSession: null,
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      centerOfGravity: "inward-work",
      inner: {
        status: "idle",
        hasPending: false,
        job: {
          status: "surfaced" as const,
          content: "finished tracing",
          origin: null,
          mode: "reflect" as const,
          obligationStatus: null,
          surfacedResult: null,
          queuedAt: null,
          startedAt: "2026-03-20T16:00:00.000Z",
          surfacedAt: "2026-03-20T16:05:00.000Z",
        },
      },
      bridges: [],
      taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
      friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
      pendingObligations: [],
      bridgeSuggestion: null,
    } as any)

    expect(rendered).toContain("i finished thinking about something privately. i should bring my answer back.")
    expect(rendered).not.toContain("what i came to:")
  })

  it("renders surfaced inner result and non-investigating obligation surfaces", async () => {
    const { formatActiveWorkFrame } = await import("../../heart/active-work")

    const rendered = formatActiveWorkFrame({
      currentSession: null,
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      centerOfGravity: "inward-work",
      inner: {
        status: "idle",
        hasPending: false,
        job: {
          status: "surfaced" as const,
          content: "finished tracing",
          origin: null,
          mode: "reflect" as const,
          obligationStatus: null,
          surfacedResult: "the fix is in the runtime handoff and needs to be merged before re-observing",
          queuedAt: null,
          startedAt: "2026-03-20T16:00:00.000Z",
          surfacedAt: "2026-03-20T16:05:00.000Z",
        },
      },
      bridges: [],
      taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
      friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
      pendingObligations: [
        {
          id: "ob-merge",
          origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
          content: "land the fix",
          status: "waiting_for_merge" as const,
          currentSurface: { kind: "merge", label: "PR #120" },
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:04:00.000Z",
        },
        {
          id: "ob-update",
          origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
          content: "restart onto latest runtime",
          status: "updating_runtime" as const,
          currentSurface: { kind: "runtime", label: "ouro up" },
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:05:00.000Z",
        },
      ],
      bridgeSuggestion: null,
    } as any)

    expect(rendered).toContain("i finished thinking about something privately. i should bring my answer back.")
    expect(rendered).toContain("what i came to: the fix is in the runtime handoff and needs to be merged before re-observing")
    expect(rendered).toContain("[waiting_for_merge] friend-1/bluebubbles/chat: land the fix (waiting at PR #120)")
    expect(rendered).toContain("[updating_runtime] friend-1/bluebubbles/chat: restart onto latest runtime (updating via ouro up)")
  })

  it("uses the default obligation surface label for open statuses without a specialized formatter", async () => {
    const { formatActiveWorkFrame } = await import("../../heart/active-work")

    const rendered = formatActiveWorkFrame({
      currentSession: null,
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      centerOfGravity: "inward-work",
      inner: {
        status: "idle",
        hasPending: false,
        job: {
          status: "idle" as const,
          content: null,
          origin: null,
          mode: "reflect" as const,
          obligationStatus: null,
          surfacedResult: null,
          queuedAt: null,
          startedAt: null,
          surfacedAt: null,
        },
      },
      bridges: [],
      taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
      friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
      pendingObligations: [
        {
          id: "ob-pending",
          origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
          content: "keep the scratchpad visible",
          status: "pending" as const,
          currentSurface: { kind: "session", label: "cli notes" },
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:01:00.000Z",
        },
      ],
      bridgeSuggestion: null,
    } as any)

    expect(rendered).toContain("[pending] friend-1/bluebubbles/chat: keep the scratchpad visible (cli notes)")
  })

  it("omits the obligation suffix when no current surface label is known", async () => {
    const { formatActiveWorkFrame } = await import("../../heart/active-work")

    const rendered = formatActiveWorkFrame({
      currentSession: null,
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      centerOfGravity: "inward-work",
      inner: {
        status: "idle",
        hasPending: false,
        job: {
          status: "idle" as const,
          content: null,
          origin: null,
          mode: "reflect" as const,
          obligationStatus: null,
          surfacedResult: null,
          queuedAt: null,
          startedAt: null,
          surfacedAt: null,
        },
      },
      bridges: [],
      taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
      friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
      pendingObligations: [
        {
          id: "ob-pending",
          origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
          content: "keep the scratchpad visible",
          status: "pending" as const,
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:01:00.000Z",
        },
      ],
      bridgeSuggestion: null,
    } as any)

    expect(rendered).toContain("[pending] friend-1/bluebubbles/chat: keep the scratchpad visible")
    expect(rendered).not.toContain("(cli notes)")
  })

  it("keeps coding-session completion visibly open when merge or runtime closure is still pending", async () => {
    const { formatActiveWorkFrame } = await import("../../heart/active-work")

    const rendered = formatActiveWorkFrame({
      currentSession: null,
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      centerOfGravity: "inward-work",
      inner: {
        status: "idle",
        hasPending: false,
        job: {
          status: "idle" as const,
          content: null,
          origin: null,
          mode: "reflect" as const,
          obligationStatus: null,
          surfacedResult: null,
          queuedAt: null,
          startedAt: null,
          surfacedAt: null,
        },
      },
      bridges: [],
      taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
      friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
      pendingObligations: [
        {
          id: "ob-coding",
          origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
          content: "carry the self-fix back",
          status: "investigating" as const,
          currentSurface: { kind: "coding", label: "codex coding-001" },
          latestNote: "coding session completed; merge/update still pending",
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:01:00.000Z",
        },
      ],
      bridgeSuggestion: null,
    } as any)

    expect(rendered).toContain("[investigating] friend-1/bluebubbles/chat: carry the self-fix back (working in codex coding-001)")
    expect(rendered).toContain("latest: coding session completed; merge/update still pending")
  })

  it("truncates long surfaced inner results and skips fulfilled obligations in the return block", async () => {
    const { formatActiveWorkFrame } = await import("../../heart/active-work")
    const longResult = "x".repeat(140)

    const rendered = formatActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "cli",
        key: "session",
        sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
      },
      currentObligation: "close the loop",
      mustResolveBeforeHandoff: false,
      centerOfGravity: "inward-work",
      inner: {
        status: "idle",
        hasPending: false,
        job: {
          status: "surfaced" as const,
          content: "finished tracing",
          origin: null,
          mode: "reflect" as const,
          obligationStatus: null,
          surfacedResult: longResult,
          queuedAt: null,
          startedAt: "2026-03-20T16:00:00.000Z",
          surfacedAt: "2026-03-20T16:05:00.000Z",
        },
      },
      bridges: [],
      taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
      friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
      pendingObligations: [
        {
          id: "ob-open",
          origin: { friendId: "friend-1", channel: "cli", key: "session" },
          content: "bring the fix back",
          status: "waiting_for_merge" as const,
          currentSurface: { kind: "merge", label: "PR #123" },
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:01:00.000Z",
        },
        {
          id: "ob-closed",
          origin: { friendId: "friend-1", channel: "cli", key: "session" },
          content: "already done",
          status: "fulfilled" as const,
          createdAt: "2026-03-20T15:00:00.000Z",
          fulfilledAt: "2026-03-20T15:10:00.000Z",
        },
      ],
      bridgeSuggestion: {
        kind: "begin-new",
        reason: "shared-work-candidate",
        objectiveHint: "keep the loop aligned",
        targetSession: {
          friendId: "friend-1",
          friendName: "Ari",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
          snapshot: "recent focus: waiting on the fix",
          trust: {
            level: "friend",
            basis: "direct",
            summary: "trusted",
            why: "same person",
            permits: ["shared coordination"],
            constraints: [],
          },
          delivery: {
            mode: "queue_only",
            reason: "needs explicit cross-chat authorization",
          },
          lastActivityAt: "2026-03-20T16:06:00.000Z",
          lastActivityMs: Date.parse("2026-03-20T16:06:00.000Z"),
          activitySource: "friend-facing",
        },
      },
      targetCandidates: [],
    } as any)

    expect(rendered).toContain(`what i came to: ${"x".repeat(117)}...`)
    expect(rendered).toContain("[waiting_for_merge] friend-1/cli/session: bring the fix back (waiting at PR #123)")
    expect(rendered).not.toContain("already done")
    expect(rendered).toContain("this work touches my conversation on bluebubbles/chat too")
  })

  it("renders basic inner status without enrichment when origin is absent", async () => {
    const { formatActiveWorkFrame } = await import("../../heart/active-work")

    const rendered = formatActiveWorkFrame({
      currentSession: null,
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      centerOfGravity: "local-turn",
      inner: { status: "idle", hasPending: false },
      bridges: [],
      taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
      friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
      bridgeSuggestion: null,
    } as any)

    expect(rendered).toContain("## what i'm holding")
    expect(rendered).toContain("not in a conversation right now")
  })
})

describe("ActiveWorkFrame.inner with InnerJob", () => {
  it("buildActiveWorkFrame preserves job field from inner input", async () => {
    const { buildActiveWorkFrame } = await import("../../heart/active-work")

    const idleJob = {
      status: "idle" as const,
      content: null,
      origin: null,
      mode: "reflect" as const,
      obligationStatus: null,
      surfacedResult: null,
      queuedAt: null,
      startedAt: null,
      surfacedAt: null,
    }

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "cli",
        key: "session",
        sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
      },
      mustResolveBeforeHandoff: false,
      inner: { status: "idle", hasPending: false, job: idleJob },
      bridges: [],
      taskBoard: {
        compact: "",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [],
    })

    expect(frame.inner.job).toEqual(idleJob)
    expect(frame.inner.job.status).toBe("idle")
  })

  it("buildActiveWorkFrame preserves running InnerJob with origin", async () => {
    const { buildActiveWorkFrame } = await import("../../heart/active-work")

    const runningJob = {
      status: "running" as const,
      content: "think about naming conventions",
      origin: { friendId: "alex", channel: "teams", key: "session1" },
      mode: "plan" as const,
      obligationStatus: "pending" as const,
      surfacedResult: null,
      queuedAt: 1000,
      startedAt: "2026-01-01T00:00:00Z",
      surfacedAt: null,
    }

    const frame = buildActiveWorkFrame({
      currentSession: {
        friendId: "friend-1",
        channel: "cli",
        key: "session",
        sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
      },
      mustResolveBeforeHandoff: false,
      inner: {
        status: "running",
        hasPending: false,
        origin: { friendId: "alex", channel: "teams", key: "session1" },
        contentSnippet: "think about naming conventions",
        obligationPending: true,
        job: runningJob,
      },
      bridges: [],
      taskBoard: {
        compact: "",
        activeBridges: [],
        byStatus: {
          drafting: [],
          processing: [],
          validating: [],
          collaborating: [],
          paused: [],
          blocked: [],
          done: [],
        },
      },
      friendActivity: [],
    })

    expect(frame.inner.job).toEqual(runningJob)
    expect(frame.inner.job.status).toBe("running")
    expect(frame.inner.job.origin).toEqual({ friendId: "alex", channel: "teams", key: "session1" })
    expect(frame.inner.job.mode).toBe("plan")
  })
})
