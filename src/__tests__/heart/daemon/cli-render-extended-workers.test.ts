import { describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import { parseStatusPayload } from "../../../heart/daemon/cli-render"

/** Minimal valid overview for parseStatusPayload */
function makeOverview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    daemon: "running",
    health: "ok",
    socketPath: "/tmp/test.sock",
    outlookUrl: "http://localhost:6876",
    version: "0.1.0-alpha.1",
    lastUpdated: "2026-04-09T12:00:00Z",
    repoRoot: "/repo",
    configFingerprint: "abc123",
    workerCount: 1,
    senseCount: 0,
    entryPath: "/entry",
    mode: "production",
    ...overrides,
  }
}

function makeWorkerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: "testagent",
    worker: "cli",
    status: "running",
    pid: 1234,
    restartCount: 0,
    lastExitCode: null,
    lastSignal: null,
    startedAt: "2026-04-09T12:00:00.000Z",
    errorReason: null,
    fixHint: null,
    ...overrides,
  }
}

describe("parseStatusPayload extended worker fields", () => {
  it("emits at least one nerves event", () => {
    // Required by project audit rules
    emitNervesEvent({
      component: "daemon",
      event: "daemon.test_marker",
      message: "cli-render-extended-workers test",
    })
  })

  it("parses startedAt from worker rows", () => {
    const data = {
      overview: makeOverview(),
      workers: [makeWorkerRow({ startedAt: "2026-04-09T12:00:05.000Z" })],
      senses: [],
    }
    const payload = parseStatusPayload(data)
    expect(payload).not.toBeNull()
    expect(payload!.workers[0].startedAt).toBe("2026-04-09T12:00:05.000Z")
  })

  it("parses errorReason from worker rows", () => {
    const data = {
      overview: makeOverview(),
      workers: [makeWorkerRow({ errorReason: "credentials missing", status: "crashed" })],
      senses: [],
    }
    const payload = parseStatusPayload(data)
    expect(payload).not.toBeNull()
    expect(payload!.workers[0].errorReason).toBe("credentials missing")
  })

  it("parses fixHint from worker rows", () => {
    const data = {
      overview: makeOverview(),
      workers: [makeWorkerRow({ fixHint: "run ouro auth testagent", status: "crashed" })],
      senses: [],
    }
    const payload = parseStatusPayload(data)
    expect(payload).not.toBeNull()
    expect(payload!.workers[0].fixHint).toBe("run ouro auth testagent")
  })

  it("handles null startedAt", () => {
    const data = {
      overview: makeOverview(),
      workers: [makeWorkerRow({ startedAt: null })],
      senses: [],
    }
    const payload = parseStatusPayload(data)
    expect(payload).not.toBeNull()
    expect(payload!.workers[0].startedAt).toBeNull()
  })

  it("handles null errorReason and fixHint", () => {
    const data = {
      overview: makeOverview(),
      workers: [makeWorkerRow({ errorReason: null, fixHint: null })],
      senses: [],
    }
    const payload = parseStatusPayload(data)
    expect(payload).not.toBeNull()
    expect(payload!.workers[0].errorReason).toBeNull()
    expect(payload!.workers[0].fixHint).toBeNull()
  })

  it("handles missing startedAt, errorReason, fixHint (undefined)", () => {
    const row = makeWorkerRow()
    delete row.startedAt
    delete row.errorReason
    delete row.fixHint
    const data = {
      overview: makeOverview(),
      workers: [row],
      senses: [],
    }
    const payload = parseStatusPayload(data)
    expect(payload).not.toBeNull()
    // Missing fields should default to null
    expect(payload!.workers[0].startedAt).toBeNull()
    expect(payload!.workers[0].errorReason).toBeNull()
    expect(payload!.workers[0].fixHint).toBeNull()
  })

  it("includes all three new fields in StatusWorkerRow", () => {
    const data = {
      overview: makeOverview(),
      workers: [makeWorkerRow({
        startedAt: "2026-04-09T12:00:00.000Z",
        errorReason: "bad config",
        fixHint: "edit agent.json",
      })],
      senses: [],
    }
    const payload = parseStatusPayload(data)
    expect(payload).not.toBeNull()
    const w = payload!.workers[0]
    expect(w).toEqual(expect.objectContaining({
      agent: "testagent",
      worker: "cli",
      status: "running",
      startedAt: "2026-04-09T12:00:00.000Z",
      errorReason: "bad config",
      fixHint: "edit agent.json",
    }))
  })
})
