import { describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import { formatDaemonStatusOutput, parseStatusPayload } from "../../../heart/daemon/cli-render"

/** Minimal valid overview for parseStatusPayload */
function makeOverview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    daemon: "running",
    health: "ok",
    socketPath: "/tmp/test.sock",
    mailboxUrl: "http://localhost:6876",
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

function makeSenseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: "slugger",
    sense: "bluebubbles",
    enabled: true,
    status: "running",
    detail: ":18789 /bluebubbles-webhook",
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

  it("renders crashed worker error and fix hints in daemon status output", () => {
    const output = formatDaemonStatusOutput({
      ok: true,
      data: {
        overview: makeOverview({ health: "warn" }),
        workers: [makeWorkerRow({
          status: "crashed",
          pid: null,
          errorReason: "secrets.json for 'ouroboros' is missing providers.github-copilot section",
          fixHint: "Run 'ouro auth ouroboros' to configure github-copilot credentials.",
        })],
        senses: [],
      },
    }, "fallback")

    expect(output).toContain("crashed")
    expect(output).toContain("error: secrets.json for 'ouroboros' is missing providers.github-copilot section")
    expect(output).toContain("fix:   Run 'ouro auth ouroboros' to configure github-copilot credentials.")
  })

  it("parses and renders BlueBubbles active-turn health fields", () => {
    const senses = [makeSenseRow({
      pendingRecoveryCount: 0,
      failedRecoveryCount: 0,
      activeTurnCount: 2,
      stalledTurnCount: 1,
      oldestActiveTurnStartedAt: "2026-04-30T23:00:00.000Z",
      oldestActiveTurnAgeMs: 120_000,
    })]
    const data = {
      overview: makeOverview({ senseCount: 1 }),
      workers: [],
      senses,
    }

    const payload = parseStatusPayload(data)
    expect(payload?.senses[0]).toEqual(expect.objectContaining({
      activeTurnCount: 2,
      stalledTurnCount: 1,
      oldestActiveTurnStartedAt: "2026-04-30T23:00:00.000Z",
      oldestActiveTurnAgeMs: 120_000,
    }))

    const output = formatDaemonStatusOutput({ ok: true, data }, "fallback")
    expect(output).toContain("activeTurns=2")
    expect(output).toContain("stalledTurns=1")
    expect(output).toContain("oldestActive=2026-04-30T23:00:00.000Z")
    expect(output).toContain("oldestActiveAge=2m")
  })

  it("parses and renders provider lane readiness without leaking credentials", () => {
    const output = formatDaemonStatusOutput({
      ok: true,
      data: {
        overview: makeOverview({ workerCount: 0 }),
        workers: [],
        senses: [],
        agents: [{ name: "slugger", enabled: true }],
        providers: [
          {
            agent: "slugger",
            lane: "outward",
            provider: "minimax",
            model: "MiniMax-M2.5",
            source: "local",
            readiness: "ready",
            credential: "auth-flow from slugger",
          },
          {
            agent: "slugger",
            lane: "inner",
            provider: "openai-codex",
            model: "gpt-5.4",
            source: "local",
            readiness: "failed",
            detail: "400 status code",
            credential: "manual",
          },
        ],
      },
    }, "fallback")

    expect(output).toContain("Providers")
    expect(output).toContain("slugger outward")
    expect(output).toContain("minimax / MiniMax-M2.5")
    expect(output).toContain("ready")
    expect(output).toContain("inner")
    expect(output).toContain("openai-codex / gpt-5.4")
    expect(output).toContain("400 status code")
    expect(output).toContain("manual")
    expect(output).not.toContain("secret-value")
  })

  it("rejects malformed provider lane status payloads", () => {
    const base = {
      overview: makeOverview(),
      workers: [],
      senses: [],
    }

    expect(parseStatusPayload({ ...base, providers: { bad: true } })).toBeNull()
    expect(parseStatusPayload({ ...base, providers: [null] })).toBeNull()
    expect(parseStatusPayload({
      ...base,
      providers: [{
        agent: "slugger",
        lane: "inner",
        provider: "minimax",
        model: "MiniMax-M2.5",
        source: "local",
        readiness: "ready",
      }],
    })).toBeNull()
    expect(parseStatusPayload({
      ...base,
      providers: [{
        agent: "slugger",
        lane: "inner",
        provider: "minimax",
        model: "MiniMax-M2.5",
        source: "local",
        readiness: "ready",
        credential: "auth-flow from slugger",
        detail: "fresh",
      }],
    })?.providers[0]).toMatchObject({
      agent: "slugger",
      lane: "inner",
      detail: "fresh",
    })
  })

  it("parses and rejects health check status payload rows", () => {
    const base = {
      overview: makeOverview(),
      workers: [],
      senses: [],
    }

    expect(parseStatusPayload({
      ...base,
      healthChecks: [{
        name: "sense-probe:mcp-canary:slugger",
        status: "critical",
        message: "mcp canary failed",
      }],
    })?.healthChecks[0]).toEqual({
      name: "sense-probe:mcp-canary:slugger",
      status: "critical",
      message: "mcp canary failed",
    })
    expect(parseStatusPayload({ ...base, healthChecks: { bad: true } })).toBeNull()
    expect(parseStatusPayload({ ...base, healthChecks: [null] })).toBeNull()
    expect(parseStatusPayload({
      ...base,
      healthChecks: [{
        name: "sense-probe:mcp-canary:slugger",
        status: "critical",
      }],
    })).toBeNull()
  })
})
