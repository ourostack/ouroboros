import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it, vi } from "vitest"

const rsvpMocks = vi.hoisted(() => ({
  importLegacyRsvpConfig: vi.fn(),
  readRsvpConfig: vi.fn(),
  validateRsvpReadiness: vi.fn(),
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
    refreshRuntimeCredentialConfig: vi.fn(async () => ({
      ok: true,
      config: {
        rsvp: {
          aisleplanner: { username: "user@example.com", password: "secret" },
        },
      },
    })),
    refreshMachineRuntimeCredentialConfig: vi.fn(async () => ({
      ok: true,
      config: {
        bluebubbles: { serverUrl: "http://127.0.0.1:1234", password: "secret" },
      },
    })),
  }
})

import { runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"
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

describe("ouro rsvp operational CLI wiring", () => {
  it("runs bare import-legacy through native RSVP state migration, not config import", async () => {
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
})
