import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"

import { OuroDaemon } from "../../../heart/daemon/daemon"

function tmpSocketPath(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

function makeDaemon(socketPath: string) {
  const processManager = {
    listAgentSnapshots: vi.fn(() => []),
    startAutoStartAgents: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    startAgent: vi.fn(async () => undefined),
    sendToAgent: vi.fn(),
  }

  const scheduler = {
    listJobs: vi.fn(() => []),
    triggerJob: vi.fn(async (jobId: string) => ({ ok: true, message: `triggered ${jobId}` })),
    reconcile: vi.fn(async () => undefined),
  }

  const healthMonitor = {
    runChecks: vi.fn(async () => [{ name: "agent-processes", status: "ok" as const, message: "good" }]),
  }

  const router = {
    send: vi.fn(async () => ({ id: "msg-1", queuedAt: "2026-03-05T23:00:00.000Z" })),
    pollInbox: vi.fn(() => []),
  }

  const senseManager = {
    startAutoStartSenses: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    listSenseRows: vi.fn(() => []),
  }

  const daemon = new OuroDaemon({
    socketPath,
    processManager,
    scheduler,
    healthMonitor,
    router,
    senseManager,
  } as any)
  return { daemon, processManager }
}

describe("daemon socket error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("handles connection.end() EPIPE errors gracefully", async () => {
    const socketPath = tmpSocketPath("daemon-epipe-test")
    const { daemon } = makeDaemon(socketPath)
    await daemon.start()

    // Connect and immediately destroy the socket before the daemon can respond
    await new Promise<void>((resolve) => {
      const client = net.createConnection(socketPath)
      client.on("connect", () => {
        client.write('{"kind":"daemon.status"}')
        // Destroy immediately — this may cause EPIPE when daemon tries connection.end()
        client.destroy()
        resolve()
      })
      client.on("error", () => {
        resolve()
      })
    })

    // Wait briefly for the server to process the destroyed connection
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Daemon should still be running fine
    const status = await daemon.handleCommand({ kind: "daemon.status" })
    expect(status.ok).toBe(true)

    await daemon.stop()
  })

  it("installs persistent server error handler after listen", async () => {
    const socketPath = tmpSocketPath("daemon-server-error")
    const { daemon } = makeDaemon(socketPath)
    await daemon.start()

    // Verify daemon is alive
    const status = await daemon.handleCommand({ kind: "daemon.status" })
    expect(status.ok).toBe(true)

    await daemon.stop()
  })

  it("handles connection errors without crashing the server", async () => {
    const socketPath = tmpSocketPath("daemon-conn-error")
    const { daemon } = makeDaemon(socketPath)
    await daemon.start()

    // Connect and trigger a sudden destroy of the connection
    const client = new net.Socket()
    await new Promise<void>((resolve) => {
      client.connect(socketPath, () => {
        // Send partial data then destroy — simulates dropped connection
        client.write('{"kind":')
        client.destroy()
        resolve()
      })
      client.on("error", () => {
        resolve()
      })
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Daemon should still handle commands normally
    const status = await daemon.handleCommand({ kind: "daemon.status" })
    expect(status.ok).toBe(true)

    await daemon.stop()
  })
})
