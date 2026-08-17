import { EventEmitter } from "events"
import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// This test exercises the REAL socket-client functions (not mocks). Disable
// the defense-in-depth vitest guard for the duration of this suite so the
// guard's no-op short circuit doesn't bypass the actual code paths we're
// trying to verify. The guard is what protects every OTHER test from
// accidentally leaking real socket commands to the running daemon.
beforeAll(async () => {
  const { __bypassVitestGuardForTests } = await import("../../../heart/daemon/socket-client")
  __bypassVitestGuardForTests(true)
})
afterAll(async () => {
  const { __bypassVitestGuardForTests } = await import("../../../heart/daemon/socket-client")
  __bypassVitestGuardForTests(false)
})

describe("daemon socket client", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("returns null for the legacy wake alias when the daemon socket does not exist", async () => {
    const createConnection = vi.fn()

    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => false),
    }))
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { requestInnerWake } = await import("../../../heart/daemon/socket-client")
    const response = await requestInnerWake("slugger", "/tmp/daemon.sock")

    expect(response).toBeNull()
    expect(createConnection).not.toHaveBeenCalled()
  })

  it("sends an inner.wake command when the daemon socket exists", async () => {
    class MockConnection extends EventEmitter {
      write = vi.fn(() => {
        queueMicrotask(() => {
          this.emit("data", Buffer.from("{\"ok\":true,\"message\":\"woke private runtime for slugger\"}", "utf-8"))
          this.emit("end")
        })
      })
      end = vi.fn()
    }

    const createConnection = vi.fn(() => {
      const connection = new MockConnection()
      queueMicrotask(() => connection.emit("connect"))
      return connection
    })

    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => true),
    }))
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { requestInnerWake } = await import("../../../heart/daemon/socket-client")
    const response = await requestInnerWake("slugger", "/tmp/daemon.sock")

    expect(createConnection).toHaveBeenCalledWith("/tmp/daemon.sock")
    expect(response).toEqual({ ok: true, message: "woke private runtime for slugger" })
    const connection = createConnection.mock.results[0]?.value as MockConnection
    expect(connection.write).toHaveBeenCalledWith(JSON.stringify({ kind: "inner.wake", agent: "slugger" }) + "\n")
  })

  it("sends a private.wake command through the canonical private-runtime wake helper", async () => {
    class MockConnection extends EventEmitter {
      write = vi.fn(() => {
        queueMicrotask(() => {
          this.emit("data", Buffer.from("{\"ok\":true,\"message\":\"woke private runtime for slugger\"}", "utf-8"))
          this.emit("end")
        })
      })
      end = vi.fn()
    }

    const createConnection = vi.fn(() => {
      const connection = new MockConnection()
      queueMicrotask(() => connection.emit("connect"))
      return connection
    })

    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => true),
    }))
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { requestPrivateWake } = await import("../../../heart/daemon/socket-client") as {
      requestPrivateWake?: (
        agent: string,
        socketPath: string,
        options: { reason: string; triggerSource: string; budgetClass: string; idempotencyKey: string },
      ) => Promise<unknown>
    }
    expect(requestPrivateWake).toEqual(expect.any(Function))

    const response = await requestPrivateWake!("slugger", "/tmp/daemon.sock", {
      reason: "manual wake",
      triggerSource: "manual",
      budgetClass: "interactive",
      idempotencyKey: "manual-private-wake",
    })

    expect(createConnection).toHaveBeenCalledWith("/tmp/daemon.sock")
    expect(response).toEqual({ ok: true, message: "woke private runtime for slugger" })
    const connection = createConnection.mock.results[0]?.value as MockConnection
    expect(connection.write).toHaveBeenCalledWith(JSON.stringify({
      kind: "private.wake",
      agent: "slugger",
      reason: "manual wake",
      triggerSource: "manual",
      budgetClass: "interactive",
      idempotencyKey: "manual-private-wake",
    }) + "\n")
  })

  it("returns null for private wake when the daemon socket does not exist", async () => {
    const createConnection = vi.fn()

    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => false),
    }))
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { requestPrivateWake } = await import("../../../heart/daemon/socket-client")
    const response = await requestPrivateWake("slugger", "/tmp/daemon.sock")

    expect(response).toBeNull()
    expect(createConnection).not.toHaveBeenCalled()
  })

  it("rejects socket commands when the connection emits an error", async () => {
    class MockConnection extends EventEmitter {}

    const createConnection = vi.fn(() => {
      const connection = new MockConnection()
      queueMicrotask(() => connection.emit("error", new Error("socket broke")))
      return connection
    })

    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => true),
    }))
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { sendDaemonCommand } = await import("../../../heart/daemon/socket-client")

    await expect(sendDaemonCommand("/tmp/daemon.sock", { kind: "daemon.status" } as any)).rejects.toThrow("socket broke")
  })

  it("rejects socket commands when the daemon never responds", async () => {
    class MockConnection extends EventEmitter {
      setTimeout = vi.fn((_timeoutMs: number, callback: () => void) => {
        queueMicrotask(callback)
        return this
      })
      destroy = vi.fn()
    }

    const createConnection = vi.fn(() => new MockConnection())

    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => true),
    }))
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { sendDaemonCommand } = await import("../../../heart/daemon/socket-client")

    const error = await sendDaemonCommand("/tmp/daemon.sock", { kind: "agent.status", agent: "slugger" } as any, { timeoutMs: 25 })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("timed out after 25ms")
    expect((error as NodeJS.ErrnoException).code).toBe("ETIMEDOUT")
    const connection = createConnection.mock.results[0]?.value as MockConnection
    expect(connection.destroy).toHaveBeenCalled()
  })

  it("bounds a connected silent status socket at the five-second production policy", async () => {
    vi.resetModules()
    vi.doUnmock("net")
    vi.doUnmock("../../../nerves/runtime")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-silent-status-"))
    const socketPath = path.join(root, "daemon.sock")
    const clients = new Set<net.Socket>()
    const server = net.createServer((socket) => {
      clients.add(socket)
      socket.on("close", () => clients.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, resolve)
    })

    try {
      const { DEFAULT_DAEMON_STATUS_TIMEOUT_MS, sendDaemonCommand } = await import("../../../heart/daemon/socket-client")
      const startedAt = Date.now()
      const error = await sendDaemonCommand(
        socketPath,
        { kind: "daemon.status" },
        { timeoutMs: DEFAULT_DAEMON_STATUS_TIMEOUT_MS },
      ).catch((caught: unknown) => caught)
      const durationMs = Date.now() - startedAt

      expect((error as NodeJS.ErrnoException).code).toBe("ETIMEDOUT")
      expect(durationMs).toBeGreaterThanOrEqual(4_900)
      expect(durationMs).toBeLessThanOrEqual(6_000)
    } finally {
      for (const client of clients) client.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 7_000)

  it("settles exactly once when timeout races with end and error events", async () => {
    const emitNervesEvent = vi.fn()
    class MockConnection extends EventEmitter {
      setTimeout = vi.fn((_timeoutMs: number, callback: () => void) => {
        queueMicrotask(() => {
          callback()
          this.emit("end")
          this.emit("error", new Error("late socket error"))
        })
        return this
      })
      destroy = vi.fn()
    }
    vi.doMock("net", () => ({ createConnection: vi.fn(() => new MockConnection()) }))
    vi.doMock("fs", () => ({ existsSync: vi.fn(() => true) }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))

    const { sendDaemonCommand } = await import("../../../heart/daemon/socket-client")
    const error = await sendDaemonCommand("/tmp/daemon.sock", { kind: "daemon.status" }, { timeoutMs: 25 })
      .catch((caught: unknown) => caught)

    expect((error as NodeJS.ErrnoException).code).toBe("ETIMEDOUT")
    expect(emitNervesEvent.mock.calls.filter(([event]) => event.event === "daemon.socket_command_timeout")).toHaveLength(1)
    expect(emitNervesEvent.mock.calls.filter(([event]) => event.event === "daemon.socket_command_error")).toHaveLength(0)
  })

  it("stringifies non-Error JSON parse failures from daemon responses", async () => {
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
      const connection = new MockConnection()
      queueMicrotask(() => connection.emit("connect"))
      return connection
    })

    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => true),
    }))
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const parseSpy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw "bad-json"
    })

    const { sendDaemonCommand } = await import("../../../heart/daemon/socket-client")

    await expect(sendDaemonCommand("/tmp/daemon.sock", { kind: "daemon.status" } as any)).rejects.toBe("bad-json")
    parseSpy.mockRestore()
  })
})

describe("vitest guard (defense in depth)", () => {
  // These tests verify the guard is ON by default. We re-enable the guard
  // (the suite-level beforeAll above turns it OFF for the other tests) and
  // verify that real socket calls become safe no-ops.
  beforeEach(async () => {
    vi.resetModules()
    const { __bypassVitestGuardForTests } = await import("../../../heart/daemon/socket-client")
    __bypassVitestGuardForTests(false)
  })
  // Restore the bypass after each test so the rest of the suite (and any
  // tests that run after) sees the test-friendly mode.
  afterEach(async () => {
    const { __bypassVitestGuardForTests } = await import("../../../heart/daemon/socket-client")
    __bypassVitestGuardForTests(true)
  })

  it("requestInnerWake returns null without touching net or fs when guard is active", async () => {
    const createConnection = vi.fn()
    const existsSync = vi.fn()
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("fs", () => ({ existsSync }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { requestInnerWake } = await import("../../../heart/daemon/socket-client")
    const result = await requestInnerWake("testagent", "/tmp/some-real-daemon.sock")

    expect(result).toBeNull()
    expect(createConnection).not.toHaveBeenCalled()
    expect(existsSync).not.toHaveBeenCalled()
  })

  it("requestPrivateWake returns null without touching net or fs when guard is active", async () => {
    const createConnection = vi.fn()
    const existsSync = vi.fn()
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("fs", () => ({ existsSync }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { requestPrivateWake } = await import("../../../heart/daemon/socket-client")
    const result = await requestPrivateWake("testagent", "/tmp/some-real-daemon.sock")

    expect(result).toBeNull()
    expect(createConnection).not.toHaveBeenCalled()
    expect(existsSync).not.toHaveBeenCalled()
  })

  it("sendDaemonCommand resolves with a safe stub without touching net when guard is active", async () => {
    const createConnection = vi.fn()
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("fs", () => ({ existsSync: vi.fn() }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { sendDaemonCommand } = await import("../../../heart/daemon/socket-client")
    const result = await sendDaemonCommand("/tmp/some-real-daemon.sock", { kind: "daemon.status" } as any)

    expect(result.ok).toBe(true)
    expect(createConnection).not.toHaveBeenCalled()
  })

  it("checkDaemonSocketAlive resolves false without touching net when guard is active", async () => {
    const createConnection = vi.fn()
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("fs", () => ({ existsSync: vi.fn() }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { checkDaemonSocketAlive } = await import("../../../heart/daemon/socket-client")
    const result = await checkDaemonSocketAlive("/tmp/some-real-daemon.sock")

    expect(result).toBe(false)
    expect(createConnection).not.toHaveBeenCalled()
  })
})

describe("vitest guard hardening — production socket is always blocked", () => {
  // This block runs with the suite-level beforeAll bypass ON. The hardening
  // contract: even with the bypass on, calls to the production daemon socket
  // (DEFAULT_DAEMON_SOCKET_PATH = /tmp/ouroboros-daemon.sock) must be blocked.
  // This is the defense against cross-file leaks documented in
  // src/heart/daemon/socket-client.ts:27-42.
  beforeEach(() => {
    vi.resetModules()
  })

  it("requestInnerWake to /tmp/ouroboros-daemon.sock is blocked even with bypass on", async () => {
    const createConnection = vi.fn()
    const existsSync = vi.fn()
    const emitNervesEvent = vi.fn()
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("fs", () => ({ existsSync }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))

    const { requestInnerWake } = await import("../../../heart/daemon/socket-client")
    // Default socket path = production socket. Even with bypass ON, this MUST be blocked.
    const result = await requestInnerWake("testagent")

    expect(result).toBeNull()
    expect(createConnection).not.toHaveBeenCalled()
    expect(existsSync).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "daemon.inner_wake_test_blocked",
        meta: expect.objectContaining({ isProductionSocket: true }),
      }),
    )
  })

  it("sendDaemonCommand to /tmp/ouroboros-daemon.sock is blocked even with bypass on", async () => {
    const createConnection = vi.fn()
    const emitNervesEvent = vi.fn()
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("fs", () => ({ existsSync: vi.fn() }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))

    const { sendDaemonCommand } = await import("../../../heart/daemon/socket-client")
    const result = await sendDaemonCommand("/tmp/ouroboros-daemon.sock", { kind: "inner.wake", agent: "testagent" } as any)

    expect(result.ok).toBe(true)
    expect(createConnection).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "daemon.socket_command_test_blocked",
        meta: expect.objectContaining({ isProductionSocket: true }),
      }),
    )
  })

  it("checkDaemonSocketAlive on /tmp/ouroboros-daemon.sock is blocked even with bypass on", async () => {
    const createConnection = vi.fn()
    vi.doMock("net", () => ({ createConnection }))
    vi.doMock("fs", () => ({ existsSync: vi.fn() }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { checkDaemonSocketAlive } = await import("../../../heart/daemon/socket-client")
    const result = await checkDaemonSocketAlive("/tmp/ouroboros-daemon.sock")

    expect(result).toBe(false)
    expect(createConnection).not.toHaveBeenCalled()
  })

  it("non-vitest runtime is never blocked (covers the production-mode branch)", async () => {
    // Simulate running in production by removing "vitest" markers from
    // process.argv. The shouldSuppressSocketCall guard reads argv at call
    // time, so this exercises the `if (!isVitestProcess()) return false`
    // branch that the rest of the suite (running under vitest) cannot reach.
    const originalArgv = process.argv
    const cleanArgv = originalArgv.filter((arg) => !arg.includes("vitest"))
    Object.defineProperty(process, "argv", { value: cleanArgv, configurable: true, writable: true })

    class MockConnection extends EventEmitter {
      write = vi.fn(() => {
        queueMicrotask(() => {
          this.emit("data", Buffer.from("{\"ok\":true}", "utf-8"))
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

    try {
      vi.doMock("net", () => ({ createConnection }))
      vi.doMock("fs", () => ({ existsSync: vi.fn() }))
      vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

      const { sendDaemonCommand } = await import("../../../heart/daemon/socket-client")
      // Even targeting the production socket path is allowed when not under vitest.
      const result = await sendDaemonCommand("/tmp/ouroboros-daemon.sock", { kind: "daemon.status" } as any)

      expect(result.ok).toBe(true)
      expect(createConnection).toHaveBeenCalledWith("/tmp/ouroboros-daemon.sock")
    } finally {
      Object.defineProperty(process, "argv", { value: originalArgv, configurable: true, writable: true })
    }
  })

  it("test sockets like /tmp/daemon.sock still work when bypass is on", async () => {
    // Sanity: the bypass continues to allow non-production socket paths so
    // that legitimate socket-client unit tests still exercise the real code.
    class MockConnection extends EventEmitter {
      write = vi.fn(() => {
        queueMicrotask(() => {
          this.emit("data", Buffer.from("{\"ok\":true}", "utf-8"))
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
    vi.doMock("fs", () => ({ existsSync: vi.fn() }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { sendDaemonCommand } = await import("../../../heart/daemon/socket-client")
    const result = await sendDaemonCommand("/tmp/daemon.sock", { kind: "daemon.status" } as any)

    expect(result.ok).toBe(true)
    expect(createConnection).toHaveBeenCalledWith("/tmp/daemon.sock")
  })
})
