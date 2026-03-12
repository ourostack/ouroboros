import { EventEmitter } from "events"
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("daemon socket client", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("returns null for inner wake when the daemon socket does not exist", async () => {
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
      write = vi.fn()
      end = vi.fn(() => {
        this.emit("data", Buffer.from("{\"ok\":true,\"message\":\"woke inner dialog for slugger\"}", "utf-8"))
        this.emit("end")
      })
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
    expect(response).toEqual({ ok: true, message: "woke inner dialog for slugger" })
    const connection = createConnection.mock.results[0]?.value as MockConnection
    expect(connection.write).toHaveBeenCalledWith(JSON.stringify({ kind: "inner.wake", agent: "slugger" }))
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

  it("stringifies non-Error JSON parse failures from daemon responses", async () => {
    class MockConnection extends EventEmitter {
      write = vi.fn()
      end = vi.fn(() => {
        this.emit("data", Buffer.from("not-json", "utf-8"))
        this.emit("end")
      })
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
