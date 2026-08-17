import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const { mockEmitNervesEvent } = vi.hoisted(() => ({
  mockEmitNervesEvent: vi.fn(),
}))
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

vi.mock("../../../heart/identity", () => ({
  getRepoRoot: () => "/mock/repo",
  getAgentBundlesRoot: () => "/mock/AgentBundles",
  getAgentDaemonLogsDir: () => "/tmp/test-logs",
  getAgentDaemonLoggingConfigPath: () => "/tmp/test-logging.json",
}))

vi.mock("../../../heart/daemon/runtime-metadata", () => ({
  getRuntimeMetadata: () => ({
    version: "0.1.0-alpha.100",
    lastUpdated: "2026-03-29",
    repoRoot: "/mock/repo",
    configFingerprint: "abc123",
  }),
}))

vi.mock("../../../heart/daemon/runtime-mode", () => ({
  detectRuntimeMode: () => "prod",
}))

import {
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"

import {
  DaemonHealthWriter,
  readHealth,
  type DaemonHealthState,
} from "../../../heart/daemon/daemon-health"

import {
  getDefaultHealthPath,
} from "../../../heart/daemon/daemon-health"
import { isDaemonTimeoutError } from "../../../heart/daemon/cli-render"

describe("ouro status with health file fallback", () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    vi.clearAllMocks()
  })

  function makeTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "status-health-"))
    return tmpDir
  }

  function makeUnavailableDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
    return {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => {
        const error = new Error("connect ENOENT") as Error & { code?: string }
        error.code = "ENOENT"
        throw error
      }),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      ...overrides,
    }
  }

  it("ouro status shows SAFE MODE when health file indicates safe mode active", async () => {
    const dir = makeTmpDir()
    const healthPath = path.join(dir, "daemon-health.json")
    const writer = new DaemonHealthWriter(healthPath)
    writer.writeHealth({
      status: "safe-mode",
      mode: "prod",
      pid: 12345,
      startedAt: "2026-03-29T10:00:00.000Z",
      uptimeSeconds: 30,
      safeMode: { active: true, reason: "crash loop detected: 3 crashes in last 5 minutes", enteredAt: "2026-03-29T10:00:00.000Z" },
      degraded: [],
      agents: {},
      habits: {},
    })

    const deps = makeUnavailableDeps({ healthFilePath: healthPath } as any)
    const result = await runOuroCli(["status"], deps)

    expect(result).toContain("SAFE MODE")
  })

  it("ouro status shows degraded components from health file when daemon is down", async () => {
    const dir = makeTmpDir()
    const healthPath = path.join(dir, "daemon-health.json")
    const writer = new DaemonHealthWriter(healthPath)
    writer.writeHealth({
      // healthy at the daemon-rollup level; the cached `degraded` list is
      // the surface this test exercises (not the rollup state).
      status: "healthy",
      mode: "prod",
      pid: 12345,
      startedAt: "2026-03-29T10:00:00.000Z",
      uptimeSeconds: 3600,
      safeMode: null,
      degraded: [{ component: "cron", reason: "launchctl verification failed", since: "2026-03-29T09:00:00.000Z" }],
      agents: { slugger: { status: "running", pid: 99, crashes: 2 } },
      habits: { heartbeat: { cronStatus: "failed", lastFired: "2026-03-29T09:45:00.000Z", fallback: true } },
    })

    const deps = makeUnavailableDeps({ healthFilePath: healthPath } as any)
    const result = await runOuroCli(["status"], deps)

    expect(result).toContain("Degraded")
    expect(result).toContain("cron")
  })

  it("ouro status works normally when health file does not exist", async () => {
    const deps = makeUnavailableDeps({ healthFilePath: "/tmp/nonexistent/daemon-health.json" } as any)
    const result = await runOuroCli(["status"], deps)

    // Should still show the basic unavailable output
    expect(result).toContain("daemon not running")
  })

  it("ouro status --json stays parseable when the daemon is unavailable", async () => {
    const deps = makeUnavailableDeps({ healthFilePath: "/tmp/nonexistent/daemon-health.json" } as any)
    const result = await runOuroCli(["status", "--json"], deps)

    expect(JSON.parse(result)).toEqual({
      ok: false,
      error: "daemon unavailable",
      socketPath: "/tmp/ouro-test.sock",
      healthFilePath: "/tmp/nonexistent/daemon-health.json",
    })
    expect(result).not.toContain("daemon not running")
  })

  it("ouro status --json omits health file context when no health path is configured", async () => {
    const deps = makeUnavailableDeps()
    const result = await runOuroCli(["status", "--json"], deps)

    expect(JSON.parse(result)).toEqual({
      ok: false,
      error: "daemon unavailable",
      socketPath: "/tmp/ouro-test.sock",
    })
  })

  it("ouro status --json distinguishes a typed daemon timeout from unavailability", async () => {
    const timeout = new Error("Daemon command daemon.status timed out after 25ms waiting for a response.") as NodeJS.ErrnoException
    timeout.code = "ETIMEDOUT"
    const deps = makeUnavailableDeps({
      sendCommand: vi.fn(async () => { throw timeout }),
    })

    const result = await runOuroCli(["status", "--json"], deps)

    expect(JSON.parse(result)).toEqual({
      ok: false,
      error: "daemon timeout",
      classification: "timeout",
      code: "ETIMEDOUT",
      socketPath: "/tmp/ouro-test.sock",
      detail: timeout.message,
    })
  })

  it("classifies only ETIMEDOUT as a daemon timeout", () => {
    expect(isDaemonTimeoutError({ code: "ETIMEDOUT" })).toBe(true)
    expect(isDaemonTimeoutError({ code: undefined })).toBe(false)
    expect(isDaemonTimeoutError(null)).toBe(false)
  })

  it("renders non-JSON timeout diagnostics without daemon-down fallback", async () => {
    const timeout = new Error("Daemon command daemon.status timed out after 25ms waiting for a response.") as NodeJS.ErrnoException
    timeout.code = "ETIMEDOUT"
    const deps = makeUnavailableDeps({ sendCommand: vi.fn(async () => { throw timeout }) })

    const result = await runOuroCli(["status"], deps)

    expect(result).toBe(`daemon status timed out: ${timeout.message}`)
    expect(result).not.toContain("daemon not running")
  })

  it("stringifies typed non-Error timeout details in JSON", async () => {
    const timeout = { code: "ETIMEDOUT", toString: () => "silent daemon timeout" }
    const deps = makeUnavailableDeps({ sendCommand: vi.fn(async () => { throw timeout }) })

    const result = await runOuroCli(["status", "--json"], deps)

    expect(JSON.parse(result).detail).toBe("silent daemon timeout")
  })

  it("ouro status falls back to the default health path when no explicit path is provided", async () => {
    const dir = makeTmpDir()
    const originalHome = process.env.HOME
    process.env.HOME = dir

    try {
      const healthPath = getDefaultHealthPath()
      const writer = new DaemonHealthWriter(healthPath)
      writer.writeHealth({
        status: "healthy",
        mode: "prod",
        pid: 2468,
        startedAt: "2026-03-29T08:00:00.000Z",
        uptimeSeconds: 99,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      })

      const deps = makeUnavailableDeps()
      const result = await runOuroCli(["status"], deps)

      expect(result).toContain("Last known status: healthy (pid 2468, uptime 99s)")
    } finally {
      process.env.HOME = originalHome
    }
  })

  it("ouro status shows last-known status info from health file", async () => {
    const dir = makeTmpDir()
    const healthPath = path.join(dir, "daemon-health.json")
    const writer = new DaemonHealthWriter(healthPath)
    writer.writeHealth({
      status: "healthy",
      mode: "prod",
      pid: 54321,
      startedAt: "2026-03-29T08:00:00.000Z",
      uptimeSeconds: 7200,
      safeMode: null,
      degraded: [],
      agents: {},
      habits: {},
    })

    const deps = makeUnavailableDeps({ healthFilePath: healthPath } as any)
    const result = await runOuroCli(["status"], deps)

    expect(result).toContain("Last known")
  })
})
