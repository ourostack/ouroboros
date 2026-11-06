import { describe, expect, it } from "vitest"

describe("outlook machine view", () => {
  it("builds a machine-overview-first view with daemon truth, entrypoints, and attention-sorted agents", async () => {
    const { buildOutlookMachineView } = await import("../../../heart/outlook/outlook-view")

    const view = buildOutlookMachineView({
      machine: {
        productName: "Ouro Mailbox",
        observedAt: "2026-03-30T07:35:00.000Z",
        runtime: {
          version: "0.1.0-alpha.109",
          lastUpdated: "2026-03-30T00:30:24.000Z",
          repoRoot: "/mock/repo",
          configFingerprint: "cfg-123",
        },
        agentCount: 3,
        freshness: {
          status: "fresh",
          latestActivityAt: "2026-03-30T07:34:00.000Z",
          ageMs: 60_000,
        },
        degraded: {
          status: "degraded",
          issues: [{ code: "agent-degraded", detail: "alpha: task scanner unreadable" }],
        },
        agents: [
          {
            agentName: "beta",
            enabled: true,
            freshness: { status: "fresh", latestActivityAt: "2026-03-30T07:34:00.000Z", ageMs: 60_000 },
            degraded: { status: "ok", issues: [] },
            tasks: { liveCount: 1, blockedCount: 0 },
            obligations: { openCount: 1 },
            coding: { activeCount: 1, blockedCount: 0 },
          },
          {
            agentName: "alpha",
            enabled: true,
            freshness: { status: "fresh", latestActivityAt: "2026-03-30T07:32:00.000Z", ageMs: 180_000 },
            degraded: { status: "degraded", issues: [{ code: "task-parse-error", detail: "bad frontmatter" }] },
            tasks: { liveCount: 2, blockedCount: 1 },
            obligations: { openCount: 2 },
            coding: { activeCount: 0, blockedCount: 1 },
          },
          {
            agentName: "gamma",
            enabled: false,
            freshness: { status: "stale", latestActivityAt: "2026-03-28T07:34:00.000Z", ageMs: 172_800_000 },
            degraded: { status: "ok", issues: [] },
            tasks: { liveCount: 0, blockedCount: 0 },
            obligations: { openCount: 0 },
            coding: { activeCount: 0, blockedCount: 0 },
          },
        ],
      },
      daemon: {
        status: "running",
        health: "warn",
        mode: "dev",
        socketPath: "/tmp/ouro.sock",
        outlookUrl: "http://127.0.0.1:4310/outlook",
        entryPath: "/mock/repo/dist/heart/daemon/daemon-entry.js",
        workerCount: 2,
        senseCount: 5,
      },
    })

    expect(view.overview).toEqual(expect.objectContaining({
      productName: "Ouro Mailbox",
      primaryEntryPoint: "http://127.0.0.1:4310/outlook",
      daemon: expect.objectContaining({
        status: "running",
        health: "warn",
        mode: "dev",
        workerCount: 2,
        senseCount: 5,
      }),
      runtime: expect.objectContaining({
        version: "0.1.0-alpha.109",
        repoRoot: "/mock/repo",
      }),
      freshness: expect.objectContaining({ status: "fresh" }),
      degraded: expect.objectContaining({ status: "degraded" }),
      totals: {
        agents: 3,
        enabledAgents: 2,
        degradedAgents: 1,
        staleAgents: 1,
        liveTasks: 3,
        blockedTasks: 1,
        openObligations: 3,
        activeCodingAgents: 1,
        blockedCodingAgents: 1,
      },
      entrypoints: [
        { kind: "web", label: "Open Mailbox", target: "http://127.0.0.1:4310/outlook" },
        { kind: "cli", label: "CLI JSON", target: "ouro mailbox --json" },
      ],
    }))

    // Sorted by recency: beta (07:34) > alpha (07:32) > gamma (03-28)
    expect(view.agents.map((agent) => agent.agentName)).toEqual(["beta", "alpha", "gamma"])
    expect(view.agents.map((agent) => agent.attention)).toEqual([
      expect.objectContaining({ level: "active", label: "Active" }),
      expect.objectContaining({ level: "degraded", label: "Degraded" }),
      expect.objectContaining({ level: "stale", label: "Stale" }),
    ])
  })

  it("treats healthy idle machines as calm and keeps agent order stable within the same attention band", async () => {
    const { buildOutlookMachineView } = await import("../../../heart/outlook/outlook-view")

    const view = buildOutlookMachineView({
      machine: {
        productName: "Ouro Mailbox",
        observedAt: "2026-03-30T07:35:00.000Z",
        runtime: {
          version: "0.1.0-alpha.109",
          lastUpdated: "2026-03-30T00:30:24.000Z",
          repoRoot: "/mock/repo",
          configFingerprint: "cfg-123",
        },
        agentCount: 2,
        freshness: {
          status: "unknown",
          latestActivityAt: null,
          ageMs: null,
        },
        degraded: {
          status: "ok",
          issues: [],
        },
        agents: [
          {
            agentName: "alpha",
            enabled: true,
            freshness: { status: "unknown", latestActivityAt: null, ageMs: null },
            degraded: { status: "ok", issues: [] },
            tasks: { liveCount: 0, blockedCount: 0 },
            obligations: { openCount: 0 },
            coding: { activeCount: 0, blockedCount: 0 },
          },
          {
            agentName: "beta",
            enabled: true,
            freshness: { status: "unknown", latestActivityAt: null, ageMs: null },
            degraded: { status: "ok", issues: [] },
            tasks: { liveCount: 0, blockedCount: 0 },
            obligations: { openCount: 0 },
            coding: { activeCount: 0, blockedCount: 0 },
          },
        ],
      },
      daemon: {
        status: "running",
        health: "ok",
        mode: "production",
        socketPath: "/tmp/ouro.sock",
        outlookUrl: "http://127.0.0.1:4310/outlook",
        entryPath: "/mock/repo/dist/heart/daemon/daemon-entry.js",
        workerCount: 0,
        senseCount: 0,
      },
    })

    expect(view.overview.mood).toBe("calm")
    expect(view.agents.map((agent) => agent.agentName)).toEqual(["alpha", "beta"])
    expect(view.agents.every((agent) => agent.attention.level === "idle")).toBe(true)
  })

  it("marks stale but non-degraded machines as watchful and blocked agents as blocked", async () => {
    const { buildOutlookMachineView } = await import("../../../heart/outlook/outlook-view")

    const view = buildOutlookMachineView({
      machine: {
        productName: "Ouro Mailbox",
        observedAt: "2026-03-30T07:35:00.000Z",
        runtime: {
          version: "0.1.0-alpha.109",
          lastUpdated: "2026-03-30T00:30:24.000Z",
          repoRoot: "/mock/repo",
          configFingerprint: "cfg-123",
        },
        agentCount: 1,
        freshness: {
          status: "stale",
          latestActivityAt: "2026-03-28T07:35:00.000Z",
          ageMs: 172_800_000,
        },
        degraded: {
          status: "ok",
          issues: [],
        },
        agents: [
          {
            agentName: "alpha",
            enabled: true,
            freshness: { status: "fresh", latestActivityAt: "2026-03-30T07:35:00.000Z", ageMs: 0 },
            degraded: { status: "ok", issues: [] },
            tasks: { liveCount: 1, blockedCount: 1 },
            obligations: { openCount: 0 },
            coding: { activeCount: 0, blockedCount: 0 },
          },
        ],
      },
      daemon: {
        status: "running",
        health: "ok",
        mode: "production",
        socketPath: "/tmp/ouro.sock",
        outlookUrl: "http://127.0.0.1:4310/outlook",
        entryPath: "/mock/repo/dist/heart/daemon/daemon-entry.js",
        workerCount: 1,
        senseCount: 1,
      },
    })

    expect(view.overview.mood).toBe("watchful")
    expect(view.agents).toEqual([
      expect.objectContaining({
        agentName: "alpha",
        attention: { level: "blocked", label: "Blocked" },
      }),
    ])
  })
})

describe("outlook agent view", () => {
  it("builds a read-only human-default agent view with summary-only inward work and recent activity", async () => {
    const { buildOutlookAgentView } = await import("../../../heart/outlook/outlook-view")

    const view = buildOutlookAgentView({
      agent: {
        productName: "Ouro Mailbox",
        agentName: "slugger",
        agentRoot: "/mock/slugger.ouro",
        enabled: true,
        provider: "anthropic",
        senses: ["cli", "bluebubbles"],
        freshness: {
          status: "fresh",
          latestActivityAt: "2026-03-30T07:38:00.000Z",
          ageMs: 30_000,
        },
        degraded: {
          status: "ok",
          issues: [],
        },
        tasks: {
          totalCount: 4,
          liveCount: 2,
          blockedCount: 1,
          byStatus: {
            drafting: 0,
            processing: 1,
            validating: 0,
            collaborating: 0,
            paused: 0,
            blocked: 1,
            done: 2,
          },
          liveTaskNames: ["Build Outlook", "Review daemon seam"],
          actionRequired: ["Resolve failing Teams auth"],
          activeBridges: ["ouroboros"],
        },
        obligations: {
          openCount: 2,
          items: [
            {
              id: "ob-1",
              status: "pending",
              content: "Reply to Ari",
              updatedAt: "2026-03-30T07:37:00.000Z",
              nextAction: "send reply",
            },
          ],
        },
        sessions: {
          liveCount: 1,
          items: [
            {
              friendId: "ari",
              friendName: "Ari",
              channel: "bluebubbles",
              key: "bb:ari",
              sessionPath: "/mock/sessions/ari.json",
              lastActivityAt: "2026-03-30T07:38:00.000Z",
              activitySource: "friend-facing",
            },
          ],
        },
        inner: {
          visibility: "summary",
          status: "working",
          hasPending: true,
          surfacedSummary: "Ship the daemon seam",
          origin: {
            friendId: "ari",
            channel: "bluebubbles",
            key: "bb:ari",
            friendName: "Ari",
          },
          obligationStatus: "pending",
          latestActivityAt: "2026-03-30T07:35:00.000Z",
        },
        coding: {
          totalCount: 2,
          activeCount: 1,
          blockedCount: 1,
          items: [
            {
              id: "code-1",
              runner: "claude-code",
              status: "running",
              checkpoint: "Implementing view model",
              taskRef: "task-123",
              workdir: "/mock/repo",
              originSession: {
                friendId: "ari",
                channel: "bluebubbles",
                key: "bb:ari",
              },
              lastActivityAt: "2026-03-30T07:39:00.000Z",
            },
            {
              id: "code-2",
              runner: "codex",
              status: "stalled",
              checkpoint: "Waiting on daemon contract",
              taskRef: null,
              workdir: "/mock/repo",
              originSession: null,
              lastActivityAt: "2026-03-30T07:20:00.000Z",
            },
          ],
        },
      },
      viewer: { kind: "human" },
    })

    expect(view).toEqual(expect.objectContaining({
      interactionModel: "read-only",
      viewer: {
        kind: "human",
        innerDetail: "summary",
      },
      agent: expect.objectContaining({
        agentName: "slugger",
        provider: "anthropic",
        senses: ["cli", "bluebubbles"],
        freshness: expect.objectContaining({ status: "fresh" }),
      }),
      work: expect.objectContaining({
        tasks: expect.objectContaining({ liveCount: 2, blockedCount: 1 }),
        obligations: expect.objectContaining({ openCount: 2 }),
        coding: expect.objectContaining({ activeCount: 1, blockedCount: 1 }),
        bridges: ["ouroboros"],
      }),
      inner: {
        mode: "summary",
        status: "working",
        summary: "Ship the daemon seam",
        hasPending: true,
      },
    }))

    expect(view.activity.recent).toEqual([
      expect.objectContaining({ kind: "coding", at: "2026-03-30T07:39:00.000Z" }),
      expect.objectContaining({ kind: "session", at: "2026-03-30T07:38:00.000Z" }),
      expect.objectContaining({ kind: "obligation", at: "2026-03-30T07:37:00.000Z" }),
      expect.objectContaining({ kind: "inner", at: "2026-03-30T07:35:00.000Z" }),
    ])
  })

  it("allows explicit deep inward drill-down for self-inspection without changing read-only behavior", async () => {
    const { buildOutlookAgentView } = await import("../../../heart/outlook/outlook-view")

    const view = buildOutlookAgentView({
      agent: {
        productName: "Ouro Mailbox",
        agentName: "slugger",
        agentRoot: "/mock/slugger.ouro",
        enabled: true,
        provider: "anthropic",
        senses: ["cli"],
        freshness: {
          status: "fresh",
          latestActivityAt: "2026-03-30T07:38:00.000Z",
          ageMs: 30_000,
        },
        degraded: {
          status: "ok",
          issues: [],
        },
        tasks: {
          totalCount: 1,
          liveCount: 0,
          blockedCount: 0,
          byStatus: {
            drafting: 0,
            processing: 0,
            validating: 0,
            collaborating: 0,
            paused: 0,
            blocked: 0,
            done: 1,
          },
          liveTaskNames: [],
          actionRequired: [],
          activeBridges: [],
        },
        obligations: {
          openCount: 0,
          items: [],
        },
        sessions: {
          liveCount: 0,
          items: [],
        },
        inner: {
          visibility: "summary",
          status: "working",
          hasPending: true,
          surfacedSummary: "Untangle the daemon state",
          origin: {
            friendId: "self",
            channel: "inner",
            key: "dialog",
            friendName: "self",
          },
          obligationStatus: "pending",
          latestActivityAt: "2026-03-30T07:35:00.000Z",
        },
        coding: {
          totalCount: 0,
          activeCount: 0,
          blockedCount: 0,
          items: [],
        },
      },
      viewer: { kind: "agent-self", agentName: "slugger", innerDetail: "deep" },
    })

    expect(view.interactionModel).toBe("read-only")
    expect(view.inner).toEqual({
      mode: "deep",
      status: "working",
      summary: "Untangle the daemon state",
      hasPending: true,
      origin: {
        friendId: "self",
        channel: "inner",
        key: "dialog",
        friendName: "self",
      },
      obligationStatus: "pending",
    })
  })

  it("defaults to a human summary viewer and filters recent activity down to valid truth-bearing items", async () => {
    const { buildOutlookAgentView } = await import("../../../heart/outlook/outlook-view")

    const view = buildOutlookAgentView({
      agent: {
        productName: "Ouro Mailbox",
        agentName: "slugger",
        agentRoot: "/mock/slugger.ouro",
        enabled: true,
        provider: null,
        senses: [],
        freshness: {
          status: "unknown",
          latestActivityAt: null,
          ageMs: null,
        },
        degraded: {
          status: "ok",
          issues: [],
        },
        tasks: {
          totalCount: 0,
          liveCount: 0,
          blockedCount: 0,
          byStatus: {
            drafting: 0,
            processing: 0,
            validating: 0,
            collaborating: 0,
            paused: 0,
            blocked: 0,
            done: 0,
          },
          liveTaskNames: [],
          actionRequired: [],
          activeBridges: [],
        },
        obligations: {
          openCount: 1,
          items: [
            {
              id: "ob-1",
              status: "pending",
              content: "Follow up with daemon health",
              updatedAt: "2026-03-30T07:36:00.000Z",
              nextAction: null,
            },
          ],
        },
        sessions: {
          liveCount: 1,
          items: [
            {
              friendId: "ari",
              friendName: "Ari",
              channel: "cli",
              key: "cli:ari",
              sessionPath: "/mock/sessions/ari.json",
              lastActivityAt: "2026-03-30T07:37:00.000Z",
              activitySource: "friend-facing",
            },
          ],
        },
        inner: {
          visibility: "summary",
          status: "working",
          hasPending: false,
          surfacedSummary: null,
          origin: null,
          obligationStatus: null,
          latestActivityAt: "2026-03-30T07:35:00.000Z",
        },
        coding: {
          totalCount: 2,
          activeCount: 1,
          blockedCount: 1,
          items: [
            {
              id: "code-1",
              runner: "codex",
              status: "stalled",
              checkpoint: null,
              taskRef: null,
              workdir: "/mock/repo",
              originSession: null,
              lastActivityAt: "2026-03-30T07:38:00.000Z",
            },
            {
              id: "code-2",
              runner: "claude-code",
              status: "running",
              checkpoint: "Bad timestamp should vanish",
              taskRef: null,
              workdir: "/mock/repo",
              originSession: null,
              lastActivityAt: "not-a-date",
            },
          ],
        },
      },
    })

    expect(view.viewer).toEqual({
      kind: "human",
      agentName: undefined,
      innerDetail: "summary",
    })
    expect(view.inner).toEqual({
      mode: "summary",
      status: "working",
      summary: null,
      hasPending: false,
    })
    expect(view.activity.recent).toEqual([
      {
        kind: "coding",
        at: "2026-03-30T07:38:00.000Z",
        label: "codex stalled",
        detail: "/mock/repo",
      },
      {
        kind: "session",
        at: "2026-03-30T07:37:00.000Z",
        label: "Ari via cli",
        detail: "cli:ari",
      },
      {
        kind: "obligation",
        at: "2026-03-30T07:36:00.000Z",
        label: "Follow up with daemon health",
        detail: "pending",
      },
      {
        kind: "inner",
        at: "2026-03-30T07:35:00.000Z",
        label: "working",
        detail: "no linked obligation",
      },
    ])
  })

  it("omits inner activity when no latest inner timestamp exists", async () => {
    const { buildOutlookAgentView } = await import("../../../heart/outlook/outlook-view")

    const view = buildOutlookAgentView({
      agent: {
        productName: "Ouro Mailbox",
        agentName: "slugger",
        agentRoot: "/mock/slugger.ouro",
        enabled: true,
        provider: null,
        senses: [],
        freshness: {
          status: "unknown",
          latestActivityAt: null,
          ageMs: null,
        },
        degraded: {
          status: "ok",
          issues: [],
        },
        tasks: {
          totalCount: 0,
          liveCount: 0,
          blockedCount: 0,
          byStatus: {
            drafting: 0,
            processing: 0,
            validating: 0,
            collaborating: 0,
            paused: 0,
            blocked: 0,
            done: 0,
          },
          liveTaskNames: [],
          actionRequired: [],
          activeBridges: [],
        },
        obligations: {
          openCount: 0,
          items: [],
        },
        sessions: {
          liveCount: 1,
          items: [
            {
              friendId: "ari",
              friendName: "Ari",
              channel: "cli",
              key: "cli:ari",
              sessionPath: "/mock/sessions/ari.json",
              lastActivityAt: "2026-03-30T07:37:00.000Z",
              activitySource: "friend-facing",
            },
          ],
        },
        inner: {
          visibility: "summary",
          status: "idle",
          hasPending: false,
          surfacedSummary: null,
          origin: null,
          obligationStatus: null,
          latestActivityAt: null,
        },
        coding: {
          totalCount: 0,
          activeCount: 0,
          blockedCount: 0,
          items: [],
        },
      },
    })

    expect(view.activity.recent).toEqual([
      {
        kind: "session",
        at: "2026-03-30T07:37:00.000Z",
        label: "Ari via cli",
        detail: "cli:ari",
      },
    ])
  })
})
