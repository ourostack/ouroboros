import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it, vi } from "vitest"

const rsvpMocks = vi.hoisted(() => ({
  loadOrCreateMachineIdentity: vi.fn(),
  importLegacyRsvpConfig: vi.fn(),
  readRsvpConfig: vi.fn(),
  validateRsvpReadiness: vi.fn(),
  refreshRuntimeCredentialConfig: vi.fn(),
  refreshMachineRuntimeCredentialConfig: vi.fn(),
  fetchAislePlannerRsvps: vi.fn(),
  buildRsvpSnapshot: vi.fn(),
  parseRsvpSnapshot: vi.fn(),
  importLegacyRsvpState: vi.fn(),
  computeRsvpDelta: vi.fn(),
  renderRsvpReport: vi.fn(),
  decideRsvpOutboundReport: vi.fn(),
  recordRsvpOutboundAttempt: vi.fn(),
  queryRsvpSnapshot: vi.fn(),
  sendText: vi.fn(),
}))

vi.mock("../../../heart/machine-identity", () => ({
  loadOrCreateMachineIdentity: rsvpMocks.loadOrCreateMachineIdentity,
}))

vi.mock("../../../rsvp/config", async () => {
  const actual = await vi.importActual<typeof import("../../../rsvp/config")>("../../../rsvp/config")
  return {
    ...actual,
    importLegacyRsvpConfig: rsvpMocks.importLegacyRsvpConfig,
    readRsvpConfig: rsvpMocks.readRsvpConfig,
    validateRsvpReadiness: rsvpMocks.validateRsvpReadiness,
  }
})

vi.mock("../../../rsvp/aisleplanner-client", async () => {
  const actual = await vi.importActual<typeof import("../../../rsvp/aisleplanner-client")>("../../../rsvp/aisleplanner-client")
  return {
    ...actual,
    fetchAislePlannerRsvps: rsvpMocks.fetchAislePlannerRsvps,
  }
})

vi.mock("../../../rsvp/snapshot", async () => {
  const actual = await vi.importActual<typeof import("../../../rsvp/snapshot")>("../../../rsvp/snapshot")
  return {
    ...actual,
    buildRsvpSnapshot: rsvpMocks.buildRsvpSnapshot,
    parseRsvpSnapshot: rsvpMocks.parseRsvpSnapshot,
  }
})

vi.mock("../../../rsvp/migration", async () => {
  const actual = await vi.importActual<typeof import("../../../rsvp/migration")>("../../../rsvp/migration")
  return {
    ...actual,
    importLegacyRsvpState: rsvpMocks.importLegacyRsvpState,
  }
})

vi.mock("../../../rsvp/diff-renderer", async () => {
  const actual = await vi.importActual<typeof import("../../../rsvp/diff-renderer")>("../../../rsvp/diff-renderer")
  return {
    ...actual,
    computeRsvpDelta: rsvpMocks.computeRsvpDelta,
    renderRsvpReport: rsvpMocks.renderRsvpReport,
  }
})

vi.mock("../../../rsvp/outbound-state", async () => {
  const actual = await vi.importActual<typeof import("../../../rsvp/outbound-state")>("../../../rsvp/outbound-state")
  return {
    ...actual,
    decideRsvpOutboundReport: rsvpMocks.decideRsvpOutboundReport,
    recordRsvpOutboundAttempt: rsvpMocks.recordRsvpOutboundAttempt,
  }
})

vi.mock("../../../rsvp/query", async () => {
  const actual = await vi.importActual<typeof import("../../../rsvp/query")>("../../../rsvp/query")
  return {
    ...actual,
    queryRsvpSnapshot: rsvpMocks.queryRsvpSnapshot,
  }
})

vi.mock("../../../senses/bluebubbles/client", async () => {
  const actual = await vi.importActual<typeof import("../../../senses/bluebubbles/client")>("../../../senses/bluebubbles/client")
  return {
    ...actual,
    createBlueBubblesClient: vi.fn(() => ({ sendText: rsvpMocks.sendText })),
  }
})

vi.mock("../../../heart/runtime-credentials", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/runtime-credentials")>("../../../heart/runtime-credentials")
  return {
    ...actual,
    refreshRuntimeCredentialConfig: rsvpMocks.refreshRuntimeCredentialConfig,
    refreshMachineRuntimeCredentialConfig: rsvpMocks.refreshMachineRuntimeCredentialConfig,
  }
})

import { runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"
import { runRsvpCliCommand } from "../../../rsvp/cli"
import { createTmpBundle } from "../../test-helpers/tmpdir-bundle"

function createMockDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn().mockRejectedValue(new Error("daemon should not be called")),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 12345 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
    ...overrides,
  }
}

const rsvpConfig = {
  schemaVersion: 1,
  policyVersion: "rsvp-config/v1",
  agent: "slugger",
  mode: "shadow",
  source: { kind: "aisleplanner", weddingId: "wed-1", eventId: "event-1" },
  credentialRef: { runtimeConfigItem: "runtime/config", runtimeConfigPath: "rsvp.aisleplanner" },
  bluebubblesRoute: { chatGuid: "iMessage;-;chat-guid", chatIdentifier: "wedding-chat" },
}

const previousSnapshot = {
  snapshotId: "snap_previous",
  summary: { attending: 148, declined: 123, pending: 2, unknown: 0, total: 273 },
  guests: [],
}

const currentSnapshot = {
  snapshotId: "snap_current",
  summary: { attending: 149, declined: 123, pending: 1, unknown: 0, total: 273 },
  guests: [{ id: "pending-1", displayName: "Casey Pending", firstName: "Casey", lastName: "Pending", groupId: null, status: "pending", sourceStatus: "pending" }],
}

function seedBundle(): ReturnType<typeof createTmpBundle> {
  const tmp = createTmpBundle({ agentName: "slugger" })
  const rsvpRoot = path.join(tmp.agentRoot, "state", "rsvp")
  fs.mkdirSync(path.join(tmp.agentRoot, "rsvp"), { recursive: true })
  fs.mkdirSync(path.join(rsvpRoot, "snapshots"), { recursive: true })
  fs.writeFileSync(path.join(tmp.agentRoot, "rsvp", "config.json"), JSON.stringify(rsvpConfig), "utf-8")
  fs.writeFileSync(path.join(rsvpRoot, "snapshots", "latest.json"), JSON.stringify(currentSnapshot), "utf-8")
  fs.writeFileSync(path.join(rsvpRoot, "baseline.json"), JSON.stringify({ nativeSnapshotId: previousSnapshot.snapshotId }), "utf-8")
  fs.writeFileSync(path.join(rsvpRoot, "snapshots", `${previousSnapshot.snapshotId}.json`), JSON.stringify(previousSnapshot), "utf-8")
  return tmp
}

afterEach(() => {
  for (const mock of Object.values(rsvpMocks)) mock.mockReset()
})

function mockRuntimeCredentials(): void {
  rsvpMocks.loadOrCreateMachineIdentity.mockReturnValue({ machineId: "machine_test" })
  rsvpMocks.refreshRuntimeCredentialConfig.mockResolvedValue({
    ok: true,
    config: {
      rsvp: {
        aisleplanner: { username: "user@example.com", password: "secret" },
      },
    },
  })
  rsvpMocks.refreshMachineRuntimeCredentialConfig.mockResolvedValue({
    ok: true,
    config: {
      bluebubbles: { serverUrl: "http://127.0.0.1:1234", password: "secret" },
    },
  })
}

describe("ouro rsvp operational CLI wiring", () => {
  it("runs bare import-legacy through native RSVP state migration, not config import", async () => {
    mockRuntimeCredentials()
    const tmp = seedBundle()
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-operational-legacy-"))
    rsvpMocks.readRsvpConfig.mockReturnValue({ ok: true, config: rsvpConfig })
    rsvpMocks.importLegacyRsvpState.mockReturnValue({
      ok: true,
      latestSnapshotId: "snap_current",
      baselineSnapshotId: "snap_previous",
      latestSnapshotPath: "/tmp/latest.json",
      baselineSnapshotPath: "/tmp/baseline.json",
      baselineSource: "sent",
    })
    rsvpMocks.importLegacyRsvpConfig.mockResolvedValue({ ok: true, message: "wrong path" })
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    try {
      const result = await runOuroCli([
        "rsvp",
        "import-legacy",
        "--agent",
        "slugger",
        "--legacy-root",
        legacyRoot,
        "--mode",
        "shadow",
        "--yes",
        "--json",
      ], deps)
      const parsed = JSON.parse(result)

      expect(rsvpMocks.importLegacyRsvpState).toHaveBeenCalledWith(expect.objectContaining({
        agent: "slugger",
        agentRoot: tmp.agentRoot,
        legacyRoot,
        weddingId: "wed-1",
        eventId: "event-1",
      }))
      expect(rsvpMocks.importLegacyRsvpConfig).not.toHaveBeenCalled()
      expect(parsed).toMatchObject({
        ok: true,
        command: "rsvp.import-legacy",
        sideEffect: true,
        migration: { latestSnapshotId: "snap_current" },
      })
      expect(result).not.toMatch(/registered|planned/i)
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
      fs.rmSync(legacyRoot, { recursive: true, force: true })
    }
  })

  it("runs refresh through config readiness, AislePlanner fetch, snapshot build, diff rendering, and no-send outbound decision", async () => {
    mockRuntimeCredentials()
    const tmp = seedBundle()
    rsvpMocks.readRsvpConfig.mockReturnValue({ ok: true, config: rsvpConfig })
    rsvpMocks.validateRsvpReadiness.mockReturnValue({ ok: true, checks: [] })
    rsvpMocks.fetchAislePlannerRsvps.mockResolvedValue({
      ok: true,
      fetchedAt: "2026-07-09T17:00:00.000Z",
      guests: { "pending-1": { first_name: "Casey", last_name: "Pending", attending_status: "pending" } },
      allGuests: { "pending-1": { first_name: "Casey", last_name: "Pending" } },
    })
    rsvpMocks.buildRsvpSnapshot.mockReturnValue(currentSnapshot)
    rsvpMocks.parseRsvpSnapshot
      .mockReturnValueOnce({ ok: true, snapshot: previousSnapshot })
      .mockReturnValueOnce({ ok: true, snapshot: currentSnapshot })
    rsvpMocks.computeRsvpDelta.mockReturnValue({ currentSnapshotId: "snap_current", newRsvps: [], statusChanges: [], newGuests: [], removedGuests: [], summary: currentSnapshot.summary })
    rsvpMocks.renderRsvpReport.mockReturnValue("RSVP Update\n\nNo changes since last check.")
    rsvpMocks.decideRsvpOutboundReport.mockReturnValue({ action: "skip", reason: "no-send" })
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    try {
      const result = await runOuroCli(["rsvp", "refresh", "--agent", "slugger", "--mode", "shadow", "--no-send", "--json"], deps)
      const parsed = JSON.parse(result)

      expect(rsvpMocks.validateRsvpReadiness).toHaveBeenCalled()
      expect(rsvpMocks.refreshMachineRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", "machine_test", { preserveCachedOnFailure: true })
      expect(rsvpMocks.fetchAislePlannerRsvps).toHaveBeenCalled()
      expect(rsvpMocks.buildRsvpSnapshot).toHaveBeenCalled()
      expect(rsvpMocks.computeRsvpDelta).toHaveBeenCalledWith(previousSnapshot, currentSnapshot)
      expect(rsvpMocks.renderRsvpReport).toHaveBeenCalled()
      expect(rsvpMocks.decideRsvpOutboundReport).toHaveBeenCalled()
      expect(rsvpMocks.sendText).not.toHaveBeenCalled()
      expect(parsed).toMatchObject({
        ok: true,
        command: "rsvp.refresh",
        sideEffect: false,
        allowSend: false,
        refresh: {
          snapshotId: "snap_current",
          reportText: expect.stringContaining("RSVP Update"),
          outboundDecision: { action: "skip" },
        },
      })
      expect(result).not.toMatch(/registered|planned/i)
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
    }
  })

  it("runs compare through real snapshot parsing and report rendering", async () => {
    mockRuntimeCredentials()
    const tmp = seedBundle()
    const nativePath = path.join(os.tmpdir(), `rsvp-native-${process.pid}.json`)
    const legacyPath = path.join(os.tmpdir(), `rsvp-legacy-${process.pid}.json`)
    fs.writeFileSync(nativePath, JSON.stringify(currentSnapshot), "utf-8")
    fs.writeFileSync(legacyPath, JSON.stringify(previousSnapshot), "utf-8")
    rsvpMocks.parseRsvpSnapshot
      .mockReturnValueOnce({ ok: true, snapshot: currentSnapshot })
      .mockReturnValueOnce({ ok: true, snapshot: previousSnapshot })
    rsvpMocks.computeRsvpDelta.mockReturnValue({ currentSnapshotId: "snap_current", newRsvps: [], statusChanges: [], newGuests: [], removedGuests: [], summary: currentSnapshot.summary })
    rsvpMocks.renderRsvpReport.mockReturnValue("RSVP Update\n\nComparison report")
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    try {
      const result = await runOuroCli(["rsvp", "compare", "--agent", "slugger", "--native", nativePath, "--legacy", legacyPath, "--json"], deps)
      const parsed = JSON.parse(result)

      expect(rsvpMocks.parseRsvpSnapshot).toHaveBeenCalledTimes(2)
      expect(rsvpMocks.computeRsvpDelta).toHaveBeenCalledWith(previousSnapshot, currentSnapshot)
      expect(rsvpMocks.renderRsvpReport).toHaveBeenCalled()
      expect(parsed).toMatchObject({
        ok: true,
        command: "rsvp.compare",
        sideEffect: false,
        compare: {
          nativeSnapshotId: "snap_current",
          legacySnapshotId: "snap_previous",
          reportText: expect.stringContaining("Comparison report"),
        },
      })
      expect(result).not.toMatch(/registered|planned/i)
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
      fs.rmSync(nativePath, { force: true })
      fs.rmSync(legacyPath, { force: true })
    }
  })

  it("runs smoke through RSVP follow-up query and only sends in live allow-send mode", async () => {
    mockRuntimeCredentials()
    const tmp = seedBundle()
    rsvpMocks.parseRsvpSnapshot.mockReturnValue({ ok: true, snapshot: currentSnapshot })
    rsvpMocks.queryRsvpSnapshot.mockReturnValue({
      ok: true,
      status: "pending",
      count: 1,
      total: 273,
      names: ["Casey Pending"],
      text: "Pending (1/273): Casey Pending",
    })
    rsvpMocks.sendText.mockResolvedValue({ ok: true, guid: "sent-guid" })
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    try {
      const preflight = JSON.parse(await runOuroCli([
        "rsvp",
        "smoke",
        "--agent",
        "slugger",
        "--mode",
        "preflight",
        "--surface",
        "bluebubbles",
        "--question",
        "who is pending?",
        "--json",
      ], deps))
      expect(rsvpMocks.queryRsvpSnapshot).toHaveBeenCalledWith(currentSnapshot, { query: "who is pending?" })
      expect(rsvpMocks.sendText).not.toHaveBeenCalled()
      expect(preflight).toMatchObject({
        ok: true,
        command: "rsvp.smoke",
        sideEffect: false,
        sendAllowed: false,
        answer: expect.stringContaining("Casey Pending"),
      })

      const live = JSON.parse(await runOuroCli([
        "rsvp",
        "smoke",
        "--agent",
        "slugger",
        "--mode",
        "live",
        "--surface",
        "bluebubbles",
        "--question",
        "who is pending?",
        "--allow-send",
        "--json",
      ], deps))
      expect(rsvpMocks.sendText).toHaveBeenCalledTimes(1)
      expect(live).toMatchObject({
        ok: true,
        command: "rsvp.smoke",
        sideEffect: true,
        sendAllowed: true,
        delivery: { guid: "sent-guid" },
      })
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
    }
  })

  it("fails operational commands closed when required agent or native config inputs are missing", async () => {
    mockRuntimeCredentials()
    const deps = createMockDeps()

    const missingAgentText = await runOuroCli(["rsvp", "refresh", "--mode", "shadow", "--no-send"], deps)
    expect(missingAgentText).toBe("rsvp.refresh: dry run requires=--agent")
    await expect(runOuroCli(["rsvp", "smoke", "--mode", "preflight", "--surface", "bluebubbles", "--json"], deps))
      .resolves.toMatch(/"requires": "--agent"/)

    rsvpMocks.readRsvpConfig.mockReturnValue({ ok: false, reason: "missing", path: "/missing/rsvp/config.json", message: "missing native RSVP config" })

    const importResult = JSON.parse(await runOuroCli([
      "rsvp",
      "import-legacy",
      "--agent",
      "slugger",
      "--legacy-root",
      "/tmp/legacy-rsvp",
      "--mode",
      "shadow",
      "--yes",
      "--json",
    ], deps))
    const refreshResult = JSON.parse(await runOuroCli(["rsvp", "refresh", "--agent", "slugger", "--mode", "shadow", "--no-send", "--json"], deps))
    const smokeResult = JSON.parse(await runOuroCli(["rsvp", "smoke", "--agent", "slugger", "--mode", "preflight", "--surface", "bluebubbles", "--json"], deps))
    const outputPath = path.join(os.tmpdir(), `rsvp-refresh-missing-config-${process.pid}-${Date.now()}.json`)
    const refreshText = await runOuroCli(["rsvp", "refresh", "--agent", "slugger", "--mode", "shadow", "--no-send", "--output", outputPath], deps)
    const writtenRefresh = JSON.parse(fs.readFileSync(outputPath, "utf-8"))

    expect(importResult).toMatchObject({ ok: false, command: "rsvp.import-legacy", requires: "native RSVP config" })
    expect(refreshResult).toMatchObject({ ok: true, command: "rsvp.refresh", requires: "native RSVP config" })
    expect(smokeResult).toMatchObject({ ok: true, command: "rsvp.smoke", requires: "native RSVP config", sendAllowed: false })
    expect(refreshText).toBe("rsvp.refresh: dry run agent=slugger requires=native RSVP config")
    expect(writtenRefresh).toMatchObject({ ok: true, command: "rsvp.refresh", requires: "native RSVP config" })
    expect(rsvpMocks.importLegacyRsvpState).not.toHaveBeenCalled()
    expect(rsvpMocks.fetchAislePlannerRsvps).not.toHaveBeenCalled()
    expect(rsvpMocks.sendText).not.toHaveBeenCalled()
    expect(deps.sendCommand).not.toHaveBeenCalled()
    fs.rmSync(outputPath, { force: true })
  })

  it("surfaces unsuccessful legacy state imports without falling back to config migration", async () => {
    mockRuntimeCredentials()
    const tmp = seedBundle()
    rsvpMocks.readRsvpConfig.mockReturnValue({ ok: true, config: rsvpConfig })
    rsvpMocks.importLegacyRsvpState.mockReturnValue({
      ok: false,
      reason: "missing_legacy_state",
      message: "legacy RSVP state is missing",
    })
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    try {
      const result = JSON.parse(await runOuroCli([
        "rsvp",
        "import-legacy",
        "--agent",
        "slugger",
        "--legacy-root",
        "/tmp/legacy-rsvp",
        "--mode",
        "shadow",
        "--yes",
        "--json",
      ], deps))

      expect(result).toMatchObject({
        ok: true,
        command: "rsvp.import-legacy",
        message: "legacy RSVP state is missing",
        migration: { ok: false, reason: "missing_legacy_state" },
      })
      expect(rsvpMocks.importLegacyRsvpConfig).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
    }
  })

  it("falls back to native config files when the primary config reader yields no result", async () => {
    mockRuntimeCredentials()
    const tmp = createTmpBundle({ agentName: "slugger" })
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    rsvpMocks.readRsvpConfig.mockReturnValue(undefined)
    try {
      const missing = JSON.parse(await runOuroCli(["rsvp", "refresh", "--agent", "slugger", "--mode", "shadow", "--no-send", "--json"], deps))
      expect(missing).toMatchObject({
        ok: true,
        command: "rsvp.refresh",
        requires: "native RSVP config",
        result: { reason: "missing" },
      })

      fs.mkdirSync(path.join(tmp.agentRoot, "rsvp"), { recursive: true })
      fs.writeFileSync(path.join(tmp.agentRoot, "rsvp", "config.json"), "{not-json", "utf-8")
      const malformed = JSON.parse(await runOuroCli(["rsvp", "refresh", "--agent", "slugger", "--mode", "shadow", "--no-send", "--json"], deps))
      expect(malformed).toMatchObject({
        ok: true,
        command: "rsvp.refresh",
        requires: "native RSVP config",
        result: { reason: "malformed" },
      })
    } finally {
      tmp.cleanup()
    }
  })

  it("blocks refresh on readiness failure or fetch failure before any outbound send", async () => {
    mockRuntimeCredentials()
    const tmp = seedBundle()
    rsvpMocks.readRsvpConfig.mockReturnValue({ ok: true, config: rsvpConfig })
    rsvpMocks.validateRsvpReadiness.mockReturnValueOnce({ status: "blocked", checks: [{ id: "rsvp.aisleplanner_credentials", status: "fail" }] })
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot, fetchImpl: vi.fn() as unknown as typeof fetch })
    try {
      const readiness = JSON.parse(await runOuroCli(["rsvp", "refresh", "--agent", "slugger", "--mode", "shadow", "--no-send", "--json"], deps))
      expect(readiness).toMatchObject({
        ok: false,
        command: "rsvp.refresh",
        message: "RSVP refresh blocked by readiness checks",
      })
      expect(rsvpMocks.fetchAislePlannerRsvps).not.toHaveBeenCalled()

      rsvpMocks.validateRsvpReadiness.mockReturnValueOnce({ ok: true, checks: [] })
      rsvpMocks.fetchAislePlannerRsvps.mockResolvedValueOnce({ ok: false, message: "AislePlanner refused auth" })
      const fetchFailure = JSON.parse(await runOuroCli(["rsvp", "refresh", "--agent", "slugger", "--mode", "shadow", "--no-send", "--json"], deps))

      expect(rsvpMocks.fetchAislePlannerRsvps).toHaveBeenCalledWith(expect.objectContaining({
        fetchFn: deps.fetchImpl,
        weddingId: "wed-1",
        eventId: "event-1",
      }))
      expect(fetchFailure).toMatchObject({
        ok: false,
        command: "rsvp.refresh",
        message: "AislePlanner refused auth",
      })
      expect(rsvpMocks.sendText).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
    }
  })

  it("handles absent or non-object baselines as an empty previous RSVP snapshot", async () => {
    mockRuntimeCredentials()
    const tmp = seedBundle()
    rsvpMocks.readRsvpConfig.mockReturnValue({ ok: true, config: rsvpConfig })
    rsvpMocks.validateRsvpReadiness.mockReturnValue({ ok: true, checks: [] })
    rsvpMocks.fetchAislePlannerRsvps.mockResolvedValue({
      ok: true,
      fetchedAt: "2026-07-09T17:00:00.000Z",
      guests: { "pending-1": { first_name: "Casey", last_name: "Pending", attending_status: "pending" } },
      allGuests: { "pending-1": { first_name: "Casey", last_name: "Pending" } },
    })
    rsvpMocks.buildRsvpSnapshot.mockReturnValue(currentSnapshot)
    rsvpMocks.computeRsvpDelta.mockReturnValue({ currentSnapshotId: "snap_current", newRsvps: [], statusChanges: [], newGuests: [], removedGuests: [], summary: currentSnapshot.summary })
    rsvpMocks.renderRsvpReport.mockReturnValue("RSVP Update\n\nNo baseline yet.")
    rsvpMocks.decideRsvpOutboundReport.mockReturnValue({ action: "skip", reason: "no-send" })
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    const baselinePath = path.join(tmp.agentRoot, "state", "rsvp", "baseline.json")
    try {
      fs.rmSync(baselinePath, { force: true })
      await runOuroCli(["rsvp", "refresh", "--agent", "slugger", "--mode", "shadow", "--no-send", "--json"], deps)
      expect(rsvpMocks.computeRsvpDelta).toHaveBeenLastCalledWith(null, currentSnapshot)

      fs.writeFileSync(baselinePath, JSON.stringify(["not-an-object"]), "utf-8")
      await runOuroCli(["rsvp", "refresh", "--agent", "slugger", "--mode", "shadow", "--no-send", "--json"], deps)
      expect(rsvpMocks.computeRsvpDelta).toHaveBeenLastCalledWith(null, currentSnapshot)
    } finally {
      tmp.cleanup()
    }
  })

  it("sends refresh reports only with explicit live permission and records the accepted BlueBubbles receipt", async () => {
    mockRuntimeCredentials()
    const tmp = seedBundle()
    rsvpMocks.readRsvpConfig.mockReturnValue({ ok: true, config: { ...rsvpConfig, bluebubblesRoute: { chatGuid: "iMessage;-;chat-guid" } } })
    rsvpMocks.validateRsvpReadiness.mockReturnValue({
      status: "ready",
      credentials: { username: "user@example.com", password: "secret" },
      checks: [],
    })
    rsvpMocks.fetchAislePlannerRsvps.mockResolvedValue({
      ok: true,
      fetchedAt: "2026-07-09T17:00:00.000Z",
      guests: { "pending-1": { first_name: "Casey", last_name: "Pending", attending_status: "pending" } },
      allGuests: { "pending-1": { first_name: "Casey", last_name: "Pending" } },
    })
    rsvpMocks.buildRsvpSnapshot.mockReturnValue(currentSnapshot)
    rsvpMocks.parseRsvpSnapshot.mockReturnValue({ ok: true, snapshot: previousSnapshot })
    rsvpMocks.computeRsvpDelta.mockReturnValue({ currentSnapshotId: "snap_current", newRsvps: [], statusChanges: [], newGuests: [], removedGuests: [], summary: currentSnapshot.summary })
    rsvpMocks.renderRsvpReport.mockReturnValue("RSVP Update\n\nCasey is pending.")
    rsvpMocks.decideRsvpOutboundReport.mockReturnValue({ action: "send", idempotencyKey: "rsvp:snap_current:hash" })
    rsvpMocks.sendText.mockResolvedValue({ ok: true, messageGuid: "bluebubbles-guid" })
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    try {
      const result = JSON.parse(await runOuroCli(["rsvp", "refresh", "--agent", "slugger", "--mode", "live", "--allow-send", "--json"], deps))

      expect(rsvpMocks.sendText).toHaveBeenCalledWith({
        chat: expect.objectContaining({
          chatGuid: "iMessage;-;chat-guid",
          sendTarget: { kind: "chat_guid", value: "iMessage;-;chat-guid" },
          sessionKey: "bluebubbles:rsvp:iMessage;-;chat-guid",
        }),
        text: "RSVP Update\n\nCasey is pending.",
        tempGuid: "rsvp:snap_current:hash",
      })
      expect(rsvpMocks.recordRsvpOutboundAttempt).toHaveBeenCalledWith(expect.objectContaining({
        bluebubblesRecord: expect.objectContaining({
          recordId: "rsvp:snap_current:hash",
          messageGuid: "bluebubbles-guid",
        }),
      }))
      expect(result).toMatchObject({
        ok: true,
        command: "rsvp.refresh",
        sideEffect: true,
        sendAllowed: true,
        refresh: {
          delivery: { guid: "bluebubbles-guid", messageGuid: "bluebubbles-guid" },
        },
      })
    } finally {
      tmp.cleanup()
    }
  })

  it("refuses to send refresh reports in shadow mode even if the lower adapter receives allowSend directly", async () => {
    mockRuntimeCredentials()
    const tmp = seedBundle()
    rsvpMocks.readRsvpConfig.mockReturnValue({ ok: true, config: rsvpConfig })
    rsvpMocks.validateRsvpReadiness.mockReturnValue({
      status: "ready",
      credentials: { username: "user@example.com", password: "secret" },
      checks: [],
    })
    rsvpMocks.fetchAislePlannerRsvps.mockResolvedValue({
      ok: true,
      fetchedAt: "2026-07-09T17:00:00.000Z",
      guests: { "pending-1": { first_name: "Casey", last_name: "Pending", attending_status: "pending" } },
      allGuests: { "pending-1": { first_name: "Casey", last_name: "Pending" } },
    })
    rsvpMocks.buildRsvpSnapshot.mockReturnValue(currentSnapshot)
    rsvpMocks.parseRsvpSnapshot.mockReturnValue({ ok: true, snapshot: previousSnapshot })
    rsvpMocks.computeRsvpDelta.mockReturnValue({ currentSnapshotId: "snap_current", newRsvps: [], statusChanges: [], newGuests: [], removedGuests: [], summary: currentSnapshot.summary })
    rsvpMocks.renderRsvpReport.mockReturnValue("RSVP Update\n\nShadow must not send.")
    rsvpMocks.decideRsvpOutboundReport.mockReturnValue({ action: "send", idempotencyKey: "rsvp:shadow" })
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    try {
      const result = JSON.parse(await runRsvpCliCommand({
        kind: "rsvp.refresh",
        agent: "slugger",
        mode: "shadow",
        allowSend: true,
        json: true,
      }, deps))

      expect(result).toMatchObject({
        ok: true,
        command: "rsvp.refresh",
        sideEffect: false,
        allowSend: false,
        sendAllowed: false,
        refresh: {
          outboundDecision: { action: "send", idempotencyKey: "rsvp:shadow" },
        },
      })
      expect(rsvpMocks.sendText).not.toHaveBeenCalled()
      expect(rsvpMocks.recordRsvpOutboundAttempt).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
    }
  })

  it("records refresh sends even when BlueBubbles returns no receipt body", async () => {
    mockRuntimeCredentials()
    const tmp = seedBundle()
    rsvpMocks.readRsvpConfig.mockReturnValue({ ok: true, config: rsvpConfig })
    rsvpMocks.validateRsvpReadiness.mockReturnValue({ status: "ready", credentials: { username: "user@example.com", password: "secret" }, checks: [] })
    rsvpMocks.fetchAislePlannerRsvps.mockResolvedValue({
      ok: true,
      fetchedAt: "2026-07-09T17:00:00.000Z",
      guests: { "pending-1": { first_name: "Casey", last_name: "Pending", attending_status: "pending" } },
      allGuests: { "pending-1": { first_name: "Casey", last_name: "Pending" } },
    })
    rsvpMocks.buildRsvpSnapshot.mockReturnValue(currentSnapshot)
    rsvpMocks.parseRsvpSnapshot.mockReturnValue({ ok: true, snapshot: previousSnapshot })
    rsvpMocks.computeRsvpDelta.mockReturnValue({ currentSnapshotId: "snap_current", newRsvps: [], statusChanges: [], newGuests: [], removedGuests: [], summary: currentSnapshot.summary })
    rsvpMocks.renderRsvpReport.mockReturnValue("RSVP Update\n\nAccepted without receipt.")
    rsvpMocks.decideRsvpOutboundReport.mockReturnValue({ action: "send", idempotencyKey: "rsvp:no-receipt" })
    rsvpMocks.sendText.mockResolvedValue(null)
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    try {
      const result = JSON.parse(await runOuroCli(["rsvp", "refresh", "--agent", "slugger", "--mode", "live", "--allow-send", "--json"], deps))

      expect(result).toMatchObject({
        ok: true,
        command: "rsvp.refresh",
        sideEffect: true,
        refresh: { delivery: {} },
      })
      expect(rsvpMocks.recordRsvpOutboundAttempt).toHaveBeenCalledWith(expect.objectContaining({
        bluebubblesRecord: {
          recordId: "rsvp:no-receipt",
          status: "accepted",
          tempGuid: "rsvp:no-receipt",
        },
      }))
    } finally {
      tmp.cleanup()
    }
  })

  it("writes smoke replay output and uses the default pending question", async () => {
    mockRuntimeCredentials()
    const tmp = seedBundle()
    const replayOutput = path.join(os.tmpdir(), `rsvp-smoke-replay-${process.pid}-${Date.now()}.json`)
    rsvpMocks.readRsvpConfig.mockReturnValue({ ok: true, config: rsvpConfig })
    rsvpMocks.parseRsvpSnapshot.mockReturnValue({ ok: true, snapshot: currentSnapshot })
    rsvpMocks.queryRsvpSnapshot.mockReturnValue({
      ok: true,
      status: "pending",
      count: 1,
      total: 273,
      names: ["Casey Pending"],
      text: "Pending (1/273): Casey Pending",
    })
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    try {
      const result = JSON.parse(await runOuroCli([
        "rsvp",
        "smoke",
        "--agent",
        "slugger",
        "--mode",
        "preflight",
        "--surface",
        "bluebubbles",
        "--replay-output",
        replayOutput,
        "--json",
      ], deps))
      const replay = JSON.parse(fs.readFileSync(replayOutput, "utf-8"))

      expect(rsvpMocks.queryRsvpSnapshot).toHaveBeenCalledWith(currentSnapshot, { query: "who is pending?" })
      expect(result).toMatchObject({ ok: true, command: "rsvp.smoke", answer: expect.stringContaining("Casey Pending") })
      expect(replay).toMatchObject({ ok: true, command: "rsvp.smoke", answer: expect.stringContaining("Casey Pending") })

      rsvpMocks.sendText.mockResolvedValue({ ok: true, guid: "sent-guid" })
      const liveText = await runOuroCli([
        "rsvp",
        "smoke",
        "--agent",
        "slugger",
        "--mode",
        "live",
        "--surface",
        "bluebubbles",
        "--allow-send",
      ], deps)
      expect(liveText).toBe("rsvp.smoke: explicit side effects enabled agent=slugger")
    } finally {
      fs.rmSync(replayOutput, { force: true })
      tmp.cleanup()
    }
  })

  it("reports unreadable compare snapshots instead of contacting the daemon", async () => {
    mockRuntimeCredentials()
    const deps = createMockDeps()

    const result = JSON.parse(await runOuroCli([
      "rsvp",
      "compare",
      "--native",
      "/tmp/missing-native-rsvp.json",
      "--legacy",
      "/tmp/missing-legacy-rsvp.json",
      "--json",
    ], deps))

    expect(result).toMatchObject({
      ok: true,
      command: "rsvp.compare",
      sideEffect: false,
      requires: "readable snapshots",
    })
    expect(rsvpMocks.parseRsvpSnapshot).not.toHaveBeenCalled()
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("throws on malformed snapshots before rendering a compare report", async () => {
    mockRuntimeCredentials()
    const nativePath = path.join(os.tmpdir(), `rsvp-native-bad-${process.pid}-${Date.now()}.json`)
    const legacyPath = path.join(os.tmpdir(), `rsvp-legacy-bad-${process.pid}-${Date.now()}.json`)
    fs.writeFileSync(nativePath, JSON.stringify(currentSnapshot), "utf-8")
    fs.writeFileSync(legacyPath, JSON.stringify(previousSnapshot), "utf-8")
    rsvpMocks.parseRsvpSnapshot.mockReturnValueOnce({ ok: false, reason: "bad-shape" })
    const deps = createMockDeps()
    try {
      await expect(runOuroCli([
        "rsvp",
        "compare",
        "--native",
        nativePath,
        "--legacy",
        legacyPath,
        "--json",
      ], deps)).rejects.toThrow(/invalid RSVP snapshot/)
      expect(rsvpMocks.computeRsvpDelta).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(nativePath, { force: true })
      fs.rmSync(legacyPath, { force: true })
    }
  })

  it("executes rsvp habit stage by writing the native typed RSVP habit file", async () => {
    mockRuntimeCredentials()
    const tmp = createTmpBundle({ agentName: "slugger" })
    const outputPath = path.join(os.tmpdir(), `rsvp-habit-stage-${process.pid}-${Date.now()}.json`)
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    try {
      const text = await runOuroCli([
        "rsvp",
        "habit",
        "stage",
        "--agent",
        "slugger",
        "--mode",
        "shadow",
        "--cadence",
        "0 10 * * *",
        "--output",
        outputPath,
        "--json",
      ], deps)
      const parsed = JSON.parse(text)
      const written = JSON.parse(fs.readFileSync(outputPath, "utf-8"))
      const habitPath = path.join(tmp.agentRoot, "habits", "rsvp-ari-rachel.md")
      const habitContent = fs.readFileSync(habitPath, "utf-8")

      expect(parsed).toMatchObject({
        ok: true,
        command: "rsvp.habit.stage",
        sideEffect: true,
        agent: "slugger",
        mode: "shadow",
        habit: {
          name: "rsvp-ari-rachel",
          cadence: "0 10 * * *",
          rsvp: {
            policyVersion: "rsvp-habit/v1",
            mode: "shadow",
            sense: "bluebubbles",
            liveSendEligible: false,
          },
        },
      })
      expect(written).toEqual(parsed)
      expect(habitContent).toContain("tools: [rsvp_query, rsvp_summary]")
      expect(habitContent).toContain("sense: bluebubbles")
      expect(habitContent).toContain("snapshotRef: state/rsvp/snapshots/latest.json")
      expect(habitContent).not.toMatch(/registered|planned|script, not slugger/i)
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(outputPath, { force: true })
      tmp.cleanup()
    }
  })
})
