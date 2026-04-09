import { afterEach, describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import type { StatusPayload } from "../../../heart/daemon/cli-render"
import type { DaemonResponse } from "../../../heart/daemon/daemon"

// The module under test does not exist yet — these imports will fail (red phase)
import {
  pollDaemonStartup,
  renderStartupProgress,
  assessStability,
} from "../../../heart/daemon/startup-tui"

/** Build a minimal StatusPayload for testing */
function makePayload(workers: Array<{
  agent: string
  status: string
  startedAt: string | null
  errorReason?: string | null
  fixHint?: string | null
}>): StatusPayload {
  return {
    overview: {
      daemon: "running",
      health: "ok",
      socketPath: "/tmp/test.sock",
      outlookUrl: "http://localhost:6876",
      version: "0.1.0-alpha.1",
      lastUpdated: "2026-04-09T12:00:00Z",
      repoRoot: "/repo",
      configFingerprint: "abc123",
      workerCount: workers.length,
      senseCount: 0,
      entryPath: "/entry",
      mode: "production",
    },
    workers: workers.map((w) => ({
      agent: w.agent,
      worker: "cli",
      status: w.status,
      pid: w.status === "crashed" ? null : 1234,
      restartCount: w.status === "crashed" ? 3 : 0,
      lastExitCode: w.status === "crashed" ? 1 : null,
      lastSignal: null,
      startedAt: w.startedAt,
      errorReason: w.errorReason ?? null,
      fixHint: w.fixHint ?? null,
    })),
    senses: [],
    sync: [],
    agents: [],
  }
}

function makeDaemonResponse(payload: StatusPayload): DaemonResponse {
  return { ok: true, message: "ok", data: payload as unknown }
}

describe("startup-tui", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("emits at least one nerves event", () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.test_marker",
      message: "startup-tui test",
    })
  })

  // ── assessStability ──

  describe("assessStability", () => {
    it("returns all stable when all agents running 5s+", () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
        { agent: "beta", status: "running", startedAt: "2026-04-09T12:00:04.000Z" },
      ])
      const result = assessStability(payload, now)
      expect(result.resolved).toBe(true)
      expect(result.stable).toEqual(["alpha", "beta"])
      expect(result.degraded).toEqual([])
    })

    it("returns not resolved when agent running < 5s", () => {
      const now = new Date("2026-04-09T12:00:03.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
      ])
      const result = assessStability(payload, now)
      expect(result.resolved).toBe(false)
    })

    it("returns crashed agent as degraded", () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
        { agent: "beta", status: "crashed", startedAt: null, errorReason: "credentials missing", fixHint: "run ouro auth beta" },
      ])
      const result = assessStability(payload, now)
      expect(result.resolved).toBe(true)
      expect(result.stable).toEqual(["alpha"])
      expect(result.degraded).toEqual([{
        agent: "beta",
        errorReason: "credentials missing",
        fixHint: "run ouro auth beta",
      }])
    })

    it("returns all agents crashed as all degraded", () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "crashed", startedAt: null, errorReason: "bad config", fixHint: "fix agent.json" },
        { agent: "beta", status: "crashed", startedAt: null, errorReason: "missing creds", fixHint: "run ouro auth" },
      ])
      const result = assessStability(payload, now)
      expect(result.resolved).toBe(true)
      expect(result.stable).toEqual([])
      expect(result.degraded).toHaveLength(2)
    })

    it("handles null startedAt as not-yet-stable", () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: null },
      ])
      const result = assessStability(payload, now)
      expect(result.resolved).toBe(false)
    })

    it("handles starting status as not-yet-resolved", () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "starting", startedAt: null },
      ])
      const result = assessStability(payload, now)
      expect(result.resolved).toBe(false)
    })

    it("empty workers returns immediately resolved", () => {
      const now = Date.now()
      const payload = makePayload([])
      const result = assessStability(payload, now)
      expect(result.resolved).toBe(true)
      expect(result.stable).toEqual([])
      expect(result.degraded).toEqual([])
    })
  })

  // ── renderStartupProgress ──

  describe("renderStartupProgress", () => {
    it("includes spinner character in output", () => {
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
      ])
      const output = renderStartupProgress(payload, 2000)
      const spinnerChars = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
      const hasSpinner = spinnerChars.split("").some((ch) => output.includes(ch))
      expect(hasSpinner).toBe(true)
    })

    it("includes agent names in output", () => {
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
        { agent: "beta", status: "starting", startedAt: null },
      ])
      const output = renderStartupProgress(payload, 3000)
      expect(output).toContain("alpha")
      expect(output).toContain("beta")
    })

    it("includes ANSI cursor-up escape codes for multi-line overwrite", () => {
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
        { agent: "beta", status: "starting", startedAt: null },
      ])
      const output = renderStartupProgress(payload, 3000)
      // Should contain cursor-up escape for in-place rendering
      expect(output).toMatch(/\x1b\[\d+A/)
    })

    it("includes line-clear escape codes", () => {
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
      ])
      const output = renderStartupProgress(payload, 2000)
      expect(output).toContain("\x1b[2K")
    })

    it("shows status per worker", () => {
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
        { agent: "beta", status: "crashed", startedAt: null },
      ])
      const output = renderStartupProgress(payload, 5000)
      expect(output).toContain("running")
      expect(output).toContain("crashed")
    })
  })

  // ── pollDaemonStartup ──

  describe("pollDaemonStartup", () => {
    it("returns immediate success when all agents healthy on first poll", async () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
      ])

      const deps = {
        sendCommand: vi.fn(async () => makeDaemonResponse(payload)),
        socketPath: "/tmp/test.sock",
        writeStdout: vi.fn(),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
      }

      const result = await pollDaemonStartup(deps)
      expect(result.stable).toEqual(["alpha"])
      expect(result.degraded).toEqual([])
    })

    it("waits for agent to stabilize over multiple polls", async () => {
      let callCount = 0
      const baseTime = new Date("2026-04-09T12:00:00.000Z").getTime()

      // First poll: agent running but only 2s old
      const earlyPayload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
      ])
      // Second poll: agent running 6s old
      const stablePayload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
      ])

      const deps = {
        sendCommand: vi.fn(async () => makeDaemonResponse(stablePayload)),
        socketPath: "/tmp/test.sock",
        writeStdout: vi.fn(),
        now: vi.fn(() => {
          callCount++
          // First call: 2s after start; second call: 6s after start
          return callCount <= 2 ? baseTime + 2000 : baseTime + 6000
        }),
        sleep: vi.fn(async () => {}),
      }

      const result = await pollDaemonStartup(deps)
      expect(result.stable).toEqual(["alpha"])
      expect(deps.sleep).toHaveBeenCalled()
    })

    it("reports crashed agent as degraded while other agents succeed", async () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
        { agent: "beta", status: "crashed", startedAt: null, errorReason: "creds missing", fixHint: "run ouro auth" },
      ])

      const deps = {
        sendCommand: vi.fn(async () => makeDaemonResponse(payload)),
        socketPath: "/tmp/test.sock",
        writeStdout: vi.fn(),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
      }

      const result = await pollDaemonStartup(deps)
      expect(result.stable).toEqual(["alpha"])
      expect(result.degraded).toEqual([{
        agent: "beta",
        errorReason: "creds missing",
        fixHint: "run ouro auth",
      }])
    })

    it("retries when daemon socket not responding initially", async () => {
      let callCount = 0
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
      ])

      const deps = {
        sendCommand: vi.fn(async () => {
          callCount++
          if (callCount <= 2) throw new Error("ECONNREFUSED")
          return makeDaemonResponse(payload)
        }),
        socketPath: "/tmp/test.sock",
        writeStdout: vi.fn(),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
      }

      const result = await pollDaemonStartup(deps)
      expect(result.stable).toEqual(["alpha"])
      expect(deps.sendCommand).toHaveBeenCalledTimes(3)
    })

    it("reports all agents as degraded when all crash", async () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "crashed", startedAt: null, errorReason: "bad config", fixHint: "fix it" },
        { agent: "beta", status: "crashed", startedAt: null, errorReason: "bad creds", fixHint: "auth it" },
      ])

      const deps = {
        sendCommand: vi.fn(async () => makeDaemonResponse(payload)),
        socketPath: "/tmp/test.sock",
        writeStdout: vi.fn(),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
      }

      const result = await pollDaemonStartup(deps)
      expect(result.stable).toEqual([])
      expect(result.degraded).toHaveLength(2)
      expect(result.degraded[0].agent).toBe("alpha")
      expect(result.degraded[1].agent).toBe("beta")
    })

    it("includes errorReason and fixHint from worker snapshot in degraded result", async () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        {
          agent: "alpha",
          status: "crashed",
          startedAt: null,
          errorReason: "agent.json not found",
          fixHint: "run ouro hatch alpha",
        },
      ])

      const deps = {
        sendCommand: vi.fn(async () => makeDaemonResponse(payload)),
        socketPath: "/tmp/test.sock",
        writeStdout: vi.fn(),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
      }

      const result = await pollDaemonStartup(deps)
      expect(result.degraded[0]).toEqual({
        agent: "alpha",
        errorReason: "agent.json not found",
        fixHint: "run ouro hatch alpha",
      })
    })

    it("renders ANSI output with spinner during polling", async () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
      ])

      const writes: string[] = []
      const deps = {
        sendCommand: vi.fn(async () => makeDaemonResponse(payload)),
        socketPath: "/tmp/test.sock",
        writeStdout: vi.fn((text: string) => writes.push(text)),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
      }

      await pollDaemonStartup(deps)
      const allOutput = writes.join("")
      expect(allOutput).toContain("alpha")
    })

    it("writes final summary with stable/degraded markers", async () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
        { agent: "beta", status: "crashed", startedAt: null, errorReason: "fail", fixHint: "fix" },
      ])

      const writes: string[] = []
      const deps = {
        sendCommand: vi.fn(async () => makeDaemonResponse(payload)),
        socketPath: "/tmp/test.sock",
        writeStdout: vi.fn((text: string) => writes.push(text)),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
      }

      await pollDaemonStartup(deps)
      const allOutput = writes.join("")
      // Should have green checkmark for stable and red X for degraded
      expect(allOutput).toContain("alpha")
      expect(allOutput).toContain("beta")
    })
  })
})
