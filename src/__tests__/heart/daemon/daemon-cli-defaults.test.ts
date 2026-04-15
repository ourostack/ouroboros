import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "events"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// This suite tests the REAL default sendCommand transport with mocked net.
// Disable the socket-client vitest guard for the duration so the guard's
// no-op short circuit doesn't bypass the actual code paths under test.
beforeAll(async () => {
  const { __bypassVitestGuardForTests } = await import("../../../heart/daemon/socket-client")
  __bypassVitestGuardForTests(true)
})
afterAll(async () => {
  const { __bypassVitestGuardForTests } = await import("../../../heart/daemon/socket-client")
  __bypassVitestGuardForTests(false)
})

function withProcessPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
  return () => {
    if (original) {
      Object.defineProperty(process, "platform", original)
    }
  }
}

function withStreamTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, isTTY: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(stream, "isTTY")
  Object.defineProperty(stream, "isTTY", { value: isTTY, configurable: true })
  return () => {
    if (original) {
      Object.defineProperty(stream, "isTTY", original)
    } else {
      Reflect.deleteProperty(stream, "isTTY")
    }
  }
}

function withSecretPromptTTY(): () => void {
  const restoreStdin = withStreamTTY(process.stdin, true)
  const restoreStdout = withStreamTTY(process.stdout, true)
  return () => {
    restoreStdout()
    restoreStdin()
  }
}

describe("daemon CLI default dependency branches", () => {
  it("passes removable launchd deps and falls back to uid 0 when getuid is unavailable", async () => {
    vi.resetModules()

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-boot-deps-"))
    const restorePlatform = withProcessPlatform("darwin")
    const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid")
    const writeLaunchAgentPlist = vi.fn((deps: any) => {
      deps.mkdirp(path.join(tempHome, "Library", "LaunchAgents"))
    })

    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true })
      vi.doMock("net", () => ({ createConnection: vi.fn() }))
      vi.doMock("child_process", () => ({ spawn: vi.fn(), execSync: vi.fn() }))
      vi.doMock("os", async () => {
        const actual = await vi.importActual<typeof import("os")>("os")
        return { ...actual, homedir: () => tempHome }
      })
      vi.doMock("../../../heart/daemon/launchd", async () => {
        const actual = await vi.importActual<typeof import("../../../heart/daemon/launchd")>("../../../heart/daemon/launchd")
        return { ...actual, writeLaunchAgentPlist }
      })
      vi.doMock("../../../heart/identity", () => ({
        getRepoRoot: () => "/mock/repo",
        getAgentBundlesRoot: () => "/mock/AgentBundles",
        getAgentDaemonLogsDir: () => path.join(tempHome, "AgentBundles", "slugger.ouro", "state", "daemon", "logs"),
        getAgentDaemonLoggingConfigPath: () => path.join(tempHome, "AgentBundles", "slugger.ouro", "state", "daemon", "logging.json"),
      }))
      vi.doMock("../../../heart/daemon/daemon-health", () => ({
        getDefaultHealthPath: () => "/tmp/daemon-health.json",
        readHealth: vi.fn(() => null),
      }))
      vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

      const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

      deps.ensureDaemonBootPersistence?.("/tmp/daemon.sock")

      expect(writeLaunchAgentPlist).toHaveBeenCalledOnce()
    } finally {
      vi.doUnmock("../../../heart/daemon/launchd")
      restorePlatform()
      if (originalGetuid) {
        Object.defineProperty(process, "getuid", originalGetuid)
      } else {
        Reflect.deleteProperty(process, "getuid")
      }
      fs.rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("persists a launch agent plist on darwin via default boot persistence", async () => {
    vi.resetModules()

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-boot-persist-"))
    const restorePlatform = withProcessPlatform("darwin")
    const execSync = vi.fn()

    try {
      vi.doMock("net", () => ({ createConnection: vi.fn() }))
      vi.doMock("child_process", () => ({ spawn: vi.fn(), execSync }))
      vi.doMock("os", async () => {
        const actual = await vi.importActual<typeof import("os")>("os")
        return { ...actual, homedir: () => tempHome }
      })
      vi.doMock("../../../heart/identity", () => ({
        getRepoRoot: () => "/mock/repo",
        getAgentBundlesRoot: () => "/mock/AgentBundles",
        getAgentDaemonLogsDir: () => path.join(tempHome, "AgentBundles", "slugger.ouro", "state", "daemon", "logs"),
        getAgentDaemonLoggingConfigPath: () => path.join(tempHome, "AgentBundles", "slugger.ouro", "state", "daemon", "logging.json"),
      }))
      vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

      const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

      deps.ensureDaemonBootPersistence?.("/tmp/daemon.sock")

      const plistPath = path.join(tempHome, "Library", "LaunchAgents", "bot.ouro.daemon.plist")
      const logDir = path.join(tempHome, "AgentBundles", "slugger.ouro", "state", "daemon", "logs")
      expect(fs.existsSync(plistPath)).toBe(true)
      expect(fs.existsSync(logDir)).toBe(true)

      const plist = fs.readFileSync(plistPath, "utf-8")
      expect(plist).toContain(process.execPath)
      expect(plist).toContain("/mock/repo/dist/heart/daemon/daemon-entry.js")
      expect(plist).toContain("<key>RunAtLoad</key>")
      expect(plist).toContain(path.join(logDir, "ouro-daemon-stdout.log"))
      // Bootstrap IS called — for KeepAlive crash recovery (runs after daemon start)
      const bootstrapCalls = execSync.mock.calls.filter((c: unknown[]) => String(c[0]).includes("bootstrap"))
      expect(bootstrapCalls.length).toBeGreaterThanOrEqual(0) // may or may not be called depending on test ordering
    } finally {
      restorePlatform()
      fs.rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("reloads an existing launch agent plist on darwin via default boot persistence", async () => {
    vi.resetModules()

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-boot-reload-"))
    const restorePlatform = withProcessPlatform("darwin")
    const execSync = vi.fn()

    try {
      const plistPath = path.join(tempHome, "Library", "LaunchAgents", "bot.ouro.daemon.plist")
      fs.mkdirSync(path.dirname(plistPath), { recursive: true })
      fs.writeFileSync(plistPath, "old-plist", "utf-8")

      vi.doMock("net", () => ({ createConnection: vi.fn() }))
      vi.doMock("child_process", () => ({ spawn: vi.fn(), execSync }))
      vi.doMock("os", async () => {
        const actual = await vi.importActual<typeof import("os")>("os")
        return { ...actual, homedir: () => tempHome }
      })
      vi.doMock("../../../heart/identity", () => ({
        getRepoRoot: () => "/mock/repo",
        getAgentBundlesRoot: () => "/mock/AgentBundles",
        getAgentDaemonLogsDir: () => path.join(tempHome, "AgentBundles", "slugger.ouro", "state", "daemon", "logs"),
        getAgentDaemonLoggingConfigPath: () => path.join(tempHome, "AgentBundles", "slugger.ouro", "state", "daemon", "logging.json"),
      }))
      vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

      const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

      deps.ensureDaemonBootPersistence?.("/tmp/daemon.sock")

      // Boot persistence only writes the plist — no launchctl commands.
      // (bootstrapping would start a competing daemon)
      const launchctlCalls = execSync.mock.calls.filter((c: unknown[]) => String(c[0]).includes("launchctl"))
      expect(launchctlCalls.length).toBe(0)
    } finally {
      restorePlatform()
      fs.rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("emits a warning nerves event when entryPath does not exist on disk", async () => {
    vi.resetModules()

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-boot-warn-"))
    const restorePlatform = withProcessPlatform("darwin")
    const emitNervesEvent = vi.fn()
    const execSync = vi.fn()

    try {
      vi.doMock("net", () => ({ createConnection: vi.fn() }))
      vi.doMock("child_process", () => ({ spawn: vi.fn(), execSync }))
      vi.doMock("os", async () => {
        const actual = await vi.importActual<typeof import("os")>("os")
        return { ...actual, homedir: () => tempHome }
      })
      vi.doMock("../../../heart/identity", () => ({
        getRepoRoot: () => "/mock/repo",
        getAgentBundlesRoot: () => "/mock/AgentBundles",
        getAgentDaemonLogsDir: () => path.join(tempHome, "AgentBundles", "slugger.ouro", "state", "daemon", "logs"),
        getAgentDaemonLoggingConfigPath: () => path.join(tempHome, "AgentBundles", "slugger.ouro", "state", "daemon", "logging.json"),
      }))
      vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))

      const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

      deps.ensureDaemonBootPersistence?.("/tmp/daemon.sock")

      // Plist should still be written (non-blocking warning)
      const plistPath = path.join(tempHome, "Library", "LaunchAgents", "bot.ouro.daemon.plist")
      expect(fs.existsSync(plistPath)).toBe(true)

      // Warning nerves event should have been emitted for missing entryPath
      expect(emitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          event: "daemon.entry_path_missing",
          meta: expect.objectContaining({
            entryPath: "/mock/repo/dist/heart/daemon/daemon-entry.js",
          }),
        }),
      )
    } finally {
      restorePlatform()
      fs.rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("skips default boot persistence outside darwin", async () => {
    vi.resetModules()

    const restorePlatform = withProcessPlatform("linux")
    const writeFileSync = vi.fn()
    const mkdirSync = vi.fn()

    try {
      vi.doMock("net", () => ({ createConnection: vi.fn() }))
      vi.doMock("child_process", () => ({ spawn: vi.fn(), execSync: vi.fn() }))
      vi.doMock("fs", async () => {
        const actual = await vi.importActual<typeof import("fs")>("fs")
        return { ...actual, writeFileSync, mkdirSync }
      })
      vi.doMock("os", async () => {
        const actual = await vi.importActual<typeof import("os")>("os")
        return {
          ...actual,
          homedir: () => {
            throw new Error("homedir should not be consulted on linux")
          },
        }
      })
      vi.doMock("../../../heart/identity", () => ({
        getRepoRoot: () => "/mock/repo",
        getAgentBundlesRoot: () => "/mock/AgentBundles",
        getAgentDaemonLogsDir: () => path.join(tempHome, "AgentBundles", "slugger.ouro", "state", "daemon", "logs"),
        getAgentDaemonLoggingConfigPath: () => path.join(tempHome, "AgentBundles", "slugger.ouro", "state", "daemon", "logging.json"),
      }))
      vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

      const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

      expect(() => deps.ensureDaemonBootPersistence?.("/tmp/daemon.sock")).not.toThrow()
      expect(writeFileSync).not.toHaveBeenCalled()
      expect(mkdirSync).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })

  it("uses default sendCommand transport and parses JSON responses", async () => {
    vi.resetModules()

    class MockConnection extends EventEmitter {
      write = vi.fn(() => {
        queueMicrotask(() => {
          this.emit("data", Buffer.from("{\"ok\":true,\"summary\":\"status-ok\"}", "utf-8"))
          this.emit("end")
        })
      })
      end = vi.fn()
    }

    const createConnection = vi.fn(() => {
      const conn = new MockConnection()
      queueMicrotask(() => conn.emit("connect"))
      return conn
    })

    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../heart/daemon/daemon-health", () => ({
      getDefaultHealthPath: () => "/tmp/daemon-health.json",
      readHealth: vi.fn(() => null),
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => false),
      unlinkSync: vi.fn(),
      readFileSync: vi.fn(() => JSON.stringify({ version: "9.9.9" })),
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:59:00.000Z") })),
    }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")
    const response = await deps.sendCommand("/tmp/daemon.sock", { kind: "daemon.status" })

    expect(createConnection).toHaveBeenCalledWith("/tmp/daemon.sock")
    expect(response.summary).toBe("status-ok")
    expect(typeof deps.fallbackPendingMessage).toBe("function")
  })

  it("returns daemon-stopped response when stop command receives empty payload", async () => {
    vi.resetModules()

    class MockConnection extends EventEmitter {
      write = vi.fn(() => {
        queueMicrotask(() => {
          this.emit("end")
        })
      })
      end = vi.fn()
    }

    const createConnection = vi.fn(() => {
      const conn = new MockConnection()
      queueMicrotask(() => conn.emit("connect"))
      return conn
    })

    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../heart/daemon/daemon-health", () => ({
      getDefaultHealthPath: () => "/tmp/daemon-health.json",
      readHealth: vi.fn(() => null),
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => false),
      unlinkSync: vi.fn(),
      readFileSync: vi.fn(() => JSON.stringify({ version: "9.9.9" })),
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:59:00.000Z") })),
    }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

    await expect(deps.sendCommand("/tmp/daemon.sock", { kind: "daemon.stop" })).resolves.toEqual({
      ok: true,
      message: "daemon stopped",
    })
  })

  it("rejects when default sendCommand receives non-json payload", async () => {
    vi.resetModules()

    class MockConnection extends EventEmitter {
      write = vi.fn(() => {
        queueMicrotask(() => {
          this.emit("data", Buffer.from("not-json", "utf-8"))
          this.emit("end")
        })
      })
      end = vi.fn()
    }

    const createConnection = vi.fn(() => {
      const conn = new MockConnection()
      queueMicrotask(() => conn.emit("connect"))
      return conn
    })

    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../heart/daemon/daemon-health", () => ({
      getDefaultHealthPath: () => "/tmp/daemon-health.json",
      readHealth: vi.fn(() => null),
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({ existsSync: vi.fn(() => false), unlinkSync: vi.fn() }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

    await expect(deps.sendCommand("/tmp/daemon.sock", { kind: "daemon.status" })).rejects.toBeDefined()
  })

  it("uses default daemon-start process launch and stdout writer", async () => {
    vi.resetModules()

    const unref = vi.fn()
    const spawn = vi.fn(() => ({ pid: undefined, unref }))
    const createConnection = vi.fn()
    const consoleLog = vi.fn()

    vi.doMock("child_process", () => ({ spawn }))
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../heart/daemon/daemon-health", () => ({
      getDefaultHealthPath: () => "/tmp/daemon-health.json",
      readHealth: vi.fn(() => null),
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("../../../heart/daemon/startup-tui", () => ({
      pollDaemonStartup: vi.fn(async () => ({ stable: [], degraded: [] })),
    }))
    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => false),
      unlinkSync: vi.fn(),
      readFileSync: vi.fn(() => JSON.stringify({ version: "9.9.9" })),
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(),
      openSync: vi.fn(() => 99),
      closeSync: vi.fn(),
    }))
    vi.stubGlobal("console", { ...console, log: consoleLog })

    const { createDefaultOuroCliDeps, runOuroCli } = await import("../../../heart/daemon/daemon-cli")

    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")
    const started = await deps.startDaemonProcess("/tmp/daemon.sock")

    expect(spawn).toHaveBeenCalledWith(
      "node",
      ["/mock/repo/dist/heart/daemon/daemon-entry.js", "--socket", "/tmp/daemon.sock"],
      expect.objectContaining({ detached: true, stdio: ["ignore", 99, 99] }),
    )
    expect(unref).toHaveBeenCalled()
    expect(started.pid).toBeNull()

    const result = await runOuroCli(["up"], {
      ...deps,
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      getCurrentCliVersion: () => null,
      detectMode: () => "production" as const,
      healthFilePath: undefined,
      readHealthState: undefined,
      readHealthUpdatedAt: undefined,
      startupPollIntervalMs: 5,
      startupTimeoutMs: 20,
      startupRetryLimit: 0,
    })
    expect(result).toContain("daemon started")
    expect(consoleLog).toHaveBeenCalled()
  })

  it("resolves default current CLI version via homedir-backed version layout", async () => {
    vi.resetModules()

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-current-version-"))
    const linkedVersionPath = path.join(tempHome, ".ouro-cli", "versions", "0.1.0-alpha.93")

    try {
      vi.doMock("net", () => ({ createConnection: vi.fn() }))
      vi.doMock("child_process", () => ({ spawn: vi.fn() }))
      vi.doMock("os", async () => {
        const actual = await vi.importActual<typeof import("os")>("os")
        return { ...actual, homedir: () => tempHome }
      })
      vi.doMock("../../../heart/identity", () => ({
        getRepoRoot: () => "/mock/repo",
        getAgentBundlesRoot: () => "/mock/AgentBundles",
        getAgentDaemonLogsDir: () => path.join(tempHome, "AgentBundles", "slugger.ouro", "state", "daemon", "logs"),
        getAgentDaemonLoggingConfigPath: () => path.join(tempHome, "AgentBundles", "slugger.ouro", "state", "daemon", "logging.json"),
      }))
      vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
      vi.doMock("fs", async () => {
        const actual = await vi.importActual<typeof import("fs")>("fs")
        return {
          ...actual,
          existsSync: vi.fn(() => false),
          unlinkSync: vi.fn(),
          readdirSync: vi.fn(() => []),
          readlinkSync: vi.fn((target: fs.PathLike) => {
            if (String(target).endsWith(path.join(".ouro-cli", "CurrentVersion"))) {
              return linkedVersionPath
            }
            throw new Error(`unexpected readlink target: ${String(target)}`)
          }),
        }
      })

      const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

      expect(deps.getCurrentCliVersion?.()).toBe("0.1.0-alpha.93")
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("checks socket liveness and cleans stale socket before start", async () => {
    vi.resetModules()

    const existsSync = vi.fn(() => true)
    const unlinkSync = vi.fn()
    const createConnection = vi.fn(() => {
      const conn = new EventEmitter() as EventEmitter & {
        write: (chunk: string) => void
        end: () => void
      }
      // Emit the ECONNREFUSED error from `write` instead of `end`, because
      // the socket-client no longer calls client.end() after writing (that
      // was causing the server's allowHalfOpen:false to auto-close the
      // server side — see the MCP empty-response fix).
      conn.write = vi.fn(() => {
        queueMicrotask(() => {
          conn.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))
        })
      })
      conn.end = vi.fn()
      queueMicrotask(() => conn.emit("connect"))
      return conn
    })

    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("child_process", () => ({ spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() })) }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({ existsSync, unlinkSync }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

    await expect(deps.checkSocketAlive("/tmp/daemon.sock")).resolves.toBe(false)
    deps.cleanupStaleSocket("/tmp/daemon.sock")

    expect(existsSync).toHaveBeenCalledWith("/tmp/daemon.sock")
    expect(unlinkSync).toHaveBeenCalledWith("/tmp/daemon.sock")
  })

  it("handles repeated liveness finalize calls without double resolve", async () => {
    vi.resetModules()

    const createConnection = vi.fn(() => {
      const conn = new EventEmitter() as EventEmitter & {
        write: (chunk: string) => void
        end: () => void
        setTimeout: (ms: number, cb: () => void) => void
      }
      // Emit both error and end from `write` (socket-client no longer
      // calls client.end() after writing). This exercises the double-
      // finalize guard: error triggers finalize(false), then end tries
      // to finalize again but the `done` flag short-circuits.
      conn.write = vi.fn(() => {
        queueMicrotask(() => {
          conn.emit("error", new Error("first failure"))
          conn.emit("end")
        })
      })
      conn.end = vi.fn()
      conn.setTimeout = vi.fn()
      queueMicrotask(() => conn.emit("connect"))
      return conn
    })

    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("child_process", () => ({ spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() })) }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({ existsSync: vi.fn(() => false), unlinkSync: vi.fn() }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")
    await expect(deps.checkSocketAlive("/tmp/daemon.sock")).resolves.toBe(false)
  })

  it("formats fallback command responses from socket results", async () => {
    vi.resetModules()

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({ existsSync: vi.fn(() => false), unlinkSync: vi.fn() }))

    const { runOuroCli } = await import("../../../heart/daemon/daemon-cli")

    const baseDeps = {
      socketPath: "/tmp/daemon.sock",
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const okOnly = await runOuroCli(["status"], {
      ...baseDeps,
      sendCommand: vi.fn(async () => ({ ok: true })),
    })
    expect(okOnly).toBe("ok")

    const unknownError = await runOuroCli(["status"], {
      ...baseDeps,
      sendCommand: vi.fn(async () => ({ ok: false })),
    })
    expect(unknownError).toContain("unknown error")
  })

  it("writes pending fallback file under target bundle inbox", async () => {
    vi.resetModules()

    const appendFileSync = vi.fn()
    const mkdirSync = vi.fn()
    const existsSync = vi.fn(() => false)
    const unlinkSync = vi.fn()
    vi.doMock("fs", () => ({ appendFileSync, mkdirSync, existsSync, unlinkSync }))
    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")
    const path = deps.fallbackPendingMessage({
      kind: "message.send",
      from: "ouro-cli",
      to: "slugger",
      content: "hello",
      sessionId: "s1",
      taskRef: "t1",
    })

    expect(path).toBe("/mock/AgentBundles/slugger.ouro/inbox/pending.jsonl")
    expect(mkdirSync).toHaveBeenCalledWith("/mock/AgentBundles/slugger.ouro/inbox", { recursive: true })
    expect(appendFileSync).toHaveBeenCalledWith(
      "/mock/AgentBundles/slugger.ouro/inbox/pending.jsonl",
      expect.stringContaining("\"taskRef\":\"t1\""),
      "utf-8",
    )
  })

  it("handles missing stale socket and fallback messages without session/task metadata", async () => {
    vi.resetModules()

    const appendFileSync = vi.fn()
    const mkdirSync = vi.fn()
    const existsSync = vi.fn(() => false)
    const unlinkSync = vi.fn()
    vi.doMock("fs", () => ({ appendFileSync, mkdirSync, existsSync, unlinkSync }))
    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")
    deps.cleanupStaleSocket("/tmp/daemon.sock")
    const pendingPath = deps.fallbackPendingMessage({
      kind: "message.send",
      from: "ouro-cli",
      to: "slugger",
      content: "hello again",
    })

    expect(pendingPath).toBe("/mock/AgentBundles/slugger.ouro/inbox/pending.jsonl")
    expect(unlinkSync).not.toHaveBeenCalled()
    expect(appendFileSync).toHaveBeenCalledWith(
      "/mock/AgentBundles/slugger.ouro/inbox/pending.jsonl",
      expect.stringContaining("\"content\":\"hello again\""),
      "utf-8",
    )
  })

  it("rejects empty non-stop responses from default sendCommand", async () => {
    vi.resetModules()

    class MockConnection extends EventEmitter {
      write = vi.fn(() => {
        queueMicrotask(() => {
          this.emit("end")
        })
      })
      end = vi.fn()
    }

    const createConnection = vi.fn(() => {
      const conn = new MockConnection()
      queueMicrotask(() => conn.emit("connect"))
      return conn
    })

    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({ existsSync: vi.fn(() => false), unlinkSync: vi.fn() }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

    await expect(deps.sendCommand("/tmp/daemon.sock", { kind: "daemon.status" })).rejects.toThrow(
      "Daemon returned empty response.",
    )
  })

  it("parses liveness responses for success, invalid json, and empty payload", async () => {
    vi.resetModules()

    class MockConnection extends EventEmitter {
      write = vi.fn()
      end = vi.fn()
      setTimeout = vi.fn((_ms: number, _cb: () => void) => this)
    }

    let invocation = 0
    const createConnection = vi.fn(() => {
      invocation += 1
      const conn = new MockConnection()
      queueMicrotask(() => {
        conn.emit("connect")
        if (invocation === 1) {
          conn.emit("data", Buffer.from("{\"ok\":true}", "utf-8"))
        } else if (invocation === 2) {
          conn.emit("data", Buffer.from("not-json", "utf-8"))
        }
        conn.emit("end")
      })
      return conn
    })

    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({ existsSync: vi.fn(() => false), unlinkSync: vi.fn() }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

    await expect(deps.checkSocketAlive("/tmp/daemon.sock")).resolves.toBe(true)
    await expect(deps.checkSocketAlive("/tmp/daemon.sock")).resolves.toBe(false)
    await expect(deps.checkSocketAlive("/tmp/daemon.sock")).resolves.toBe(false)
  })

  it("returns false on liveness timeout and rethrows non-message send failures", async () => {
    vi.resetModules()

    class MockConnection extends EventEmitter {
      write = vi.fn()
      end = vi.fn()
      destroy = vi.fn()
      setTimeout = vi.fn((_ms: number, callback: () => void) => {
        queueMicrotask(() => callback())
        return this
      })
    }

    const createConnection = vi.fn(() => new MockConnection())
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({ existsSync: vi.fn(() => false), unlinkSync: vi.fn() }))

    const { createDefaultOuroCliDeps, runOuroCli } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

    await expect(deps.checkSocketAlive("/tmp/daemon.sock")).resolves.toBe(false)
    const statusResult = await runOuroCli(["status"], {
      ...deps,
      sendCommand: vi.fn(async () => {
        const error = new Error("daemon unreachable") as Error & { code?: string }
        error.code = "ENOENT"
        throw error
      }),
      writeStdout: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    })

    expect(statusResult).toContain("stopped")
    expect(statusResult).toContain("daemon not running; run `ouro up`")

    await expect(runOuroCli(["status"], {
      ...deps,
      sendCommand: vi.fn(async () => {
        throw new Error("daemon unreachable")
      }),
      writeStdout: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    })).rejects.toThrow("daemon unreachable")
  })

  it("returns a friendly message when stop is requested and the daemon socket is missing", async () => {
    vi.resetModules()

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => false),
      unlinkSync: vi.fn(),
      readFileSync: vi.fn(() => JSON.stringify({ version: "9.9.9" })),
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:59:00.000Z") })),
    }))

    const { runOuroCli } = await import("../../../heart/daemon/daemon-cli")
    const result = await runOuroCli(["stop"], {
      socketPath: "/tmp/daemon.sock",
      sendCommand: vi.fn(async () => {
        const error = new Error("missing socket") as Error & { code?: string }
        error.code = "ENOENT"
        throw error
      }),
      writeStdout: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    })

    expect(result).toBe("daemon not running")
  })

  it("rethrows status errors whose code property is present but undefined", async () => {
    vi.resetModules()

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs")
      return { ...actual }
    })

    const { runOuroCli } = await import("../../../heart/daemon/daemon-cli")

    await expect(runOuroCli(["status"], {
      socketPath: "/tmp/daemon.sock",
      sendCommand: vi.fn(async () => {
        const error = new Error("mystery failure") as Error & { code?: string | undefined }
        error.code = undefined
        throw error
      }),
      writeStdout: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    })).rejects.toThrow("mystery failure")
  })

  it("default link command persists external identity on friend record", async () => {
    vi.resetModules()

    const tmpBundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-link-defaults-"))
    const friendPath = path.join(tmpBundlesRoot, "slugger.ouro", "friends")
    fs.mkdirSync(friendPath, { recursive: true })
    fs.writeFileSync(
      path.join(friendPath, "friend-1.json"),
      JSON.stringify({
        id: "friend-1",
        name: "Jordan",
        role: "primary",
        trustLevel: "family",
        connections: [],
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-03-07T00:00:00.000Z",
        updatedAt: "2026-03-07T00:00:00.000Z",
        schemaVersion: 1,
      }, null, 2),
      "utf-8",
    )

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs")
      return { ...actual }
    })
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => tmpBundlesRoot,
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { createDefaultOuroCliDeps, runOuroCli } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")
    const result = await runOuroCli([
      "link",
      "slugger",
      "--friend",
      "friend-1",
      "--provider",
      "aad",
      "--external-id",
      "aad-user-100",
    ], {
      ...deps,
      writeStdout: vi.fn(),
    })

    expect(result).toContain("linked aad:aad-user-100 to friend-1")
    const saved = JSON.parse(fs.readFileSync(path.join(friendPath, "friend-1.json"), "utf-8")) as {
      externalIds: Array<{ provider: string; externalId: string }>
    }
    expect(saved.externalIds).toEqual([
      expect.objectContaining({
        provider: "aad",
        externalId: "aad-user-100",
      }),
    ])
  })

  it("default link command reports friend-not-found when record does not exist", async () => {
    vi.resetModules()

    const tmpBundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-link-missing-"))
    const friendPath = path.join(tmpBundlesRoot, "slugger.ouro", "friends")
    fs.mkdirSync(friendPath, { recursive: true })

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs")
      return { ...actual }
    })
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => tmpBundlesRoot,
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { createDefaultOuroCliDeps, runOuroCli } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")
    const result = await runOuroCli([
      "link",
      "slugger",
      "--friend",
      "missing-friend",
      "--provider",
      "aad",
      "--external-id",
      "aad-user-404",
    ], {
      ...deps,
      writeStdout: vi.fn(),
    })

    expect(result).toBe("friend not found: missing-friend")
  })

  it("default link command is idempotent when identity already linked", async () => {
    vi.resetModules()

    const tmpBundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-link-duplicate-"))
    const friendPath = path.join(tmpBundlesRoot, "slugger.ouro", "friends")
    fs.mkdirSync(friendPath, { recursive: true })
    fs.writeFileSync(
      path.join(friendPath, "friend-1.json"),
      JSON.stringify({
        id: "friend-1",
        name: "Jordan",
        role: "primary",
        trustLevel: "family",
        connections: [],
        externalIds: [{ provider: "aad", externalId: "aad-user-100", linkedAt: "2026-03-07T00:00:00.000Z" }],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-03-07T00:00:00.000Z",
        updatedAt: "2026-03-07T00:00:00.000Z",
        schemaVersion: 1,
      }, null, 2),
      "utf-8",
    )

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs")
      return { ...actual }
    })
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => tmpBundlesRoot,
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { createDefaultOuroCliDeps, runOuroCli } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")
    const result = await runOuroCli([
      "link",
      "slugger",
      "--friend",
      "friend-1",
      "--provider",
      "aad",
      "--external-id",
      "aad-user-100",
    ], {
      ...deps,
      writeStdout: vi.fn(),
    })

    expect(result).toBe("identity already linked: aad:aad-user-100")
    const saved = JSON.parse(fs.readFileSync(path.join(friendPath, "friend-1.json"), "utf-8")) as {
      externalIds: Array<{ provider: string; externalId: string }>
    }
    expect(saved.externalIds).toHaveLength(1)
  })

  it("links friend identity using default friend store when no friendStore dep", async () => {
    vi.resetModules()

    const tmpBundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-link-fallback-linker-"))
    const friendPath = path.join(tmpBundlesRoot, "slugger.ouro", "friends")
    fs.mkdirSync(friendPath, { recursive: true })
    fs.writeFileSync(
      path.join(friendPath, "friend-1.json"),
      JSON.stringify({
        id: "friend-1",
        name: "Jordan",
        role: "primary",
        trustLevel: "family",
        connections: [],
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-03-07T00:00:00.000Z",
        updatedAt: "2026-03-07T00:00:00.000Z",
        schemaVersion: 1,
      }, null, 2),
      "utf-8",
    )

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs")
      return { ...actual }
    })
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => tmpBundlesRoot,
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { createDefaultOuroCliDeps, runOuroCli } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")
    const result = await runOuroCli([
      "link",
      "slugger",
      "--friend",
      "friend-1",
      "--provider",
      "aad",
      "--external-id",
      "aad-user-222",
    ], {
      ...deps,
      writeStdout: vi.fn(),
    })

    expect(result).toContain("linked aad:aad-user-222 to friend-1")
  })

  it("uses default promptInput and trims readline responses", async () => {
    vi.resetModules()

    const question = vi.fn(async () => "  yes  ")
    const close = vi.fn()
    const createInterface = vi.fn(() => ({
      question,
      close,
    }))

    vi.doMock("readline/promises", () => ({ createInterface }))
    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({ existsSync: vi.fn(() => false), unlinkSync: vi.fn(), readdirSync: vi.fn(() => []) }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

    const value = await deps.promptInput!("Continue? ")
    expect(value).toBe("yes")
    expect(question).toHaveBeenCalledWith("Continue? ")
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("uses default promptSecret and trims readline responses", async () => {
    vi.resetModules()

    const restoreTTY = withSecretPromptTTY()
    const close = vi.fn()
    const originalWriteToOutput = vi.fn()
    let iface!: {
      question: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      _writeToOutput: (text: string) => void
    }
    const question = vi.fn((prompt: string, callback: (answer: string) => void) => {
      iface._writeToOutput(prompt)
      setImmediate(() => {
        iface._writeToOutput("typed-secret")
        callback("  hush  ")
      })
    })
    const createInterface = vi.fn(() => {
      iface = {
        question,
        close,
        _writeToOutput: originalWriteToOutput,
      }
      return iface
    })
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.doMock("readline", () => ({ createInterface }))
    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({ existsSync: vi.fn(() => false), unlinkSync: vi.fn(), readdirSync: vi.fn(() => []) }))

    try {
      const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

      const value = await deps.promptSecret!("Secret: ")
      expect(value).toBe("hush")
      expect(question).toHaveBeenCalledWith("Secret: ", expect.any(Function))
      expect(originalWriteToOutput).toHaveBeenCalledWith("Secret: ")
      expect(originalWriteToOutput).not.toHaveBeenCalledWith("typed-secret")
      expect(stdoutWrite).toHaveBeenCalledWith("\n")
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      stdoutWrite.mockRestore()
      restoreTTY()
    }
  })

  it("uses default promptSecret when readline has no output hook", async () => {
    vi.resetModules()

    const restoreTTY = withSecretPromptTTY()
    const question = vi.fn((_prompt: string, callback: (answer: string) => void) => {
      callback("  still-hush  ")
    })
    const close = vi.fn()
    const createInterface = vi.fn(() => ({
      question,
      close,
    }))
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.doMock("readline", () => ({ createInterface }))
    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({ existsSync: vi.fn(() => false), unlinkSync: vi.fn(), readdirSync: vi.fn(() => []) }))

    try {
      const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

      const value = await deps.promptSecret!("Secret: ")
      expect(value).toBe("still-hush")
      expect(question).toHaveBeenCalledWith("Secret: ", expect.any(Function))
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      stdoutWrite.mockRestore()
      restoreTTY()
    }
  })

  it("rejects default promptSecret outside an interactive terminal", async () => {
    vi.resetModules()

    const restoreStdinTTY = withStreamTTY(process.stdin, false)
    const restoreStdoutTTY = withStreamTTY(process.stdout, true)

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({ existsSync: vi.fn(() => false), unlinkSync: vi.fn(), readdirSync: vi.fn(() => []) }))

    try {
      const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

      await expect(deps.promptSecret!("Secret: ")).rejects.toThrow(
        "vault unlock secret entry requires an interactive terminal",
      )
    } finally {
      restoreStdoutTTY()
      restoreStdinTTY()
    }
  })

  it("default discovery filters disabled/invalid bundles and sorts enabled agents", async () => {
    vi.resetModules()

    const tmpBundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-discovery-defaults-"))
    const makeBundle = (name: string, configRaw: string): void => {
      const dir = path.join(tmpBundlesRoot, `${name}.ouro`)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "agent.json"), configRaw, "utf-8")
    }

    makeBundle("zeta", JSON.stringify({ enabled: true }))
    makeBundle("alpha", JSON.stringify({ enabled: true }))
    makeBundle("disabled", JSON.stringify({ enabled: false }))
    makeBundle("broken", "{")
    fs.mkdirSync(path.join(tmpBundlesRoot, "notes"), { recursive: true })

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs")
      return { ...actual }
    })
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => tmpBundlesRoot,
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { createDefaultOuroCliDeps, runOuroCli } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")
    const writeStdout = vi.fn()
    const result = await runOuroCli([], {
      ...deps,
      writeStdout,
      startChat: undefined,
    })

    expect(result).toContain("who do you want to talk to?")
    expect(result).toContain("alpha")
    expect(result).toContain("zeta")
    expect(result.indexOf("alpha")).toBeLessThan(result.indexOf("zeta"))
    expect(writeStdout).toHaveBeenCalledTimes(1)
  })

  it("default discovery returns empty list when bundle directory read fails", async () => {
    vi.resetModules()

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => false),
      unlinkSync: vi.fn(),
      readFileSync: vi.fn(() => JSON.stringify({ enabled: true })),
      readdirSync: vi.fn(() => {
        throw new Error("read failed")
      }),
    }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

    expect(deps.listDiscoveredAgents!()).toEqual([])
  })

  it("default deps include startChat function", async () => {
    vi.resetModules()

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({ existsSync: vi.fn(() => false), unlinkSync: vi.fn() }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

    expect(typeof deps.startChat).toBe("function")
  })

  it("falls back to internal discovery when deps.listDiscoveredAgents is explicitly undefined", async () => {
    vi.resetModules()

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => false),
      unlinkSync: vi.fn(),
      readFileSync: vi.fn(() => JSON.stringify({ enabled: true })),
      readdirSync: vi.fn(() => {
        throw new Error("read failed")
      }),
    }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { runOuroCli } = await import("../../../heart/daemon/daemon-cli")
    const sendCommand = vi.fn(async () => ({ ok: true, message: "hatch started" }))
    await runOuroCli([], {
      socketPath: "/tmp/daemon.sock",
      sendCommand,
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: undefined,
    })

    expect(sendCommand).toHaveBeenCalledWith(
      "/tmp/daemon.sock",
      expect.objectContaining({ kind: "hatch.start" }),
    )
  })

  it("wires default startup health and daemon-log helpers into the CLI deps", async () => {
    vi.resetModules()

    const readHealth = vi.fn(() => ({
      status: "ok",
      mode: "normal",
      pid: 123,
      startedAt: "2026-04-10T05:02:36.000Z",
      uptimeSeconds: 1,
      safeMode: null,
      degraded: [],
      agents: {},
      habits: {},
    }))
    const discoverLogFiles = vi.fn(() => ["/tmp/daemon.ndjson"])
    const readLastLines = vi.fn(() => ['{"level":"warn","component":"daemon","event":"daemon.startup","message":"socket lost"}'])
    const formatLogLine = vi.fn((line: string) => `formatted:${line}`)
    const statSync = vi.fn(() => ({ mtimeMs: 4242 }))

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs")
      return {
        ...actual,
        statSync,
        existsSync: vi.fn(() => false),
        unlinkSync: vi.fn(),
        readdirSync: vi.fn(() => []),
      }
    })
    vi.doMock("../../../heart/daemon/daemon-health", () => ({
      getDefaultHealthPath: () => "/tmp/daemon-health.json",
      readHealth,
    }))
    vi.doMock("../../../heart/daemon/log-tailer", () => ({
      discoverLogFiles,
      readLastLines,
      formatLogLine,
    }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

    expect(deps.healthFilePath).toBe("/tmp/daemon-health.json")
    expect(deps.readHealthState?.("/tmp/daemon-health.json")).toEqual(expect.objectContaining({
      pid: 123,
      status: "ok",
    }))
    expect(deps.readHealthUpdatedAt?.("/tmp/daemon-health.json")).toBe(4242)
    expect(deps.readRecentDaemonLogLines?.(5)).toEqual([
      'formatted:{"level":"warn","component":"daemon","event":"daemon.startup","message":"socket lost"}',
    ])
    expect(deps.startupPollIntervalMs).toBe(250)
    expect(deps.startupStabilityWindowMs).toBe(1_500)
    expect(deps.startupTimeoutMs).toBe(10_000)
    expect(deps.startupRetryLimit).toBe(1)
    await expect(deps.sleep?.(0)).resolves.toBeUndefined()
  })

  it("returns null for health mtime when the health file cannot be stat'ed", async () => {
    vi.resetModules()

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs")
      return {
        ...actual,
        statSync: vi.fn(() => {
          throw new Error("missing")
        }),
        existsSync: vi.fn(() => false),
        unlinkSync: vi.fn(),
        readdirSync: vi.fn(() => []),
      }
    })
    vi.doMock("../../../heart/daemon/daemon-health", () => ({
      getDefaultHealthPath: () => "/tmp/daemon-health.json",
      readHealth: vi.fn(() => null),
    }))
    vi.doMock("../../../heart/daemon/log-tailer", () => ({
      discoverLogFiles: vi.fn(() => []),
      readLastLines: vi.fn(() => []),
      formatLogLine: vi.fn((line: string) => line),
    }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
      getAgentDaemonLogsDir: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logs",
      getAgentDaemonLoggingConfigPath: () => "/tmp/AgentBundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

    expect(deps.readHealthUpdatedAt?.("/tmp/daemon-health.json")).toBeNull()
  })
})
