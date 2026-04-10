import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import { ensureDaemonRunning, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"

const { pollDaemonStartupMock, latestStartupEvent, mockedBundlesRoot } = vi.hoisted(() => ({
  pollDaemonStartupMock: vi.fn(async (options: { readLatestDaemonEvent?: () => string | null }) => {
    latestStartupEvent.value = options.readLatestDaemonEvent?.() ?? null
    return { stable: [], degraded: [] }
  }),
  latestStartupEvent: { value: null as string | null },
  mockedBundlesRoot: { value: null as string | null },
}))

vi.mock("../../../heart/daemon/startup-tui", () => ({
  pollDaemonStartup: (...args: unknown[]) => pollDaemonStartupMock(...args),
}))

vi.mock("../../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/identity")>(
    "../../../heart/identity",
  )

  return {
    ...actual,
    getAgentBundlesRoot: () => mockedBundlesRoot.value ?? actual.getAgentBundlesRoot(),
  }
})

describe("ensureDaemonRunning startup log tail", () => {
  const tempRoots: string[] = []

  afterEach(() => {
    latestStartupEvent.value = null
    mockedBundlesRoot.value = null
    pollDaemonStartupMock.mockClear()
    vi.restoreAllMocks()
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("emits at least one nerves event", () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.startup_log_tail_test",
      message: "daemon startup log tail coverage test",
    })
  })

  function makeBundlesRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-startup-log-tail-"))
    tempRoots.push(root)
    return root
  }

  function makeStartupDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
    let nowMs = Date.parse("2026-04-10T08:00:00.000Z")
    const pid = 4242
    const sleep = vi.fn(async (ms: number) => {
      nowMs += Math.max(ms, 1)
    })

    return {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => ({
        status: "ok",
        mode: "normal",
        pid,
        startedAt: new Date(nowMs).toISOString(),
        uptimeSeconds: 0,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      })),
      readHealthUpdatedAt: vi.fn(() => nowMs),
      sleep,
      now: () => nowMs,
      startupPollIntervalMs: 1,
      startupStabilityWindowMs: 0,
      startupTimeoutMs: 10,
      startupRetryLimit: 0,
      ...overrides,
    }
  }

  async function captureLatestEvent(
    bundlesRoot: string,
    depsOverrides: Partial<OuroCliDeps> = {},
  ): Promise<string | null> {
    mockedBundlesRoot.value = bundlesRoot
    const result = await ensureDaemonRunning(makeStartupDeps(depsOverrides))
    expect(result.message).toContain("daemon started")
    return latestStartupEvent.value
  }

  it("surfaces the latest recent daemon.ndjson message to the startup poller", async () => {
    const bundlesRoot = makeBundlesRoot()
    const logDir = path.join(bundlesRoot, "slugger.ouro", "state", "daemon", "logs")
    fs.mkdirSync(logDir, { recursive: true })
    const logPath = path.join(logDir, "daemon.ndjson")
    fs.writeFileSync(logPath, [
      JSON.stringify({ message: "daemon entrypoint booting" }),
      JSON.stringify({ message: "starting auto-start agents" }),
    ].join("\n") + "\n", "utf-8")

    const phases: string[] = []
    const event = await captureLatestEvent(bundlesRoot, {
      reportDaemonStartupPhase: (text) => phases.push(text),
    })

    expect(event).toBe("starting auto-start agents")
    expect(phases).toContain("verifying daemon health...")
  })

  it("returns null when the bundles root does not exist", async () => {
    const missingRoot = path.join(makeBundlesRoot(), "missing")
    const event = await captureLatestEvent(missingRoot)
    expect(event).toBeNull()
  })

  it("returns null when the bundle exists but no daemon log has been created yet", async () => {
    const bundlesRoot = makeBundlesRoot()
    fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro"), { recursive: true })

    const event = await captureLatestEvent(bundlesRoot)
    expect(event).toBeNull()
  })

  it("returns null for empty daemon log files", async () => {
    const bundlesRoot = makeBundlesRoot()
    const logDir = path.join(bundlesRoot, "slugger.ouro", "state", "daemon", "logs")
    fs.mkdirSync(logDir, { recursive: true })
    fs.writeFileSync(path.join(logDir, "daemon.ndjson"), "", "utf-8")

    const event = await captureLatestEvent(bundlesRoot)
    expect(event).toBeNull()
  })

  it("returns null for stale daemon log files", async () => {
    const bundlesRoot = makeBundlesRoot()
    const logDir = path.join(bundlesRoot, "slugger.ouro", "state", "daemon", "logs")
    fs.mkdirSync(logDir, { recursive: true })
    const logPath = path.join(logDir, "daemon.ndjson")
    fs.writeFileSync(logPath, `${JSON.stringify({ message: "old event" })}\n`, "utf-8")
    const old = new Date(Date.now() - 31_000)
    fs.utimesSync(logPath, old, old)

    const event = await captureLatestEvent(bundlesRoot)
    expect(event).toBeNull()
  })

  it("returns null for whitespace-only daemon logs", async () => {
    const bundlesRoot = makeBundlesRoot()
    const logDir = path.join(bundlesRoot, "slugger.ouro", "state", "daemon", "logs")
    fs.mkdirSync(logDir, { recursive: true })
    fs.writeFileSync(path.join(logDir, "daemon.ndjson"), "\n", "utf-8")

    const event = await captureLatestEvent(bundlesRoot)
    expect(event).toBeNull()
  })

  it("returns null when the latest daemon log record has no message field", async () => {
    const bundlesRoot = makeBundlesRoot()
    const logDir = path.join(bundlesRoot, "slugger.ouro", "state", "daemon", "logs")
    fs.mkdirSync(logDir, { recursive: true })
    fs.writeFileSync(path.join(logDir, "daemon.ndjson"), `${JSON.stringify({ event: "daemon.entry_start" })}\n`, "utf-8")

    const event = await captureLatestEvent(bundlesRoot)
    expect(event).toBeNull()
  })

  it("keeps polling after announcing the health check until current-boot health becomes fresh", async () => {
    const bundlesRoot = makeBundlesRoot()
    const logDir = path.join(bundlesRoot, "slugger.ouro", "state", "daemon", "logs")
    fs.mkdirSync(logDir, { recursive: true })
    fs.writeFileSync(path.join(logDir, "daemon.ndjson"), `${JSON.stringify({ message: "warming up" })}\n`, "utf-8")
    mockedBundlesRoot.value = bundlesRoot

    let healthReads = 0
    const phases: string[] = []
    const result = await ensureDaemonRunning(makeStartupDeps({
      reportDaemonStartupPhase: (text) => phases.push(text),
      readHealthState: vi.fn(() => {
        healthReads += 1
        if (healthReads === 1) return null
        return {
          status: "ok",
          mode: "normal",
          pid: 4242,
          startedAt: "2026-04-10T08:00:00.002Z",
          uptimeSeconds: 0,
          safeMode: null,
          degraded: [],
          agents: {},
          habits: {},
        }
      }),
      now: (() => {
        let nowMs = Date.parse("2026-04-10T08:00:00.000Z")
        return () => nowMs
      })(),
      sleep: vi.fn(async () => {}),
      startupPollIntervalMs: 1,
      startupStabilityWindowMs: 0,
      startupTimeoutMs: 10,
      startupRetryLimit: 0,
    }))

    expect(result.message).toContain("daemon started")
    expect(phases.filter((phase) => phase === "verifying daemon health...")).toHaveLength(1)
    expect(healthReads).toBeGreaterThanOrEqual(2)
  })
})
