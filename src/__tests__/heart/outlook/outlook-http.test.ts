import { EventEmitter } from "events"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

function createMockResponse() {
  const response = new EventEmitter() as any
  response.headers = null as Record<string, string> | null
  response.statusCode = null as number | null
  response.body = Buffer.alloc(0)
  response.writeHead = vi.fn((statusCode: number, headers: Record<string, string>) => {
    response.statusCode = statusCode
    response.headers = headers
  })
  response.write = vi.fn((chunk: string | Buffer) => {
    response.body = Buffer.concat([response.body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    return true
  })
  response.end = vi.fn((chunk?: string | Buffer) => {
    if (chunk) response.write(chunk)
  })
  return response
}

function createMockRequest(url: string, method = "GET") {
  const request = new EventEmitter() as any
  request.url = url
  request.method = method
  return request
}

function createRouteOptions(overrides: Record<string, unknown> = {}) {
  const hooks = {
    agentRoot: vi.fn((agentName: string) => path.join(os.tmpdir(), `${agentName}.ouro`)),
    readAgentSessions: vi.fn(() => ({ totalCount: 0, activeCount: 0, staleCount: 0, items: [] })),
    readAgentTranscript: vi.fn(() => null),
    readAgentCoding: vi.fn(() => ({ totalCount: 0, activeCount: 0, blockedCount: 0, items: [] })),
    readAgentAttention: vi.fn(() => ({ queueLength: 0, queueItems: [], pendingChannels: [], returnObligations: [] })),
    readAgentBridges: vi.fn(() => ({ totalCount: 0, activeCount: 0, items: [] })),
    readAgentMemory: vi.fn(() => ({ diaryEntryCount: 0, recentDiaryEntries: [], journalEntryCount: 0, recentJournalEntries: [] })),
    readAgentFriends: vi.fn(() => ({ totalFriends: 0, friends: [] })),
    readAgentContinuity: vi.fn(() => ({ presence: { self: null, peers: [] }, cares: { activeCount: 0, items: [] }, episodes: { recentCount: 0, items: [] } })),
    readAgentOrientation: vi.fn(() => ({ currentSession: null, centerOfGravity: null, primaryObligation: null, resumeHandle: null, otherActiveSessions: [], rawState: null })),
    readAgentObligations: vi.fn(() => ({ openCount: 0, primaryId: null, primarySelectionReason: null, items: [] })),
    readAgentChanges: vi.fn(() => ({ changeCount: 0, items: [], snapshotAge: null, formatted: "" })),
    readAgentSelfFix: vi.fn(() => ({ active: false, currentStep: null, steps: [] })),
    readAgentMemoryDecisions: vi.fn(() => ({ totalCount: 0, items: [] })),
    readAgentHabits: vi.fn(() => ({ totalCount: 0, activeCount: 0, pausedCount: 0, degradedCount: 0, overdueCount: 0, items: [] })),
    readDaemonHealth: vi.fn(() => null),
    readLogs: vi.fn(() => ({ logPath: null, totalLines: 0, entries: [] })),
    readDeskPrefs: vi.fn(() => ({ carrying: null, statusLine: null, tabOrder: null, starredFriends: [], pinnedConstellations: [], dismissedObligations: [] })),
    readNeedsMe: vi.fn(() => ({ items: [] })),
  }

  return {
    host: "127.0.0.1",
    getPort: () => 1234,
    readMachineState: () => ({ productName: "Ouro Outlook", agentCount: 0 }),
    readAgentState: () => null,
    hooks,
    sse: { add: vi.fn() },
    ...overrides,
  } as any
}

describe("outlook http", () => {
  it("keeps path normalization and static serving in explicit helper seams", async () => {
    const {
      normalizeOutlookRequestPath,
      normalizeLegacyOutlookApiPath,
      resolveSpaDistDir,
      serveStaticFile,
    } = await import("../../../heart/outlook/outlook-http-static")

    expect(normalizeOutlookRequestPath("/outlook/api/machine///?fresh=true")).toBe("/outlook/api/machine")
    expect(normalizeOutlookRequestPath()).toBe("/")
    expect(normalizeLegacyOutlookApiPath("/outlook/api")).toBe("/api")
    expect(normalizeLegacyOutlookApiPath("/outlook/api/agents/slugger")).toBe("/api/agents/slugger")
    expect(normalizeLegacyOutlookApiPath("/api/machine")).toBe("/api/machine")

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outlook-static-"))
    const htmlPath = path.join(dir, "index.html")
    const dataPath = path.join(dir, "agent.unknown")
    fs.writeFileSync(htmlPath, "<main>Ouro</main>")
    fs.writeFileSync(dataPath, "opaque")
    expect(resolveSpaDistDir([dir])).toBe(dir)
    expect(resolveSpaDistDir([path.join(dir, "missing")])).toBeNull()

    const htmlResponse = createMockResponse()
    expect(serveStaticFile(htmlResponse, htmlPath)).toBe(true)
    expect(htmlResponse.statusCode).toBe(200)
    expect(htmlResponse.headers).toEqual(expect.objectContaining({
      "content-type": "text/html",
      "cache-control": "no-cache",
    }))
    expect(htmlResponse.body.toString("utf8")).toBe("<main>Ouro</main>")

    const opaqueResponse = createMockResponse()
    expect(serveStaticFile(opaqueResponse, dataPath)).toBe(true)
    expect(opaqueResponse.headers).toEqual(expect.objectContaining({
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    }))

    const missingResponse = createMockResponse()
    expect(serveStaticFile(missingResponse, path.join(dir, "missing.js"))).toBe(false)
    expect(missingResponse.writeHead).not.toHaveBeenCalled()

    expect(serveStaticFile(createMockResponse(), dir)).toBe(false)

    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("keeps SSE broadcast and bundle watch mechanics in explicit transport seams", async () => {
    const {
      createSseBroadcaster,
      createBundleWatcher,
      createStateChangedBroadcast,
    } = await import("../../../heart/outlook/outlook-http-transport")

    const sse = createSseBroadcaster()
    const firstResponse = createMockResponse()
    const secondResponse = createMockResponse()
    const brokenWriteResponse = createMockResponse()
    brokenWriteResponse.write = vi.fn(() => {
      throw new Error("closed")
    })
    const brokenEndResponse = createMockResponse()
    brokenEndResponse.end = vi.fn(() => {
      throw new Error("already closed")
    })
    sse.add(firstResponse)
    sse.add(secondResponse)
    sse.add(brokenWriteResponse)
    sse.add(brokenEndResponse)

    sse.broadcast("state-changed", { at: "2026-04-10T20:00:00.000Z" })
    expect(firstResponse.write).toHaveBeenCalledWith("event: state-changed\ndata: {\"at\":\"2026-04-10T20:00:00.000Z\"}\n\n")
    expect(secondResponse.write).toHaveBeenCalledTimes(1)
    expect(brokenWriteResponse.write).toHaveBeenCalledTimes(1)

    firstResponse.emit("close")
    sse.broadcast("state-changed", { at: "later" })
    expect(firstResponse.write).toHaveBeenCalledTimes(1)
    expect(secondResponse.write).toHaveBeenCalledTimes(2)
    expect(brokenWriteResponse.write).toHaveBeenCalledTimes(1)

    sse.disconnectAll()
    expect(secondResponse.end).toHaveBeenCalled()
    expect(brokenEndResponse.end).toHaveBeenCalled()

    const broadcast = vi.fn()
    createStateChangedBroadcast({ broadcast })()
    expect(broadcast).toHaveBeenCalledWith("state-changed", { at: expect.any(String) })

    const onChange = vi.fn()
    const close = vi.fn()
    const clearTimeout = vi.fn()
    let watchedCallback: (() => void) | null = null
    const watcher = createBundleWatcher("/bundles", onChange, {
      existsSync: () => true,
      watch: (_root, _options, callback) => {
        watchedCallback = callback
        return { close }
      },
      setTimeout: (callback) => {
        callback()
        return 1 as any
      },
      clearTimeout,
    })

    watchedCallback?.()
    watchedCallback?.()
    expect(clearTimeout).toHaveBeenCalledWith(1)
    expect(onChange).toHaveBeenCalledTimes(2)
    watcher.stop()
    expect(close).toHaveBeenCalledTimes(1)

    const missingWatcher = createBundleWatcher("/missing", onChange, {
      existsSync: () => false,
      watch: vi.fn(),
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
    })
    missingWatcher.stop()

    const throwingWatcher = createBundleWatcher("/bundles", onChange, {
      existsSync: () => true,
      watch: () => {
        throw new Error("unsupported")
      },
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
    })
    throwingWatcher.stop()
  })

  it("keeps default hook composition in an explicit helper seam", async () => {
    const { createOutlookHttpReadHooks } = await import("../../../heart/outlook/outlook-http-hooks")
    const coding = { totalCount: 1, activeCount: 1, blockedCount: 0, items: [] }
    const hooks = createOutlookHttpReadHooks({
      bundlesRoot: "/tmp/ouro-bundles",
      readAgentCoding: () => coding,
      readDaemonHealth: () => null,
    })

    expect(hooks.agentRoot("slugger")).toBe(path.join("/tmp/ouro-bundles", "slugger.ouro"))
    expect(hooks.readAgentCoding("slugger")).toBe(coding)
    expect(hooks.readDaemonHealth()).toBeNull()
    expect(createOutlookHttpReadHooks({}).agentRoot("slugger")).toBe("slugger.ouro")

    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "outlook-default-hooks-"))
    const defaultHooks = createOutlookHttpReadHooks({ bundlesRoot })
    expect(defaultHooks.readAgentContinuity("nobody")).toBeTruthy()
    expect(defaultHooks.readAgentOrientation("nobody")).toBeTruthy()
    expect(defaultHooks.readAgentObligations("nobody")).toBeTruthy()
    expect(defaultHooks.readAgentChanges("nobody")).toBeTruthy()
    expect(defaultHooks.readAgentSelfFix("nobody")).toBeTruthy()
    expect(defaultHooks.readAgentMemoryDecisions("nobody")).toBeTruthy()
    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("keeps asset and SPA fallback dispatch in the route helper seam", async () => {
    const { createOutlookHttpRequestHandler } = await import("../../../heart/outlook/outlook-http-routes")
    const serveStaticFile = vi.fn(() => true)
    const handler = createOutlookHttpRequestHandler(createRouteOptions({
      staticFiles: {
        resolveSpaDistDir: () => "/spa",
        serveStaticFile,
      },
    }))

    const assetResponse = createMockResponse()
    handler(createMockRequest("/assets/index.js"), assetResponse)
    expect(serveStaticFile).toHaveBeenCalledWith(assetResponse, path.join("/spa", "/assets/index.js"))
    expect(assetResponse.writeHead).not.toHaveBeenCalled()

    const fallbackResponse = createMockResponse()
    handler(createMockRequest("/client/side/route"), fallbackResponse)
    expect(serveStaticFile).toHaveBeenCalledWith(fallbackResponse, path.join("/spa", "index.html"))
    expect(fallbackResponse.writeHead).not.toHaveBeenCalled()

    const missingAssetResponse = createMockResponse()
    createOutlookHttpRequestHandler(createRouteOptions({
      staticFiles: {
        resolveSpaDistDir: () => "/spa",
        serveStaticFile: () => false,
      },
    }))(createMockRequest("/assets/missing.js"), missingAssetResponse)
    expect(missingAssetResponse.statusCode).toBe(404)
    expect(missingAssetResponse.body.toString("utf8")).toContain("asset not found")

    const missingAssetWithoutSpaResponse = createMockResponse()
    createOutlookHttpRequestHandler(createRouteOptions({
      staticFiles: {
        resolveSpaDistDir: () => null,
        serveStaticFile: vi.fn(),
      },
    }))(createMockRequest("/assets/missing-no-spa.js"), missingAssetWithoutSpaResponse)
    expect(missingAssetWithoutSpaResponse.statusCode).toBe(404)
    expect(missingAssetWithoutSpaResponse.body.toString("utf8")).toContain("asset not found")

    const missingFallbackResponse = createMockResponse()
    createOutlookHttpRequestHandler(createRouteOptions({
      staticFiles: {
        resolveSpaDistDir: () => null,
        serveStaticFile: vi.fn(),
      },
    }))(createMockRequest("/client/side/route"), missingFallbackResponse)
    expect(missingFallbackResponse.statusCode).toBe(404)
    expect(missingFallbackResponse.body.toString("utf8")).toContain("not found: /client/side/route")

    const missingFallbackWithSpaResponse = createMockResponse()
    createOutlookHttpRequestHandler(createRouteOptions({
      staticFiles: {
        resolveSpaDistDir: () => "/spa",
        serveStaticFile: () => false,
      },
    }))(createMockRequest("/client/side/missing"), missingFallbackWithSpaResponse)
    expect(missingFallbackWithSpaResponse.statusCode).toBe(404)
    expect(missingFallbackWithSpaResponse.body.toString("utf8")).toContain("not found: /client/side/missing")

    const agentResponse = createMockResponse()
    createOutlookHttpRequestHandler(createRouteOptions({
      readAgentState: () => ({ agentName: "slugger", productName: "Ouro Outlook" }),
    }))(createMockRequest("/api/agents/slugger"), agentResponse)
    expect(agentResponse.statusCode).toBe(200)
    expect(JSON.parse(agentResponse.body.toString("utf8"))).toEqual(expect.objectContaining({ agentName: "slugger" }))
  })

  it("keeps desk preference mutation in the route helper seam", async () => {
    const { createOutlookHttpRequestHandler } = await import("../../../heart/outlook/outlook-http-routes")
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "outlook-agent-"))
    const hooks = createRouteOptions().hooks
    hooks.agentRoot = vi.fn(() => agentRoot)
    const handler = createOutlookHttpRequestHandler(createRouteOptions({ hooks }))

    const successResponse = createMockResponse()
    const successRequest = createMockRequest("/api/agents/slugger/dismiss-obligation", "POST")
    handler(successRequest, successResponse)
    successRequest.emit("data", JSON.stringify({ obligationId: "ob-1" }))
    successRequest.emit("end")
    expect(successResponse.statusCode).toBe(200)
    expect(JSON.parse(successResponse.body.toString("utf8"))).toEqual({ ok: true, dismissed: 1 })

    const duplicateResponse = createMockResponse()
    const duplicateRequest = createMockRequest("/api/agents/slugger/dismiss-obligation", "POST")
    handler(duplicateRequest, duplicateResponse)
    duplicateRequest.emit("data", JSON.stringify({ obligationId: "ob-1" }))
    duplicateRequest.emit("end")
    expect(JSON.parse(duplicateResponse.body.toString("utf8"))).toEqual({ ok: true, dismissed: 1 })

    const missingResponse = createMockResponse()
    const missingRequest = createMockRequest("/api/agents/slugger/dismiss-obligation", "POST")
    handler(missingRequest, missingResponse)
    missingRequest.emit("data", JSON.stringify({ obligationId: "" }))
    missingRequest.emit("end")
    expect(missingResponse.statusCode).toBe(400)

    const invalidResponse = createMockResponse()
    const invalidRequest = createMockRequest("/api/agents/slugger/dismiss-obligation", "POST")
    handler(invalidRequest, invalidResponse)
    invalidRequest.emit("data", "{")
    invalidRequest.emit("end")
    expect(invalidResponse.statusCode).toBe(500)

    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("serves loopback-only HTML and JSON endpoints for Outlook", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

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

  it("serves the SPA fallback safely and normalizes trailing-slash Outlook routes", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

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

    // Root serves the built SPA when available, or JSON 404 otherwise.
    const rootResponse = await fetch(`${server.origin}/`)
    expect([200, 404]).toContain(rootResponse.status)

    await server.stop()
  })

  it("returns a JSON 404 for unknown Outlook routes", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

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

  it("uses the default direct-read hooks and SPA route fallback when no options are provided", async () => {
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

    vi.doMock("../../../heart/outlook/outlook-read", () => ({
      readOutlookMachineState,
      readOutlookAgentState,
    }))

    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")
    const server = await startOutlookHttpServer()

    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    // Root serves the built SPA when available, or JSON 404 otherwise.
    const rootResponse = await fetch(`${server.origin}/`)
    expect([200, 404]).toContain(rootResponse.status)

    // Hit API endpoints to trigger the mocked read functions
    await fetch(`${server.origin}/outlook/api/machine`).then((r) => r.json())
    const agent = await fetch(`${server.origin}/outlook/api/agents/slugger`).then((response) => response.json())
    expect(agent).toEqual(expect.objectContaining({ agentName: "slugger" }))

    expect(readOutlookMachineState).toHaveBeenCalled()
    expect(readOutlookAgentState).toHaveBeenCalledWith("slugger")

    await server.stop()
    vi.doUnmock("../../../heart/outlook/outlook-read")
  })

  it("serves deep inspectability endpoints for agent surfaces", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

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
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

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

    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")
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

    const missingAgent = await fetch(`${server.origin}/outlook/api/agents/nobody`)
    expect([200, 404]).toContain(missingAgent.status)

    await server.stop()
    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("streams SSE events and supports manual broadcast", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

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

  it("serves /api/machine at root namespace (canonical)", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({
        productName: "Ouro Outlook",
        agentCount: 1,
      }),
      readAgentState: () => null,
    })

    const res = await fetch(`${server.origin}/api/machine`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(expect.objectContaining({ productName: "Ouro Outlook" }))

    await server.stop()
  })

  it("serves /api/agents/:agent at root namespace (canonical)", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({ productName: "Ouro Outlook", agentCount: 1 }) as any,
      readAgentState: () => null,
      readAgentView: (name: string) =>
        name === "slugger"
          ? { productName: "Ouro Outlook", interactionModel: "read-only", agent: { agentName: "slugger" } } as any
          : null,
    })

    const res = await fetch(`${server.origin}/api/agents/slugger`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(expect.objectContaining({ agent: expect.objectContaining({ agentName: "slugger" }) }))

    // Missing agent
    const missing = await fetch(`${server.origin}/api/agents/missing`)
    expect(missing.status).toBe(404)

    await server.stop()
  })

  it("streams SSE events at /api/events (canonical)", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({ productName: "Ouro Outlook", agentCount: 0 }) as any,
      readAgentState: () => null,
    })

    const controller = new AbortController()
    const sseResponse = await fetch(`${server.origin}/api/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    })

    expect(sseResponse.status).toBe(200)
    expect(sseResponse.headers.get("content-type")).toBe("text/event-stream")

    server.broadcast("state-changed", { at: "2026-04-03T10:00:00.000Z" })

    const reader = sseResponse.body!.getReader()
    const decoder = new TextDecoder()
    let accumulated = ""
    while (!accumulated.includes("state-changed")) {
      const { value, done } = await reader.read()
      if (done) break
      accumulated += decoder.decode(value, { stream: true })
    }

    expect(accumulated).toContain("event: state-changed")
    expect(accumulated).toContain("2026-04-03T10:00:00.000Z")

    controller.abort()
    await server.stop()
  })

  it("serves /api/agents/:agent/coding and other surfaces at root namespace", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({ productName: "Ouro Outlook", agentCount: 1 }) as any,
      readAgentState: () => null,
      readAgentSessions: () => ({ totalCount: 2, activeCount: 1, staleCount: 1, items: [] }),
      readAgentCoding: () => ({ totalCount: 1, activeCount: 1, blockedCount: 0, items: [] }),
      readAgentAttention: () => ({ queueLength: 0, queueItems: [], pendingChannels: [], returnObligations: [] }),
      readAgentBridges: () => ({ totalCount: 0, activeCount: 0, items: [] }),
      readAgentMemory: () => ({ diaryEntryCount: 0, recentDiaryEntries: [], journalEntryCount: 0, recentJournalEntries: [] }),
      readAgentFriends: () => ({ totalFriends: 0, friends: [] }),
      readAgentHabits: () => ({ totalCount: 0, activeCount: 0, pausedCount: 0, degradedCount: 0, overdueCount: 0, items: [] }),
      readDaemonHealth: () => ({ status: "ok", mode: "dev", pid: 1, startedAt: "", uptimeSeconds: 0, safeMode: null, degradedComponents: [], agentHealth: {}, habitHealth: {} }),
      readLogs: () => ({ logPath: null, totalLines: 0, entries: [] }),
    })

    // Canonical root-namespace agent surfaces
    const sessions = await fetch(`${server.origin}/api/agents/test/sessions`).then((r) => r.json())
    expect(sessions).toEqual(expect.objectContaining({ totalCount: 2 }))

    const coding = await fetch(`${server.origin}/api/agents/test/coding`).then((r) => r.json())
    expect(coding).toEqual(expect.objectContaining({ totalCount: 1 }))

    const health = await fetch(`${server.origin}/api/machine/health`).then((r) => r.json())
    expect(health).toEqual(expect.objectContaining({ status: "ok" }))

    const logs = await fetch(`${server.origin}/api/machine/logs`).then((r) => r.json())
    expect(logs).toEqual(expect.objectContaining({ totalLines: 0 }))

    await server.stop()
  })

  it("returns unavailable status when readDaemonHealth returns null", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({ productName: "Ouro Outlook", agentCount: 0 }) as any,
      readAgentState: () => null,
      readAgentSessions: () => ({ totalCount: 0, activeCount: 0, staleCount: 0, items: [] }),
      readAgentCoding: () => ({ totalCount: 0, activeCount: 0, blockedCount: 0, items: [] }),
      readAgentAttention: () => ({ queueLength: 0, queueItems: [], pendingChannels: [], returnObligations: [] }),
      readAgentBridges: () => ({ totalCount: 0, activeCount: 0, items: [] }),
      readAgentMemory: () => ({ diaryEntryCount: 0, recentDiaryEntries: [], journalEntryCount: 0, recentJournalEntries: [] }),
      readAgentFriends: () => ({ totalFriends: 0, friends: [] }),
      readAgentHabits: () => ({ totalCount: 0, activeCount: 0, pausedCount: 0, degradedCount: 0, overdueCount: 0, items: [] }),
      readDaemonHealth: () => null as any,
      readLogs: () => ({ logPath: null, totalLines: 0, entries: [] }),
    })

    const health = await fetch(`${server.origin}/api/machine/health`).then((r) => r.json())
    expect(health).toEqual({ status: "unavailable" })

    await server.stop()
  })

  it("serves /api/agents/:agent/continuity endpoint", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

    const mockContinuity = {
      presence: {
        self: { agentName: "slugger", availability: "active" },
        peers: [{ agentName: "ouroboros", availability: "idle" }],
      },
      cares: { activeCount: 2, items: [{ id: "c-1", label: "deploy", status: "active", salience: "high" }] },
      episodes: { recentCount: 1, items: [{ id: "ep-1", kind: "milestone", summary: "shipped", timestamp: "2026-04-03T10:00:00Z" }] },
    }

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({ productName: "Ouro Outlook", agentCount: 1 }) as any,
      readAgentState: () => null,
      readAgentContinuity: () => mockContinuity,
    })

    // Canonical route
    const res = await fetch(`${server.origin}/api/agents/slugger/continuity`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockContinuity)

    // Compatibility alias
    const legacyRes = await fetch(`${server.origin}/outlook/api/agents/slugger/continuity`)
    expect(legacyRes.status).toBe(200)
    const legacyBody = await legacyRes.json()
    expect(legacyBody).toEqual(mockContinuity)

    await server.stop()
  })

  it("serves /api/agents/:agent/orientation endpoint", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

    const mockOrientation = {
      currentSession: { friendId: "ari", channel: "cli", key: "chat", lastActivityAt: "2026-04-03T10:00:00Z" },
      centerOfGravity: "Deploying v2",
      primaryObligation: { id: "ob-1", content: "Deploy", status: "pending", nextAction: "run script", waitingOn: null },
      resumeHandle: null,
      otherActiveSessions: [],
      rawState: null,
    }

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({ productName: "Ouro Outlook", agentCount: 1 }) as any,
      readAgentState: () => null,
      readAgentOrientation: () => mockOrientation,
    })

    const res = await fetch(`${server.origin}/api/agents/slugger/orientation`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockOrientation)

    await server.stop()
  })

  it("serves /api/agents/:agent/obligations endpoint", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

    const mockObligations = {
      openCount: 2,
      primaryId: "ob-1",
      primarySelectionReason: "most recent pending",
      items: [
        { id: "ob-1", status: "pending", content: "Deploy", updatedAt: "2026-04-03T10:00:00Z", nextAction: "run", origin: null, currentSurface: null, meaning: null, isPrimary: true },
        { id: "ob-2", status: "pending", content: "Review", updatedAt: "2026-04-03T09:00:00Z", nextAction: null, origin: null, currentSurface: null, meaning: null, isPrimary: false },
      ],
    }

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({ productName: "Ouro Outlook", agentCount: 1 }) as any,
      readAgentState: () => null,
      readAgentObligations: () => mockObligations,
    })

    const res = await fetch(`${server.origin}/api/agents/slugger/obligations`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockObligations)

    await server.stop()
  })

  it("serves /api/agents/:agent/changes endpoint", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

    const mockChanges = {
      changeCount: 1,
      items: [{ kind: "obligation_status_changed", id: "ob-1", from: "pending", to: "in_progress", summary: "obligation pending -> in_progress" }],
      snapshotAge: "2026-04-03T09:00:00Z",
      formatted: "obligation pending -> in_progress",
    }

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({ productName: "Ouro Outlook", agentCount: 1 }) as any,
      readAgentState: () => null,
      readAgentChanges: () => mockChanges,
    })

    const res = await fetch(`${server.origin}/api/agents/slugger/changes`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockChanges)

    await server.stop()
  })

  it("serves /api/agents/:agent/self-fix endpoint", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

    const mockSelfFix = { active: false, currentStep: null, steps: [] }

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({ productName: "Ouro Outlook", agentCount: 1 }) as any,
      readAgentState: () => null,
      readAgentSelfFix: () => mockSelfFix,
    })

    const res = await fetch(`${server.origin}/api/agents/slugger/self-fix`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockSelfFix)

    await server.stop()
  })

  it("serves /api/agents/:agent/memory-decisions endpoint", async () => {
    const { startOutlookHttpServer } = await import("../../../heart/outlook/outlook-http")

    const mockDecisions = {
      totalCount: 1,
      items: [{ kind: "diary_write", decision: "saved", reason: "important", excerpt: "hello", timestamp: "2026-04-03T10:00:00Z" }],
    }

    const server = await startOutlookHttpServer({
      host: "127.0.0.1",
      port: 0,
      readMachineState: () => ({ productName: "Ouro Outlook", agentCount: 1 }) as any,
      readAgentState: () => null,
      readAgentMemoryDecisions: () => mockDecisions,
    })

    const res = await fetch(`${server.origin}/api/agents/slugger/memory-decisions`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockDecisions)

    await server.stop()
  })
})
