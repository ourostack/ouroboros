import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"

function tmpSocketPath(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

function daemonDeps() {
  return {
    processManager: {
      listAgentSnapshots: vi.fn(() => []),
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => undefined),
      sendToAgent: vi.fn(),
    },
    scheduler: {
      listJobs: vi.fn(() => []),
      triggerJob: vi.fn(async () => ({ ok: true, message: "" })),
      reconcile: vi.fn(async () => undefined),
    },
    healthMonitor: { runChecks: vi.fn(async () => []) },
    router: {
      send: vi.fn(async () => ({ id: "msg-1", queuedAt: "2026-09-03T00:00:00.000Z" })),
      pollInbox: vi.fn(() => []),
    },
    senseManager: {
      startAutoStartSenses: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      listSenseRows: vi.fn(() => []),
    },
    mailboxServerFactory: vi.fn(async () => ({
      origin: "http://127.0.0.1:0",
      broadcast: vi.fn(),
      stop: vi.fn(async () => undefined),
    })),
  }
}

function frontendHandle(stop = vi.fn(async () => undefined)) {
  return {
    socketPath: "/tmp/frontend.sock",
    publish: vi.fn(),
    stop,
  }
}

describe("daemon frontend socket lifecycle", () => {
  it("starts one derived frontend socket and stops it with the daemon", async () => {
    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const socketPath = tmpSocketPath("daemon-frontend")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-frontend-"))
    const stop = vi.fn(async () => undefined)
    const factory = vi.fn(async () => frontendHandle(stop))
    const daemon = new OuroDaemon({
      socketPath,
      bundlesRoot,
      frontendSocketServerFactory: factory,
      ...daemonDeps(),
    } as any)

    await daemon.start()
    try {
      await daemon.start()
      expect(factory).toHaveBeenCalledOnce()
      expect(factory).toHaveBeenCalledWith(expect.objectContaining({
        socketPath: `${socketPath}.frontend`,
        service: expect.any(Object),
      }))
    } finally {
      await daemon.stop()
    }
    expect(stop).toHaveBeenCalledOnce()
    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("keeps the legacy daemon available when the frontend socket fails to start", async () => {
    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const socketPath = tmpSocketPath("daemon-frontend-failure")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-frontend-"))
    const daemon = new OuroDaemon({
      socketPath,
      bundlesRoot,
      frontendSocketServerFactory: vi.fn(async () => { throw new Error("frontend bind failed") }),
      ...daemonDeps(),
    } as any)

    await expect(daemon.start()).resolves.toBeUndefined()
    await expect(daemon.handleCommand({ kind: "daemon.status" })).resolves.toMatchObject({ ok: true })
    await expect(daemon.stop()).resolves.toBeUndefined()
    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("cancels active frontend turns before stopping the socket", async () => {
    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const socketPath = tmpSocketPath("daemon-frontend-cancel")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-frontend-"))
    const cancelAllTurns = vi.fn(() => 2)
    const stop = vi.fn(async () => undefined)
    const daemon = new OuroDaemon({
      socketPath,
      bundlesRoot,
      frontendSessionService: { cancelAllTurns } as any,
      frontendSocketServerFactory: vi.fn(async () => frontendHandle(stop)),
      ...daemonDeps(),
    } as any)

    await daemon.start()
    await daemon.stop()
    expect(cancelAllTurns).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(cancelAllTurns.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0])
    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })
})
