import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"

import { MAX_SOCKET_COMMAND_BYTES, OuroDaemon, socketCommandComplete } from "../../../heart/daemon/daemon"

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

/** Sends the pieces as separate writes, a tick apart, and returns the daemon's whole answer. */
function exchange(socketPath: string, pieces: Buffer[], end = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath)
    let answer = ""
    client.on("data", (chunk) => { answer += chunk.toString("utf8") })
    client.on("end", () => resolve(answer))
    client.on("error", reject)
    client.on("connect", async () => {
      for (const piece of pieces) {
        client.write(piece)
        await new Promise((tick) => setTimeout(tick, 20))
      }
      if (end) client.end()
    })
  })
}

describe("daemon socket framing", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("reads a command sent in two writes, split inside a UTF-8 character, as one command", async () => {
    const socketPath = tmpSocketPath("daemon-framing-split")
    const { daemon } = makeDaemon(socketPath)
    const handled = vi.spyOn(daemon, "handleRawPayload")
    await daemon.start()
    try {
      const whole = Buffer.from(`${JSON.stringify({ kind: "daemon.status", note: "é".repeat(6000) })}\n`, "utf8")
      // Cut one byte into a two-byte "é", so the first piece ends mid-character.
      const cut = whole.indexOf(Buffer.from("é", "utf8")) + 1
      const answer = await exchange(socketPath, [whole.subarray(0, cut + 9000), whole.subarray(cut + 9000)])
      expect(JSON.parse(answer).ok).toBe(true)
      expect(handled).toHaveBeenCalledTimes(1)
      expect(handled.mock.calls[0]![0]).toBe(whole.toString("utf8"))
    } finally {
      await daemon.stop()
    }
  })

  it("answers a command without a newline once its JSON is whole, and on end", async () => {
    const socketPath = tmpSocketPath("daemon-framing-bare")
    const { daemon } = makeDaemon(socketPath)
    await daemon.start()
    try {
      const bare = await exchange(socketPath, [Buffer.from('{"kind":'), Buffer.from('"daemon.status"}')])
      expect(JSON.parse(bare).ok).toBe(true)
      const ended = await exchange(socketPath, [Buffer.from('{"kind":"daemon.status"')], true)
      expect(JSON.parse(ended).ok).toBe(false)
    } finally {
      await daemon.stop()
    }
  })

  it("refuses a command over the size cap without reading it on", async () => {
    const socketPath = tmpSocketPath("daemon-framing-cap")
    const { daemon } = makeDaemon(socketPath)
    const handled = vi.spyOn(daemon, "handleRawPayload")
    await daemon.start()
    try {
      // The cap is crossed well before the first write ends, so more arrives after it; that is ignored, and the daemon answers once.
      const answer = await exchange(socketPath, [Buffer.alloc(MAX_SOCKET_COMMAND_BYTES + 256 * 1024, "a"), Buffer.from('{"kind":"daemon.status"}\n')])
      expect(JSON.parse(answer)).toEqual({ ok: false, error: `The daemon command is larger than ${MAX_SOCKET_COMMAND_BYTES} bytes.` })
      expect(handled).not.toHaveBeenCalled()
    } finally {
      await daemon.stop()
    }
  })

  it("knows a whole command by its newline or by JSON that parses on its own", () => {
    expect(socketCommandComplete('{"kind":"x"}\n')).toBe(true)
    expect(socketCommandComplete('{"kind":"x"}  ')).toBe(true)
    expect(socketCommandComplete('{"kind":"x"')).toBe(false)
    expect(socketCommandComplete('{"kind":"}')).toBe(false)
    expect(socketCommandComplete("")).toBe(false)
  })
})
