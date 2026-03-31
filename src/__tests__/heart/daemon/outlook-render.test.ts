import { describe, expect, it } from "vitest"

describe("outlook render", () => {
  it("renders a machine-first Outlook shell with agent drill-down affordances and polling hooks", async () => {
    const { renderOutlookApp } = await import("../../../heart/daemon/outlook-render")

    const html = renderOutlookApp({
      origin: "http://127.0.0.1:4310",
      machine: {
        productName: "Ouro Outlook",
        observedAt: "2026-03-30T07:35:00.000Z",
        runtime: {
          version: "0.1.0-alpha.109",
          lastUpdated: "2026-03-30T00:30:24.000Z",
          repoRoot: "/mock/repo",
          configFingerprint: "cfg-123",
        },
        agentCount: 2,
        freshness: {
          status: "fresh",
          latestActivityAt: "2026-03-30T07:34:00.000Z",
          ageMs: 60_000,
        },
        degraded: {
          status: "ok",
          issues: [],
        },
        agents: [
          {
            agentName: "slugger",
            enabled: true,
            freshness: { status: "fresh", latestActivityAt: "2026-03-30T07:34:00.000Z", ageMs: 60_000 },
            degraded: { status: "ok", issues: [] },
            tasks: { liveCount: 2, blockedCount: 1 },
            obligations: { openCount: 1 },
            coding: { activeCount: 1, blockedCount: 0 },
          },
          {
            agentName: "ouroboros",
            enabled: true,
            freshness: { status: "stale", latestActivityAt: "2026-03-29T07:34:00.000Z", ageMs: 86_400_000 },
            degraded: { status: "ok", issues: [] },
            tasks: { liveCount: 0, blockedCount: 0 },
            obligations: { openCount: 0 },
            coding: { activeCount: 0, blockedCount: 0 },
          },
        ],
      },
      machineView: {
        overview: {
          productName: "Ouro Outlook",
          observedAt: "2026-03-30T07:35:00.000Z",
          primaryEntryPoint: "http://127.0.0.1:4310/outlook",
          daemon: {
            status: "running",
            health: "ok",
            mode: "dev",
            socketPath: "/tmp/ouro.sock",
            outlookUrl: "http://127.0.0.1:4310/outlook",
            entryPath: "/mock/repo/dist/heart/daemon/daemon-entry.js",
            workerCount: 2,
            senseCount: 4,
          },
          runtime: {
            version: "0.1.0-alpha.109",
            lastUpdated: "2026-03-30T00:30:24.000Z",
            repoRoot: "/mock/repo",
            configFingerprint: "cfg-123",
          },
          freshness: {
            status: "fresh",
            latestActivityAt: "2026-03-30T07:34:00.000Z",
            ageMs: 60_000,
          },
          degraded: {
            status: "ok",
            issues: [],
          },
          totals: {
            agents: 2,
            enabledAgents: 2,
            degradedAgents: 0,
            staleAgents: 1,
            liveTasks: 2,
            blockedTasks: 1,
            openObligations: 1,
            activeCodingAgents: 1,
            blockedCodingAgents: 0,
          },
          mood: "watchful",
          entrypoints: [
            { kind: "web", label: "Open Outlook", target: "http://127.0.0.1:4310/outlook" },
            { kind: "cli", label: "CLI JSON", target: "ouro outlook --json" },
          ],
        },
        agents: [
          {
            agentName: "slugger",
            enabled: true,
            freshness: { status: "fresh", latestActivityAt: "2026-03-30T07:34:00.000Z", ageMs: 60_000 },
            degraded: { status: "ok", issues: [] },
            tasks: { liveCount: 2, blockedCount: 1 },
            obligations: { openCount: 1 },
            coding: { activeCount: 1, blockedCount: 0 },
            attention: { level: "blocked", label: "Blocked" },
          },
          {
            agentName: "ouroboros",
            enabled: true,
            freshness: { status: "stale", latestActivityAt: "2026-03-29T07:34:00.000Z", ageMs: 86_400_000 },
            degraded: { status: "ok", issues: [] },
            tasks: { liveCount: 0, blockedCount: 0 },
            obligations: { openCount: 0 },
            coding: { activeCount: 0, blockedCount: 0 },
            attention: { level: "stale", label: "Needs reorientation" },
          },
        ],
      },
    })

    expect(html).toContain("<title>Ouro Outlook</title>")
    expect(html).toContain('data-outlook-app="Ouro Outlook"')
    expect(html).toContain("Machine Overview")
    expect(html).toContain("ouro outlook --json")
    expect(html).toContain('data-agent-name="slugger"')
    expect(html).toContain('data-outlook-agent-list')
    expect(html).toContain('data-outlook-agent-panel')
    expect(html).toContain("/outlook/api/machine")
    expect(html).toContain("/outlook/api/agents/")
    expect(html).toContain("setInterval(")
    expect(html).toContain("Cormorant Garamond")
    expect(html).toContain("--outlook-void")
    expect(html).toContain("Regain the plot together.")
  })

  it("renders a graceful empty-state shell when no agents are currently visible", async () => {
    const { renderOutlookApp } = await import("../../../heart/daemon/outlook-render")

    const html = renderOutlookApp({
      origin: "http://127.0.0.1:4310",
      machine: {
        productName: "Ouro Outlook",
        observedAt: "2026-03-30T07:35:00.000Z",
        runtime: {
          version: "0.1.0-alpha.109",
          lastUpdated: "2026-03-30T00:30:24.000Z",
          repoRoot: "/mock/repo",
          configFingerprint: "cfg-123",
        },
        agentCount: 0,
        freshness: {
          status: "unknown",
          latestActivityAt: null,
          ageMs: null,
        },
        degraded: {
          status: "ok",
          issues: [],
        },
        agents: [],
      },
      machineView: {
        overview: {
          productName: "Ouro Outlook",
          observedAt: "2026-03-30T07:35:00.000Z",
          primaryEntryPoint: "http://127.0.0.1:4310/outlook",
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
          runtime: {
            version: "0.1.0-alpha.109",
            lastUpdated: "2026-03-30T00:30:24.000Z",
            repoRoot: "/mock/repo",
            configFingerprint: "cfg-123",
          },
          freshness: {
            status: "unknown",
            latestActivityAt: null,
            ageMs: null,
          },
          degraded: {
            status: "ok",
            issues: [],
          },
          totals: {
            agents: 0,
            enabledAgents: 0,
            degradedAgents: 0,
            staleAgents: 0,
            liveTasks: 0,
            blockedTasks: 0,
            openObligations: 0,
            activeCodingAgents: 0,
            blockedCodingAgents: 0,
          },
          mood: "calm",
          entrypoints: [
            { kind: "web", label: "Open Outlook", target: "http://127.0.0.1:4310/outlook" },
            { kind: "cli", label: "CLI JSON", target: "ouro outlook --json" },
          ],
        },
        agents: [],
      },
    })

    expect(html).toContain("No agents are visible yet.")
    expect(html).toContain("When the daemon sees enabled bundles on this machine, they will gather here.")
    expect(html).toContain('data-outlook-agent-panel')
  })

  it("falls back to raw machine truth when no machine view is provided", async () => {
    const { renderOutlookApp } = await import("../../../heart/daemon/outlook-render")

    const html = renderOutlookApp({
      origin: "http://127.0.0.1:4310",
      machine: {
        observedAt: "2026-03-30T07:35:00.000Z",
        runtime: {
          version: "0.1.0-alpha.109",
          lastUpdated: "2026-03-30T00:30:24.000Z",
          repoRoot: "/mock/repo",
          configFingerprint: "cfg-123",
        },
        agentCount: 2,
        freshness: {
          status: "stale",
          latestActivityAt: null,
          ageMs: null,
        },
        degraded: {
          status: "degraded",
          issues: [{ code: "agent-degraded", detail: "scanner unreadable" }],
        },
        agents: [
          {
            agentName: "slugger",
            enabled: true,
            freshness: { status: "stale", latestActivityAt: null, ageMs: null },
            degraded: { status: "degraded", issues: [{ code: "agent-degraded", detail: "scanner unreadable" }] },
            tasks: { liveCount: 3, blockedCount: 2 },
            obligations: { openCount: 4 },
            coding: { activeCount: 1, blockedCount: 1 },
          },
          {
            agentName: "ouroboros",
            enabled: false,
            freshness: { status: "fresh", latestActivityAt: "2026-03-30T07:34:00.000Z", ageMs: 60_000 },
            degraded: { status: "ok", issues: [] },
          },
        ],
      } as any,
    })

    expect(html).toContain("<title>Ouro Outlook</title>")
    expect(html).toContain("Visible agents")
    expect(html).toContain(">2<")
    expect(html).toContain(">3<")
    expect(html).toContain(">4<")
    expect(html).toContain(">1<")
    expect(html).toContain("Freshness</span><strong>stale</strong>")
    expect(html).toContain("Degraded</span><strong>degraded</strong>")
    expect(html).toContain("http://127.0.0.1:4310/outlook")
  })
})
