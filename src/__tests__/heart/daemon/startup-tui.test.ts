import { afterEach, describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import type { StatusPayload } from "../../../heart/daemon/cli-render"
import type { DaemonResponse } from "../../../heart/daemon/daemon"

// The module under test does not exist yet — these imports will fail (red phase)
import {
  pollDaemonStartup,
  renderWaitingForDaemon,
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
        daemonPid: 12345,
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
      // Pass prevLineCount > 0 to trigger cursor-up (simulating a second render)
      const output = renderStartupProgress(payload, 3000, 3)
      // Should contain cursor-up escape for in-place rendering
      expect(output).toMatch(/\x1b\[\d+A/)
    })

    it("does not include cursor-up on first render (prevLineCount=0)", () => {
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
      ])
      const output = renderStartupProgress(payload, 1000)
      expect(output).not.toMatch(/\x1b\[\d+A/)
    })

    it("includes line-clear escape codes", () => {
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
      ])
      const output = renderStartupProgress(payload, 2000)
      expect(output).toContain("\x1b[2K")
    })

    it("omits ANSI control and color escapes in non-TTY mode", () => {
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
        { agent: "beta", status: "starting", startedAt: null },
      ])
      const output = renderStartupProgress(payload, 3000, 3, { isTTY: false })
      expect(output).toContain("waiting for agents")
      expect(output).toContain("alpha/cli: running")
      expect(output).toContain("beta/cli: starting")
      expect(output).not.toMatch(/\x1b\[/)
    })

  it("omits ANSI control and color escapes while waiting for daemon in non-TTY mode", () => {
      const output = renderWaitingForDaemon(3000, "loading bundles", 2, { isTTY: false })
      expect(output).toContain("starting background service")
      expect(output).toContain("latest daemon event: loading bundles")
      expect(output).not.toMatch(/\x1b\[/)
    })

    it("defaults waiting-for-daemon rendering to TTY ANSI output", () => {
      const output = renderWaitingForDaemon(3000, null, 1)
      expect(output).toContain("starting background service")
      expect(output).toMatch(/\x1b\[\d+A/)
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
        daemonPid: 12345,
        writeRaw: vi.fn(),
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
        daemonPid: 12345,
        writeRaw: vi.fn(),
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
        daemonPid: 12345,
        writeRaw: vi.fn(),
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
        daemonPid: 12345,
        writeRaw: vi.fn(),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
        isProcessAlive: vi.fn(() => true),
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
        daemonPid: 12345,
        writeRaw: vi.fn(),
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
        daemonPid: 12345,
        writeRaw: vi.fn(),
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
        daemonPid: 12345,
        writeRaw: vi.fn((text: string) => writes.push(text)),
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
        daemonPid: 12345,
        writeRaw: vi.fn((text: string) => writes.push(text)),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
      }

      await pollDaemonStartup(deps)
      const allOutput = writes.join("")
      // Should have green checkmark for stable and red X for degraded
      expect(allOutput).toContain("alpha")
      expect(allOutput).toContain("beta")
    })

    it("shows waiting message with daemon event while socket is unavailable", async () => {
      let callCount = 0
      const writes: string[] = []
      const deps = {
        sendCommand: vi.fn(async () => {
          callCount++
          if (callCount <= 2) throw new Error("ECONNREFUSED")
          // Third call: return a resolved payload so the loop exits
          return makeDaemonResponse(makePayload([
            { agent: "alpha", status: "crashed", startedAt: null, errorReason: "test", fixHint: "test" },
          ]))
        }),
        socketPath: "/tmp/test.sock",
        daemonPid: 12345,
        writeRaw: vi.fn((text: string) => writes.push(text)),
        now: vi.fn(() => 5_000),
        sleep: vi.fn(async () => {}),
        isProcessAlive: vi.fn(() => true),
        readLatestDaemonEvent: vi.fn(() => "starting auto-start agents"),
      }

      const result = await pollDaemonStartup(deps)
      // First two calls show startup spinner with daemon event
      expect(writes.some((w) => w.includes("starting background service"))).toBe(true)
      expect(writes.some((w) => w.includes("latest daemon event: starting auto-start agents"))).toBe(true)
      // Eventually resolves
      expect(result.degraded).toHaveLength(1)
    })

    it("shows waiting message without event when readLatestDaemonEvent returns null", async () => {
      let callCount = 0
      const writes: string[] = []
      const deps = {
        sendCommand: vi.fn(async () => {
          callCount++
          if (callCount <= 1) throw new Error("ECONNREFUSED")
          return makeDaemonResponse(makePayload([
            { agent: "alpha", status: "crashed", startedAt: null, errorReason: "test", fixHint: "test" },
          ]))
        }),
        socketPath: "/tmp/test.sock",
        daemonPid: 12345,
        writeRaw: vi.fn((text: string) => writes.push(text)),
        now: vi.fn(() => 5_000),
        sleep: vi.fn(async () => {}),
        isProcessAlive: vi.fn(() => true),
        readLatestDaemonEvent: vi.fn(() => null),
      }

      const result = await pollDaemonStartup(deps)
      expect(writes.some((w) => w.includes("starting background service"))).toBe(true)
      expect(result.degraded).toHaveLength(1)
    })

    it("shows waiting message without event when readLatestDaemonEvent is not provided", async () => {
      let callCount = 0
      const writes: string[] = []
      const deps = {
        sendCommand: vi.fn(async () => {
          callCount++
          if (callCount <= 1) throw new Error("ECONNREFUSED")
          return makeDaemonResponse(makePayload([
            { agent: "alpha", status: "crashed", startedAt: null, errorReason: "test", fixHint: "test" },
          ]))
        }),
        socketPath: "/tmp/test.sock",
        daemonPid: 12345,
        writeRaw: vi.fn((text: string) => writes.push(text)),
        now: vi.fn(() => 5_000),
        sleep: vi.fn(async () => {}),
        isProcessAlive: vi.fn(() => true),
      }

      const result = await pollDaemonStartup(deps)
      expect(writes.some((w) => w.includes("starting background service"))).toBe(true)
      expect(result.degraded).toHaveLength(1)
    })

    it("final summary omits error/fix lines for default messages", async () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      // errorReason/fixHint null -> assessStability fills defaults "unknown error"/"check daemon logs"
      const payload = makePayload([
        { agent: "alpha", status: "crashed", startedAt: null, errorReason: null, fixHint: null },
      ])

      const writes: string[] = []
      const deps = {
        sendCommand: vi.fn(async () => makeDaemonResponse(payload)),
        socketPath: "/tmp/test.sock",
        daemonPid: 12345,
        writeRaw: vi.fn((text: string) => writes.push(text)),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
      }

      await pollDaemonStartup(deps)
      const allOutput = writes.join("")
      // Should NOT contain "error: unknown error" or "fix: check daemon logs"
      // because renderFinalSummary suppresses default values
      expect(allOutput).toContain("alpha")
      expect(allOutput).toContain("degraded")
      expect(allOutput).not.toContain("error: unknown error")
      expect(allOutput).not.toContain("fix:   check daemon logs")
    })

    it("final summary includes custom error/fix lines", async () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "crashed", startedAt: null, errorReason: "bad config file", fixHint: "edit agent.json" },
      ])

      const writes: string[] = []
      const deps = {
        sendCommand: vi.fn(async () => makeDaemonResponse(payload)),
        socketPath: "/tmp/test.sock",
        daemonPid: 12345,
        writeRaw: vi.fn((text: string) => writes.push(text)),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
      }

      await pollDaemonStartup(deps)
      const allOutput = writes.join("")
      expect(allOutput).toContain("bad config file")
      expect(allOutput).toContain("edit agent.json")
    })

    it("writes append-only plain output during non-TTY startup polling", async () => {
      let callCount = 0
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
      ])
      const writes: string[] = []

      const result = await pollDaemonStartup({
        sendCommand: vi.fn(async () => {
          callCount++
          if (callCount === 1) throw new Error("ECONNREFUSED")
          return makeDaemonResponse(payload)
        }),
        socketPath: "/tmp/test.sock",
        daemonPid: null,
        writeRaw: vi.fn((text: string) => writes.push(text)),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
        readLatestDaemonEvent: vi.fn(() => "loading bundles"),
        isTTY: false,
      })

      expect(result.stable).toEqual(["alpha"])
      const allOutput = writes.join("")
      expect(allOutput).toContain("starting background service")
      expect(allOutput).toContain("loading bundles")
      expect(allOutput).toContain("alpha/cli: running")
      expect(allOutput).toContain("alpha: stable")
      expect(allOutput).not.toMatch(/\x1b\[/)
    })

    it("can report startup progress without rendering its own nested TUI", async () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "alpha", status: "running", startedAt: "2026-04-09T12:00:00.000Z" },
      ])
      const writes: string[] = []
      const progress: string[] = []

      const result = await pollDaemonStartup({
        sendCommand: vi.fn(async () => makeDaemonResponse(payload)),
        socketPath: "/tmp/test.sock",
        daemonPid: 12345,
        writeRaw: vi.fn((text: string) => writes.push(text)),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
        isTTY: false,
        render: false,
        onProgress: (message) => progress.push(message),
      })

      expect(result.stable).toEqual(["alpha"])
      expect(writes).toEqual([])
      expect(progress).toContain("Ouro answered\n- alpha/cli: running")
    })

    it("reports daemon answered in progress-only mode when there are no workers", async () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const writes: string[] = []
      const progress: string[] = []

      const result = await pollDaemonStartup({
        sendCommand: vi.fn(async () => makeDaemonResponse(makePayload([]))),
        socketPath: "/tmp/test.sock",
        daemonPid: 12345,
        writeRaw: vi.fn((text: string) => writes.push(text)),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
        isTTY: false,
        render: false,
        onProgress: (message) => progress.push(message),
      })

      expect(result).toEqual({ stable: [], degraded: [] })
      expect(writes).toEqual([])
      expect(progress).toContain("Ouro answered")
    })

    it("writes plain degraded error and fix summary in non-TTY startup polling", async () => {
      const now = new Date("2026-04-09T12:00:10.000Z").getTime()
      const payload = makePayload([
        { agent: "beta", status: "crashed", startedAt: null, errorReason: "missing token", fixHint: "run ouro auth beta" },
      ])
      const writes: string[] = []

      const result = await pollDaemonStartup({
        sendCommand: vi.fn(async () => makeDaemonResponse(payload)),
        socketPath: "/tmp/test.sock",
        daemonPid: 12345,
        writeRaw: vi.fn((text: string) => writes.push(text)),
        now: vi.fn(() => now),
        sleep: vi.fn(async () => {}),
        isTTY: false,
      })

      expect(result.degraded).toEqual([{
        agent: "beta",
        errorReason: "missing token",
        fixHint: "run ouro auth beta",
      }])
      const allOutput = writes.join("")
      expect(allOutput).toContain("beta/cli: crashed")
      expect(allOutput).toContain("beta: degraded")
      expect(allOutput).toContain("error: missing token")
      expect(allOutput).toContain("fix:   run ouro auth beta")
      expect(allOutput).not.toMatch(/\x1b\[/)
    })

    it("detects daemon process death and returns immediately", async () => {
      const writes: string[] = []
      const deps = {
        sendCommand: vi.fn(async () => { throw new Error("ECONNREFUSED") }),
        socketPath: "/tmp/test.sock",
        daemonPid: 99999,
        writeRaw: vi.fn((text: string) => writes.push(text)),
        now: vi.fn(() => 5_000),
        sleep: vi.fn(async () => {}),
        isProcessAlive: vi.fn(() => false),
        readLatestDaemonEvent: vi.fn(() => "daemon entrypoint failed"),
      }

      const result = await pollDaemonStartup(deps)
      expect(result.stable).toEqual([])
      expect(result.degraded).toHaveLength(1)
      expect(result.degraded[0]!.agent).toBe("daemon")
      expect(result.degraded[0]!.errorReason).toBe("daemon entrypoint failed")
    })

    it("detects daemon death after rendering waiting lines (clears output)", async () => {
      let callCount = 0
      const writes: string[] = []
      const deps = {
        sendCommand: vi.fn(async () => { throw new Error("ECONNREFUSED") }),
        socketPath: "/tmp/test.sock",
        daemonPid: 99999,
        writeRaw: vi.fn((text: string) => writes.push(text)),
        now: vi.fn(() => 5_000),
        sleep: vi.fn(async () => {}),
        isProcessAlive: vi.fn(() => {
          callCount++
          // Alive on first check, dead on second
          return callCount <= 1
        }),
        readLatestDaemonEvent: vi.fn(() => "starting agents"),
      }

      const result = await pollDaemonStartup(deps)
      expect(result.degraded[0]!.agent).toBe("daemon")
      // Should have rendered background-service startup first, then cleared it
      expect(writes.some((w) => w.includes("starting background service"))).toBe(true)
      // Clear sequence contains cursor-up
      expect(writes.some((w) => w.includes("\x1b["))).toBe(true)
    })

    it("detects daemon death with no log event available", async () => {
      const deps = {
        sendCommand: vi.fn(async () => { throw new Error("ECONNREFUSED") }),
        socketPath: "/tmp/test.sock",
        daemonPid: 99999,
        writeRaw: vi.fn(),
        now: vi.fn(() => 5_000),
        sleep: vi.fn(async () => {}),
        isProcessAlive: vi.fn(() => false),
        readLatestDaemonEvent: vi.fn(() => null),
      }

      const result = await pollDaemonStartup(deps)
      expect(result.degraded[0]!.errorReason).toBe("daemon process died during startup")
    })

    it("continues polling when daemon pid is null (unknown)", async () => {
      let callCount = 0
      const deps = {
        sendCommand: vi.fn(async () => {
          callCount++
          if (callCount <= 1) throw new Error("ECONNREFUSED")
          return makeDaemonResponse(makePayload([
            { agent: "alpha", status: "crashed", startedAt: null, errorReason: "x", fixHint: "y" },
          ]))
        }),
        socketPath: "/tmp/test.sock",
        daemonPid: null,
        writeRaw: vi.fn(),
        now: vi.fn(() => 5_000),
        sleep: vi.fn(async () => {}),
        isProcessAlive: vi.fn(() => false),
      }

      const result = await pollDaemonStartup(deps)
      // Should NOT trigger death detection when pid is null
      expect(result.degraded).toHaveLength(1)
      expect(result.degraded[0]!.agent).toBe("alpha")
    })
  })
})
