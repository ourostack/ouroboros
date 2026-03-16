import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "events"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

function withProcessPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
  return () => {
    if (original) {
      Object.defineProperty(process, "platform", original)
    }
  }
}

describe("daemon CLI default dependency branches", () => {
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
      }))
      vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

      const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

      deps.ensureDaemonBootPersistence?.("/tmp/daemon.sock")

      const plistPath = path.join(tempHome, "Library", "LaunchAgents", "bot.ouro.daemon.plist")
      const logDir = path.join(tempHome, ".agentstate", "daemon", "logs")
      expect(fs.existsSync(plistPath)).toBe(true)
      expect(fs.existsSync(logDir)).toBe(true)

      const plist = fs.readFileSync(plistPath, "utf-8")
      expect(plist).toContain(process.execPath)
      expect(plist).toContain("/mock/repo/dist/heart/daemon/daemon-entry.js")
      expect(plist).toContain("<key>RunAtLoad</key>")
      expect(plist).toContain(path.join(logDir, "ouro-daemon-stdout.log"))
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining("launchctl load"),
        { stdio: "ignore" },
      )
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
      }))
      vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

      const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")

      deps.ensureDaemonBootPersistence?.("/tmp/daemon.sock")

      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining("launchctl unload"),
        { stdio: "ignore" },
      )
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining("launchctl load"),
        { stdio: "ignore" },
      )
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
      write = vi.fn()
      end = vi.fn(() => {
        this.emit("data", Buffer.from("{\"ok\":true,\"summary\":\"status-ok\"}", "utf-8"))
        this.emit("end")
      })
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
      write = vi.fn()
      end = vi.fn(() => {
        this.emit("end")
      })
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
      write = vi.fn()
      end = vi.fn(() => {
        this.emit("data", Buffer.from("not-json", "utf-8"))
        this.emit("end")
      })
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
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => false),
      unlinkSync: vi.fn(),
      readFileSync: vi.fn(() => JSON.stringify({ version: "9.9.9" })),
      readdirSync: vi.fn(() => []),
    }))
    vi.stubGlobal("console", { ...console, log: consoleLog })

    const { createDefaultOuroCliDeps, runOuroCli } = await import("../../../heart/daemon/daemon-cli")

    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")
    const started = await deps.startDaemonProcess("/tmp/daemon.sock")

    expect(spawn).toHaveBeenCalledWith(
      "node",
      ["/mock/repo/dist/heart/daemon/daemon-entry.js", "--socket", "/tmp/daemon.sock"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    )
    expect(unref).toHaveBeenCalled()
    expect(started.pid).toBeNull()

    const result = await runOuroCli(["up"], {
      ...deps,
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
    })
    expect(result).toContain("daemon started")
    expect(consoleLog).toHaveBeenCalled()
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
      conn.write = vi.fn()
      conn.end = vi.fn(() => {
        conn.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))
      })
      queueMicrotask(() => conn.emit("connect"))
      return conn
    })

    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("child_process", () => ({ spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() })) }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
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
      conn.write = vi.fn()
      conn.end = vi.fn(() => {
        conn.emit("error", new Error("first failure"))
        conn.emit("end")
      })
      conn.setTimeout = vi.fn()
      queueMicrotask(() => conn.emit("connect"))
      return conn
    })

    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("child_process", () => ({ spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() })) }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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

  it("wires default subagent installer through repo-root detection", async () => {
    vi.resetModules()

    const installSubagentsForAvailableCli = vi.fn(async () => ({
      claudeInstalled: 0,
      codexInstalled: 0,
      notes: [],
    }))

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
    }))
    vi.doMock("../../../heart/daemon/subagent-installer", () => ({ installSubagentsForAvailableCli }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({ existsSync: vi.fn(() => false), unlinkSync: vi.fn() }))

    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps("/tmp/daemon.sock")
    await deps.installSubagents()

    expect(installSubagentsForAvailableCli).toHaveBeenCalledWith({
      repoRoot: "/mock/repo",
    })
  })

  it("rejects empty non-stop responses from default sendCommand", async () => {
    vi.resetModules()

    class MockConnection extends EventEmitter {
      write = vi.fn()
      end = vi.fn(() => {
        this.emit("end")
      })
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
    })

    expect(statusResult).toContain("| Daemon       | stopped")
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
    })).rejects.toThrow("daemon unreachable")
  })

  it("returns a friendly message when stop is requested and the daemon socket is missing", async () => {
    vi.resetModules()

    vi.doMock("net", () => ({ createConnection: vi.fn() }))
    vi.doMock("child_process", () => ({ spawn: vi.fn() }))
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/AgentBundles",
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
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
      listDiscoveredAgents: undefined,
    })

    expect(sendCommand).toHaveBeenCalledWith(
      "/tmp/daemon.sock",
      expect.objectContaining({ kind: "hatch.start" }),
    )
  })
})
