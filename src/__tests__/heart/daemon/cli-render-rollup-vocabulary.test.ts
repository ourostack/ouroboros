/**
 * Unit 4a: rollup-vocabulary tests for `daemonUnavailableStatusOutput`.
 *
 * `daemonUnavailableStatusOutput` is the cli-render path that produces the
 * "daemon not running" view. When the daemon is down but a cached health
 * file exists, the output renders a "Last known status: ..." line so the
 * human can see what the daemon thought of itself before it died.
 *
 * Pre-Layer-1, the line read `Last known status: ${health.status} ...` —
 * just whatever string came back from `health.status`. With the new
 * `DaemonStatus` union, the render needs to:
 *
 * 1. Switch on each of the five literals (`healthy`/`partial`/`degraded`/
 *    `safe-mode`/`down`) with a `never`-typed default branch (so a future
 *    union widening compile-errors here).
 * 2. For `degraded`, branch on `health.agents` map size to pick a copy
 *    variant — empty map means "fresh install, no agents configured,"
 *    and a non-empty map means "agents configured but none ready."
 *    Same status, distinct UX copy.
 *
 * These tests are written against the new behavior. Until Unit 4b lands,
 * they fail because the render path still emits the old single-line
 * format.
 */

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
    lastUpdated: "2026-04-28",
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
  type DaemonHealthState,
  type DaemonStatus,
} from "../../../heart/daemon/daemon-health"

describe("cli-render rollup vocabulary — daemonUnavailableStatusOutput", () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    vi.clearAllMocks()
  })

  function makeTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollup-render-"))
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

  function writeHealth(
    healthPath: string,
    status: DaemonStatus,
    overrides: Partial<DaemonHealthState> = {},
  ): void {
    const writer = new DaemonHealthWriter(healthPath)
    writer.writeHealth({
      status,
      mode: "prod",
      pid: 12345,
      startedAt: "2026-04-28T19:30:00.000Z",
      uptimeSeconds: 60,
      safeMode: null,
      degraded: [],
      agents: {},
      habits: {},
      ...overrides,
    })
  }

  async function runStatus(healthPath: string): Promise<string> {
    const deps = makeUnavailableDeps({ healthFilePath: healthPath } as never)
    return await runOuroCli(["status"], deps)
  }

  describe("five rollup states render with distinct labels", () => {
    it("renders 'healthy' label when status is 'healthy'", async () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      writeHealth(healthPath, "healthy")
      const result = await runStatus(healthPath)
      expect(result).toContain("Last known status: healthy")
    })

    it("renders 'partial' label when status is 'partial'", async () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      writeHealth(healthPath, "partial")
      const result = await runStatus(healthPath)
      expect(result).toContain("Last known status: partial")
    })

    it("'partial' explains unhealthy agents when the cached health has a failed agent", async () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      writeHealth(healthPath, "partial", {
        agents: {
          alpha: { status: "running", pid: 1234, crashes: 0 },
          beta: { status: "crashed", pid: null, crashes: 3 },
        },
      })
      const result = await runStatus(healthPath)
      expect(result).toContain("Last known status: partial")
      expect(result).toContain("unhealthy")
    })

    it("renders 'safe-mode' label when status is 'safe-mode'", async () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      writeHealth(healthPath, "safe-mode")
      const result = await runStatus(healthPath)
      expect(result).toContain("Last known status: safe-mode")
    })

    it("renders 'down' label when status is 'down'", async () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      writeHealth(healthPath, "down")
      const result = await runStatus(healthPath)
      expect(result).toContain("Last known status: down")
    })
  })

  describe("'degraded' renders distinct copy for the two sub-cases", () => {
    it("'no agents configured' copy when agents map is empty (fresh install)", async () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      writeHealth(healthPath, "degraded", { agents: {} })
      const result = await runStatus(healthPath)
      // Same status, distinct copy. The render layer reads the cached
      // agents map to differentiate fresh-install (empty) from
      // all-failed (non-empty).
      expect(result).toContain("Last known status: degraded")
      expect(result).toContain("no agents configured")
      expect(result).not.toContain("none ready")
    })

    it("'agents configured but none ready' copy when agents map is non-empty (all live-checks failed)", async () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      writeHealth(healthPath, "degraded", {
        agents: {
          alpha: { status: "crashed", pid: null, crashes: 3 },
          beta: { status: "stopped", pid: null, crashes: 0 },
        },
      })
      const result = await runStatus(healthPath)
      expect(result).toContain("Last known status: degraded")
      expect(result).toContain("none ready")
      expect(result).not.toContain("no agents configured")
    })

    it("'stale cache, run ouro up to refresh' copy when status='degraded' but at least one cached agent is running (legacy file from pre-Layer-1 daemon)", async () => {
      // Pre-Layer-1 semantics: status="degraded" meant "any degraded component exists,"
      // which could include states where some agents were healthy and some weren't.
      // Post-Layer-1 semantics: status="degraded" means "zero enabled agents serving."
      // A cached health file from a pre-Layer-1 daemon may therefore have status="degraded"
      // AND a running agent in the agents map — mutually exclusive under new semantics.
      // The render layer must NOT falsely claim "none ready" in this case; it should
      // prompt the user to refresh the cache via `ouro up`.
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      writeHealth(healthPath, "degraded", {
        agents: {
          alpha: { status: "running", pid: 1234, crashes: 0 },
          beta: { status: "crashed", pid: null, crashes: 3 },
        },
      })
      const result = await runStatus(healthPath)
      expect(result).toContain("Last known status: degraded")
      expect(result).toContain("stale cache")
      expect(result).toContain("ouro up")
      expect(result).not.toContain("none ready")
      expect(result).not.toContain("no agents configured")
    })
  })
})
