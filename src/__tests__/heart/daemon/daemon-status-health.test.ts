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
      status: "running",
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

  it("ouro status falls back to the default health path when no explicit path is provided", async () => {
    const dir = makeTmpDir()
    const originalHome = process.env.HOME
    process.env.HOME = dir

    try {
      const healthPath = getDefaultHealthPath()
      const writer = new DaemonHealthWriter(healthPath)
      writer.writeHealth({
        status: "running",
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

      expect(result).toContain("Last known status: running (pid 2468, uptime 99s)")
    } finally {
      process.env.HOME = originalHome
    }
  })

  it("ouro status shows last-known status info from health file", async () => {
    const dir = makeTmpDir()
    const healthPath = path.join(dir, "daemon-health.json")
    const writer = new DaemonHealthWriter(healthPath)
    writer.writeHealth({
      status: "running",
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
