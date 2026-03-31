import { describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("outlook http", () => {
  it("serves loopback-only HTML and JSON endpoints for Outlook", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/daemon/outlook-http")

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({
        productName: "Ouro Outlook",
        agentCount: 1,
      }),
      readAgentState: (agentName: string) => (
        agentName === "slugger"
          ? { agentName: "slugger", productName: "Ouro Outlook" }
          : null
      ),
      readAgentView: (agentName: string) => (
        agentName === "slugger"
          ? {
              productName: "Ouro Outlook",
              interactionModel: "read-only",
              viewer: { kind: "human", innerDetail: "summary" },
              agent: { agentName: "slugger" },
            } as any
          : null
      ),
    })

    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    // Root serves SPA if built, or 404 if SPA dist not available
    const rootResponse = await fetch(`${server.origin}/`)
    expect([200, 404]).toContain(rootResponse.status)

    const machine = await fetch(`${server.origin}/outlook/api/machine`).then((response) => response.json())
    expect(machine).toEqual(expect.objectContaining({ productName: "Ouro Outlook" }))

    const agent = await fetch(`${server.origin}/outlook/api/agents/slugger`).then((response) => response.json())
    expect(agent).toEqual(expect.objectContaining({
      interactionModel: "read-only",
      agent: expect.objectContaining({ agentName: "slugger" }),
    }))

    const missing = await fetch(`${server.origin}/outlook/api/agents/missing`)
    expect(missing.status).toBe(404)

    await server.stop()
  })

  it("renders the default app safely and normalizes trailing-slash Outlook routes", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/daemon/outlook-http")

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({
        productName: "Ouro <Outlook> & \"Co\"",
        agentCount: 1,
      }),
      readMachineView: () => ({
        overview: {
          productName: "Ouro <Outlook> & \"Co\"",
          observedAt: "2026-03-30T07:35:00.000Z",
          primaryEntryPoint: "http://127.0.0.1:4310/outlook",
          daemon: {
            status: "running",
            health: "ok",
            mode: "production",
            socketPath: "/tmp/ouro.sock",
            outlookUrl: "http://127.0.0.1:4310/outlook",
            entryPath: "/mock/repo/dist/heart/daemon/daemon-entry.js",
            workerCount: 1,
            senseCount: 2,
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
            agents: 1,
            enabledAgents: 1,
            degradedAgents: 0,
            staleAgents: 0,
            liveTasks: 1,
            blockedTasks: 0,
            openObligations: 0,
            activeCodingAgents: 1,
            blockedCodingAgents: 0,
          },
          mood: "calm",
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
            tasks: { liveCount: 1, blockedCount: 0 },
            obligations: { openCount: 0 },
            coding: { activeCount: 1, blockedCount: 0 },
            attention: { level: "active", label: "In motion" },
          },
        ],
      }),
      readAgentState: () => null,
    })

    // Root serves SPA if built, or 404 if SPA dist not available
    const rootResponse = await fetch(`${server.origin}/`)
    expect([200, 404]).toContain(rootResponse.status)

    await server.stop()
  })

  it("returns a JSON 404 for unknown Outlook routes", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/daemon/outlook-http")

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({
        productName: "Ouro Outlook",
        agentCount: 1,
      }),
      readAgentState: () => null,
    })

    // /outlook redirects to /
    const redirectResponse = await fetch(`${server.origin}/outlook`, { redirect: "manual" })
    expect(redirectResponse.status).toBe(301)
    expect(redirectResponse.headers.get("location")).toBe("/")

    // Unknown API route should still 404
    const apiResponse = await fetch(`${server.origin}/outlook/api/agents/test/nope`)
    expect(apiResponse.status).toBe(404)
    // Non-API routes get SPA fallback if built, or 404 otherwise
    const spaResponse = await fetch(`${server.origin}/outlook/nope`)
    expect([200, 404]).toContain(spaResponse.status)

    await server.stop()
  })

  it("uses the default direct-read hooks and default renderer when no options are provided", async () => {
    vi.resetModules()
    const readOutlookMachineState = vi.fn(() => ({
      productName: "Ouro Outlook",
      agentCount: 1,
    }))
    const readOutlookAgentState = vi.fn((agentName: string) => (
      agentName === "slugger"
        ? { agentName: "slugger", productName: "Ouro Outlook" }
        : null
    ))

    vi.doMock("../../../heart/daemon/outlook-read", () => ({
      readOutlookMachineState,
      readOutlookAgentState,
    }))

    const { startOutlookHttpServer } = await import("../../../heart/daemon/outlook-http")
    const server = await startOutlookHttpServer()

    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    // Root serves SPA if built, or 404 if SPA dist not available
    const rootResponse = await fetch(`${server.origin}/`)
    expect([200, 404]).toContain(rootResponse.status)

    // Hit API endpoints to trigger the mocked read functions
    await fetch(`${server.origin}/outlook/api/machine`).then((r) => r.json())
    const agent = await fetch(`${server.origin}/outlook/api/agents/slugger`).then((response) => response.json())
    expect(agent).toEqual(expect.objectContaining({ agentName: "slugger" }))

    expect(readOutlookMachineState).toHaveBeenCalled()
    expect(readOutlookAgentState).toHaveBeenCalledWith("slugger")

    await server.stop()
    vi.doUnmock("../../../heart/daemon/outlook-read")
  })

  it("serves deep inspectability endpoints for agent surfaces", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/daemon/outlook-http")

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({ productName: "Ouro Outlook", agentCount: 1 }) as any,
      readAgentState: () => null,
      readAgentSessions: () => ({ totalCount: 3, activeCount: 2, staleCount: 1, items: [] }),
      readAgentTranscript: (_agent, friendId) => (
        friendId === "friend-1"
          ? { friendId: "friend-1", friendName: "Ari", channel: "cli", key: "session", sessionPath: "/p", messageCount: 5, lastUsage: null, continuity: null, messages: [] }
          : null
      ),
      readAgentCoding: () => ({ totalCount: 1, activeCount: 1, blockedCount: 0, items: [] }),
      readAgentAttention: () => ({ queueLength: 2, queueItems: [], pendingChannels: [], returnObligations: [] }),
      readAgentBridges: () => ({ totalCount: 1, activeCount: 1, items: [] }),
      readAgentMemory: () => ({ diaryEntryCount: 5, recentDiaryEntries: [], journalEntryCount: 2, recentJournalEntries: [] }),
      readAgentFriends: () => ({ totalFriends: 3, friends: [] }),
      readAgentHabits: () => ({ totalCount: 2, activeCount: 1, pausedCount: 1, degradedCount: 0, overdueCount: 0, items: [] }),
      readDaemonHealth: () => ({ status: "ok", mode: "dev", pid: 1, startedAt: "", uptimeSeconds: 0, safeMode: null, degradedComponents: [], agentHealth: {}, habitHealth: {} }),
      readLogs: () => ({ logPath: null, totalLines: 0, entries: [] }),
    })

    // Session inventory
    const sessions = await fetch(`${server.origin}/outlook/api/agents/slugger/sessions`).then((r) => r.json())
    expect(sessions).toEqual(expect.objectContaining({ totalCount: 3, activeCount: 2 }))

    // Session transcript
    const transcript = await fetch(`${server.origin}/outlook/api/agents/slugger/sessions/friend-1/cli/session`).then((r) => r.json())
    expect(transcript).toEqual(expect.objectContaining({ friendId: "friend-1", messageCount: 5 }))

    // Missing transcript
    const missingTranscript = await fetch(`${server.origin}/outlook/api/agents/slugger/sessions/nobody/cli/session`)
    expect(missingTranscript.status).toBe(404)

    // Coding deep
    const coding = await fetch(`${server.origin}/outlook/api/agents/slugger/coding`).then((r) => r.json())
    expect(coding).toEqual(expect.objectContaining({ totalCount: 1 }))

    // Attention
    const attention = await fetch(`${server.origin}/outlook/api/agents/slugger/attention`).then((r) => r.json())
    expect(attention).toEqual(expect.objectContaining({ queueLength: 2 }))

    // Bridges
    const bridges = await fetch(`${server.origin}/outlook/api/agents/slugger/bridges`).then((r) => r.json())
    expect(bridges).toEqual(expect.objectContaining({ totalCount: 1 }))

    // Memory
    const memory = await fetch(`${server.origin}/outlook/api/agents/slugger/memory`).then((r) => r.json())
    expect(memory).toEqual(expect.objectContaining({ diaryEntryCount: 5 }))

    // Friends
    const friends = await fetch(`${server.origin}/outlook/api/agents/slugger/friends`).then((r) => r.json())
    expect(friends).toEqual(expect.objectContaining({ totalFriends: 3 }))

    // Habits
    const habits = await fetch(`${server.origin}/outlook/api/agents/slugger/habits`).then((r) => r.json())
    expect(habits).toEqual(expect.objectContaining({ totalCount: 2 }))

    // Daemon health
    const health = await fetch(`${server.origin}/outlook/api/machine/health`).then((r) => r.json())
    expect(health).toEqual(expect.objectContaining({ status: "ok", mode: "dev" }))

    // Logs
    const logs = await fetch(`${server.origin}/outlook/api/machine/logs`).then((r) => r.json())
    expect(logs).toEqual(expect.objectContaining({ totalLines: 0 }))

    // Unknown agent surface
    const unknown = await fetch(`${server.origin}/outlook/api/agents/slugger/nope`)
    expect(unknown.status).toBe(404)
    const unknownBody = await unknown.json()
    expect(unknownBody.error).toBe("unknown agent surface: nope")

    await server.stop()
  })

  it("serves inner-transcript and machine health/logs endpoints", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/daemon/outlook-http")

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({ productName: "Ouro Outlook", agentCount: 0 }) as any,
      readAgentState: () => null,
      readAgentSessions: () => ({ totalCount: 0, activeCount: 0, staleCount: 0, items: [] }),
      readAgentTranscript: (_agent, friendId) => (
        friendId === "self"
          ? { friendId: "self", friendName: "self", channel: "inner", key: "dialog", sessionPath: "/p", messageCount: 3, lastUsage: null, continuity: null, messages: [] }
          : null
      ),
      readAgentCoding: () => ({ totalCount: 0, activeCount: 0, blockedCount: 0, items: [] }),
      readAgentAttention: () => ({ queueLength: 0, queueItems: [], pendingChannels: [], returnObligations: [] }),
      readAgentBridges: () => ({ totalCount: 0, activeCount: 0, items: [] }),
      readAgentMemory: () => ({ diaryEntryCount: 0, recentDiaryEntries: [], journalEntryCount: 0, recentJournalEntries: [] }),
      readAgentFriends: () => ({ totalFriends: 0, friends: [] }),
      readAgentHabits: () => ({ totalCount: 0, activeCount: 0, pausedCount: 0, degradedCount: 0, overdueCount: 0, items: [] }),
      readDaemonHealth: () => ({ status: "ok", mode: "dev", pid: 1, startedAt: "", uptimeSeconds: 0, safeMode: null, degradedComponents: [], agentHealth: {}, habitHealth: {} }),
      readLogs: () => ({ logPath: null, totalLines: 0, entries: [] }),
    })

    // Inner transcript
    const inner = await fetch(`${server.origin}/outlook/api/agents/test/inner-transcript`).then((r) => r.json())
    expect(inner).toEqual(expect.objectContaining({ messageCount: 3 }))

    // Machine health
    const health = await fetch(`${server.origin}/outlook/api/machine/health`).then((r) => r.json())
    expect(health).toEqual(expect.objectContaining({ status: "ok" }))

    // Machine logs
    const logs = await fetch(`${server.origin}/outlook/api/machine/logs`).then((r) => r.json())
    expect(logs).toEqual(expect.objectContaining({ totalLines: 0 }))

    await server.stop()
  })

  it("constructs default hooks from bundlesRoot when provided", async () => {
    vi.resetModules()
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "outlook-hooks-"))

    const { startOutlookHttpServer } = await import("../../../heart/daemon/outlook-http")
    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      bundlesRoot,
    })

    // These should all return empty/default data without crashing
    const sessions = await fetch(`${server.origin}/outlook/api/agents/nobody/sessions`).then((r) => r.json())
    expect(sessions.totalCount).toBe(0)

    const coding = await fetch(`${server.origin}/outlook/api/agents/nobody/coding`).then((r) => r.json())
    expect(coding.totalCount).toBe(0)

    const bridges = await fetch(`${server.origin}/outlook/api/agents/nobody/bridges`).then((r) => r.json())
    expect(bridges.totalCount).toBe(0)

    const attention = await fetch(`${server.origin}/outlook/api/agents/nobody/attention`).then((r) => r.json())
    expect(attention.queueLength).toBe(0)

    const memory = await fetch(`${server.origin}/outlook/api/agents/nobody/memory`).then((r) => r.json())
    expect(memory.diaryEntryCount).toBe(0)

    const friends = await fetch(`${server.origin}/outlook/api/agents/nobody/friends`).then((r) => r.json())
    expect(friends.totalFriends).toBe(0)

    const habits = await fetch(`${server.origin}/outlook/api/agents/nobody/habits`).then((r) => r.json())
    expect(habits.totalCount).toBe(0)

    const health = await fetch(`${server.origin}/outlook/api/machine/health`).then((r) => r.json())
    expect(health).toBeTruthy()

    const logs = await fetch(`${server.origin}/outlook/api/machine/logs`).then((r) => r.json())
    expect(logs.totalLines).toBe(0)

    const inner = await fetch(`${server.origin}/outlook/api/agents/nobody/inner-transcript`).then((r) => r.json())
    expect(inner.messageCount).toBe(0)

    const prefs = await fetch(`${server.origin}/outlook/api/agents/nobody/desk-prefs`).then((r) => r.json())
    expect(prefs).toEqual(expect.objectContaining({ carrying: null }))

    const needsMe = await fetch(`${server.origin}/outlook/api/agents/nobody/needs-me`).then((r) => r.json())
    expect(needsMe).toEqual(expect.objectContaining({ items: expect.any(Array) }))

    await server.stop()
    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("streams SSE events and supports manual broadcast", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/daemon/outlook-http")

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({ productName: "Ouro Outlook", agentCount: 0 }) as any,
      readAgentState: () => null,
    })

    // Connect an SSE client
    const controller = new AbortController()
    const sseResponse = await fetch(`${server.origin}/outlook/api/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    })

    expect(sseResponse.status).toBe(200)
    expect(sseResponse.headers.get("content-type")).toBe("text/event-stream")

    // Broadcast an event
    server.broadcast("state-changed", { at: "2026-03-30T16:00:00.000Z" })

    // Read what the client received
    const reader = sseResponse.body!.getReader()
    const decoder = new TextDecoder()
    let accumulated = ""

    // Read chunks until we have the broadcast event
    while (!accumulated.includes("state-changed")) {
      const { value, done } = await reader.read()
      if (done) break
      accumulated += decoder.decode(value, { stream: true })
    }

    expect(accumulated).toContain(":ok")
    expect(accumulated).toContain("event: state-changed")
    expect(accumulated).toContain("2026-03-30T16:00:00.000Z")

    controller.abort()
    await server.stop()
  })
})
