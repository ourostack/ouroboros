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
    expect(rendered).toContain("## active work")
    expect(rendered).toContain("center: local-turn")
    expect(rendered).toContain("obligation: keep Ari aligned across chats")
    expect(rendered).toContain("freshest friend-facing session: cli/session")
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

    expect(rendered).toContain("## active work")
    expect(rendered).toContain("center: local-turn")
    expect(rendered).toContain("inner status: idle")
    expect(rendered).not.toContain("live tasks:")
    expect(rendered).not.toContain("bridges:")
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
    const { buildActiveWorkFrame } = await import("../../heart/active-work")

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
    })

    expect(frame.bridgeSuggestion).toBeNull()

    const rendered = formatActiveWorkFrame(frame)
    expect(rendered).toContain("handoff pressure: must resolve before handoff")
    expect(rendered).toContain("bridges: bridge-1 [active-idle]")
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
    expect(rendered).toContain("center: inward-work")
    expect(rendered).toContain("inner status: idle (pending queued)")
    expect(rendered).not.toContain("current session:")
    expect(rendered).not.toContain("freshest friend-facing session:")
    expect(rendered).not.toContain("obligation:")
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
    })).toContain("suggested bridge: attach bridge-1 -> cli/session")
  })

  it("refuses to auto-suggest when more than one non-blocked cross-relationship target candidate is live", async () => {
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

    expect(frame.bridgeSuggestion).toBeNull()
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
})
